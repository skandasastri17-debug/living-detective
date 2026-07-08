/**
 * Accusation evaluation and the full-truth reveal.
 *
 * A conviction needs the right person AND a case: physical weapon linkage,
 * placement near the scene, a documented motive, or a broken alibi. The
 * reveal reconstructs the entire true chain of events from the event log —
 * the payoff of a world where nothing was fabricated.
 */

import { fmtTimeLong } from "../core/time";
import type { MotiveKind, NpcId, World } from "../world/types";
import { buildingById, fullName } from "../world/types";
import { computeContradictions, type AccusationResult, type CaseFile } from "./casefile";

export const MOTIVE_LABELS: Record<MotiveKind, string> = {
  "money": "Money / debt",
  "jealousy": "Jealousy",
  "revenge": "Revenge / hatred",
  "blackmail": "Blackmail",
  "fear-of-exposure": "Fear of exposure",
  "passion": "Obsession / passion",
  "business-rivalry": "Business rivalry",
  "inheritance": "Inheritance",
};

export function evaluateAccusation(
  world: World,
  cf: CaseFile,
  accusedId: NpcId,
  motiveGuess: MotiveKind
): AccusationResult {
  const crime = world.crime!;
  const accused = world.npcs.find((n) => n.id === accusedId)!;
  const correct = accusedId === crime.killerId;
  const breakdown: string[] = [];
  let strength = 0;

  // Pillar 1 — weapon linkage (25).
  const weaponLink = cf.evidence.some(
    (e) =>
      (e.itemLink && e.npcIds.includes(accusedId) && e.itemId === crime.weaponItemId) ||
      (e.kind === "financial-records" && e.npcIds.includes(accusedId) && /knife|hammer/.test(e.detail) &&
        world.transactions.some((t) => t.fromId === accusedId && /knife|hammer/.test(t.memo)))
  );
  if (weaponLink) {
    strength += 25;
    breakdown.push("Physical link between the accused and the murder weapon.");
  } else {
    breakdown.push("No physical link between the accused and the weapon.");
  }

  // Pillar 2 — placement near the scene in the window (25).
  const wFrom = crime.murderTime - 90;
  const wTo = crime.murderTime + 90;
  const placed = cf.evidence.some(
    (e) =>
      e.npcIds.includes(accusedId) &&
      e.placesAtBuildingId !== null &&
      e.placesFrom !== null && e.placesTo !== null &&
      Math.min(e.placesTo, wTo) - Math.max(e.placesFrom, wFrom) > 0 &&
      (e.placesAtBuildingId === crime.sceneBuildingId || e.placesAtBuildingId.startsWith("street:"))
  );
  if (placed) {
    strength += 25;
    breakdown.push("Evidence places the accused at or near the scene around the time of death.");
  } else {
    breakdown.push("Nothing places the accused near the scene at the relevant time.");
  }

  // Pillar 3 — documented motive (25).
  const victimId = crime.victimId;
  const motiveDocumented = cf.evidence.some(
    (e) => e.motiveHint && e.npcIds.includes(accusedId) && (e.npcIds.includes(victimId) || e.kind === "financial-records")
  );
  if (motiveDocumented) {
    strength += 25;
    breakdown.push("A motive is documented in the case file.");
  } else {
    breakdown.push("The motive is speculative — nothing in the file documents it.");
  }

  // Pillar 4 — broken alibi (25).
  const broken = computeContradictions(cf).some((c) => c.npcId === accusedId);
  if (broken) {
    strength += 25;
    breakdown.push("The accused's account is contradicted by collected evidence.");
  } else {
    breakdown.push("The accused's story stands unchallenged.");
  }

  // Bonus — consciousness of guilt: post-crime conduct tied to the accused.
  const guiltConduct = cf.evidence.some(
    (e) => e.consciousnessOfGuilt && e.npcIds.includes(accusedId)
  );
  if (guiltConduct) {
    strength = Math.min(100, strength + 10);
    breakdown.push("Post-crime conduct (tampering or witness intimidation) betrays consciousness of guilt.");
  }

  // Bonus — naming the actual motive.
  if (correct && motiveGuess === crime.motive) {
    strength = Math.min(100, strength + 10);
    breakdown.push("The stated motive matches the truth.");
  }

  if (!cf.interviewed.includes(accusedId)) {
    strength = Math.max(0, strength - 15);
    breakdown.push("The accused was never even interviewed — the prosecutor is not pleased.");
  }

  const verdict: AccusationResult["verdict"] = !correct
    ? "wrongful"
    : strength >= 50
      ? "conviction"
      : "walks-free";

  const result: AccusationResult = {
    accusedId,
    motiveGuess: MOTIVE_LABELS[motiveGuess],
    correct,
    caseStrength: strength,
    breakdown,
    verdict,
    revealText: buildReveal(world),
  };
  cf.accusation = result;
  void accused;
  return result;
}

