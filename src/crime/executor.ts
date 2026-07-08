/**
 * Crime execution and discovery.
 *
 * Drives the killer through the physical steps of the plan using the same
 * movement/event machinery as everyone else: buy or fetch the weapon, travel
 * to the scene (cameras and passers-by can catch them), wait for isolation,
 * kill, leave traces, dispose of the weapon, go home. Discovery then happens
 * to whoever the simulation naturally brings to the body — with a
 * missed-work → phone-call → check-on-them chain as the believable fallback.
 */

import { Rng, hashString } from "../core/rng";
import { log } from "../core/log";
import { fmtClock, fmtTime, fmtTimeLong, hourOf, type SimTime } from "../core/time";
import type { SimEngine } from "../sim/engine";
import type { CrimePlan } from "./planner";
import type { Item, Npc, RoomId, World } from "../world/types";
import { buildingById, fullName, itemById, roomById } from "../world/types";
import { addMemory } from "../sim/memory";

export type ExecutionStatus = "pending" | "in-progress" | "done" | "failed";

interface Waypoint {
  buildingId: string;
  purpose: "purchase-weapon" | "fetch-weapon" | "scene" | "dispose" | "go-home";
  notBefore: SimTime;
}

export class CrimeExecutor {
  readonly plan: CrimePlan;
  status: ExecutionStatus = "pending";
  private waypoints: Waypoint[] = [];
  private weaponItemId: string | null = null;
  private rng: Rng;
  private discoveryHandled = false;
  private missedWorkEmitted = false;
  private checkerDispatched = false;
  private searchDispatched = false;

  constructor(plan: CrimePlan, seed: number) {
    this.plan = plan;
    this.rng = new Rng((seed ^ hashString(`exec:${plan.killerId}:${plan.murderTime}`)) >>> 0);
  }

  /** Called by the director after every engine tick. */
  step(engine: SimEngine): void {
    const world = engine.world;
    if (world.crime) this.watchDiscovery(engine);

    const killer = world.npcs.find((n) => n.id === this.plan.killerId);
    const victim = world.npcs.find((n) => n.id === this.plan.victimId);
    if (!killer || !victim) {
      this.status = "failed";
      return;
    }

    if (this.status === "pending") {
      if (!killer.alive || !victim.alive) { this.status = "failed"; return; }
      this.prepareWaypoints(engine, killer);
      this.status = "in-progress";
    }

    if (this.status === "in-progress" && world.time > this.plan.windowEnd + 60) {
      log.warn("crime", `Execution window expired for ${fullName(killer)}; plan failed`);
      killer.scheduleOverride = null;
      this.status = "failed";
      return;
    }
    if (this.status !== "in-progress" && this.status !== "done") return;

    // Advance through waypoints (pre-murder approach AND post-murder cleanup).
    const wp = this.waypoints[0];
    if (!wp) return;
    if (world.time < wp.notBefore) return;
    if (killer.position.kind === "street") return; // in transit

    if (killer.position.buildingId !== wp.buildingId) {
      killer.scheduleOverride = {
        buildingId: wp.buildingId,
        until: world.time + 360,
        activity: "errand",
      };
      return;
    }

    // Arrived at the current waypoint.
    switch (wp.purpose) {
      case "purchase-weapon":
        this.doPurchase(engine, killer);
        this.waypoints.shift();
        break;
      case "fetch-weapon":
        this.doFetch(engine, killer);
        this.waypoints.shift();
        break;
      case "scene":
        // Keep the schedule from pulling the killer away while they wait.
        killer.scheduleOverride = { buildingId: wp.buildingId, until: world.time + 60, activity: "social" };
        this.tryMurder(engine, killer, victim);
        break;
      case "dispose":
        this.doDispose(engine, killer);
        this.waypoints.shift();
        break;
      case "go-home":
        killer.scheduleOverride = null;
        this.finalizeTakenHome(engine);
        this.waypoints.shift();
        break;
    }
  }

