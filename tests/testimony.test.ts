/**
 * Testimony depth: absence testimony (negative placements), personality
 * voices, and reluctant/hostile witnesses.
 *
 * The provenance invariant extends to negatives: an "X was never there"
 * statement must be verified against the event log — these tests recompute
 * the truth independently and assert no honest alibi can be broken by one.
 */

import { describe, expect, it } from "vitest";
import { Game } from "../src/game/director";
import { actualWhereabouts, cooperationOf } from "../src/investigation/interview";
import { computeContradictions } from "../src/investigation/casefile";
import { voiceOf } from "../src/investigation/voice";
import { fullName } from "../src/world/types";

const SEED = "TESTIMONY-SEED-4";
let gamePromise: Promise<Game> | null = null;
function testGame(): Promise<Game> {
  gamePromise ??= Game.generate(SEED);
  return gamePromise;
}

describe("absence testimony", () => {
  it("negative placements are always verified truth (no fabrication)", async () => {
    const game = await testGame();
    const { world, casefile } = game;
    // Interview widely so absence testimony has chances to appear.
    const alive = world.npcs.filter((n) => n.alive);
    for (const speaker of alive.slice(0, 16)) {
      for (const about of alive.slice(0, 8)) {
        if (speaker.id === about.id) continue;
        game.actInterview(speaker.id, "about-person", about.id);
      }
    }
    const absences = casefile.evidence.filter((e) => e.absentFromBuildingId);
    // Every absence claim must hold against an independent recomputation.
    for (const e of absences) {
      const subject = e.npcIds[0]!;
      const segs = actualWhereabouts(world, subject, e.placesFrom!, e.placesTo!);
      const wasThere = segs.some(
        (s) =>
          s.buildingId === e.absentFromBuildingId &&
          Math.min(s.to, e.placesTo!) - Math.max(s.from, e.placesFrom!) > 0
      );
      expect(wasThere, `absence evidence "${e.title}" contradicts the event log`).toBe(false);
    }
  }, 240_000);

  it("an absence contradiction only ever fires against a false claim", async () => {
    const game = await testGame();
    const { world, casefile } = game;
    const crime = world.crime!;
    // Get the killer's alibi claim on the record too.
    game.actInterview(crime.killerId, "whereabouts");
    const contradictions = computeContradictions(casefile);
    for (const c of contradictions) {
      const st = casefile.statements.find((s) => s.id === c.statementId)!;
      const claim = st.claims[c.claimIndex]!;
      if (!claim.buildingId || claim.buildingId.startsWith("street:")) continue;
      const ev = casefile.evidence.find((e) => e.id === c.evidenceId)!;
      if (!ev.absentFromBuildingId) continue;
      // The claim this absence broke must be genuinely false: the subject was
      // NOT at the claimed building for the full overlap window.
      const segs = actualWhereabouts(world, claim.npcId, claim.from, claim.to);
      const trulyThere = segs.some(
        (s) => s.buildingId === claim.buildingId &&
          Math.min(s.to, ev.placesTo!) - Math.max(s.from, ev.placesFrom!) > 0
      );
      expect(trulyThere, `absence contradiction broke a TRUE claim: ${claim.description}`).toBe(false);
    }
  }, 240_000);

  it("the killer never gives absence testimony (won't reveal their true position)", async () => {
    const game = await testGame();
    const { world, casefile } = game;
    const killer = game.npc(world.crime!.killerId);
    for (const other of world.npcs.filter((n) => n.alive && n.id !== killer.id).slice(0, 10)) {
      game.actInterview(killer.id, "about-person", other.id);
    }
    const killerAbsences = casefile.evidence.filter((e) => {
      if (!e.absentFromBuildingId) return false;
      // Absence testimony given BY the killer would carry their name in the title.
      return e.title.startsWith(fullName(killer));
    });
    expect(killerAbsences).toEqual([]);
  }, 240_000);
});