/** How each motive reads when the whole story is told. */
const MOTIVE_CODAS: Record<MotiveKind, string> = {
  "money": "Debt does not kill people. What it does is make people believe they have no other door left.",
  "jealousy": "Nobody watches a marriage from the inside and the outside at the same time. The killer had been doing both for days.",
  "revenge": "Nobody argues that many times with someone who doesn't matter to them. Hatred is just attention, curdled.",
  "blackmail": "Extortion is arithmetic: the price of silence rose past the price of a life.",
  "fear-of-exposure": "A secret does not have to be worth a life to cost one. It only has to feel that way at the wrong hour.",
  "passion": "Wanting someone who does not want you back is an old story. Most people close the book. One didn't.",
  "business-rivalry": "Two ledgers, one street. The arithmetic of a small town can be merciless.",
  "inheritance": "The money was always going to change hands. Someone decided the date.",
};

/** The whole truth, straight from the event log — told as a story. */
export function buildReveal(world: World): string[] {
  const crime = world.crime!;
  const killer = world.npcs.find((n) => n.id === crime.killerId)!;
  const victim = world.npcs.find((n) => n.id === crime.victimId)!;
  const scene = buildingById(world, crime.sceneBuildingId);
  const weapon = crime.weaponItemId ? world.items[crime.weaponItemId] : null;

  const lines: string[] = [];
  lines.push(`THE TRUTH — ${fullName(killer)} killed ${fullName(victim)}.`);

  lines.push(`— THE MOTIVE (${MOTIVE_LABELS[crime.motive]}) —`);
  lines.push(`${capitalize(crime.motiveSummary)}.`);
  // Motive history.
  for (const eid of crime.motiveEventIds.slice(0, 6)) {
    const ev = world.eventLog.find((e) => e.id === eid);
    if (ev) lines.push(`${fmtTimeLong(ev.t)} — ${ev.summary}.`);
  }
  lines.push(MOTIVE_CODAS[crime.motive]);

  lines.push(`— THE NIGHT —`);

  // The mechanics of the night.
  const windowFrom = crime.murderTime - 360;
  const windowTo = (crime.discoveryTime ?? crime.murderTime + 720) + 10;
  const nightEvents = world.eventLog.filter(
    (e) =>
      e.t >= windowFrom && e.t <= windowTo &&
      (
        (["purchase", "take-item", "murder", "drop-item", "scream-heard", "body-discovered"].includes(e.kind) &&
          (e.actorIds.includes(killer.id) || e.id === crime.murderEventId || e.id === crime.discoveryEventId || e.kind === "scream-heard")) ||
        (["depart", "arrive"].includes(e.kind) && e.actorIds.includes(killer.id))
      )
  );
  for (const ev of nightEvents) {
    lines.push(`${fmtTimeLong(ev.t)} — ${ev.summary}.`);
  }

  lines.push(`— THE MEANS —`);
  lines.push(
    weapon
      ? `The weapon was ${weapon.name.toLowerCase()}${crime.weaponDisposal === "hidden" && weapon.hiddenAt ? `, discarded in the ${weapon.hiddenAt}` : crime.weaponDisposal === "left-at-scene" ? ", left at the scene" : ", taken home"}.`
      : `No weapon — the killer used their bare hands.`
  );
  lines.push(
    `${killer.first} ${crime.woreGloves ? "wore gloves" : "left prints"}` +
    `${world.scene?.struggleDnaOfNpcId ? `, but ${victim.first} fought back hard enough to carry ${killer.first}'s DNA under their nails` : ""}.`
  );
  lines.push(`— THE LIE —`);
  lines.push(`Asked where they were, ${killer.first} said: "${crime.alibiClaim}"`);
  if (crime.discoveredBy) {
    const d = world.npcs.find((n) => n.id === crime.discoveredBy)!;
    lines.push(`The body was found by ${fullName(d)} at ${fmtTimeLong(crime.discoveryTime!)} in ${scene.name}.`);
  }
  // What the killer did while being investigated.
  const tamperEvents = world.eventLog.filter(
    (e) =>
      e.t > windowTo &&
      ["wipe-item", "intimidation", "take-item", "drop-item", "arrive"].includes(e.kind) &&
      e.actorIds.includes(killer.id) &&
      (e.kind !== "arrive" || e.buildingId === crime.sceneBuildingId)
  );
  if (tamperEvents.length > 0) {
    lines.push(`— THE COVER-UP —`);
    lines.push(`While you investigated, ${killer.first} kept moving:`);
    for (const ev of tamperEvents.slice(0, 6)) {
      lines.push(`${fmtTimeLong(ev.t)} — ${ev.summary}.`);
    }
  }
  return lines;
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}