  private prepareWaypoints(engine: SimEngine, killer: Npc): void {
    const world = engine.world;
    const wps: Waypoint[] = [];
    const w = this.plan.weapon;
    if (w.source === "purchase") {
      // Shop a few hours ahead, when the store is open.
      const store = buildingById(world, w.storeId);
      let shopAt = this.plan.murderTime - 240;
      for (let i = 0; i < 24; i++) {
        if (engine.isOpenAt(store, ((shopAt % 1440) + 1440) % 1440) && shopAt > world.time) break;
        shopAt += 30;
      }
      if (shopAt < this.plan.murderTime - 30) {
        wps.push({ buildingId: w.storeId, purpose: "purchase-weapon", notBefore: shopAt });
      } else {
        // Store never open in time — improvise at the scene instead.
        this.plan.weapon = { source: "at-scene" };
      }
    } else if (w.source === "owned") {
      const item = itemById(world, w.itemId);
      if (item.carrierId !== killer.id) {
        const whereRoom = item.roomId ? roomById(world, item.roomId) : null;
        if (whereRoom) {
          wps.push({
            buildingId: whereRoom.buildingId,
            purpose: "fetch-weapon",
            notBefore: this.plan.murderTime - 180,
          });
        }
      } else {
        this.weaponItemId = item.id;
      }
    }
    // Travel lead: rough distance-based estimate, generous.
    wps.push({ buildingId: this.plan.sceneBuildingId, purpose: "scene", notBefore: this.plan.murderTime - 60 });
    this.waypoints = wps;
  }

  private doPurchase(engine: SimEngine, killer: Npc): void {
    const world = engine.world;
    const w = this.plan.weapon;
    if (w.source !== "purchase") return;
    const store = buildingById(world, w.storeId);
    const label = w.kind === "hunting-knife" ? "Hunting knife" : "Claw hammer";
    const price = w.kind === "hunting-knife" ? 60 : 20;
    const id = `item:${world.nextIds.item++}`;
    const item: Item = {
      id, kind: w.kind, name: label, ownerId: killer.id, roomId: null, carrierId: killer.id,
      lethality: w.kind === "hunting-knife" ? 0.95 : 0.75,
      fingerprints: [], bloodOfNpcId: null, bloodEventId: null, hiddenAt: null,
    };
    world.items[id] = item;
    killer.inventoryIds.push(id);
    this.weaponItemId = id;
    const owner = store.ownerId ? world.npcs.find((n) => n.id === store.ownerId) ?? null : null;
    const ev = engine.emit({
      kind: "purchase", buildingId: store.id, actorIds: [killer.id], itemId: id, amount: price,
      summary: `${fullName(killer)} bought a ${label.toLowerCase()} at ${store.name}`,
    });
    engine.transfer(killer, owner, price, `purchase — ${label.toLowerCase()}`, store.id, ev.id);
    item.fingerprints.push({ npcId: killer.id, t: world.time, eventId: ev.id });
  }

  private doFetch(engine: SimEngine, killer: Npc): void {
    const world = engine.world;
    const w = this.plan.weapon;
    if (w.source !== "owned") return;
    const item = itemById(world, w.itemId);
    if (item.roomId) {
      const room = roomById(world, item.roomId);
      room.itemIds = room.itemIds.filter((x) => x !== item.id);
      const ev = engine.emit({
        kind: "take-item", buildingId: room.buildingId, roomId: room.id,
        actorIds: [killer.id], itemId: item.id,
        summary: `${fullName(killer)} took the ${item.name.toLowerCase()} from ${roomLabel(world, room.id)}`,
      });
      if (!this.plan.woreGloves) item.fingerprints.push({ npcId: killer.id, t: world.time, eventId: ev.id });
    }
    item.roomId = null;
    item.carrierId = killer.id;
    if (!killer.inventoryIds.includes(item.id)) killer.inventoryIds.push(item.id);
    this.weaponItemId = item.id;
  }

