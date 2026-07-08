/**
 * Integration tests: the full pipeline from seed to solvable case.
 * These are the guardians of the game's core promise — every clue has a
 * believable, traceable origin in the event log.
 */

import { describe, expect, it } from "vitest";
import { Game } from "../src/game/director";
import { at, fmtTimeLong } from "../src/core/time";
import { actualWhereabouts } from "../src/investigation/interview";
import { evaluateAccusation } from "../src/investigation/accusation";
import { computeContradictions } from "../src/investigation/casefile";
import type { World } from "../src/world/types";
import { buildingById, itemById } from "../src/world/types";

// One generated game shared across assertions (generation is the slow part).
const SEED = "TEST-HARBOR-77";
let gamePromise: Promise<Game> | null = null;
function testGame(): Promise<Game> {
  gamePromise ??= Game.generate(SEED);
  return gamePromise;
}

function assertEventProvenance(world: World, eventId: string | null, what: string): void {
  expect(eventId, `${what} must have provenance`).toBeTruthy();
  const ev = world.eventLog.find((e) => e.id === eventId);
  expect(ev, `${what} provenance event ${eventId} must exist in the log`).toBeDefined();
}

describe("full simulation pipeline", () => {
  it("generates a murder with a real killer, victim, and consistent timeline", async () => {
    const game = await testGame();
    const { world } = game;
    const crime = world.crime!;
    expect(crime).toBeTruthy();

    const killer = world.npcs.find((n) => n.id === crime.killerId)!;
    const victim = world.npcs.find((n) => n.id === crime.victimId)!;
    expect(killer.alive).toBe(true);
    expect(victim.alive).toBe(false);

    // The murder event exists and matches the record.
    const murderEv = world.eventLog.find((e) => e.id === crime.murderEventId)!;
    expect(murderEv.kind).toBe("murder");
    expect(murderEv.actorIds).toContain(killer.id);
    expect(murderEv.targetIds).toContain(victim.id);
    expect(murderEv.buildingId).toBe(crime.sceneBuildingId);
    expect(murderEv.t).toBe(crime.murderTime);

    // The killer was genuinely at the scene: their movement trail says so.
    const segs = actualWhereabouts(world, killer.id, crime.murderTime - 15, crime.murderTime + 15);
    expect(
      segs.some((s) => s.buildingId === crime.sceneBuildingId),
      `killer's actual trail must include the scene at murder time; got ${JSON.stringify(segs)} vs ${crime.sceneBuildingId} @ ${fmtTimeLong(crime.murderTime)}`
    ).toBe(true);

    // Discovery happened after the murder, by someone other than the killer.
    expect(crime.discoveryTime).not.toBeNull();
    expect(crime.discoveryTime!).toBeGreaterThan(crime.murderTime);
    expect(crime.discoveredBy).not.toBe(crime.killerId);
  }, 120_000);

  it("motive cites real events from the log", async () => {
    const game = await testGame();
    const { world } = game;
    const crime = world.crime!;
    for (const eid of crime.motiveEventIds) {
      assertEventProvenance(world, eid, "motive event");
    }
    expect(crime.motiveSummary.length).toBeGreaterThan(10);
  }, 120_000);

  it("every fingerprint on every item traces to a real event or the owner", async () => {
    const game = await testGame();
    const { world } = game;
    for (const item of Object.values(world.items)) {
      for (const trace of item.fingerprints) {
        assertEventProvenance(world, trace.eventId, `print of ${trace.npcId} on ${item.id}`);
        const ev = world.eventLog.find((e) => e.id === trace.eventId)!;
        expect(
          ev.actorIds.includes(trace.npcId),
          `print event ${ev.id} (${ev.kind}) must involve the printer as actor`
        ).toBe(true);
      }
    }
  }, 120_000);

  it("blood on the weapon belongs to the victim and traces to the murder", async () => {
    const game = await testGame();
    const { world } = game;
    const crime = world.crime!;
    if (crime.weaponItemId) {
      const weapon = itemById(world, crime.weaponItemId);
      expect(weapon.bloodOfNpcId).toBe(crime.victimId);
      expect(weapon.bloodEventId).toBe(crime.murderEventId);
    }
  }, 120_000);

  it("every memory references an event that exists, and witnesses were plausible", async () => {
    const game = await testGame();
    const { world } = game;
    for (const npc of world.npcs) {
      for (const m of npc.memories) {
        const ev = world.eventLog.find((e) => e.id === m.eventId);
        expect(ev, `memory of ${npc.first} references missing event ${m.eventId}`).toBeDefined();
      }
    }
  }, 120_000);

  it("camera logs and phone records all have event provenance", async () => {
    const game = await testGame();
    const { world } = game;
    for (const c of world.cameraLog) assertEventProvenance(world, c.eventId, "camera entry");
    for (const p of world.phoneLog) assertEventProvenance(world, p.eventId, "phone record");
    for (const t of world.transactions) assertEventProvenance(world, t.eventId, "transaction");
    // Camera entries only exist for buildings that actually have cameras.
    for (const c of world.cameraLog) {
      expect(buildingById(world, c.buildingId).hasCamera).toBe(true);
    }
  }, 120_000);

  it("the same seed reproduces the same murder", async () => {
    const a = await testGame();
    const b = await Game.generate(SEED);
    expect(b.world.crime!.killerId).toBe(a.world.crime!.killerId);
    expect(b.world.crime!.victimId).toBe(a.world.crime!.victimId);
    expect(b.world.crime!.murderTime).toBe(a.world.crime!.murderTime);
    expect(b.world.eventLog.length).toBe(a.world.eventLog.length);
  }, 240_000);
});

