/**
 * Killer counter-play during the investigation.
 *
 * Detective actions that touch the killer build PRESSURE. A pressured
 * killer acts by temperament — wipe the weapon, move it somewhere deeper,
 * lean on the witness they remember seeing them, or compulsively revisit
 * the scene. Every action runs through the same movement/event machinery as
 * everything else, so counter-play destroys some evidence while honestly
 * creating more: fresh prints, wipe marks, camera hits, street sightings,
 * intimidation memories.
 *
 * The killer acts on what THEY know (who was around that night, where they
 * left the weapon) — never on the player's case file.
 */

import { Rng, hashString } from "../core/rng";
import { log } from "../core/log";
import { dayOf, fmtClock, fmtTimeLong, hourOf } from "../core/time";
import type { SimEngine } from "../sim/engine";
import type { EventId, Item, Npc, NpcId, World } from "../world/types";
import { buildingById, fullName, itemById, relationshipBetween, roomById } from "../world/types";
import { difficultyOf } from "../world/difficulty";
import { addMemory } from "../sim/memory";

export type PressureSource =
  | "interviewed"
  | "confronted"
  | "records-pulled"
  | "home-searched"
  | "contradicted";

const PRESSURE_WEIGHT: Record<PressureSource, number> = {
  "interviewed": 1,
  "confronted": 3,
  "records-pulled": 2,
  "home-searched": 4,
  "contradicted": 3,
};

/**
 * Pressure needed before the killer risks doing anything at all. A routine
 * town canvass (a few interviews) stays below it; targeted pressure —
 * records pulls, confrontations, a home search — crosses it.
 */
const ACT_THRESHOLD = 4;

type TamperPlan =
  | { kind: "wipe-weapon"; itemId: string }
  | { kind: "move-weapon"; itemId: string; toBuildingId: string }
  | { kind: "stash"; itemId: string; toBuildingId: string } // phase 2 of move-weapon
  | { kind: "intimidate"; witnessId: NpcId; dangerousEventId: EventId }
  | { kind: "revisit-scene" };

export class CoverupDirector {
  private readonly world: World;
  private plan: TamperPlan | null = null;

  constructor(world: World) {
    this.world = world;
    const crime = world.crime;
    if (crime) {
      crime.pressure ??= 0;
      crime.coverup ??= {
        movedWeapon: false, wipedWeapon: false,
        intimidatedId: null, intimidationEventId: null,
        revisitedScene: false, lastActionDay: -1,
      };
    }
  }

  /** The detective did something the killer would hear about or feel. */
  notePressure(source: PressureSource): void {
    const crime = this.world.crime;
    if (!crime) return;
    crime.pressure = (crime.pressure ?? 0) + PRESSURE_WEIGHT[source];
    log.debug("coverup", `killer pressure +${PRESSURE_WEIGHT[source]} (${source}) → ${crime.pressure}`);
  }

  /** Called after each engine tick while the investigation runs. */
  step(engine: SimEngine): void {
    const world = this.world;
    const crime = world.crime;
    if (!crime || !crime.coverup) return;
    const killer = world.npcs.find((n) => n.id === crime.killerId);
    if (!killer || !killer.alive) return;

    if (this.plan) {
      this.executePlan(engine, killer);
      return;
    }

    // Consider a new action: pressured, awake, at most one action per day.
    if ((crime.pressure ?? 0) < ACT_THRESHOLD) return;
    if (killer.activity === "sleep" || killer.position.kind !== "building") return;
    const day = dayOf(world.time);
    if (crime.coverup.lastActionDay === day) return;
    // Tampering happens in the quiet hours: early morning or late evening.
    const h = hourOf(world.time);
    if (h >= 8 && h <= 20) return;

    const r = new Rng((world.seed ^ hashString(`coverup:${world.time}`)) >>> 0);
    const p = killer.personality;
    // Nerve check: fearful killers act; confident ones sit tight. A more
    // competent killer (difficulty) is more decisive about covering up.
    const competence = difficultyOf(world).killerCompetence;
    const nerve = 0.15 + p.fearfulness * 0.6 - p.confidence * 0.3 + Math.min(0.3, (crime.pressure ?? 0) * 0.02) + competence * 0.3;
    if (!r.chance(Math.max(0.05, nerve))) return;

    this.plan = this.choosePlan(r, killer);
    if (this.plan) {
      crime.coverup.lastActionDay = day;
      log.info("coverup", `Killer is acting: ${this.plan.kind} (pressure ${crime.pressure})`);
    }
  }