  private tryMurder(engine: SimEngine, killer: Npc, victim: Npc): void {
    const world = engine.world;
    if (world.time < this.plan.murderTime) return;
    // Victim must be here; bystanders must not.
    const occupants = engine.occupants(this.plan.sceneBuildingId);
    const victimHere = occupants.some((n) => n.id === victim.id);
    const bystanders = occupants.filter((n) => n.id !== victim.id && n.id !== killer.id);
    if (!victimHere || bystanders.length > 0) {
      if (world.time > this.plan.windowEnd) {
        log.warn("crime", `Window closed with victim absent/observed; plan failed`);
        killer.scheduleOverride = null;
        this.status = "failed";
      }
      return; // wait another tick
    }

    // Resolve the weapon now if improvised.
    const scene = buildingById(world, this.plan.sceneBuildingId);
    const room = scene.rooms.find((rm) => rm.id === this.plan.sceneRoomId) ?? scene.rooms[0]!;
    let weapon: Item | null = null;
    if (this.plan.weapon.source === "at-scene") {
      const candidates = scene.rooms
        .flatMap((rm) => rm.itemIds)
        .map((iid) => itemById(world, iid))
        .filter((it) => it.lethality >= 0.4)
        .sort((a, b) => b.lethality - a.lethality);
      weapon = candidates[0] ?? null;
    } else if (this.weaponItemId) {
      weapon = itemById(world, this.weaponItemId);
    }

    const r = this.rng;
    const method = weapon
      ? weapon.lethality >= 0.85 ? "stabbed" : "struck down"
      : "strangled";
    const ev = engine.emit({
      kind: "murder",
      buildingId: scene.id,
      roomId: room.id,
      actorIds: [killer.id],
      targetIds: [victim.id],
      itemId: weapon?.id ?? null,
      witnessOverride: [],
      summary: `${fullName(killer)} ${method} ${fullName(victim)} in the ${room.name.toLowerCase()} of ${scene.name}`,
    });

    victim.alive = false;
    victim.position = { kind: "building", buildingId: scene.id, roomId: room.id };
    victim.scheduleOverride = null;

    // Physical traces — all with provenance to the murder event.
    if (weapon) {
      weapon.bloodOfNpcId = victim.id;
      weapon.bloodEventId = ev.id;
      if (!this.plan.woreGloves) {
        weapon.fingerprints.push({ npcId: killer.id, t: world.time, eventId: ev.id });
      }
      // Improvised weapons get picked up here — they leave the carrier.
      if (weapon.carrierId === killer.id) {
        killer.inventoryIds = killer.inventoryIds.filter((x) => x !== weapon!.id);
        weapon.carrierId = null;
      } else if (weapon.roomId) {
        const wroom = roomById(world, weapon.roomId);
        wroom.itemIds = wroom.itemIds.filter((x) => x !== weapon!.id);
        weapon.roomId = null;
      }
    }
    // Victim's carried possessions end up at the scene.
    for (const iid of [...victim.inventoryIds]) {
      const it = itemById(world, iid);
      it.carrierId = null;
      it.roomId = room.id;
      room.itemIds.push(iid);
    }
    victim.inventoryIds = [];

    // A frenzied, unplanned attack means a struggle — the victim fights
    // back, and the killer's DNA ends up under their nails.
    const struggled = !this.plan.premeditated && this.rng.chance(0.75);
    world.scene = {
      buildingId: scene.id,
      roomId: room.id,
      bloodOfVictim: true,
      footprints: [{ npcId: killer.id, shoeSize: killer.shoeSize, eventId: ev.id }],
      sceneItemIds: [],
      struggleDnaOfNpcId: struggled ? killer.id : null,
      struggleDnaEventId: struggled ? ev.id : null,
    };

    // A scream may carry to the neighbors — and can wake the sleeping.
    const screamChance = method === "strangled" ? 0.3 : method === "stabbed" ? 0.5 : 0.65;
    if (r.chance(screamChance)) {
      const nearby = neighborsWithin(world, scene.lot.x + 1, scene.lot.y + 1, 5)
        .filter((n) => n.id !== killer.id && n.alive);
      const hearers = nearby.filter((n) => r.chance(n.activity === "sleep" ? 0.35 : 0.8));
      if (hearers.length > 0) {
        const sev = engine.emit({
          kind: "scream-heard",
          buildingId: scene.id,
          actorIds: [victim.id],
          witnessOverride: [],
          suppressMemories: true,
          summary: `A scream rang out from ${scene.name} at ${fmtClock(world.time)}`,
        });
        for (const hnpc of hearers) addMemory(hnpc, sev, "heard", 0.75);
      }
    }

    killer.stress = Math.min(1, killer.stress + 0.45);
    killer.mood = Math.max(-1, killer.mood - 0.3);

    // The alibi the killer will offer: their routine location for that hour.
    const usual = engine.predictTarget(killer, this.plan.murderTime);
    const usualB = buildingById(world, usual.buildingId);
    const h = hourOf(this.plan.murderTime);
    const daypart = h < 6 ? "night" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
    const alibiClaim =
      usual.buildingId === killer.homeId
        ? `I was home all ${daypart}. Ask anyone — I never go out ${h >= 21 || h < 6 ? "that late" : "at that hour"}.`
        : `I was at ${usualB.name}, same as always at that hour.`;

    world.crime = {
      killerId: killer.id,
      victimId: victim.id,
      motive: this.plan.motive,
      motiveEventIds: this.plan.motiveEventIds,
      motiveSummary: this.plan.motiveSummary,
      weaponItemId: weapon?.id ?? "",
      premeditated: this.plan.premeditated,
      woreGloves: this.plan.woreGloves,
      murderEventId: ev.id,
      murderTime: world.time,
      sceneBuildingId: scene.id,
      sceneRoomId: room.id,
      weaponDisposal: weapon ? this.plan.disposal : "left-at-scene",
      discoveryEventId: null,
      discoveredBy: null,
      discoveryTime: null,
      alibiClaim,
    };

    // Weapon handling after the act.
    if (weapon) {
      if (this.plan.disposal === "left-at-scene") {
        weapon.roomId = room.id;
        weapon.carrierId = null;
        if (!room.itemIds.includes(weapon.id)) room.itemIds.push(weapon.id);
      } else {
        weapon.carrierId = killer.id;
        weapon.roomId = null;
        if (!killer.inventoryIds.includes(weapon.id)) killer.inventoryIds.push(weapon.id);
        this.weaponItemId = weapon.id;
        if (this.plan.disposal === "hidden" && this.plan.disposalBuildingId) {
          this.waypoints = [
            { buildingId: this.plan.disposalBuildingId, purpose: "dispose", notBefore: world.time },
            { buildingId: killer.homeId, purpose: "go-home", notBefore: world.time },
          ];
        } else {
          this.waypoints = [{ buildingId: killer.homeId, purpose: "go-home", notBefore: world.time }];
        }
      }
    }
    if (this.plan.disposal === "left-at-scene" || !weapon) {
      this.waypoints = [{ buildingId: killer.homeId, purpose: "go-home", notBefore: world.time }];
    }
    // Taken-home: drop the weapon once home.
    log.info("crime", `MURDER at ${fmtTimeLong(world.time)}: ${ev.summary}`);
    this.status = "done";
    // Keep stepping for waypoints + discovery via director; status "done" means the kill happened.
  }