describe("voices", () => {
  it("voice style is a pure function of the NPC", async () => {
    const game = await testGame();
    for (const n of game.world.npcs) {
      expect(voiceOf(n)).toBe(voiceOf(n));
    }
  }, 240_000);

  it("a town has varied voices", async () => {
    const game = await testGame();
    const styles = new Set(game.world.npcs.map((n) => voiceOf(n)));
    expect(styles.size).toBeGreaterThanOrEqual(3);
  }, 240_000);

  it("identical seeds produce identical statement text", async () => {
    const a = await Game.generate("VOICE-DETERMINISM-1");
    const b = await Game.generate("VOICE-DETERMINISM-1");
    const subject = a.world.npcs.find((n) => n.alive)!;
    const sa = a.actInterview(subject.id, "whereabouts").statement!;
    const sb = b.actInterview(subject.id, "whereabouts").statement!;
    expect(sa.answer).toBe(sb.answer);
    expect(sa.claims).toEqual(sb.claims);
  }, 240_000);
});

describe("reluctant and hostile witnesses", () => {
  it("hostile witnesses refuse, then open up under leverage", async () => {
    const game = await Game.generate("HOSTILE-WITNESS-2");
    const { world, casefile } = game;
    const crime = world.crime!;
    // Force a deterministic hostile subject (pure trait function, so this is
    // a legitimate unit-level probe of the gate).
    const subject = world.npcs.find((n) => n.alive && n.id !== crime.killerId)!;
    subject.personality.aggression = 0.95;
    subject.personality.empathy = 0.05;
    subject.personality.honesty = 0.2;
    expect(cooperationOf(world, casefile, subject)).toBe("hostile");

    const refusalOut = game.actInterview(subject.id, "whereabouts").statement!;
    expect(refusalOut.guarded).toBe(true);
    expect(refusalOut.claims).toEqual([]);

    // Leverage: their own financial records, presented back to them.
    const finance = game.actPullFinance(subject.id).evidence![0]!;
    game.actConfront(subject.id, finance.id);
    expect(casefile.openedUp).toContain(subject.id);
    expect(cooperationOf(world, casefile, subject)).toBe("cooperative");

    const afterOut = game.actInterview(subject.id, "whereabouts").statement!;
    expect(afterOut.guarded).toBeFalsy();
    expect(afterOut.claims.length).toBeGreaterThan(0);
  }, 240_000);

  it("the killer always presents as cooperative, whatever their traits", async () => {
    const game = await testGame();
    const { world, casefile } = game;
    const killer = game.npc(world.crime!.killerId);
    killer.personality.aggression = 0.99;
    killer.personality.empathy = 0.01;
    killer.personality.honesty = 0.01;
    expect(cooperationOf(world, casefile, killer)).toBe("cooperative");
  }, 240_000);

  it("reluctant coarsening never fabricates: every surviving claim is true or a motivated lie", async () => {
    const game = await Game.generate("RELUCTANT-CHECK-3");
    const { world, casefile } = game;
    const crime = world.crime!;
    // Interview everyone; then verify every non-killer, non-secret-covering
    // whereabouts claim against the log.
    for (const n of world.npcs.filter((x) => x.alive).slice(0, 14)) {
      game.actInterview(n.id, "whereabouts");
    }
    for (const st of casefile.statements.filter((s) => s.topic === "whereabouts")) {
      if (st.npcId === crime.killerId) continue; // the alibi is a lie by design
      for (const claim of st.claims) {
        if (!claim.buildingId || claim.npcId !== st.npcId) continue;
        const segs = actualWhereabouts(world, claim.npcId, claim.from, claim.to);
        const matches = segs.some((s) => s.buildingId === claim.buildingId);
        // A false self-claim is only permitted as a secret cover story
        // (claimed home while actually at the secret venue).
        if (!matches) {
          const speaker = game.npc(st.npcId);
          expect(
            claim.buildingId,
            `${fullName(speaker)}'s false claim must be a home cover story: ${claim.description}`
          ).toBe(speaker.homeId);
        }
      }
    }
  }, 240_000);
});