  // ------------------------------------------------------------- planning

  private choosePlan(r: Rng, killer: Npc): TamperPlan | null {
    const world = this.world;
    const crime = world.crime!;
    const cover = crime.coverup!;
    const p = killer.personality;
    const options: Array<[TamperPlan, number]> = [];

    // Weapon still out there, reachable, and carrying their prints?
    const weapon = crime.weaponItemId ? world.items[crime.weaponItemId] : null;
    const weaponAccessible = weapon && weapon.roomId !== null && weapon.carrierId === null;
    if (weapon && weaponAccessible) {
      const hasTheirPrints = weapon.fingerprints.some((f) => f.npcId === killer.id);
      if (hasTheirPrints && !cover.wipedWeapon) {
        options.push([{ kind: "wipe-weapon", itemId: weapon.id }, 1.2 + p.fearfulness * 0.5]);
      }
      if (!cover.movedWeapon && crime.weaponDisposal !== "left-at-scene") {
        const spots = world.city.buildings.filter(
          (b) => (b.type === "park" || b.type === "warehouse") && !this.itemIsIn(weapon, b.id)
        );
        if (spots.length > 0) {
          options.push([
            { kind: "move-weapon", itemId: weapon.id, toBuildingId: r.pick(spots).id },
            0.8 + p.fearfulness * 0.4,
          ]);
        }
      }
    }

    // A witness the killer REMEMBERS being around that night.
    if (!cover.intimidatedId && p.aggression > 0.4) {
      const dangerous = this.dangerousWitness(killer);
      if (dangerous) {
        options.push([
          { kind: "intimidate", witnessId: dangerous.witnessId, dangerousEventId: dangerous.eventId },
          0.6 + p.aggression * 0.7,
        ]);
      }
    }

    // The compulsion to look at it again.
    if (!cover.revisitedScene && p.curiosity > 0.5 && p.confidence < 0.5) {
      options.push([{ kind: "revisit-scene" }, 0.35]);
    }

    if (options.length === 0) return null;
    return r.weighted(options);
  }

  private itemIsIn(item: Item, buildingId: string): boolean {
    if (!item.roomId) return false;
    return roomById(this.world, item.roomId).buildingId === buildingId;
  }

  /**
   * Who does the killer remember seeing them near the murder? Witnesses of
   * their own arrive/depart events around the window — knowledge the killer
   * genuinely has (they were there; witness lists are who noticed them).
   */
  private dangerousWitness(killer: Npc): { witnessId: NpcId; eventId: EventId } | null {
    const world = this.world;
    const crime = world.crime!;
    const wFrom = crime.murderTime - 120;
    const wTo = crime.murderTime + 120;
    const risky = world.eventLog.filter(
      (e) =>
        e.t >= wFrom && e.t <= wTo &&
        (e.kind === "arrive" || e.kind === "depart" || e.kind === "sighting") &&
        (e.actorIds[0] === killer.id || (e.kind === "sighting" && e.targetIds[0] === killer.id))
    );
    for (const e of risky) {
      const witnesses = e.kind === "sighting" ? e.actorIds : e.witnessIds;
      const w = witnesses.find((id) => {
        const n = world.npcs.find((x) => x.id === id);
        return n !== undefined && n.alive && id !== killer.id;
      });
      if (w) return { witnessId: w, eventId: e.id };
    }
    return null;
  }

  // ------------------------------------------------------------ execution