  private doDispose(engine: SimEngine, killer: Npc): void {
    const world = engine.world;
    if (!this.weaponItemId) return;
    const item = itemById(world, this.weaponItemId);
    const b = buildingById(world, killer.position.kind === "building" ? killer.position.buildingId : this.plan.disposalBuildingId!);
    const room =
      b.rooms.find((rm) => rm.name === "Trash area") ??
      b.rooms.find((rm) => rm.name === "Storage") ??
      b.rooms[b.rooms.length - 1]!;
    killer.inventoryIds = killer.inventoryIds.filter((x) => x !== item.id);
    item.carrierId = null;
    item.roomId = room.id;
    item.hiddenAt = `${room.name.toLowerCase()} of ${b.name}`;
    room.itemIds.push(item.id);
    engine.emit({
      kind: "drop-item", buildingId: b.id, roomId: room.id, actorIds: [killer.id], itemId: item.id,
      summary: `${fullName(killer)} discarded the ${item.name.toLowerCase()} in the ${room.name.toLowerCase()} of ${b.name}`,
    });
    if (world.crime) world.crime.weaponDisposal = "hidden";
  }

  /** After go-home with a taken-home weapon, stash it. */
  finalizeTakenHome(engine: SimEngine): void {
    const world = engine.world;
    if (this.plan.disposal !== "taken-home" || !this.weaponItemId || !world.crime) return;
    const item = itemById(world, this.weaponItemId);
    if (item.carrierId !== this.plan.killerId) return;
    const killer = world.npcs.find((n) => n.id === this.plan.killerId)!;
    if (killer.position.kind !== "building" || killer.position.buildingId !== killer.homeId) return;
    const home = buildingById(world, killer.homeId);
    const room = home.rooms.find((rm) => rm.name === "Kitchen") ?? home.rooms[0]!;
    killer.inventoryIds = killer.inventoryIds.filter((x) => x !== item.id);
    item.carrierId = null;
    item.roomId = room.id;
    room.itemIds.push(item.id);
  }