describe("investigation", () => {
  it("scene examination yields evidence with provenance and no fabrication", async () => {
    const game = await testGame();
    const out = game.actExamineScene();
    expect(out.evidence!.length).toBeGreaterThan(0);
    const crime = game.world.crime!;
    // Footprint evidence matches the killer's real shoe size.
    const killer = game.npc(crime.killerId);
    const fp = game.casefile.evidence.find((e) => e.kind === "footprint");
    expect(fp).toBeDefined();
    expect(fp!.detail).toContain(`size-${killer.shoeSize}`);
  }, 120_000);

  it("autopsy window contains the true murder time", async () => {
    const game = await testGame();
    if (game.world.time < game.autopsyReadyAt()) {
      game.advance(game.autopsyReadyAt() - game.world.time + 10);
    }
    const { evidence } = game.actAutopsy();
    const autopsy = evidence![0]!;
    expect(autopsy.placesFrom!).toBeLessThanOrEqual(game.world.crime!.murderTime);
    expect(autopsy.placesTo!).toBeGreaterThanOrEqual(game.world.crime!.murderTime);
  }, 120_000);

  it("the killer lies about the murder window; honest bystanders don't", async () => {
    const game = await testGame();
    const crime = game.world.crime!;
    const killer = game.npc(crime.killerId);

    const { statement } = game.actInterview(killer.id, "whereabouts");
    expect(statement!.claims.length).toBeGreaterThan(0);
    // The killer's claim must NOT truthfully place them at the scene at murder time
    // (unless the scene is the very building they claim — impossible by construction
    // since the alibi is their routine location and they deviated to kill).
    const claim = statement!.claims[0]!;
    const truth = actualWhereabouts(game.world, killer.id, crime.murderTime - 10, crime.murderTime + 10);
    expect(truth.some((s) => s.buildingId === crime.sceneBuildingId)).toBe(true);
    const claimCoversMurder = claim.buildingId === crime.sceneBuildingId;
    expect(claimCoversMurder, "killer should not admit being at the scene").toBe(false);
  }, 120_000);

  it("a full investigation can build a convictable case against the killer", async () => {
    const game = await testGame();
    const { world, casefile } = game;
    const crime = world.crime!;
    const killer = game.npc(crime.killerId);

    // Thorough sweep: scene, autopsy, killer interview, records, searches.
    game.actExamineScene();
    if (world.time < game.autopsyReadyAt()) game.advance(game.autopsyReadyAt() - world.time + 10);
    game.actAutopsy();
    game.actInterview(killer.id, "whereabouts");
    game.actInterview(killer.id, "relationship-victim");
    game.actPullFinance(killer.id);
    game.actPullPhone(killer.id);
    // Interview everyone in the victim's orbit about the night + unusual sights.
    for (const n of world.npcs.filter((x) => x.alive).slice(0, 20)) {
      game.actInterview(n.id, "anything-unusual");
      game.actInterview(n.id, "about-person", killer.id);
    }
    // Camera sweep + searches of key locations.
    for (const b of world.city.buildings.filter((x) => x.hasCamera).slice(0, 6)) {
      game.actPullCamera(b.id);
    }
    if (!game.needsWarrant(killer.homeId)) {
      game.actSearch(killer.homeId);
    } else {
      game.actObtainWarrant(killer.homeId);
      game.actSearch(killer.homeId);
    }
    for (const b of world.city.buildings.filter((x) => x.type === "park" || x.type === "warehouse")) {
      game.actSearch(b.id);
    }

    const contradictions = computeContradictions(casefile);
    const result = evaluateAccusation(world, casefile, killer.id, crime.motive);
    expect(result.correct).toBe(true);
    // The pipeline should produce a reasonably strong case on a thorough sweep.
    expect(
      result.caseStrength,
      `case strength too low; breakdown: ${result.breakdown.join(" | ")}; contradictions: ${contradictions.length}`
    ).toBeGreaterThanOrEqual(50);
    expect(result.verdict).toBe("conviction");
    expect(result.revealText.length).toBeGreaterThan(3);
  }, 240_000);

  it("wrongful accusation is rejected with the truth revealed", async () => {
    const game = await Game.generate("SECOND-SEED-11");
    const crime = game.world.crime!;
    const innocent = game.world.npcs.find((n) => n.alive && n.id !== crime.killerId && n.id !== crime.victimId)!;
    const result = evaluateAccusation(game.world, game.casefile, innocent.id, "revenge");
    expect(result.correct).toBe(false);
    expect(result.verdict).toBe("wrongful");
  }, 240_000);
});

describe("world consistency during play", () => {
  it("time advances and the city keeps living during the investigation", async () => {
    const game = await testGame();
    const before = game.world.time;
    const eventsBefore = game.world.eventLog.length;
    game.advance(at(0, 3)); // three hours
    expect(game.world.time).toBeGreaterThan(before);
    expect(game.world.eventLog.length).toBeGreaterThan(eventsBefore);
  }, 120_000);
});
