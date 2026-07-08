/**
 * Simulation engine.
 *
 * Advances the world in 10-minute ticks: schedule resolution, street travel
 * with real paths (so people can be seen en route), co-location interactions,
 * phone calls, purchases, salaries/rent, memory decay, and record-keeping
 * (camera, phone, financial). Every observable fact is emitted as a SimEvent
 * through emit(), which also computes witnesses and writes memories — the
 * single choke point that guarantees provenance.
 */

import { Rng, hashString } from "../core/rng";
import { EventBus } from "../core/events";
import { log } from "../core/log";
import {
  MINUTES_PER_DAY, TICK_MINUTES, dayOf, isNight, minuteOfDay, fmtTime,
  type SimTime,
} from "../core/time";
import type {
  Building, BuildingId, EventId, Npc, NpcId, Secret, SecretId, SimEvent, World,
} from "../world/types";
import { buildingById, fullName, relationshipBetween } from "../world/types";
import { roadPath } from "../world/citygen";
import { addMemory, decayMemories, witnessPerceives } from "./memory";
import { tryInteraction } from "./interactions";

export interface SimBusEvents extends Record<string, unknown> {
  "sim:tick": { t: SimTime };
  "sim:event": SimEvent;
}

export interface EmitSpec {
  kind: SimEvent["kind"];
  buildingId?: BuildingId | null;
  roomId?: string | null;
  streetName?: string | null;
  actorIds: NpcId[];
  targetIds?: NpcId[];
  itemId?: string | null;
  amount?: number | null;
  summary: string;
  /** Skip automatic witness computation and use exactly these. */
  witnessOverride?: NpcId[];
  /** Don't write memories (used for bookkeeping events like salary). */
  suppressMemories?: boolean;
}

export class SimEngine {
  readonly world: World;
  readonly bus: EventBus<SimBusEvents>;
  /** Duplicate-suppression for street sightings (transient; safe to lose). */
  private recentSightings = new Map<string, SimTime>();
  /** Rolling tick durations in ms for the profiler (transient). */
  private tickTimes: number[] = [];

  constructor(world: World, bus?: EventBus<SimBusEvents>) {
    this.world = world;
    this.bus = bus ?? new EventBus<SimBusEvents>();
  }

  /** Deterministic stream for a given purpose at the current tick. */
  private tickRng(label: string): Rng {
    return new Rng((this.world.seed ^ hashString(`${label}@${this.world.time}`)) >>> 0);
  }

  occupants(buildingId: BuildingId): Npc[] {
    return this.world.npcs.filter(
      (n) => n.alive && n.position.kind === "building" && n.position.buildingId === buildingId
    );
  }

  // ------------------------------------------------------------------ emit

  emit(spec: EmitSpec): SimEvent {
    const world = this.world;
    const ev: SimEvent = {
      id: `ev:${world.nextIds.event++}`,
      t: world.time,
      kind: spec.kind,
      buildingId: spec.buildingId ?? null,
      roomId: spec.roomId ?? null,
      streetName: spec.streetName ?? null,
      actorIds: spec.actorIds,
      targetIds: spec.targetIds ?? [],
      itemId: spec.itemId ?? null,
      amount: spec.amount ?? null,
      witnessIds: [],
      summary: spec.summary,
    };

    // Witnesses: bystanders in the same building, rolled for perception.
    if (spec.witnessOverride) {
      ev.witnessIds = spec.witnessOverride;
    } else if (ev.buildingId) {
      const involved = new Set([...ev.actorIds, ...ev.targetIds]);
      const b = buildingById(world, ev.buildingId);
      const r = this.tickRng(`wit:${ev.id}`);
      ev.witnessIds = this.occupants(ev.buildingId)
        .filter((n) => !involved.has(n.id))
        .filter((n) => witnessPerceives(n, ev.kind, isNight(ev.t) ? b.lightLevel * 0.6 : b.lightLevel, r.float()))
        .map((n) => n.id);
    }

    world.eventLog.push(ev);

    if (!spec.suppressMemories) {
      for (const id of new Set([...ev.actorIds, ...ev.targetIds])) {
        const n = world.npcs.find((x) => x.id === id);
        if (n && n.alive) addMemory(n, ev, "participant");
      }
      for (const id of ev.witnessIds) {
        const n = world.npcs.find((x) => x.id === id);
        if (n && n.alive) addMemory(n, ev, "witness");
        if (n) this.witnessReactions(n, ev);
      }
    }

    this.bus.emit("sim:event", ev);
    return ev;
  }

