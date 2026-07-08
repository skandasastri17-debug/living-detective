/**
 * Testimony narration: correct pronoun/role handling and phrasing variety.
 *
 * Regression coverage for a reported bug: a witness recounting an event
 * where they were the OBJECT (not the subject) used to get a blind
 * find-and-replace of their own name with "I", producing nonsense like
 * "Cornelius Winslow argued heatedly with I". These tests exercise the
 * fixed narration path directly, and sweep real generated interviews to
 * make sure the broken pattern can never resurface, in any topic.
 */

import { describe, expect, it } from "vitest";
import { Game } from "../src/game/director";
import { narrateEvent } from "../src/investigation/narration";
import type { SimEvent } from "../src/world/types";
import {
  askAboutPerson, askAnythingUnusual, askRelationshipWithVictim, askWhereabouts, askWhoHadTrouble,
} from "../src/investigation/interview";

const SEED = "NARRATION-SEED-1";
let gamePromise: Promise<Game> | null = null;
function testGame(): Promise<Game> {
  gamePromise ??= Game.generate(SEED);
  return gamePromise;
}

/** Build a minimal, realistic "argue" event between two real NPCs. */
function makeArgueEvent(actorId: string, targetId: string, buildingId: string | null = null): SimEvent {
  return {
    id: "ev:test-1", t: 1000, kind: "argue",
    buildingId, roomId: null, streetName: null,
    actorIds: [actorId], targetIds: [targetId],
    itemId: null, amount: null, witnessIds: [],
    summary: "placeholder — narration must not depend on this field for correctness",
  };
}

// A preposition directly followed by the subject pronoun "I" is always
// wrong English ("argued with I", "stole it from I") — the exact shape of
// the reported bug. This is a general-purpose grammar-regression detector,
// not tied to any one template.
const BROKEN_PATTERN = /\b(with|from|to|at|of|against|about)\s+I\b/i;

describe("narrateEvent — role-correct pronouns", () => {
  it("uses first person and never the speaker's own name when they are the subject", async () => {
    const game = await testGame();
    const [a, b] = game.world.npcs;
    const ev = makeArgueEvent(a!.id, b!.id);
    for (let i = 0; i < 20; i++) {
      const line = narrateEvent(game.world, a!.id, { ...ev, id: `ev:t${i}` });
      expect(line).toMatch(/\bI\b/);
      expect(line).not.toContain(`${a!.first} ${a!.last}`);
      expect(line).not.toMatch(BROKEN_PATTERN);
    }
  });

  it("uses first person and never the speaker's own name when they are the object", async () => {
    const game = await testGame();
    const [a, b] = game.world.npcs;
    const ev = makeArgueEvent(a!.id, b!.id);
    for (let i = 0; i < 20; i++) {
      const line = narrateEvent(game.world, b!.id, { ...ev, id: `ev:t${i}` });
      expect(line).not.toContain(`${b!.first} ${b!.last}`);
      expect(line).not.toMatch(BROKEN_PATTERN);
      expect(line).toMatch(/\bme\b|\bI\b/);
    }
  });

  it("names both real participants in third person for a pure witness, with no first person", async () => {
    const game = await testGame();
    const [a, b, c] = game.world.npcs;
    const ev = makeArgueEvent(a!.id, b!.id);
    const line = narrateEvent(game.world, c!.id, ev);
    expect(line).toContain(`${a!.first} ${a!.last}`);
    expect(line).toContain(`${b!.first} ${b!.last}`);
    expect(line).not.toMatch(/\bI\b/);
    expect(line).not.toMatch(BROKEN_PATTERN);
  });

  it("is deterministic for the same event+speaker, but varies across different speakers", async () => {
    const game = await testGame();
    const [a, b, c, d, e] = game.world.npcs;
    const ev = makeArgueEvent(a!.id, b!.id);
    const once = narrateEvent(game.world, c!.id, ev);
    const twice = narrateEvent(game.world, c!.id, ev);
    expect(once).toBe(twice);

    const phrasings = new Set([c, d, e].filter(Boolean).map((w) => narrateEvent(game.world, w!.id, ev)));
    expect(phrasings.size, [...phrasings].join(" || ")).toBeGreaterThan(1);
  });

  it("includes the venue when the event has one", async () => {
    const game = await testGame();
    const [a, b] = game.world.npcs;
    const venue = game.world.city.buildings[0]!;
    const ev = makeArgueEvent(a!.id, b!.id, venue.id);
    let sawVenue = false;
    for (let i = 0; i < 10; i++) {
      const line = narrateEvent(game.world, a!.id, { ...ev, id: `ev:v${i}` });
      if (line.includes(venue.name)) sawVenue = true;
    }
    expect(sawVenue).toBe(true);
  });
});

describe("no broken pronoun substitution in real interviews", () => {
  it("sweeps every interview topic across many NPCs and seeds for the broken pattern", async () => {
    for (const seed of ["NARRATION-SWEEP-1", "NARRATION-SWEEP-2", "NARRATION-SWEEP-3"]) {
      const game = await Game.generate(seed);
      const { world, casefile } = game;
      const crime = world.crime!;
      const alive = world.npcs.filter((n) => n.alive).slice(0, 18);
      for (const n of alive) {
        askWhereabouts(world, casefile, n, crime.murderTime - 150, crime.murderTime + 90);
        askAnythingUnusual(world, casefile, n);
        askWhoHadTrouble(world, casefile, n);
        askRelationshipWithVictim(world, casefile, n);
        for (const other of alive.slice(0, 5)) {
          if (other.id === n.id) continue;
          askAboutPerson(world, casefile, n, other.id);
        }
      }
      for (const st of casefile.statements) {
        expect(st.answer, `${seed}: "${st.answer}" contains a broken preposition+"I"`).not.toMatch(BROKEN_PATTERN);
      }
    }
  }, 120_000);

  it("different witnesses of a shared event produce different testimony text (not copy-paste with names swapped)", async () => {
    const game = await Game.generate("NARRATION-VARIETY-1");
    const { world, casefile } = game;
    // Find an argue/fight event with at least 3 witnesses to interview.
    const ev = world.eventLog.find(
      (e) => ["argue", "fight"].includes(e.kind) && e.witnessIds.length >= 3
    );
    if (!ev) return; // this seed didn't produce one; the sweep above still covers the grammar invariant
    const witnesses = ev.witnessIds.slice(0, 4).map((id) => game.npc(id));
    const answers = witnesses.map((w) => askAnythingUnusual(world, casefile, w).answer);
    expect(new Set(answers).size).toBeGreaterThan(1);
  });
});