  // -------------------------------------------------------------- discovery

  private watchDiscovery(engine: SimEngine): void {
    const world = engine.world;
    const crime = world.crime;
    if (!crime || this.discoveryHandled) return;
    this.finalizeTakenHome(engine);

    const victim = world.npcs.find((n) => n.id === crime.victimId)!;
    const scene = buildingById(world, crime.sceneBuildingId);

    // 1) Natural discovery: anyone (except the killer) entering the scene.
    const visitors = engine
      .occupants(crime.sceneBuildingId)
      .filter((n) => n.id !== crime.killerId && n.alive);
    if (visitors.length > 0) {
      const discoverer = visitors[0]!;
      const ev = engine.emit({
        kind: "body-discovered",
        buildingId: scene.id,
        roomId: crime.sceneRoomId,
        actorIds: [discoverer.id],
        targetIds: [victim.id],
        summary: `${fullName(discoverer)} found ${fullName(victim)}'s body in the ${roomLabel(world, crime.sceneRoomId)} of ${scene.name}`,
      });
      crime.discoveryEventId = ev.id;
      crime.discoveredBy = discoverer.id;
      crime.discoveryTime = world.time;
      discoverer.stress = Math.min(1, discoverer.stress + 0.5);
      discoverer.scheduleOverride = null;
      // They call it in — to a police officer if the town has one.
      const officer = world.npcs.find((n) => n.alive && n.occupation === "police-officer");
      if (officer) {
        const callEv = engine.emit({
          kind: "phone-call", buildingId: scene.id, actorIds: [discoverer.id], targetIds: [officer.id],
          summary: `${fullName(discoverer)} called ${fullName(officer)} to report the body`,
        });
        world.phoneLog.push({ t: world.time, fromId: discoverer.id, toId: officer.id, durationMin: 4, eventId: callEv.id });
      }
      this.discoveryHandled = true;
      log.info("crime", `DISCOVERY at ${fmtTime(world.time)} by ${fullName(discoverer)}`);
      return;
    }

    // 2) Missed work → phone call → someone checks on them.
    if (!this.missedWorkEmitted && victim.workplaceId) {
      const target = engine.predictTarget(victim, world.time);
      if (target.activity === "work" && world.time > crime.murderTime + 60) {
        const shiftStart = world.time - 60;
        void shiftStart;
        this.missedWorkEmitted = true;
        const workplace = buildingById(world, victim.workplaceId);
        const coworker = workplace.employeeIds
          .map((id) => world.npcs.find((n) => n.id === id)!)
          .find((n) => n && n.alive && n.id !== victim.id);
        const mev = engine.emit({
          kind: "missed-work", buildingId: victim.workplaceId, actorIds: [victim.id],
          witnessOverride: workplace.employeeIds.filter((id) => id !== victim.id),
          summary: `${fullName(victim)} did not show up for work at ${workplace.name}`,
        });
        void mev;
        if (coworker) {
          const cev = engine.emit({
            kind: "phone-call", buildingId: victim.workplaceId, actorIds: [coworker.id], targetIds: [victim.id],
            summary: `${fullName(coworker)} called ${fullName(victim)} — no answer`,
          });
          world.phoneLog.push({ t: world.time, fromId: coworker.id, toId: victim.id, durationMin: 0, eventId: cev.id });
        }
      }
    }

    // 3) Dispatch a checker to the victim's home a few hours after the murder.
    const hoursSince = (world.time - crime.murderTime) / 60;
    if (!this.checkerDispatched && hoursSince >= 5 && hourOf(world.time) >= 8 && hourOf(world.time) <= 21) {
      const checker = closestContact(world, victim, crime.killerId);
      if (checker) {
        this.checkerDispatched = true;
        checker.scheduleOverride = {
          buildingId: victim.homeId, until: world.time + 240, activity: "errand",
        };
        log.debug("crime", `${fullName(checker)} is going to check on ${fullName(victim)}`);
      }
    }
    // 4) Failsafe: they search the victim's haunts (which include the scene).
    if (!this.searchDispatched && hoursSince >= 18 && hourOf(world.time) >= 8 && hourOf(world.time) <= 21) {
      const searcher = closestContact(world, victim, crime.killerId);
      if (searcher) {
        this.searchDispatched = true;
        searcher.scheduleOverride = {
          buildingId: crime.sceneBuildingId, until: world.time + 240, activity: "errand",
        };
        log.debug("crime", `${fullName(searcher)} is searching ${fullName(victim)}'s usual places`);
      }
    }
  }