  /** Emotional / knowledge side-effects of seeing something happen. */
  private witnessReactions(w: Npc, ev: SimEvent): void {
    const world = this.world;
    if (ev.kind === "flirt" || ev.kind === "affair-meeting") {
      const [actorId] = ev.actorIds;
      const [targetId] = ev.targetIds;
      if (!actorId || !targetId) return;
      // A partner watching their partner flirt: jealousy, anger.
      for (const [pId, otherId] of [[actorId, targetId], [targetId, actorId]] as const) {
        if (w.partnerId === pId) {
          const relToPartner = relationshipBetween(w, pId);
          relToPartner.jealousy = Math.min(1, relToPartner.jealousy + 0.3);
          relToPartner.trust = Math.max(0, relToPartner.trust - 0.15);
          const relToRival = relationshipBetween(w, otherId);
          relToRival.friendship = Math.max(-1, relToRival.friendship - 0.25);
          relToRival.jealousy = Math.min(1, relToRival.jealousy + 0.25);
          w.mood = Math.max(-1, w.mood - 0.2);
          w.stress = Math.min(1, w.stress + 0.15);
        }
      }
      // Witness of an affair meeting learns the secret.
      if (ev.kind === "affair-meeting") {
        for (const s of Object.values(world.secrets)) {
          if (s.kind === "affair" && ev.actorIds.includes(s.holderId) && s.otherId && ev.targetIds.includes(s.otherId)) {
            if (!s.knownBy.includes(w.id)) s.knownBy.push(w.id);
          }
        }
      }
    }
    if (ev.kind === "theft") {
      const thiefId = ev.actorIds[0];
      if (thiefId) {
        const rel = relationshipBetween(w, thiefId);
        rel.friendship = Math.max(-1, rel.friendship - 0.2);
        rel.trust = Math.max(0, rel.trust - 0.3);
        // Seeing a theft creates knowledge of the thief's secret.
        for (const s of Object.values(world.secrets)) {
          if (s.kind === "theft" && s.holderId === thiefId && !s.knownBy.includes(w.id)) s.knownBy.push(w.id);
        }
      }
    }
  }

  mintSecret(partial: Omit<Secret, "id" | "knownBy"> & { knownBy?: NpcId[] }): SecretId {
    const id: SecretId = `sec:${this.world.nextIds.secret++}`;
    this.world.secrets[id] = { ...partial, id, knownBy: partial.knownBy ?? [] };
    const holder = this.world.npcs.find((n) => n.id === partial.holderId);
    if (holder) holder.secretIds.push(id);
    return id;
  }

  /** Money movement with a financial record (and cash update). */
  transfer(from: Npc | null, to: Npc | null, amount: number, memo: string, buildingId: BuildingId | null, eventId?: EventId): void {
    if (from) from.cash -= amount;
    if (to) to.cash += amount;
    let eid = eventId;
    if (!eid) {
      const ev = this.emit({
        kind: "purchase",
        buildingId,
        actorIds: from ? [from.id] : to ? [to.id] : [],
        targetIds: to && from ? [to.id] : [],
        amount,
        summary: from && to
          ? `${fullName(from)} paid ${fullName(to)} $${amount} (${memo})`
          : from
            ? `${fullName(from)} paid $${amount} (${memo})`
            : `${to ? fullName(to) : "?"} received $${amount} (${memo})`,
        suppressMemories: true,
      });
      eid = ev.id;
    }
    this.world.transactions.push({
      t: this.world.time, fromId: from?.id ?? null, toId: to?.id ?? null,
      amount, memo, buildingId, eventId: eid,
    });
  }

  // ------------------------------------------------------- schedule / movement

