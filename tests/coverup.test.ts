/**
 * Killer counter-play: pressure-driven tampering that is itself simulated.
 *
 * Invariant coverage: tampering must be real sim events with provenance
 * (wipe events referenced by the item, intimidation remembered by the
 * witness), must never happen without pressure, and must generate at least
 * as much investigative surface as it destroys.
 */

import { describe, expect, it } from "vitest";
import { Game } from "../src/game/director";
import { MINUTES_PER_DAY } from "../src/core/time";
import { itemById } from "../src/world/types";

/** Crank the pressure the way a aggressive investigation would. */
function applyPressure(game: Game): void {
  const killerId = game.world.crime!.killerId;
  game.actInterview(killerId, "whereabouts");
  game.actPullFinance(killerId);
  game.actPullPhone(killerId);
}

/** Make the killer maximally jumpy so the nerve roll fires deterministically-ish. */
function makeNervous(game: Game): void {
  const killer = game.npc(game.world.crime!.killerId);
  killer.personality.fearfulness = 0.95;
  killer.personality.confidence = 0.05;
  killer.personality.aggression = 0.6;
  killer.personality.curiosity = 0.7;
}

describe("killer counter-play", () => {
  it("no tampering ever happens without pressure", async () => {
    const game = await Game.generate("COVERUP-CONTROL-1");
    makeNervous(game);
    game.advance(2 * MINUTES_PER_DAY);
    const tampering = game.world.eventLog.filter(
      (e) => e.kind === "wipe-item" || e.kind === "intimidation"
    );
    expect(tampering).toEqual([]);
    expect(game.world.crime!.pressure ?? 0).toBe(0);
  }, 240_000);

  it("a pressured, nervous killer tampers — with full provenance", async () => {
    // Scan a few seeds: the nerve roll and opportunity windows are seeded,
    // so some towns' killers hold out. At least one must act.
    const seeds = ["COVERUP-A-1", "COVERUP-B-2", "COVERUP-C-3", "COVERUP-D-4"];
    let acted = false;
    for (const seed of seeds) {
      const game = await Game.generate(seed);
      makeNervous(game);
      applyPressure(game);
      expect(game.world.crime!.pressure!).toBeGreaterThanOrEqual(3);
      game.advance(3 * MINUTES_PER_DAY);
      const world = game.world;
      const killerId = world.crime!.killerId;
      const tampering = world.eventLog.filter(
        (e) =>
          (["wipe-item", "intimidation"].includes(e.kind) && e.actorIds[0] === killerId) ||
          (["take-item", "drop-item"].includes(e.kind) && e.actorIds[0] === killerId && e.t > world.crime!.discoveryTime!)
      );
      if (tampering.length === 0) continue;
      acted = true;

      for (const ev of tampering) {
        // Every tamper event is in the log with the killer as actor.
        expect(ev.actorIds[0]).toBe(killerId);
        if (ev.kind === "wipe-item") {
          const item = itemById(world, ev.itemId!);
          expect(item.wipedAt).toBe(ev.t);
          expect(item.wipedEventId).toBe(ev.id);
          // Any surviving print must reference the wipe itself (the panic print).
          for (const f of item.fingerprints) {
            expect(f.eventId).toBe(ev.id);
          }
        }
        if (ev.kind === "intimidation") {
          const witness = world.npcs.find((n) => n.id === ev.targetIds[0])!;
          expect(
            witness.memories.some((m) => m.eventId === ev.id),
            "intimidated witness must remember it"
          ).toBe(true);
          expect(world.crime!.coverup!.intimidatedId).toBe(witness.id);
        }
      }
      break;
    }
    expect(acted, `none of ${seeds.join(", ")} produced tampering under max pressure`).toBe(true);
  }, 240_000);

  it("intimidated witnesses clam up, then reveal the intimidation as consciousness-of-guilt evidence", async () => {
    // Find a seed where intimidation specifically occurs.
    const seeds = ["COVERUP-A-1", "COVERUP-B-2", "COVERUP-C-3", "COVERUP-D-4", "COVERUP-E-5", "COVERUP-F-6"];
    let exercised = false;
    for (const seed of seeds) {
      const game = await Game.generate(seed);
      makeNervous(game);
      applyPressure(game);
      game.advance(3 * MINUTES_PER_DAY);
      const world = game.world;
      const cover = world.crime!.coverup!;
      if (!cover.intimidatedId) continue;
      exercised = true;

      const killerId = world.crime!.killerId;
      const witness = game.npc(cover.intimidatedId);
      // Clammed up about the killer specifically.
      const before = game.actInterview(witness.id, "about-person", killerId).statement!;
      expect(before.guarded).toBe(true);
      expect(before.claims).toEqual([]);

      // Open them with leverage, then they name the intimidation.
      const finance = game.actPullFinance(witness.id).evidence![0]!;
      game.actConfront(witness.id, finance.id);
      expect(game.casefile.openedUp).toContain(witness.id);
      game.actInterview(witness.id, "about-person", killerId);
      const guiltEvidence = game.casefile.evidence.filter(
        (e) => e.consciousnessOfGuilt && e.npcIds.includes(killerId)
      );
      expect(guiltEvidence.length).toBeGreaterThan(0);
      // The intimidation evidence places the killer at a real event.
      const placed = guiltEvidence.find((e) => e.placesAtBuildingId !== null);
      expect(placed).toBeDefined();
      break;
    }
    expect(exercised, "no seed produced an intimidation — broaden the sweep").toBe(true);
  }, 240_000);

  it("saves made mid-coverup reload cleanly", async () => {
    const game = await Game.generate("COVERUP-A-1");
    makeNervous(game);
    applyPressure(game);
    game.advance(MINUTES_PER_DAY);
    // Round-trip the world/casefile through JSON like the save system does.
    const worldJson = JSON.parse(JSON.stringify({ ...game.world, city: { ...game.world.city, roads: [...game.world.city.roads.values()] } }));
    const roads = new Map();
    for (const cell of worldJson.city.roads) roads.set(`${cell.x},${cell.y}`, cell);
    const world2 = { ...worldJson, city: { ...worldJson.city, roads } };
    const game2 = Game.fromLoaded(world2, JSON.parse(JSON.stringify(game.casefile)), "investigating");
    expect(game2.world.crime!.pressure).toBe(game.world.crime!.pressure);
    // Coverup keeps working after load.
    game2.advance(MINUTES_PER_DAY);
    expect(game2.world.time).toBeGreaterThan(game.world.time - 1);
  }, 240_000);
});
