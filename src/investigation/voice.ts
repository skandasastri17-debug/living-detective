/**
 * Interview voices.
 *
 * Deterministic, personality-driven phrasing so testimony doesn't read the
 * same across cases. Voices change only the WORDS — claims, evidence and
 * every mechanical consequence of a statement are untouched.
 */

import type { Rng } from "../core/rng";
import type { Npc } from "../world/types";

export type VoiceStyle = "curt" | "chatty" | "nervous" | "precise" | "plain";

/** Stable style per person, derived from their traits. */
export function voiceOf(npc: Npc): VoiceStyle {
  const p = npc.personality;
  if (p.fearfulness > 0.62) return "nervous";
  if (p.aggression > 0.6 && p.empathy < 0.55) return "curt";
  if (p.gossip > 0.62) return "chatty";
  if (p.curiosity > 0.58 && p.memoryQuality > 0.55) return "precise";
  return "plain";
}

const OPENERS: Record<VoiceStyle, string[]> = {
  curt: [
    "Make it quick.",
    "Ask what you came to ask.",
    "I've got things to do.",
    "",
  ],
  chatty: [
    "Oh, I was wondering when you'd get to me.",
    "Sit down, sit down — terrible business, all of it.",
    "You know I notice things. Everyone says so.",
    "",
  ],
  nervous: [
    "Am I in trouble? I— fine. Fine.",
    "Keep my name out of this, alright?",
    "I already told the officer everything. But… alright.",
    "",
  ],
  precise: [
    "Let me be exact about this.",
    "I keep a good calendar in my head.",
    "I'll tell you precisely what I know and no more.",
    "",
  ],
  plain: ["", "", "Alright.", "Let's see."],
};

const CLOSERS: Record<VoiceStyle, string[]> = {
  curt: ["That's all you're getting.", "We done?", ""],
  chatty: ["And that's just what I saw myself, mind you.", "Come back if you want the rest of it.", ""],
  nervous: ["That's everything. Really.", "Please — that's all I know.", ""],
  precise: ["That is accurate to the best of my recollection.", ""],
  plain: ["", ""],
};

const REFUSALS: Record<VoiceStyle, string[]> = {
  curt: [
    "I've got nothing to say to a badge.",
    "You're wasting your time and mine.",
  ],
  chatty: [
    "Ohh, no. No no. I talk plenty, but not about this. Not to you.",
    "People who talk to detectives stop getting talked to. I have a life here.",
  ],
  nervous: [
    "I can't. You don't understand — I just can't.",
    "Please don't make me do this. I didn't see anything. I don't KNOW anything.",
  ],
  precise: [
    "I decline to answer. That is my right, and I am exercising it.",
    "Unless you have a warrant with my name on it, we're finished.",
  ],
  plain: [
    "I'd rather not get involved.",
    "Not my business. Not making it my business.",
  ],
};

const GUARDED_HEDGES: Record<VoiceStyle, string[]> = {
  curt: ["That's it. Don't ask twice.", ""],
  chatty: ["…and that's ALL I'm saying, which for me is something.", ""],
  nervous: ["I— that's all I'm comfortable saying.", "That's all. Please."],
  precise: ["Anything further would be speculation, and I don't speculate.", ""],
  plain: ["That's as much as I'll say.", ""],
};

const OPENED_UP: Record<VoiceStyle, string[]> = {
  curt: ["Fine. You've done your homework. Ask."],
  chatty: ["Alright, alright — you clearly already know half of it. Might as well hear it straight."],
  nervous: ["Okay. Okay. If it's already out there, hiding it just makes me look worse."],
  precise: ["Very well. Given what you've assembled, cooperation is the rational course."],
  plain: ["Alright. What do you want to know."],
};

function pickLine(pool: string[], r: Rng): string {
  return r.pick(pool);
}

export function opener(npc: Npc, r: Rng): string {
  return pickLine(OPENERS[voiceOf(npc)], r);
}

export function closer(npc: Npc, r: Rng): string {
  return pickLine(CLOSERS[voiceOf(npc)], r);
}

export function refusal(npc: Npc, r: Rng): string {
  return pickLine(REFUSALS[voiceOf(npc)], r);
}

export function guardedHedge(npc: Npc, r: Rng): string {
  return pickLine(GUARDED_HEDGES[voiceOf(npc)], r);
}

export function openedUpLine(npc: Npc, r: Rng): string {
  return pickLine(OPENED_UP[voiceOf(npc)], r);
}

/** Compose an answer with voice dressing; skips empty fragments. */
export function dress(npc: Npc, r: Rng, body: string, opts: { withCloser?: boolean } = {}): string {
  const parts = [opener(npc, r), body];
  if (opts.withCloser) parts.push(closer(npc, r));
  return parts.filter((p) => p.length > 0).join(" ");
}