  /**
   * Where does this NPC's schedule put them at time t?
   * Pure and deterministic — the crime planner uses it to predict the future.
   */
  predictTarget(npc: Npc, t: SimTime): { buildingId: BuildingId; activity: Npc["activity"] } {
    const day = dayOf(t) % 7;
    const mod = minuteOfDay(t);
    for (let i = 0; i < npc.schedule.length; i++) {
      const block = npc.schedule[i]!;
      if (!block.days.includes(day)) continue;
      if (mod < block.startMin || mod >= block.endMin) continue;
      if (block.buildingId) {
        return { buildingId: block.buildingId, activity: block.kind };
      }
      // Dynamic destination: deterministic per (npc, calendar day, block).
      const r = new Rng((this.world.seed ^ hashString(`dyn:${npc.id}:${dayOf(t)}:${i}`)) >>> 0);
      const dest = this.resolveDynamicDestination(npc, t, r);
      return { buildingId: dest, activity: block.kind };
    }
    return { buildingId: npc.homeId, activity: "home" };
  }

  private resolveDynamicDestination(npc: Npc, t: SimTime, r: Rng): BuildingId {
    const world = this.world;
    // Friend visit (40%) or an open venue (60%).
    const friends = world.npcs.filter((o) => {
      if (o.id === npc.id || !o.alive || o.householdId === npc.householdId) return false;
      const rel = npc.relationships[o.id];
      return rel !== undefined && rel.friendship > 0.4;
    });
    if (friends.length > 0 && r.chance(0.4)) {
      return r.pick(friends).homeId;
    }
    const mod = minuteOfDay(t);
    const open = world.city.buildings.filter((b) => {
      if (!["bar", "cafe", "restaurant", "park"].includes(b.type)) return false;
      return this.isOpenAt(b, mod);
    });
    if (open.length > 0) return r.pick(open).id;
    return npc.homeId;
  }

  isOpenAt(b: Building, mod: number): boolean {
    if (b.closeMin > 1440) return mod >= b.openMin || mod < b.closeMin - 1440;
    return mod >= b.openMin && mod < b.closeMin;
  }

  /** Begin travel toward a building (emits depart + camera log). */
  startTravel(npc: Npc, toBuildingId: BuildingId): void {
    const world = this.world;
    if (npc.position.kind !== "building") return;
    const from = buildingById(world, npc.position.buildingId);
    const to = buildingById(world, toBuildingId);
    if (from.id === to.id) return;

    const departEv = this.emit({
      kind: "depart", buildingId: from.id, actorIds: [npc.id],
      summary: `${fullName(npc)} left ${from.name}`,
    });
    if (from.hasCamera) {
      world.cameraLog.push({ t: world.time, buildingId: from.id, npcId: npc.id, direction: "out", eventId: departEv.id });
    }
    this.nosyNeighborWitness(departEv, from.id);
    const path = roadPath(world.city, from.door, to.door);
    npc.position = { kind: "street", x: from.door.x, y: from.door.y, toBuildingId, path, step: 0 };
  }

  private arrive(npc: Npc, buildingId: BuildingId): void {
    const world = this.world;
    const b = buildingById(world, buildingId);
    npc.position = { kind: "building", buildingId, roomId: null };
    const ev = this.emit({
      kind: "arrive", buildingId, actorIds: [npc.id],
      summary: `${fullName(npc)} arrived at ${b.name}`,
    });
    if (b.hasCamera) {
      world.cameraLog.push({ t: world.time, buildingId, npcId: npc.id, direction: "in", eventId: ev.id });
    }
    this.nosyNeighborWitness(ev, buildingId);
  }

  /**
   * Curtain-twitchers: people in adjacent homes sometimes notice comings and
   * goings next door. This is the believable origin of "I saw him go in
   * around six" testimony — crucial placement evidence for quiet murders.
   */
  private nosyNeighborWitness(ev: SimEvent, buildingId: BuildingId): void {
    const world = this.world;
    const b = buildingById(world, buildingId);
    const r = this.tickRng(`nosy:${ev.id}`);
    const night = isNight(world.time);
    const cx = b.lot.x + b.lot.w / 2;
    const cy = b.lot.y + b.lot.h / 2;
    let witnesses = 0;
    for (const nb of world.city.buildings) {
      if (nb.id === buildingId) continue;
      if (nb.type !== "house" && nb.type !== "apartment") continue;
      const nx = nb.lot.x + nb.lot.w / 2;
      const ny = nb.lot.y + nb.lot.h / 2;
      if (Math.abs(nx - cx) > 4 || Math.abs(ny - cy) > 4) continue;
      for (const n of this.occupants(nb.id)) {
        if (ev.actorIds.includes(n.id) || witnesses >= 2) continue;
        if (n.activity === "sleep") continue;
        const p = (0.04 + n.personality.curiosity * 0.1) * (night ? 0.45 : 1);
        if (!r.chance(p)) continue;
        addMemory(n, ev, "witness", 0.4);
        witnesses++;
      }
    }
  }

