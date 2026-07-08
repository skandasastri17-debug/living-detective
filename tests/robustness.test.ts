/**
 * Seed sweep: many different cities must all generate a discovered murder
 * within a sane wall-clock budget. This is the regression net for
 * pathological seeds (stalled discovery, runaway event logs, unplannable
 * crimes).
 */

import { describe, expect, it } from "vitest";
import { Game } from "../src/game/director";
import { MINUTES_PER_DAY } from "../src/core/time";

const SWEEP_SEEDS = [
  "SWEEP-ALPHA-1", "SWEEP-BRAVO-2", "SWEEP-CHARLIE-3",
  "SWEEP-DELTA-4", "SWEEP-ECHO-5", "SWEEP-FOXTROT-6",
];

describe("seed sweep", () => {
  for (const seed of SWEEP_SEEDS) {
    it(`generates a complete, discovered case for "${seed}" quickly`, async () => {
      const started = Date.now();
      const game = await Game.generate(seed);
      const elapsed = Date.now() - started;
      const crime = game.world.crime!;

      expect(crime).toBeTruthy();
      expect(crime.discoveryTime).not.toBeNull();
      expect(game.world.npcs.find((n) => n.id === crime.victimId)!.alive).toBe(false);
      expect(game.world.npcs.find((n) => n.id === crime.killerId)!.alive).toBe(true);
      // Murder happens within the simulated fortnight.
      expect(crime.murderTime).toBeLessThan(15 * MINUTES_PER_DAY);
      // Generation must stay fast — this guards quadratic regressions.
      expect(elapsed, `generation for ${seed} took ${elapsed}ms`).toBeLessThan(30_000);

      // The case must be *solvable*: weapon linkable, or motive documented in
      // events, or witnesses/records exist around the murder window.
      const w = game.world;
      const nearWindow = w.eventLog.filter(
        (e) => Math.abs(e.t - crime.murderTime) <= 180 &&
          (e.witnessIds.length > 0 || e.kind === "scream-heard" || e.kind === "sighting")
      );
      const motiveTrail = crime.motiveEventIds.length;
      const weaponExists = crime.weaponItemId !== "";
      expect(
        weaponExists || motiveTrail > 0 || nearWindow.length > 0,
        `case for ${seed} has no investigative surface at all`
      ).toBe(true);
    }, 60_000);
  }
});
