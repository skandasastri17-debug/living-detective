/**
 * Testimony narration.
 *
 * Turns a SimEvent into a sentence told FROM A GIVEN SPEAKER'S POINT OF
 * VIEW. Correctness comes from the speaker's actual role in the event —
 * subject (they did it), object (it was done to them), or witness (it
 * happened between two other people) — never from blind string
 * substitution on the canonical third-person summary (that produced
 * nonsense like "Cornelius argued heatedly with I").
 *
 * Phrasing is seeded per (event, speaker), so the same witness always
 * tells the same event the same way on re-ask (no flip-flopping that would
 * read as a contradiction bug), but different witnesses of the SAME event
 * naturally phrase it differently — the fix for "everyone gives the exact
 * same answer, just with different names."
 */

import { Rng, hashString } from "../core/rng";
import type { NpcId, SimEvent, World } from "../world/types";
import { buildingById, fullName } from "../world/types";

type Role = "subject" | "object" | "witness";

interface RoleTemplates {
  subject: string[];
  object: string[];
  witness: string[];
}

function roleOf(ev: SimEvent, npcId: NpcId): Role {
  if (ev.actorIds.includes(npcId)) return "subject";
  if (ev.targetIds.includes(npcId)) return "object";
  return "witness";
}

function nameOf(world: World, id: NpcId | undefined): string {
  const n = id ? world.npcs.find((x) => x.id === id) : undefined;
  return n ? fullName(n) : "someone";
}

function whereClause(world: World, ev: SimEvent): string {
  if (ev.buildingId) {
    try {
      return ` at ${buildingById(world, ev.buildingId).name}`;
    } catch {
      return "";
    }
  }
  if (ev.streetName) return ` on ${ev.streetName}`;
  return "";
}