  // ------------------------------------------------------------------- tick

  /** Profiler snapshot over the recent tick window. */
  perfStats(): { ticks: number; avgMs: number; maxMs: number } {
    const n = this.tickTimes.length;
    if (n === 0) return { ticks: 0, avgMs: 0, maxMs: 0 };
    const sum = this.tickTimes.reduce((s, x) => s + x, 0);
    return { ticks: n, avgMs: sum / n, maxMs: Math.max(...this.tickTimes) };
  }

  tick(): void {
    const tickStart = performance.now();
    const world = this.world;
    world.time += TICK_MINUTES;
    const t = world.time;
    const mod = minuteOfDay(t);

    // Housekeeping at 04:00: memory decay, mood/stress drift.
    if (mod === 240) {
      decayMemories(world);
      for (const n of world.npcs) {
        if (!n.alive) continue;
        n.stress = Math.max(0, n.stress * 0.88);
        n.mood *= 0.8;
      }
    }
    // Salaries: Friday 17:00.
    if (dayOf(t) % 7 === 4 && mod === 1020) {
      for (const n of world.npcs) {
        if (!n.alive || n.income <= 0) continue;
        this.transfer(null, n, n.income, `weekly wages — ${n.occupation}`, null);
      }
    }
    // Rent: Monday 09:00, apartment households pay the landlord.
    if (dayOf(t) % 7 === 0 && mod === 540) {
      for (const b of world.city.buildings) {
        if (b.type !== "apartment" || !b.ownerId) continue;
        const landlord = world.npcs.find((n) => n.id === b.ownerId);
        if (!landlord) continue;
        const paidHouseholds = new Set<number>();
        for (const rid of b.residentIds) {
          const n = world.npcs.find((x) => x.id === rid);
          if (!n || !n.alive || paidHouseholds.has(n.householdId)) continue;
          paidHouseholds.add(n.householdId);
          this.transfer(n, landlord, 180, "monthly-prorated rent", b.id);
        }
      }
    }

    // Movement.
    for (const npc of world.npcs) {
      if (!npc.alive) continue;
      if (npc.position.kind === "street") {
        const pos = npc.position;
        pos.step += npc.walkingSpeed;
        if (pos.step >= pos.path.length - 1) {
          this.arrive(npc, pos.toBuildingId);
        } else {
          const cell = pos.path[pos.step]!;
          pos.x = cell.x;
          pos.y = cell.y;
        }
      } else {
        if (npc.scheduleOverride && t >= npc.scheduleOverride.until) npc.scheduleOverride = null;
        const target = npc.scheduleOverride
          ? { buildingId: npc.scheduleOverride.buildingId, activity: npc.scheduleOverride.activity }
          : this.predictTarget(npc, t);
        npc.activity = target.activity;
        if (npc.position.buildingId !== target.buildingId) {
          this.startTravel(npc, target.buildingId);
        }
      }
    }

    // Street sightings between travellers.
    this.streetSightings();

    // Interactions inside buildings.
    const byBuilding = new Map<BuildingId, Npc[]>();
    for (const npc of world.npcs) {
      if (!npc.alive || npc.position.kind !== "building") continue;
      const arr = byBuilding.get(npc.position.buildingId) ?? [];
      arr.push(npc);
      byBuilding.set(npc.position.buildingId, arr);
    }
    for (const [bid, group] of byBuilding) {
      if (group.length < 2) continue;
      const venue = buildingById(world, bid);
      const r = this.tickRng(`int:${bid}`);
      for (const a of group) {
        if (a.activity === "sleep") continue;
        const others = group.filter((o) => o.id !== a.id && o.activity !== "sleep");
        if (others.length === 0) continue;
        const b = r.pick(others);
        tryInteraction(this, a, b, venue, r.stream(`pair:${a.id}`));
      }
    }

    // Evening phone calls.
    if (mod >= 1080 && mod <= 1290) {
      const r = this.tickRng("calls");
      for (const npc of world.npcs) {
        if (!npc.alive || npc.activity === "sleep" || npc.phoneContactIds.length === 0) continue;
        if (!r.chance(0.035)) continue;
        const calleeId = r.pick(npc.phoneContactIds);
        const callee = world.npcs.find((n) => n.id === calleeId);
        if (!callee || !callee.alive || callee.activity === "sleep") continue;
        // Don't phone someone standing next to you.
        if (
          callee.position.kind === "building" && npc.position.kind === "building" &&
          callee.position.buildingId === npc.position.buildingId
        ) continue;
        const duration = r.int(2, 18);
        const ev = this.emit({
          kind: "phone-call",
          buildingId: npc.position.kind === "building" ? npc.position.buildingId : null,
          actorIds: [npc.id], targetIds: [callee.id],
          summary: `${fullName(npc)} called ${fullName(callee)} (${duration} min)`,
        });
        world.phoneLog.push({ t, fromId: npc.id, toId: callee.id, durationMin: duration, eventId: ev.id });
        addMemory(callee, ev, "participant");
      }
    }

    // Purchases at commercial venues.
    const pr = this.tickRng("purch");
    for (const npc of world.npcs) {
      if (!npc.alive || npc.position.kind !== "building") continue;
      const b = buildingById(world, npc.position.buildingId);
      if (!["store", "cafe", "restaurant", "bar"].includes(b.type)) continue;
      if (npc.workplaceId === b.id) continue; // staff don't buy from themselves
      if (!this.isOpenAt(b, mod) || !pr.chance(0.07)) continue;
      const owner = b.ownerId ? world.npcs.find((n) => n.id === b.ownerId) ?? null : null;
      const amount = b.type === "store" ? pr.int(8, 60) : b.type === "bar" ? pr.int(9, 35) : pr.int(6, 45);
      this.transfer(npc, owner, amount, `purchase at ${b.name}`, b.id);
    }

    this.bus.emit("sim:tick", { t });
    this.tickTimes.push(performance.now() - tickStart);
    if (this.tickTimes.length > 500) this.tickTimes.splice(0, this.tickTimes.length - 500);
  }