  private executePlan(engine: SimEngine, killer: Npc): void {
    const plan = this.plan!;
    const world = this.world;
    const crime = world.crime!;
    const cover = crime.coverup!;

    const target =
      plan.kind === "wipe-weapon" ? this.buildingOfItem(plan.itemId) :
      plan.kind === "move-weapon" ? this.buildingOfItem(plan.itemId) :
      plan.kind === "stash" ? plan.toBuildingId :
      plan.kind === "intimidate" ? this.currentBuildingOf(plan.witnessId) :
      crime.sceneBuildingId;
    if (!target) { this.plan = null; return; }

    if (killer.position.kind === "street") return; // in transit
    if (killer.position.buildingId !== target) {
      killer.scheduleOverride = { buildingId: target, until: world.time + 300, activity: "errand" };
      return;
    }

    const r = new Rng((world.seed ^ hashString(`coverup-exec:${world.time}`)) >>> 0);
    switch (plan.kind) {
      case "wipe-weapon": {
        const item = itemById(world, plan.itemId);
        const room = item.roomId ? roomById(world, item.roomId) : null;
        const ev = engine.emit({
          kind: "wipe-item",
          buildingId: target, roomId: room?.id ?? null,
          actorIds: [killer.id], itemId: item.id,
          summary: `${fullName(killer)} wiped the ${item.name.toLowerCase()} clean of prints`,
        });
        item.fingerprints = [];
        item.wipedAt = world.time;
        item.wipedEventId = ev.id;
        // Panic makes people careless: sometimes the wipe leaves one fresh
        // print. Competent killers (difficulty) fumble less.
        const panicPrint = Math.max(0.05, 0.3 - difficultyOf(world).killerCompetence * 0.5);
        if (r.chance(panicPrint)) {
          item.fingerprints.push({ npcId: killer.id, t: world.time, eventId: ev.id });
        }
        cover.wipedWeapon = true;
        break;
      }
      case "move-weapon": {
        const item = itemById(world, plan.itemId);
        if (item.roomId) {
          const fromRoom = roomById(world, item.roomId);
          fromRoom.itemIds = fromRoom.itemIds.filter((x) => x !== item.id);
          engine.emit({
            kind: "take-item", buildingId: fromRoom.buildingId, roomId: fromRoom.id,
            actorIds: [killer.id], itemId: item.id,
            summary: `${fullName(killer)} retrieved the ${item.name.toLowerCase()} from ${buildingById(world, fromRoom.buildingId).name}`,
          });
          item.roomId = null;
          item.carrierId = killer.id;
          killer.inventoryIds.push(item.id);
          // Handling it again deposits prints unless they think to glove up.
          if (r.chance(0.5)) {
            const takeEv = world.eventLog[world.eventLog.length - 1]!;
            item.fingerprints.push({ npcId: killer.id, t: world.time, eventId: takeEv.id });
          }
          // Now walk it to the new spot.
          this.plan = { kind: "stash", toBuildingId: plan.toBuildingId, itemId: item.id };
          killer.scheduleOverride = { buildingId: plan.toBuildingId, until: world.time + 300, activity: "errand" };
          return;
        }
        this.plan = null;
        return;
      }
      case "intimidate": {
        const witness = world.npcs.find((n) => n.id === plan.witnessId)!;
        const ev = engine.emit({
          kind: "intimidation",
          buildingId: target,
          actorIds: [killer.id], targetIds: [witness.id],
          summary: `${fullName(killer)} cornered ${fullName(witness)} and warned them to forget what they saw`,
        });
        const relWK = relationshipBetween(witness, killer.id);
        relWK.fear = Math.min(1, relWK.fear + 0.5);
        relWK.friendship = Math.max(-1, relWK.friendship - 0.3);
        witness.stress = Math.min(1, witness.stress + 0.3);
        addMemory(witness, ev, "participant", 0.95);
        cover.intimidatedId = witness.id;
        cover.intimidationEventId = ev.id;
        break;
      }
      case "revisit-scene": {
        // The visit itself is the mistake — arrive/depart, cameras, and
        // nosy neighbors do the rest through the normal machinery.
        cover.revisitedScene = true;
        break;
      }
      case "stash": {
        const item = itemById(world, plan.itemId);
        const b = buildingById(world, plan.toBuildingId);
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
          kind: "drop-item", buildingId: b.id, roomId: room.id,
          actorIds: [killer.id], itemId: item.id,
          summary: `${fullName(killer)} re-hid the ${item.name.toLowerCase()} in the ${room.name.toLowerCase()} of ${b.name}`,
        });
        cover.movedWeapon = true;
        break;
      }
    }
    // Done — go home and resume normal life.
    killer.scheduleOverride = { buildingId: killer.homeId, until: world.time + 240, activity: "home" };
    this.plan = null;
    log.info("coverup", `Tampering complete at ${fmtTimeLong(world.time)} (${fmtClock(world.time)})`);
  }

  private buildingOfItem(itemId: string): string | null {
    const item = this.world.items[itemId];
    if (!item || !item.roomId) return null;
    return roomById(this.world, item.roomId).buildingId;
  }

  private currentBuildingOf(npcId: NpcId): string | null {
    const n = this.world.npcs.find((x) => x.id === npcId);
    if (!n || !n.alive) return null;
    return n.position.kind === "building" ? n.position.buildingId : n.position.toBuildingId;
  }
}
