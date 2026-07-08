/**
 * Content breadth: DNA as a distinct forensic channel, the victim's phone
 * shortcut, and narrative reveal/motive variety — all provenance-honest.
 */

import { describe, expect, it } from "vitest";
import { Game } from "../src/game/director";
import { buildReveal } from "../src/investigation/accusation";
import { compareDna } from "../src/investigation/actions";

/** Find a seed whose murder was frenzied (struggle DNA recovered). */
async function struggleCase(): Promise<Game> {
  for (let i = 0; i < 10; i++) {
    const game = await Game.generate(`DNA-SWEEP-${i}`);
    if (game.world.scene?.struggleDnaOfNpcId) return game;
  }
  throw new Error("no struggle case in 10 seeds — loosen the sweep");
}

describe("struggle DNA", () => {
  it("only exists for frenzied murders, and always names the killer with murder-event provenance", async () => {
    for (let i = 0; i < 6; i++) {
      const game = await Game.generate(`DNA-SWEEP-${i}`);
      const scene = game.world.scene!;
      const crime = game.world.crime!;
      if (scene.struggleDnaOfNpcId) {
        expect(crime.premeditated, "struggle DNA implies a frenzied attack").toBe(false);
        expect(scene.struggleDnaOfNpcId).toBe(crime.killerId);
        expect(scene.struggleDnaEventId).toBe(crime.murderEventId);
      }
    }
  }, 240_000);

  it("comparison confirms the killer, clears the innocent, and needs the autopsy first", async () => {
    const game = await struggleCase();
    const { world, casefile } = game;
    const crime = world.crime!;
    const innocent = world.npcs.find((n) => n.alive && n.id !== crime.killerId && n.id !== crime.victimId)!;

    // Gate: no autopsy yet.
    expect(() => compareDna(world, casefile, innocent.id)).toThrow();
    if (world.time < game.autopsyReadyAt()) game.advance(game.autopsyReadyAt() - world.time + 10);
    game.actAutopsy();
    expect(game.dnaComparisonAvailable()).toBe(true);

    // Innocent: excluded, exculpatory, no physical-link flag.
    const cleared = game.actCompareDna(innocent.id).evidence![0]!;
    expect(cleared.title).toContain("excluded");
    expect(cleared.itemLink).toBeFalsy();
    expect(cleared.placesAtBuildingId).toBeNull();

    // Killer: match, physical link, placement at the scene at murder time.
    const match = game.actCompareDna(crime.killerId).evidence![0]!;
    expect(match.title).toContain("DNA match");
    expect(match.itemLink).toBe(true);
    expect(match.placesAtBuildingId).toBe(crime.sceneBuildingId);
    expect(match.placesFrom!).toBeLessThanOrEqual(crime.murderTime);
    expect(match.placesTo!).toBeGreaterThanOrEqual(crime.murderTime);
  }, 240_000);

  it("the autopsy only mentions nail material when the sim actually recorded a struggle", async () => {
    for (let i = 0; i < 6; i++) {
      const game = await Game.generate(`DNA-SWEEP-${i}`);
      if (game.world.time < game.autopsyReadyAt()) game.advance(game.autopsyReadyAt() - game.world.time + 10);
      const autopsy = game.actAutopsy().evidence![0]!;
      const mentions = autopsy.detail.includes("under the fingernails");
      expect(mentions).toBe(game.world.scene?.struggleDnaOfNpcId != null);
    }
  }, 240_000);
});

describe("victim's phone", () => {
  it("examining the scene surfaces the victim's call history via their dropped phone", async () => {
    const game = await Game.generate("PHONE-SHORTCUT-1");
    game.actExamineScene();
    const cf = game.casefile;
    expect(cf.phoneRecordsPulled).toContain(cf.victimId);
    expect(cf.evidence.some((e) => e.kind === "phone-records" && e.npcIds.includes(cf.victimId))).toBe(true);
  }, 240_000);
});

describe("reveal narration", () => {
  it("is sectioned, includes the motive coda, and is deterministic", async () => {
    const a = await Game.generate("REVEAL-NARRATION-1");
    const b = await Game.generate("REVEAL-NARRATION-1");
    const linesA = buildReveal(a.world);
    const linesB = buildReveal(b.world);
    expect(linesA).toEqual(linesB);
    const text = linesA.join("\n");
    expect(text).toContain("— THE MOTIVE");
    expect(text).toContain("— THE NIGHT —");
    expect(text).toContain("— THE MEANS —");
    expect(text).toContain("— THE LIE —");
    expect(linesA[0]).toContain("THE TRUTH");
  }, 240_000);

  it("motive phrasing varies across seeds (flavor variants engage)", async () => {
    const summaries = new Set<string>();
    for (const seed of ["FLAVOR-1", "FLAVOR-2", "FLAVOR-3", "FLAVOR-4", "FLAVOR-5"]) {
      const g = await Game.generate(seed);
      // Normalize away names so we compare templates, not participants.
      const s = g.world.crime!.motiveSummary
        .replace(/[A-Z][a-z]+ [A-Z][a-z]+/g, "X")
        .replace(/\$\d+/g, "$N");
      summaries.add(s);
    }
    expect(summaries.size, [...summaries].join(" || ")).toBeGreaterThanOrEqual(2);
  }, 240_000);
});
