/**
 * Memory system.
 *
 * NPCs form memories as participants, witnesses, or via gossip. Memories
 * decay nightly; decay rate depends on personality.memoryQuality, and
 * salient events (violence, screams, bodies) decay far slower. The interview
 * system reads memory strength to decide between precise testimony, vague
 * testimony, and "I don't remember".
 */

import type { Npc, SimEvent, World } from "../world/types";
import type { SimTime } from "../core/time";
import { difficultyOf } from "../world/difficulty";

/** How noticeable an event is to bystanders (0..1). */
export function eventSalience(kind: SimEvent["kind"]): number {
  switch (kind) {
    case "murder":
    case "body-discovered":
    case "scream-heard":
    case "fight":
      return 1.0;
    case "argue":
    case "blackmail-demand":
    case "intimidation":
      return 0.85;
    case "theft":
    case "wipe-item":
      return 0.5; // done sneakily
    case "flirt":
    case "affair-meeting":
      return 0.6;
    case "loan-demand":
      return 0.65;
    case "sighting":
      return 0.35;
    case "gossip":
    case "chat":
      return 0.3;
    case "purchase":
    case "phone-call":
      return 0.25;
    default:
      return 0.3;
  }
}

/** Perception roll: does this bystander register the event at all? */
export function witnessPerceives(npc: Npc, kind: SimEvent["kind"], lightLevel: number, roll: number): boolean {
  const perception = 0.35 + npc.personality.curiosity * 0.55;
  const p = Math.min(0.98, perception * eventSalience(kind) * (0.5 + lightLevel * 0.5) * 1.4);
  return roll < p;
}

export function addMemory(
  npc: Npc,
  ev: SimEvent,
  source: "participant" | "witness" | "heard" | "gossip",
  strengthOverride?: number
): void {
  const base =
    source === "participant" ? 0.95 :
    source === "witness" ? 0.45 + eventSalience(ev.kind) * 0.4 :
    source === "heard" ? 0.6 :
    0.45; // gossip
  npc.memories.push({
    eventId: ev.id,
    t: ev.t,
    source,
    strength: strengthOverride ?? base,
    aboutIds: [...new Set([...ev.actorIds, ...ev.targetIds])].filter((id) => id !== npc.id),
    buildingId: ev.buildingId,
    summary: ev.summary,
  });
}

/** Nightly decay pass. Salient events persist much longer. */
export function decayMemories(world: World): void {
  // O(events + memories): index event kinds once instead of scanning the
  // log per memory (the log grows all week; a find() here is quadratic).
  const kindById = new Map<string, SimEvent["kind"]>();
  for (const e of world.eventLog) kindById.set(e.id, e.kind);
  const keepBonus = difficultyOf(world).memoryKeepBonus;
  for (const npc of world.npcs) {
    if (!npc.alive) continue;
    const keep = Math.min(0.99, Math.max(0.7, 0.80 + npc.personality.memoryQuality * 0.17 + keepBonus));
    npc.memories = npc.memories.filter((m) => {
      const kind = kindById.get(m.eventId);
      const salience = kind ? eventSalience(kind) : 0.3;
      // Salient memories decay at a fraction of the rate.
      const effective = keep + (1 - keep) * salience * 0.85;
      m.strength *= effective;
      return m.strength > 0.05;
    });
  }
}

export type RecallQuality = "vivid" | "vague" | "forgotten";

export function recallQuality(strength: number): RecallQuality {
  if (strength >= 0.35) return "vivid";
  if (strength >= 0.14) return "vague";
  return "forgotten";
}

/** Memories an NPC can recall about a given person. */
export function recallAbout(npc: Npc, aboutId: string): Array<{ m: Npc["memories"][number]; q: RecallQuality }> {
  return npc.memories
    .filter((m) => m.aboutIds.includes(aboutId))
    .map((m) => ({ m, q: recallQuality(m.strength) }))
    .filter((x) => x.q !== "forgotten")
    .sort((a, b) => b.m.t - a.m.t);
}

/** Memories an NPC can recall in a time window (e.g. the murder window). */
export function recallWindow(npc: Npc, from: SimTime, to: SimTime): Array<{ m: Npc["memories"][number]; q: RecallQuality }> {
  return npc.memories
    .filter((m) => m.t >= from && m.t <= to)
    .map((m) => ({ m, q: recallQuality(m.strength) }))
    .filter((x) => x.q !== "forgotten")
    .sort((a, b) => a.m.t - b.m.t);
}