const TEMPLATES: Partial<Record<SimEvent["kind"], RoleTemplates>> = {
  "argue": {
    subject: [
      "I argued with {other}{where}",
      "{other} and I got into it{where} — heated words",
      "I had words with {other}",
      "{other} and I went back and forth pretty hard{where}",
      "I raised my voice at {other}{where}, I'm not proud to say",
      "{other} and I butted heads{where}",
    ],
    object: [
      "{actor} argued with me{where}",
      "{actor} laid into me over something",
      "{actor} and I went at it{where} — they started it",
      "{actor} came at me pretty hard{where}",
      "{actor} raised their voice at me{where}",
      "{actor} and I butted heads{where}, if you want the truth",
    ],
    witness: [
      "{actor} and {target} argued{where}",
      "{actor} and {target} were really going at each other{where}",
      "{actor} had words with {target}{where}",
      "there was a real row between {actor} and {target}{where}",
      "{actor} was shouting at {target}{where}",
      "{actor} and {target} couldn't agree on something{where}, loudly",
    ],
  },
  "fight": {
    subject: [
      "things turned physical between {other} and me{where}",
      "I got into it physically with {other}",
      "{other} and I came to blows{where}",
      "{other} and I actually threw hands{where}",
    ],
    object: [
      "{actor} came at me physically{where}",
      "{actor} got physical with me{where}",
      "{actor} took a swing at me{where}",
    ],
    witness: [
      "{actor} and {target} came to blows{where}",
      "{actor} got physical with {target}{where}",
      "it turned into an actual fight between {actor} and {target}{where}",
      "{actor} took a swing at {target}{where}",
    ],
  },
  "flirt": {
    subject: [
      "I was flirting with {other}, if you must know",
      "I was making eyes at {other}{where}",
    ],
    object: [
      "{actor} was flirting with me{where}",
      "{actor} was making a play for me",
    ],
    witness: [
      "{actor} was flirting with {target}{where}",
      "{actor} was making eyes at {target}{where}",
    ],
  },
  "affair-meeting": {
    subject: [
      "I met {other} somewhere private{where} — you already know why",
      "{other} and I met, just the two of us",
    ],
    object: [
      "{actor} and I met privately{where}",
      "{actor} came to see me alone{where}",
    ],
    witness: [
      "{actor} met {target} somewhere private{where}",
      "{actor} and {target} slipped off together",
    ],
  },
  "theft": {
    subject: [
      "I took something that wasn't mine{where}",
      "I helped myself to something I shouldn't have{where}",
    ],
    object: [
      "{actor} stole from me{where}",
      "{actor} took something of mine",
    ],
    witness: [
      "{actor} stole from {target}{where}",
      "{actor} took something that belonged to {target}{where}",
    ],
  },
  "blackmail-demand": {
    subject: [
      "I leaned on {other} for money{where} — they had it coming",
      "I made {other} pay up over something they'd done",
    ],
    object: [
      "{actor} was squeezing me for money{where}",
      "{actor} wanted money to keep quiet about something",
    ],
    witness: [
      "{actor} was squeezing {target} for money{where}",
      "{actor} wanted {target} to pay up over something",
    ],
  },
  "loan-demand": {
    subject: [
      "I went to collect what {other} owed me{where}",
      "I told {other} it was time to pay up",
    ],
    object: [
      "{actor} came around about money I owed{where}",
      "{actor} wanted their money back, and made sure I knew it",
    ],
    witness: [
      "{actor} was after {target} for money owed{where}",
      "{actor} pressed {target} pretty hard about a debt{where}",
    ],
  },
  "sighting": {
    subject: [
      "I saw {other} out and about{where}",
      "I noticed {other}{where}",
    ],
    object: [],
    witness: [
      "{actor} mentioned seeing {target} out that night",
    ],
  },
  "body-discovered": {
    subject: [
      "I'm the one who found the body",
      "I found them{where}",
    ],
    object: [],
    witness: [
      "{actor} was the one who found the body",
    ],
  },
  "chat": {
    subject: [
      "I chatted with {other}{where}",
      "{other} and I got to talking{where}",
    ],
    object: [
      "{actor} chatted with me{where}",
      "{actor} got to talking with me{where}",
    ],
    witness: [
      "{actor} chatted with {target}{where}",
      "{actor} and {target} were talking{where}",
    ],
  },
  "gossip": {
    subject: ["I mentioned something to {other}", "I passed something along to {other}"],
    object: ["{actor} told me something", "{actor} mentioned something to me"],
    witness: ["{actor} was talking with {target} about someone"],
  },
  "arrive": {
    subject: ["I arrived{where}", "I got in{where}"],
    object: [],
    witness: ["{actor} arrived{where}", "{actor} got in{where}"],
  },
  "depart": {
    subject: ["I left{where}", "I headed out{where}"],
    object: [],
    witness: ["{actor} left{where}", "{actor} headed out{where}"],
  },
  "purchase": {
    subject: ["I made a purchase{where}", "I paid for something{where}"],
    object: ["{actor} paid me for something{where}"],
    witness: ["{actor} made a purchase{where}"],
  },
  "phone-call": {
    subject: ["I called {other}", "I rang {other}"],
    object: ["{actor} called me", "{actor} rang me"],
    witness: ["{actor} called {target}"],
  },
  "missed-work": {
    subject: ["I missed a shift{where}"],
    object: [],
    witness: ["{actor} missed a shift{where}"],
  },
  "scream-heard": {
    subject: [],
    object: [],
    witness: ["I heard someone scream{where}", "there was a scream{where} — chilling, honestly"],
  },
};

const GENERIC: RoleTemplates = {
  subject: ["something happened between {other} and me{where}"],
  object: ["{actor} was involved in something with me{where}"],
  witness: ["{actor} and {target} were involved in something{where}"],
};

/**
 * Describe `ev` in natural language from `speakerId`'s point of view.
 * Deterministic per (event, speaker): stable across re-asks, but varies
 * between different witnesses of the same event.
 */
export function narrateEvent(world: World, speakerId: NpcId, ev: SimEvent): string {
  const role = roleOf(ev, speakerId);
  const templates = TEMPLATES[ev.kind];
  let pool = templates?.[role] ?? [];
  if (pool.length === 0) pool = GENERIC[role];

  const r = new Rng((world.seed ^ hashString(`narrate:${ev.id}:${speakerId}`)) >>> 0);
  const template = r.pick(pool);

  const otherId = [...ev.actorIds, ...ev.targetIds].find((id) => id !== speakerId);
  const filled = template
    .replaceAll("{other}", nameOf(world, otherId))
    .replaceAll("{actor}", nameOf(world, ev.actorIds[0]))
    .replaceAll("{target}", nameOf(world, ev.targetIds[0]))
    .replaceAll("{where}", whereClause(world, ev));
  // Collapse any double spaces left by an empty {where}.
  return filled.replace(/\s+/g, " ").trim();
}