  get discovered(): boolean {
    return this.discoveryHandled;
  }
}

function roomLabel(world: World, roomId: RoomId): string {
  return roomById(world, roomId).name.toLowerCase();
}

/** Occupied buildings whose lots sit within `radius` cells of a point. */
function neighborsWithin(world: World, x: number, y: number, radius: number): Npc[] {
  const out: Npc[] = [];
  for (const b of world.city.buildings) {
    const cx = b.lot.x + b.lot.w / 2;
    const cy = b.lot.y + b.lot.h / 2;
    if (Math.abs(cx - x) > radius || Math.abs(cy - y) > radius) continue;
    for (const n of world.npcs) {
      if (n.alive && n.position.kind === "building" && n.position.buildingId === b.id) out.push(n);
    }
  }
  return out;
}

/** Who would go looking for this person? Partner > household > best friend > coworker. */
function closestContact(world: World, victim: Npc, excludeId: string): Npc | null {
  const candidates = world.npcs.filter((n) => n.alive && n.id !== victim.id && n.id !== excludeId);
  if (victim.partnerId) {
    const p = candidates.find((n) => n.id === victim.partnerId);
    if (p) return p;
  }
  const household = candidates.filter((n) => n.householdId === victim.householdId);
  if (household.length > 0) return household[0]!;
  const byFriendship = candidates
    .filter((n) => (n.relationships[victim.id]?.friendship ?? 0) > 0.3)
    .sort((a, b) => (b.relationships[victim.id]?.friendship ?? 0) - (a.relationships[victim.id]?.friendship ?? 0));
  if (byFriendship.length > 0) return byFriendship[0]!;
  if (victim.workplaceId) {
    const wp = buildingById(world, victim.workplaceId);
    const cw = candidates.find((n) => wp.employeeIds.includes(n.id));
    if (cw) return cw;
  }
  return candidates[0] ?? null;
}
