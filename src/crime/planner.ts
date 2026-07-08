/**
 * Crime planning.
 *
 * The murderer is not chosen by a script — motives are scored from the
 * actual relationship graph, secrets, finances, and the event log. Every
 * candidate motive cites the real events that built it. Opportunity comes
 * from predicting genuine schedules; the weapon must already exist somewhere
 * the killer can plausibly get it.
 */

import { Rng, hashString } from "../core/rng";
import { log } from "../core/log";
import { TICK_MINUTES, fmtTimeLong, hourOf, isNight, type SimTime } from "../core/time";
import type { SimEngine } from "../sim/engine";
import type {
  Building, EventId, Item, MotiveKind, Npc, NpcId, RoomId, World,
} from "../world/types";
import { buildingById, fullName, itemById, relationshipBetween } from "../world/types";
import { difficultyOf } from "../world/difficulty";

export interface MotiveCandidate {
  killerId: NpcId;
  victimId: NpcId;
  motive: MotiveKind;
  score: number;
  eventIds: EventId[];
  summary: string;
}

export interface CrimePlan {
  killerId: NpcId;
  victimId: NpcId;
  motive: MotiveKind;
  motiveEventIds: EventId[];
  motiveSummary: string;
  murderTime: SimTime;
  windowEnd: SimTime;
  sceneBuildingId: string;
  sceneRoomId: RoomId;
  weapon: WeaponPlan;
  premeditated: boolean;
  woreGloves: boolean;
  disposal: "left-at-scene" | "hidden" | "taken-home";
  disposalBuildingId: string | null;
}

export type WeaponPlan =
  | { source: "owned"; itemId: string }
  | { source: "at-scene" } // improvised: resolved at execution from the scene room
  | { source: "purchase"; kind: "hunting-knife" | "hammer"; storeId: string }
  | { source: "bare-hands" };

/** Deterministic flavor pick — same seed, same phrasing. */
function motiveVariant(world: World, key: string, variants: string[]): string {
  const r = new Rng((world.seed ^ hashString(`motive-flavor:${key}`)) >>> 0);
  return r.pick(variants);
}

/** Events between two NPCs of the given kinds — provenance for motives. */
function eventsBetween(world: World, aId: NpcId, bId: NpcId, kinds: string[]): EventId[] {
  return world.eventLog
    .filter(
      (e) =>
        kinds.includes(e.kind) &&
        ((e.actorIds.includes(aId) && e.targetIds.includes(bId)) ||
          (e.actorIds.includes(bId) && e.targetIds.includes(aId)))
    )
    .map((e) => e.id);
}

/** Disposition: how capable of violence is this person, given this pressure? */
function disposition(n: Npc): number {
  const p = n.personality;
  return (0.35 + p.aggression * 0.9) * (1.25 - p.empathy * 0.8) * (0.7 + n.stress * 0.6);
}

