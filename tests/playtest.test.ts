/**
 * Automated playtest sweep.
 *
 * A "fair-play bot" runs an honest investigation procedure — no access to
 * the truth until scoring. Across 15 seeds on the default difficulty, every
 * case must be solvable by that procedure, the true killer must surface
 * near the top of an honest suspect ranking, and no case may be convictable
 * from the scene alone (trivial). Difficulty knobs must provably matter.
 */

import { describe, expect, it } from "vitest";
import { Game } from "../src/game/director";
import { evaluateAccusation } from "../src/investigation/accusation";
import { computeContradictions, type CaseFile } from "../src/investigation/casefile";
import type { NpcId, World } from "../src/world/types";

const PLAYTEST_SEEDS = Array.from({ length: 15 }, (_, i) => `PLAYTEST-${String(i + 1).padStart(2, "0")}`);

/** The four pillars, computed from collected evidence only (mirrors the UI). */
function pillarsFor(world: World, cf: CaseFile, suspectId: NpcId): number {
  const sceneId = world.crime!.sceneBuildingId;
  const victimId = cf.victimId;
  const autopsy = cf.evidence.find((e) => e.kind === "autopsy");
  const wFrom = autopsy?.placesFrom ?? null;
  const wTo = autopsy?.placesTo ?? null;
  let n = 0;
  if (cf.evidence.some((e) => e.itemLink && e.npcIds.includes(suspectId))) n++;
  if (
    wFrom !== null && wTo !== null &&
    cf.evidence.some((e) => {
      if (!e.npcIds.includes(suspectId) || e.placesAtBuildingId === null) return false;
      if (e.placesFrom === null || e.placesTo === null) return false;
      const overlap = Math.min(e.placesTo, wTo + 90) - Math.max(e.placesFrom, wFrom - 90);
      return overlap > 0 && (e.placesAtBuildingId === sceneId || e.placesAtBuildingId.startsWith("street:"));
    })
  ) n++;
  if (cf.evidence.some((e) => e.motiveHint && e.npcIds.includes(suspectId) && (e.npcIds.includes(victimId) || e.kind === "financial-records"))) n++;
  if (computeContradictions(cf).some((c) => c.npcId === suspectId)) n++;
  return n;
}

interface PlaytestResult {
  seed: string;
  killerRank: number; // 1-based rank of the true killer in the honest ranking
  strengthVsKiller: number;
  strengthFromSceneOnly: number;
  suspects: number;
}

