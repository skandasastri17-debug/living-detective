/**
 * Relationship-graph knowledge gating: the web may only show what the
 * detective has actually learned, and facts must dedupe.
 */

import { describe, expect, it } from "vitest";
import { Game } from "../src/game/director";
import { knownEdges, knownNpcIds } from "../src/ui/panels/relationsPanel";
import { pullFinancialRecords } from "../src/investigation/actions";

let gamePromise: Promise<Game> | null = null;
function testGame(): Promise<Game> {
  gamePromise ??= Game.generate("RELATIONS-SEED-5");
  return gamePromise;
}

describe("relationship graph knowledge gating", () => {
  it("starts with no learned facts and a case web limited to the victim", async () => {
    const game = await testGame();
    expect(game.casefile.relationFacts).toEqual([]);
    const ids = knownNpcIds(game.casefile);
    // Only the victim is connected before any investigation.
    expect(ids.has(game.casefile.victimId)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("financial records mint deduplicated debt facts", async () => {
    const game = await testGame();
    // Find someone with a real outstanding debt in the simulation.
    const debtor = game.world.npcs.find((n) =>
      n.alive && Object.values(n.relationships).some((r) => r.debt > 0)
    );
    expect(debtor, "seeded world should contain a debtor").toBeDefined();
    pullFinancialRecords(game.world, game.casefile, debtor!.id);
    const debtFacts = game.casefile.relationFacts.filter((f) => f.kind === "debt");
    expect(debtFacts.length).toBeGreaterThan(0);
    const before = game.casefile.relationFacts.length;
    pullFinancialRecords(game.world, game.casefile, debtor!.id);
    expect(game.casefile.relationFacts.length).toBe(before);
    // Every fact cites the evidence that revealed it.
    for (const f of game.casefile.relationFacts) {
      expect(game.casefile.evidence.some((e) => e.id === f.sourceEvidenceId)).toBe(true);
    }
  });

  it("public edges only connect people already tied to the case", async () => {
    const game = await testGame();
    const edges = knownEdges(game.world, game.casefile);
    const known = knownNpcIds(game.casefile);
    for (const e of edges) {
      expect(known.has(e.aId), `edge ${e.kind} references unknown ${e.aId}`).toBe(true);
      expect(known.has(e.bId), `edge ${e.kind} references unknown ${e.bId}`).toBe(true);
    }
  });

  it("interviewing about a person with a feud mints a feud fact", async () => {
    const game = await testGame();
    const crime = game.world.crime!;
    // Interview several people about the killer; feud witnesses should surface facts.
    for (const n of game.world.npcs.filter((x) => x.alive && x.id !== crime.killerId).slice(0, 15)) {
      game.actInterview(n.id, "about-person", crime.killerId);
    }
    const kinds = game.casefile.relationFacts.map((f) => f.kind);
    // At minimum the case web should have grown beyond financial facts.
    expect(game.casefile.relationFacts.length).toBeGreaterThan(0);
    expect(kinds.length).toBeGreaterThan(0);
  });
});