export function scoreMotives(world: World): MotiveCandidate[] {
  const out: MotiveCandidate[] = [];
  const alive = world.npcs.filter((n) => n.alive);

  for (const a of alive) {
    for (const b of alive) {
      if (a.id === b.id) continue;
      const rel = relationshipBetween(a, b.id);

      // Revenge / hatred: fed by real arguments and fights.
      if (rel.friendship < -0.35) {
        const evs = eventsBetween(world, a.id, b.id, ["argue", "fight"]);
        const score = (-rel.friendship * 1.1 + Math.min(1, evs.length * 0.25)) * disposition(a);
        out.push({
          killerId: a.id, victimId: b.id, motive: "revenge", score, eventIds: evs,
          summary: motiveVariant(world, `rev:${a.id}:${b.id}`, [
            `${fullName(a)} despised ${fullName(b)} after repeated clashes`,
            `the bad blood between ${fullName(a)} and ${fullName(b)} had been curdling for days`,
            `${fullName(a)} had stopped bothering to hide how much they hated ${fullName(b)}`,
          ]),
        });
      }

      // Jealousy: a's partner entangled with b, and a has reason to know.
      if (a.partnerId && a.partnerId !== b.id) {
        const partner = alive.find((n) => n.id === a.partnerId);
        if (partner) {
          const affair = Object.values(world.secrets).find(
            (s) => s.kind === "affair" && s.holderId === partner.id && s.otherId === b.id
          );
          const partnerAttraction = relationshipBetween(partner, b.id).attraction;
          const aware = affair ? affair.knownBy.includes(a.id) : false;
          const flirtEvs = eventsBetween(world, partner.id, b.id, ["flirt", "affair-meeting"]);
          const witnessedAny = world.eventLog.some(
            (e) => flirtEvs.includes(e.id) && e.witnessIds.includes(a.id)
          );
          if ((affair && (aware || witnessedAny)) || (partnerAttraction > 0.55 && witnessedAny)) {
            const score = (0.9 + rel.jealousy * 0.6 + relationshipBetween(a, partner.id).jealousy * 0.6) * disposition(a);
            out.push({
              killerId: a.id, victimId: b.id, motive: "jealousy", score, eventIds: flirtEvs,
              summary: motiveVariant(world, `jeal:${a.id}:${b.id}`, [
                `${fullName(a)} knew about ${partner.first}'s involvement with ${fullName(b)}`,
                `${fullName(a)} had watched ${partner.first} drift toward ${fullName(b)} and could not bear it`,
              ]),
            });
          }
        }
      }

      // Fear of exposure: b is blackmailing a.
      const bmail = Object.values(world.secrets).find(
        (s) => s.kind === "being-blackmailed" && s.holderId === a.id && s.otherId === b.id
      );
      if (bmail) {
        const evs = bmail.originEventId ? [bmail.originEventId] : [];
        const score = (1.0 + rel.fear * 0.8 + a.stress * 0.5) * disposition(a) * (0.6 + a.personality.fearfulness * 0.6);
        out.push({
          killerId: a.id, victimId: b.id, motive: "fear-of-exposure", score, eventIds: evs,
          summary: motiveVariant(world, `bm:${a.id}:${b.id}`, [
            `${fullName(b)} was blackmailing ${fullName(a)}, and it was escalating`,
            `${fullName(b)} owned ${fullName(a)}'s secret and kept raising the price of silence`,
          ]),
        });
      }

      // Money: a owes b heavily and is being pressed.
      if (rel.debt > 500) {
        const evs = eventsBetween(world, a.id, b.id, ["loan-demand"]);
        const pressure = Math.min(1.4, rel.debt / 1500) + evs.length * 0.2;
        if (evs.length > 0 || rel.debt > 900) {
          const score = pressure * (a.cash < rel.debt ? 1 : 0.3) * disposition(a);
          out.push({
            killerId: a.id, victimId: b.id, motive: "money", score, eventIds: evs,
            summary: motiveVariant(world, `debt:${a.id}:${b.id}`, [
              `${fullName(a)} owed ${fullName(b)} $${rel.debt} they could not repay`,
              `$${rel.debt} of debt to ${fullName(b)} was crushing ${fullName(a)}, and the demands kept coming`,
            ]),
          });
        }
      }

      // Inheritance: partner or family with money, killer strapped.
      const family = a.partnerId === b.id || (a.last === b.last && a.householdId === b.householdId);
      if (family && b.cash > 3500 && a.cash < b.cash * 0.3) {
        const score = Math.min(1.2, b.cash / 6000) * (1.1 - a.personality.empathy) * disposition(a) * 0.8;
        out.push({
          killerId: a.id, victimId: b.id, motive: "inheritance", score, eventIds: [],
          summary: `${fullName(b)}'s savings would pass to ${fullName(a)}`,
        });
      }

      // Business rivalry.
      const aBiz = world.city.buildings.find((x) => x.ownerId === a.id && !["house", "apartment"].includes(x.type));
      const bBiz = world.city.buildings.find((x) => x.ownerId === b.id && !["house", "apartment"].includes(x.type));
      if (aBiz && bBiz && aBiz.type === bBiz.type) {
        const evs = eventsBetween(world, a.id, b.id, ["argue"]);
        const score = (0.4 + evs.length * 0.25 + Math.max(0, -rel.friendship) * 0.5) * disposition(a) * 0.9;
        out.push({
          killerId: a.id, victimId: b.id, motive: "business-rivalry", score, eventIds: evs,
          summary: `${aBiz.name} and ${bBiz.name} were fighting over the same customers`,
        });
      }

      // Passion: strong one-sided attraction curdled by jealousy.
      if (rel.attraction > 0.6 && rel.jealousy > 0.45 && relationshipBetween(b, a.id).attraction < 0.25) {
        const evs = eventsBetween(world, a.id, b.id, ["flirt", "argue"]);
        const score = (rel.attraction * 0.6 + rel.jealousy * 0.7) * disposition(a) * 0.85;
        out.push({
          killerId: a.id, victimId: b.id, motive: "passion", score, eventIds: evs,
          summary: `${fullName(a)}'s fixation on ${fullName(b)} was not returned`,
        });
      }
    }
  }

  return out.sort((x, y) => y.score - x.score);
}