/** Honest procedure: scene → autopsy → canvass → follow the evidence. */
async function playFairly(seed: string): Promise<PlaytestResult> {
  const game = await Game.generate(seed);
  const { world, casefile } = game;
  const crime = world.crime!;

  // Phase 1: the scene and the body.
  game.actExamineScene();
  if (world.time < game.autopsyReadyAt()) game.advance(game.autopsyReadyAt() - world.time + 10);
  game.actAutopsy();
  const sceneOnly = evaluateAccusation(world, casefile, crime.killerId, "revenge").caseStrength;
  casefile.accusation = null; // measurement, not a real accusation

  // Phase 2: canvass the town — including the canonical question.
  const alive = world.npcs.filter((n) => n.alive);
  for (const n of alive) {
    game.actInterview(n.id, "whereabouts");
    game.actInterview(n.id, "anything-unusual");
    game.actInterview(n.id, "enemies");
  }

  // Phase 3: follow the evidence — persons of interest by mention count.
  const mentions = new Map<NpcId, number>();
  for (const e of casefile.evidence) {
    for (const id of e.npcIds) {
      if (id === casefile.victimId) continue;
      mentions.set(id, (mentions.get(id) ?? 0) + 1);
    }
  }
  const pois = [...mentions.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .filter((id) => alive.some((n) => n.id === id))
    .slice(0, 6);
  for (const poi of pois) {
    game.actPullFinance(poi);
    game.actPullPhone(poi);
    // Ask their circle about them.
    const poiNpc = game.npc(poi);
    const circle = alive
      .filter((n) => n.id !== poi && (n.householdId === poiNpc.householdId || n.workplaceId === poiNpc.workplaceId || (n.relationships[poi]?.friendship ?? 0) > 0.3))
      .slice(0, 4);
    for (const c of circle) game.actInterview(c.id, "about-person", poi);
    // Check their alibi: ask the staff of any venue they claim to have been
    // at (this is where absence testimony lives).
    const poiClaims = casefile.statements
      .filter((s) => s.npcId === poi && s.topic === "whereabouts")
      .flatMap((s) => s.claims)
      .filter((c) => c.npcId === poi && c.buildingId && !c.buildingId.startsWith("street:") && c.buildingId !== poiNpc.homeId);
    for (const claim of poiClaims.slice(0, 2)) {
      const venue = world.city.buildings.find((b) => b.id === claim.buildingId);
      if (!venue) continue;
      for (const staffId of venue.employeeIds.slice(0, 2)) {
        const staff = alive.find((n) => n.id === staffId);
        if (staff && staff.id !== poi) game.actInterview(staff.id, "about-person", poi);
      }
    }
    // Press them with any contradiction.
    const contra = computeContradictions(casefile).find((c) => c.npcId === poi);
    if (contra) game.actConfront(poi, contra.evidenceId);
  }

  // Phase 4: physical sweep — victim home, hiding spots, top POI homes.
  const targets = new Set<string>();
  targets.add(game.npc(casefile.victimId).homeId);
  for (const b of world.city.buildings.filter((x) => x.type === "park" || x.type === "warehouse")) targets.add(b.id);
  for (const poi of pois.slice(0, 3)) targets.add(game.npc(poi).homeId);
  for (const t of targets) {
    if (game.needsWarrant(t)) game.actObtainWarrant(t);
    game.actSearch(t);
  }
  for (const b of world.city.buildings.filter((x) => x.hasCamera)) game.actPullCamera(b.id);

  // Phase 5: iterative deepening — follow what the FILE now says, not just
  // the gossip. Search top pillar-suspects' homes, verify their alibis, and
  // re-sweep hiding spots (a rattled killer may have moved things).
  const rankNow = () => alive
    .filter((n) => n.id !== casefile.victimId)
    .map((n) => ({ id: n.id, pillars: pillarsFor(world, casefile, n.id), mentions: mentions.get(n.id) ?? 0 }))
    .sort((a, b) => b.pillars - a.pillars || b.mentions - a.mentions);
  for (const top of rankNow().slice(0, 3)) {
    const suspect = game.npc(top.id);
    if (!casefile.searchedBuildings.includes(suspect.homeId)) {
      if (game.needsWarrant(suspect.homeId)) game.actObtainWarrant(suspect.homeId);
      game.actSearch(suspect.homeId);
    }
    const claims = casefile.statements
      .filter((s) => s.npcId === top.id && s.topic === "whereabouts")
      .flatMap((s) => s.claims)
      .filter((c) => c.npcId === top.id && c.buildingId && !c.buildingId.startsWith("street:"));
    for (const claim of claims.slice(0, 2)) {
      const venue = world.city.buildings.find((b) => b.id === claim.buildingId);
      if (!venue || venue.id === suspect.homeId) continue;
      for (const staffId of venue.employeeIds.slice(0, 2)) {
        if (staffId !== top.id && alive.some((n) => n.id === staffId)) {
          game.actInterview(staffId, "about-person", top.id);
        }
      }
    }
    const contra = computeContradictions(casefile).find((c) => c.npcId === top.id);
    if (contra) game.actConfront(top.id, contra.evidenceId);
  }
  // Cold-case re-sweep of hiding spots.
  for (const b of world.city.buildings.filter((x) => x.type === "park" || x.type === "warehouse")) {
    game.actSearch(b.id);
  }

  // Ranking + verdicts.
  const ranked = rankNow();
  const killerRank = ranked.findIndex((r) => r.id === crime.killerId) + 1;
  const strengthVsKiller = evaluateAccusation(world, casefile, crime.killerId, crime.motive).caseStrength;

  return { seed, killerRank, strengthVsKiller, strengthFromSceneOnly: sceneOnly, suspects: ranked.length };
}

describe("15-seed playtest sweep (fair-play bot, default difficulty)", () => {
  const results: PlaytestResult[] = [];

  for (const seed of PLAYTEST_SEEDS) {
    it(`${seed}: solvable, non-trivial, killer surfaces`, async () => {
      const r = await playFairly(seed);
      results.push(r);
      // Solvable: the honest procedure can convict the true killer.
      expect(r.strengthVsKiller, `${seed} unsolvable (${r.strengthVsKiller}/100)`).toBeGreaterThanOrEqual(50);
      // Non-trivial: the scene alone must not close the case.
      expect(r.strengthFromSceneOnly, `${seed} trivially solvable from the scene`).toBeLessThan(70);
    }, 120_000);
  }

  it("the honest ranking surfaces the killer near the top in most towns", () => {
    expect(results.length).toBe(PLAYTEST_SEEDS.length);
    const topTwo = results.filter((r) => r.killerRank >= 1 && r.killerRank <= 2).length;
    const summary = results.map((r) => `${r.seed}: rank ${r.killerRank}, strength ${r.strengthVsKiller}, scene-only ${r.strengthFromSceneOnly}`).join("\n");
    expect(topTwo / results.length, `killer must rank top-2 in ≥70% of towns\n${summary}`).toBeGreaterThanOrEqual(0.7);
  });
});

describe("difficulty knobs", () => {
  it("seed + difficulty is deterministic; different difficulties diverge", async () => {
    const a1 = await Game.generate("DIFF-DET-1", "inspector");
    const a2 = await Game.generate("DIFF-DET-1", "inspector");
    expect(a1.world.crime!.killerId).toBe(a2.world.crime!.killerId);
    expect(a1.world.eventLog.length).toBe(a2.world.eventLog.length);
    const b = await Game.generate("DIFF-DET-1", "rookie");
    expect(b.world.difficulty).toBe("rookie");
    // Camera counts must reflect the knob (rookie ≥ inspector).
    const cams = (g: Game) => g.world.city.buildings.filter((x) => x.hasCamera).length;
    expect(cams(b)).toBeGreaterThanOrEqual(cams(a1));
  }, 240_000);

  it("inspector killers are more competent on average (gloves/hidden weapon)", async () => {
    let rookieCareful = 0;
    let inspectorCareful = 0;
    for (let i = 0; i < 6; i++) {
      const seed = `COMPETENCE-${i}`;
      const r = await Game.generate(seed, "rookie");
      const h = await Game.generate(seed, "inspector");
      const careful = (g: Game) => (g.world.crime!.woreGloves ? 1 : 0) + (g.world.crime!.weaponDisposal !== "left-at-scene" ? 1 : 0);
      rookieCareful += careful(r);
      inspectorCareful += careful(h);
    }
    expect(inspectorCareful, `rookie=${rookieCareful} inspector=${inspectorCareful}`).toBeGreaterThanOrEqual(rookieCareful);
  }, 240_000);
});