  private streetSightings(): void {
    const world = this.world;
    const travellers = world.npcs.filter((n) => n.alive && n.position.kind === "street");
    if (travellers.length < 2) return;
    const r = this.tickRng("sight");
    const night = isNight(world.time);
    for (const seer of travellers) {
      for (const seen of travellers) {
        if (seer.id === seen.id) continue;
        const sp = seer.position, np = seen.position;
        if (sp.kind !== "street" || np.kind !== "street") continue;
        const dist = Math.max(Math.abs(sp.x - np.x), Math.abs(sp.y - np.y));
        if (dist > 2) continue;
        const key = `${seer.id}>${seen.id}`;
        const last = this.recentSightings.get(key);
        if (last !== undefined && world.time - last < 90) continue;
        const p = (0.3 + seer.personality.curiosity * 0.4) * (night ? 0.5 : 1);
        if (!r.chance(p)) continue;
        this.recentSightings.set(key, world.time);
        const street = world.city.roads.get(`${np.x},${np.y}`)?.streetName ?? "the street";
        const toward = buildingById(world, np.toBuildingId);
        const ev = this.emit({
          kind: "sighting",
          streetName: street,
          actorIds: [seer.id], targetIds: [seen.id],
          witnessOverride: [],
          suppressMemories: true,
          summary: `${fullName(seer)} saw ${fullName(seen)} on ${street}, heading toward ${toward.name}`,
        });
        addMemory(seer, ev, "participant", night ? 0.5 : 0.7);
      }
    }
  }

  /** Run the sim forward to an absolute time. */
  runUntil(t: SimTime, onTick?: (engine: SimEngine) => void): void {
    let guard = 0;
    const maxTicks = Math.ceil((t - this.world.time) / TICK_MINUTES) + 2;
    while (this.world.time < t) {
      this.tick();
      onTick?.(this);
      if (++guard > maxTicks + MINUTES_PER_DAY) {
        log.error("engine", `runUntil guard tripped at ${fmtTime(this.world.time)}`);
        break;
      }
    }
  }
}