/**
 * Find an opportunity window: a stretch where the victim is predicted to be
 * somewhere with nobody else around (killer excepted). Searches the next
 * `searchHours` hours of predicted schedules.
 */
export function findOpportunity(
  engine: SimEngine,
  killer: Npc,
  victim: Npc,
  from: SimTime,
  searchHours = 40
): { start: SimTime; end: SimTime; buildingId: string } | null {
  const world = engine.world;
  const alive = world.npcs.filter((n) => n.alive && n.id !== victim.id && n.id !== killer.id);
  let best: { start: SimTime; end: SimTime; buildingId: string; score: number } | null = null;

  let runStart: SimTime | null = null;
  let runBuilding: string | null = null;

  const flush = (endT: SimTime) => {
    if (runStart === null || runBuilding === null) return;
    const len = endT - runStart;
    if (len >= 30) {
      const b = buildingById(world, runBuilding);
      const night = isNight(runStart) ? 1.5 : 1;
      const privacy = b.type === "house" || b.type === "apartment" ? 1.4 : b.type === "park" || b.type === "warehouse" ? 1.2 : 0.7;
      // Prefer windows where the killer is NOT at work (less remarkable absence).
      const killerAt = engine.predictTarget(killer, runStart + 10);
      const killerFree = killerAt.activity === "work" ? 0.5 : 1;
      const score = Math.min(len, 120) * night * privacy * killerFree;
      if (!best || score > best.score) best = { start: runStart, end: runStart + len, buildingId: runBuilding, score };
    }
    runStart = null;
    runBuilding = null;
  };

  for (let t = from; t <= from + searchHours * 60; t += TICK_MINUTES) {
    // Skip windows in the dead of sleep only if victim is home with household awake — predict handles it.
    const vt = engine.predictTarget(victim, t);
    const othersHere = alive.filter((n) => engine.predictTarget(n, t).buildingId === vt.buildingId);
    const isolated = othersHere.length === 0;
    if (isolated && (runBuilding === null || runBuilding === vt.buildingId)) {
      if (runStart === null) runStart = t;
      runBuilding = vt.buildingId;
    } else {
      flush(t);
      if (isolated) {
        runStart = t;
        runBuilding = vt.buildingId;
      }
    }
  }
  flush(from + searchHours * 60);

  if (!best) return null;
  const b = best as { start: SimTime; end: SimTime; buildingId: string };
  return { start: b.start, end: b.end, buildingId: b.buildingId };
}

/** Choose where in the building the murder happens. */
export function pickSceneRoom(world: World, buildingId: string, victim: Npc, r: Rng): RoomId {
  const b = buildingById(world, buildingId);
  // Victim's own apartment unit if they live there.
  if (b.type === "apartment" && victim.homeId === b.id) {
    const units = b.rooms.filter((rm) => rm.name.startsWith("Apartment"));
    if (units.length > 0) {
      // Stable unit per household.
      const unit = units[victim.householdId % units.length]!;
      return unit.id;
    }
  }
  const prefs: Record<string, string[]> = {
    "house": ["Bedroom", "Living room", "Kitchen", "Study"],
    "bar": ["Back room", "Cellar", "Bar floor"],
    "restaurant": ["Back room", "Kitchen"],
    "store": ["Back room", "Storage", "Front"],
    "office": ["Manager's office", "Office floor"],
    "factory": ["Workshop", "Floor", "Locker room"],
    "warehouse": ["Storage", "Loading dock"],
    "park": ["Grounds", "Bandstand"],
    "cafe": ["Back room", "Front"],
    "school": ["Staff room", "Classroom A"],
    "hospital": ["Records office", "Ward"],
    "apartment": ["Lobby"],
    "police-station": ["Front desk"],
  };
  const names = prefs[b.type] ?? [];
  for (const nm of names) {
    const room = b.rooms.find((rm) => rm.name === nm);
    if (room) return room.id;
  }
  return r.pick(b.rooms).id;
}

/** Weapon sourcing: killer's own possessions/home/work first, then purchase, then scene. */
export function planWeapon(
  world: World,
  killer: Npc,
  premeditated: boolean,
  r: Rng
): WeaponPlan {
  if (premeditated) {
    // 1) Something lethal the killer already has access to.
    const accessible: Item[] = [];
    const home = buildingById(world, killer.homeId);
    const buildingsToCheck: Building[] = [home];
    if (killer.workplaceId) buildingsToCheck.push(buildingById(world, killer.workplaceId));
    for (const b of buildingsToCheck) {
      for (const room of b.rooms) {
        // Apartment dwellers only reach their own unit.
        if (b.type === "apartment" && room.name.startsWith("Apartment")) {
          const units = b.rooms.filter((rm) => rm.name.startsWith("Apartment"));
          const own = units[killer.householdId % units.length];
          if (own && room.id !== own.id) continue;
        }
        for (const iid of room.itemIds) {
          const it = itemById(world, iid);
          if (it.lethality >= 0.6) accessible.push(it);
        }
      }
    }
    for (const iid of killer.inventoryIds) {
      const it = itemById(world, iid);
      if (it.lethality >= 0.6) accessible.push(it);
    }
    if (accessible.length > 0) {
      const it = accessible.sort((a, b) => b.lethality - a.lethality)[0]!;
      return { source: "owned", itemId: it.id };
    }
    // 2) Buy one — leaves a paper trail and maybe camera footage.
    const stores = world.city.buildings.filter((b) => b.type === "store");
    if (stores.length > 0 && killer.cash > 80) {
      return { source: "purchase", kind: r.chance(0.6) ? "hunting-knife" : "hammer", storeId: r.pick(stores).id };
    }
  }
  // Passion / no access: improvise at the scene, or bare hands.
  return r.chance(0.75) ? { source: "at-scene" } : { source: "bare-hands" };
}

/** Assemble the full crime plan, or null if no opportunity was found. */
export function planCrime(engine: SimEngine, rng: Rng, minScore: number): CrimePlan | null {
  const world = engine.world;
  const r = rng.stream("crime");
  const candidates = scoreMotives(world).filter((c) => c.score >= minScore);
  if (candidates.length === 0) return null;

  // Weighted pick among the top few — determinism with variety across seeds.
  const top = candidates.slice(0, 4);
  const chosen = r.weighted(top.map((c) => [c, Math.max(0.05, c.score)] as const));
  const killer = world.npcs.find((n) => n.id === chosen.killerId)!;
  const victim = world.npcs.find((n) => n.id === chosen.victimId)!;

  const opp = findOpportunity(engine, killer, victim, world.time + 6 * 60);
  if (!opp) {
    log.warn("crime", `No opportunity window for ${fullName(killer)} → ${fullName(victim)}; will retry later`);
    return null;
  }

  // Difficulty shifts killer competence: effective confidence for planning.
  const competence = difficultyOf(world).killerCompetence;
  const effConfidence = killer.personality.confidence + competence;
  const premeditated = effConfidence > 0.45 || chosen.motive === "inheritance" || chosen.motive === "money" || chosen.motive === "fear-of-exposure";
  const woreGloves = premeditated && effConfidence > 0.55;
  const weapon = planWeapon(world, killer, premeditated, r.stream("weapon"));

  // Disposal choice by temperament.
  let disposal: CrimePlan["disposal"];
  if (!premeditated || killer.personality.fearfulness - competence > 0.65) disposal = "left-at-scene";
  else if (effConfidence > 0.6) disposal = "hidden";
  else disposal = "taken-home";
  let disposalBuildingId: string | null = null;
  if (disposal === "hidden") {
    const spots = world.city.buildings.filter((b) => b.type === "park" || b.type === "warehouse");
    disposalBuildingId = spots.length > 0 ? r.pick(spots).id : null;
    if (!disposalBuildingId) disposal = "taken-home";
  }

  const murderTime = opp.start + TICK_MINUTES; // settle in one tick after isolation starts
  const plan: CrimePlan = {
    killerId: killer.id,
    victimId: victim.id,
    motive: chosen.motive,
    motiveEventIds: chosen.eventIds,
    motiveSummary: chosen.summary,
    murderTime,
    windowEnd: opp.end,
    sceneBuildingId: opp.buildingId,
    sceneRoomId: pickSceneRoom(world, opp.buildingId, victim, r.stream("room")),
    weapon,
    premeditated,
    woreGloves,
    disposal,
    disposalBuildingId,
  };
  log.info(
    "crime",
    `Planned: ${fullName(killer)} → ${fullName(victim)} (${chosen.motive}, score ${chosen.score.toFixed(2)}) at ${fmtTimeLong(murderTime)} in ${buildingById(world, opp.buildingId).name}; weapon=${weapon.source}, gloves=${woreGloves}, disposal=${disposal}`
  );
  return plan;
}

/** Fallback threshold schedule: pressure the sim, then lower the bar. */
export function motiveThresholdForDay(day: number): number {
  if (day <= 4) return 0.9;
  if (day <= 6) return 0.55;
  return 0.15;
}

export function hourIsReasonableForPlanning(t: SimTime): boolean {
  const h = hourOf(t);
  return h >= 4 && h <= 23;
}
