/**
 * Interviews.
 *
 * Answers are generated from what the NPC actually remembers (their memory
 * log), what they actually did (the event log), and who they are (traits,
 * loyalties, secrets). Lies are motivated: the killer defends a fabricated
 * alibi; people with secrets in the window cover that segment; loyal
 * partners may cover for each other. Lies produce *claims* that can be
 * mechanically contradicted by collected evidence.
 */

import { Rng, hashString } from "../core/rng";
import { fmtClock, fmtTime, fmtTimeLong, type SimTime } from "../core/time";
import type { Npc, NpcId, SimEvent, World } from "../world/types";
import { buildingById, fullName, relationshipBetween } from "../world/types";
import { recallAbout, recallQuality, recallWindow, type RecallQuality } from "../sim/memory";
import {
  addEvidence, addRelationFact, addStatement, computeContradictions, learnFactFromSecret,
  type CaseFile, type Claim, type EvidenceEntry, type Statement,
} from "./casefile";
import { dress, guardedHedge, openedUpLine, refusal } from "./voice";
import { difficultyOf } from "../world/difficulty";
import { narrateEvent } from "./narration";

function rngFor(world: World, npc: Npc, label: string): Rng {
  return new Rng((world.seed ^ hashString(`iv:${npc.id}:${label}`)) >>> 0);
}

// ----------------------------------------------------------------- cooperation

export type Cooperation = "cooperative" | "reluctant" | "hostile";

/**
 * How willing is this person to talk to a detective? Deterministic, from
 * traits and stakes. The killer always presents as cooperative — refusing
 * outright would draw attention, and their alibi needs an audience.
 * Leverage (a confrontation with evidence touching them) opens anyone up.
 */
export function cooperationOf(world: World, cf: CaseFile, npc: Npc): Cooperation {
  if (cf.openedUp.includes(npc.id)) return "cooperative";
  if (world.crime && npc.id === world.crime.killerId) return "cooperative";
  const p = npc.personality;
  let score = 0.55 + p.empathy * 0.25 + p.honesty * 0.2 - p.aggression * 0.3 - difficultyOf(world).cooperationPenalty;
  const secrets = npc.secretIds
    .map((id) => world.secrets[id])
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  if (secrets.some((s) => s.kind === "criminal-past")) score -= 0.3;
  if (secrets.some((s) => s.kind === "being-blackmailed")) score -= 0.2;
  if (secrets.some((s) => s.kind === "affair" || s.kind === "theft")) score -= 0.1;
  const relV = npc.relationships[cf.victimId];
  if (relV && relV.friendship < -0.3) score -= 0.15; // wants no part of it
  if (relV && relV.friendship > 0.4) score += 0.25; // wants the killer caught
  if (score < 0.32) return "hostile";
  if (score < 0.5) return "reluctant";
  return "cooperative";
}

// -------------------------------------------------- whereabouts reconstruction

export interface Segment {
  from: SimTime;
  to: SimTime;
  buildingId: string;
}

/** Ground truth: where was this NPC, from the arrive/depart event trail? */
export function actualWhereabouts(world: World, npcId: NpcId, from: SimTime, to: SimTime): Segment[] {
  const moves = world.eventLog
    .filter((e) => (e.kind === "arrive" || e.kind === "depart") && e.actorIds[0] === npcId && e.t <= to)
    .sort((a, b) => a.t - b.t);
  const segments: Segment[] = [];
  let curBuilding: string | null = null;
  let curStart = 0;
  for (const m of moves) {
    if (m.kind === "arrive") {
      curBuilding = m.buildingId;
      curStart = m.t;
    } else if (m.kind === "depart" && curBuilding === m.buildingId) {
      if (curBuilding && m.t > from) {
        segments.push({ from: Math.max(curStart, from), to: Math.min(m.t, to), buildingId: curBuilding });
      }
      curBuilding = null;
    }
  }
  if (curBuilding) {
    segments.push({ from: Math.max(curStart, from), to, buildingId: curBuilding });
  }
  // If no movement recorded before `from`, they were wherever their first
  // depart says — or home. Cover the leading gap.
  if (segments.length === 0 || segments[0]!.from > from) {
    const firstDepart = moves.find((m) => m.kind === "depart" && m.t >= from);
    const npc = world.npcs.find((n) => n.id === npcId)!;
    const leadingBuilding = firstDepart ? firstDepart.buildingId! : segments[0]?.buildingId ?? npc.homeId;
    const leadEnd = segments[0]?.from ?? (firstDepart ? Math.min(firstDepart.t, to) : to);
    segments.unshift({ from, to: leadEnd, buildingId: leadingBuilding });
  }
  return segments.filter((s) => s.to > s.from);
}

/** Secret events involving this NPC inside the window (things worth lying about). */
function secretEventsIn(world: World, npcId: NpcId, from: SimTime, to: SimTime): SimEvent[] {
  return world.eventLog.filter(
    (e) =>
      e.t >= from && e.t <= to &&
      ["affair-meeting", "theft", "blackmail-demand", "murder"].includes(e.kind) &&
      (e.actorIds.includes(npcId) || (e.kind === "affair-meeting" && e.targetIds.includes(npcId)))
  );
}

// ---------------------------------------------------------------- questions

export function askWhereabouts(
  world: World, cf: CaseFile, npc: Npc, from: SimTime, to: SimTime
): Statement {
  const r = rngFor(world, npc, `where:${from}`);
  const crime = world.crime;
  const claims: Claim[] = [];
  let answer: string;

  const isKiller = crime !== null && npc.id === crime.killerId;
  const overlapsMurder = crime !== null && crime.murderTime >= from - 30 && crime.murderTime <= to + 30;
  const coop = cooperationOf(world, cf, npc);

  if (coop === "hostile") {
    return addStatement(cf, {
      npcId: npc.id, t: world.time, topic: "whereabouts", aboutNpcId: null,
      question: `Where were you between ${fmtTime(from)} and ${fmtTime(to)}?`,
      answer: refusal(npc, r),
      claims: [],
      guarded: true,
    });
  }

  if (isKiller && overlapsMurder) {
    // The fabricated alibi, defended as one solid claim.
    const claimedId = alibiClaimedBuilding(world, npc);
    claims.push({
      npcId: npc.id, from, to, buildingId: claimedId,
      description: `${npc.first} says they were at ${buildingById(world, claimedId).name} from ${fmtClock(from)} to ${fmtClock(to)}`,
    });
    answer = crime.alibiClaim;
  } else {
    let truth = actualWhereabouts(world, npc.id, from, to);
    // Reluctant witnesses give the coarse version: brief stops go unmentioned.
    // Honest omission — no claim is made about the skipped stretch, so an
    // innocent's terse account can't produce a false contradiction.
    if (coop === "reluctant") truth = truth.filter((seg) => seg.to - seg.from >= 60);
    const secretEvs = secretEventsIn(world, npc.id, from, to).filter((e) => e.kind !== "murder");
    const secretBuildings = new Set(secretEvs.map((e) => e.buildingId));
    const parts: string[] = [];
    for (const seg of truth) {
      const b = buildingById(world, seg.buildingId);
      const hideThis = secretBuildings.has(seg.buildingId) && npc.personality.honesty < 0.75;
      if (hideThis) {
        // Cover story: claim home for that stretch.
        const home = buildingById(world, npc.homeId);
        claims.push({
          npcId: npc.id, from: seg.from, to: seg.to, buildingId: npc.homeId,
          description: `${npc.first} says they were at ${home.name} between ${fmtClock(seg.from)} and ${fmtClock(seg.to)}`,
        });
        parts.push(r.pick([`then I went home for a while`, `then home for a bit`, `and after that, home`]));
      } else {
        claims.push({
          npcId: npc.id, from: seg.from, to: seg.to, buildingId: seg.buildingId,
          description: `${npc.first} says they were at ${b.name} between ${fmtClock(seg.from)} and ${fmtClock(seg.to)}`,
        });
        const label = seg.buildingId === npc.homeId ? "home" : `at ${b.name}`;
        parts.push(r.pick([
          `${label} from about ${fmtClock(seg.from)} to ${fmtClock(seg.to)}`,
          `${label}, roughly ${fmtClock(seg.from)} until ${fmtClock(seg.to)}`,
        ]));
      }
    }
    const body = parts.length > 0
      ? `I was ${parts.join(", ")}.`
      : r.pick([
          `Honestly, I couldn't tell you. It was an ordinary stretch of time.`,
          `Nothing memorable — I couldn't pin down where exactly.`,
          `That's a blur, honestly. Nothing was happening, so I wasn't keeping track.`,
        ]);
    answer = coop === "reluctant"
      ? [body, guardedHedge(npc, r)].filter(Boolean).join(" ")
      : dress(npc, r, body, { withCloser: r.chance(0.35) });
  }

  return addStatement(cf, {
    npcId: npc.id, t: world.time, topic: "whereabouts", aboutNpcId: null,
    question: `Where were you between ${fmtTime(from)} and ${fmtTime(to)}?`,
    answer, claims,
    guarded: coop === "reluctant",
  });
}

function alibiClaimedBuilding(world: World, killer: Npc): string {
  const crime = world.crime!;
  // The alibi text was generated from the killer's routine location.
  if (crime.alibiClaim.includes("home")) return killer.homeId;
  const named = world.city.buildings.find((b) => crime.alibiClaim.includes(b.name));
  return named?.id ?? killer.homeId;
}

export function askLastSawVictim(world: World, cf: CaseFile, npc: Npc): Statement {
  const r = rngFor(world, npc, "lastsaw");
  const victimId = cf.victimId;
  const victim = world.npcs.find((n) => n.id === victimId)!;
  const crime = world.crime;
  const claims: Claim[] = [];
  let answer: string;
  const coop = cooperationOf(world, cf, npc);

  if (coop === "hostile") {
    return addStatement(cf, {
      npcId: npc.id, t: world.time, topic: "last-saw-victim", aboutNpcId: victimId,
      question: `When did you last see ${fullName(victim)}?`,
      answer: refusal(npc, r),
      claims: [],
      guarded: true,
    });
  }

  let recalled = recallAbout(npc, victimId);
  if (crime && npc.id === crime.killerId) {
    // The killer conceals the final encounter.
    recalled = recalled.filter((x) => x.m.eventId !== crime.murderEventId && x.m.t < crime.murderTime - 30);
  }
  // The reluctant only commit to what they're sure of.
  if (coop === "reluctant") recalled = recalled.filter((x) => x.q === "vivid");
  const top = recalled[0];
  if (!top) {
    answer = r.chance(0.5)
      ? `I can't say I remember the last time I saw ${victim.first}.`
      : `We didn't cross paths much lately.`;
  } else {
    const when = describeWhen(top.m.t, top.q, r);
    const where = top.m.buildingId ? buildingById(world, top.m.buildingId).name : "around town";
    const ev = world.eventLog.find((e) => e.id === top.m.eventId);
    const told = ev ? narrateEvent(world, npc.id, ev) : top.m.summary;
    answer = `${when}, at ${where}. ${capitalize(told)}.`;
    if (top.m.buildingId) {
      const spread = top.q === "vivid" ? 15 : 45;
      claims.push({
        npcId: victimId, from: top.m.t - spread, to: top.m.t + spread, buildingId: top.m.buildingId,
        description: `${npc.first} places ${victim.first} at ${where} around ${fmtClock(top.m.t)}`,
      });
    }
  }

  return addStatement(cf, {
    npcId: npc.id, t: world.time, topic: "last-saw-victim", aboutNpcId: victimId,
    question: `When did you last see ${fullName(victim)}?`, answer, claims,
    guarded: coop === "reluctant",
  });
}

export function askRelationshipWithVictim(world: World, cf: CaseFile, npc: Npc): Statement {
  const victim = world.npcs.find((n) => n.id === cf.victimId)!;
  const rel = relationshipBetween(npc, victim.id);
  const r = rngFor(world, npc, "relvic");
  const coop = cooperationOf(world, cf, npc);
  const question = `What was your relationship with ${fullName(victim)}?`;

  if (coop === "hostile") {
    return addStatement(cf, {
      npcId: npc.id, t: world.time, topic: "relationship-victim", aboutNpcId: victim.id,
      question, answer: refusal(npc, r), claims: [], guarded: true,
    });
  }

  let body: string;
  if (npc.partnerId === victim.id) {
    const spouseWord = victim.gender === "f" ? "wife" : "husband";
    body = r.pick([
      `${victim.first} was my ${spouseWord}. I don't know how to talk about this yet.`,
      `My ${spouseWord}. I keep expecting to hear the door and it'll be ${victim.gender === "f" ? "her" : "him"}.`,
      `We were married. I still can't say it in the past tense.`,
    ]);
  } else if (rel.friendship > 0.45) {
    body = r.pick([
      `We were close. ${victim.first} was one of the good ones. Find who did this.`,
      `${victim.first} was a real friend. This whole town's worse off without ${victim.gender === "f" ? "her" : "him"}.`,
      `We looked out for each other. I still don't believe ${victim.gender === "f" ? "she's" : "he's"} gone.`,
    ]);
  } else if (rel.friendship < -0.3) {
    // Dishonest people play it down; honest ones admit friction.
    body = npc.personality.honesty < 0.45
      ? r.pick([
          `We got along fine. We weren't close, but there was no trouble between us.`,
          `Nothing to tell. We kept things civil.`,
        ])
      : r.pick([
          `I won't pretend we were friends. We had our differences — that's no secret. But I didn't want ${victim.gender === "f" ? "her" : "him"} dead.`,
          `Truth is, we didn't get along. I'll say that to your face rather than have you hear it from someone else. Doesn't mean I did anything.`,
        ]);
  } else if (rel.debt > 300) {
    if (npc.personality.honesty < 0.5) {
      body = r.pick([`Acquaintances, nothing more.`, `Barely knew ${victim.first}, honestly.`]);
    } else {
      body = r.pick([
        `I owed ${victim.first} money, if that's what you're digging at. Doesn't mean anything.`,
        `We had a financial arrangement — I owed ${victim.gender === "f" ? "her" : "him"} some money. That's all it was.`,
      ]);
      const admission = addEvidence(cf, {
        kind: "testimony",
        title: `${fullName(npc)} admits owing the victim money`,
        detail: `${fullName(npc)} admitted owing ${fullName(victim)} $${rel.debt}.`,
        discoveredAt: world.time,
        buildingId: null, itemId: null,
        npcIds: [npc.id, victim.id],
        placesAtBuildingId: null, placesFrom: null, placesTo: null,
        motiveHint: true,
      });
      addRelationFact(cf, npc.id, victim.id, "debt", admission.id, `owed ${fullName(victim)} $${rel.debt}`);
    }
  } else {
    body = r.pick([
      `We knew each other the way everyone here knows each other.`,
      `Neighbors, more or less. Nothing between us.`,
      `Just faces to each other, really.`,
      `Barely more than a nod on the street, if I'm honest.`,
    ]);
  }

  const answer = coop === "reluctant"
    ? [body, guardedHedge(npc, r)].filter(Boolean).join(" ")
    : dress(npc, r, body, { withCloser: r.chance(0.25) });

  return addStatement(cf, {
    npcId: npc.id, t: world.time, topic: "relationship-victim", aboutNpcId: victim.id,
    question, answer, claims: [],
    guarded: coop === "reluctant",
  });
}

export function askAnythingUnusual(world: World, cf: CaseFile, npc: Npc): Statement {
  const crime = world.crime;
  const r = rngFor(world, npc, "unusual");
  const from = crime ? crime.murderTime - 24 * 60 : world.time - 36 * 60;
  const to = crime ? crime.murderTime + 12 * 60 : world.time;
  const isKiller = crime !== null && npc.id === crime.killerId;
  const coop = cooperationOf(world, cf, npc);

  if (coop === "hostile") {
    return addStatement(cf, {
      npcId: npc.id, t: world.time, topic: "anything-unusual", aboutNpcId: null,
      question: `Did you see or hear anything unusual recently?`,
      answer: refusal(npc, r),
      claims: [],
      guarded: true,
    });
  }

  let memories = recallWindow(npc, from, to).filter((x) => {
    const ev = world.eventLog.find((e) => e.id === x.m.eventId);
    if (!ev) return false;
    if (isKiller && crime && (ev.id === crime.murderEventId || ev.actorIds.includes(npc.id))) return false;
    return ["fight", "argue", "scream-heard", "sighting", "theft", "blackmail-demand", "body-discovered", "intimidation"].includes(ev.kind);
  });
  if (coop === "reluctant") memories = memories.filter((x) => x.q === "vivid");
  memories = memories.slice(0, coop === "reluctant" ? 1 : 3);

  const claims: Claim[] = [];
  let answer: string;
  if (memories.length === 0) {
    answer = r.pick([
      `Nothing that stands out. It was a week like any other.`,
      `Quiet, mostly. Or I wasn't paying attention.`,
      `No. And believe me, I've been racking my brain since I heard.`,
    ]);
  } else {
    const lines: string[] = [];
    for (const { m, q } of memories) {
      const when = describeWhen(m.t, q, r);
      const ev = world.eventLog.find((e) => e.id === m.eventId);
      const told = ev ? narrateEvent(world, npc.id, ev) : m.summary;
      lines.push(`${when} — ${told}`);
      if (ev && ev.kind === "sighting" && ev.targetIds[0]) {
        const spread = q === "vivid" ? 20 : 50;
        claims.push({
          npcId: ev.targetIds[0], from: m.t - spread, to: m.t + spread,
          buildingId: ev.streetName ? `street:${ev.streetName}` : null,
          description: `${npc.first} saw ${nameOf(world, ev.targetIds[0])} on ${ev.streetName ?? "the street"} around ${fmtClock(m.t)}`,
        });
      } else if (ev && ev.buildingId && ev.actorIds[0] && ev.actorIds[0] !== npc.id) {
        claims.push(placementFromWitnessedEvent(world, npc, ev, m.t, q));
      }
    }
    const body = `${lines.join(". ")}.`;
    answer = coop === "reluctant"
      ? ["One thing.", body, guardedHedge(npc, r)].filter(Boolean).join(" ")
      : dress(npc, r, `A few things, now that you ask. ${body}`);
  }

  const st = addStatement(cf, {
    npcId: npc.id, t: world.time, topic: "anything-unusual", aboutNpcId: null,
    question: `Did you see or hear anything unusual recently?`, answer, claims,
    guarded: coop === "reluctant",
  });
  // Solid testimony becomes evidence the player can cite.
  for (const c of claims) {
    addEvidence(cf, {
      kind: "testimony",
      title: `${fullName(npc)}: ${c.description}`,
      detail: `${fullName(npc)} testified: "${c.description}" (interviewed ${fmtTimeLong(world.time)})`,
      discoveredAt: world.time,
      buildingId: c.buildingId && !c.buildingId.startsWith("street:") ? c.buildingId : null,
      itemId: null,
      npcIds: [c.npcId],
      placesAtBuildingId: c.buildingId,
      placesFrom: c.from,
      placesTo: c.to,
    });
  }
  return st;
}

/**
 * The canonical canvass question: "who had trouble with the victim?"
 * Surfaces feud memories about ANYONE versus the victim — the natural way
 * a suspect first enters the frame. The killer answers too, but omits
 * their own history with the victim.
 */
export function askWhoHadTrouble(world: World, cf: CaseFile, npc: Npc): Statement {
  const r = rngFor(world, npc, `enemies:${cf.statements.length}`);
  const victimId = cf.victimId;
  const victim = world.npcs.find((n) => n.id === victimId)!;
  const coop = cooperationOf(world, cf, npc);
  const question = `Who had trouble with ${fullName(victim)}?`;

  if (coop === "hostile") {
    return addStatement(cf, {
      npcId: npc.id, t: world.time, topic: "enemies", aboutNpcId: victimId,
      question, answer: refusal(npc, r), claims: [], guarded: true,
    });
  }

  const isKiller = world.crime !== null && npc.id === world.crime.killerId;
  const feudKinds = ["argue", "fight", "loan-demand", "blackmail-demand"];
  // Group feud memories by the other party.
  const byParty = new Map<NpcId, { strength: number; memories: typeof npc.memories }>();
  for (const m of npc.memories) {
    if (!m.aboutIds.includes(victimId)) continue;
    const ev = world.eventLog.find((e) => e.id === m.eventId);
    if (!ev || !feudKinds.includes(ev.kind)) continue;
    const other = [...ev.actorIds, ...ev.targetIds].find((id) => id !== victimId && id !== npc.id);
    if (!other) continue;
    if (isKiller && other === npc.id) continue; // self-preservation
    if (other === npc.id) continue; // own feuds come out under about-person/confrontation, not volunteered
    const bucket = byParty.get(other) ?? { strength: 0, memories: [] };
    bucket.strength += m.strength;
    bucket.memories.push(m);
    byParty.set(other, bucket);
  }
  let parties = [...byParty.entries()].sort((a, b) => b[1].strength - a[1].strength);
  if (coop === "reluctant") parties = parties.slice(0, 1);
  else parties = parties.slice(0, 3);

  const lines: string[] = [];
  if (parties.length === 0) {
    lines.push(r.pick([
      `Trouble? Not that I ever saw. ${victim.first} kept a quiet life, far as I knew.`,
      `Nobody comes to mind. Which is what unsettles me.`,
    ]));
  } else {
    for (const [otherId, bucket] of parties) {
      const other = world.npcs.find((n) => n.id === otherId);
      if (!other) continue;
      const top = bucket.memories.sort((a, b) => b.strength - a.strength)[0]!;
      const topEv = world.eventLog.find((e) => e.id === top.eventId);
      const told = topEv ? narrateEvent(world, npc.id, topEv) : top.summary;
      lines.push(`${capitalize(told)}, ${describeWhen(top.t, recallQuality(top.strength), r).toLowerCase()}.`);
      const feudEvidence = addEvidence(cf, {
        kind: "testimony",
        title: `${fullName(npc)} names ${other.first}: ${top.summary}`,
        detail: `Asked who had trouble with ${fullName(victim)}, ${fullName(npc)} named ${fullName(other)}: "${top.summary}" (${fmtTimeLong(top.t)}).`,
        discoveredAt: world.time,
        buildingId: top.buildingId, itemId: null,
        npcIds: [otherId, victimId],
        placesAtBuildingId: null, placesFrom: null, placesTo: null,
        motiveHint: true,
      });
      addRelationFact(cf, otherId, victimId, "feud", feudEvidence.id, top.summary);
    }
  }
  const body = lines.join(" ");
  return addStatement(cf, {
    npcId: npc.id, t: world.time, topic: "enemies", aboutNpcId: victimId,
    question,
    answer: coop === "reluctant"
      ? [body, guardedHedge(npc, r)].filter(Boolean).join(" ")
      : dress(npc, r, body),
    claims: [],
    guarded: coop === "reluctant",
  });
}

export function askAboutPerson(world: World, cf: CaseFile, npc: Npc, aboutId: NpcId): Statement {
  const about = world.npcs.find((n) => n.id === aboutId)!;
  const r = rngFor(world, npc, `about:${aboutId}:${cf.statements.length}`);
  const rel = relationshipBetween(npc, aboutId);
  const loyalty = rel.friendship * 0.6 + rel.trust * 0.4 + (npc.partnerId === aboutId ? 0.5 : 0);
  const claims: Claim[] = [];
  const lines: string[] = [];
  const coop = cooperationOf(world, cf, npc);

  if (coop === "hostile") {
    return addStatement(cf, {
      npcId: npc.id, t: world.time, topic: "about-person", aboutNpcId: aboutId,
      question: `Tell me about ${fullName(about)}.`,
      answer: refusal(npc, r),
      claims: [],
      guarded: true,
    });
  }

  // Intimidated witnesses clam up about their intimidator — until leverage
  // opens them, at which point the intimidation itself becomes evidence.
  const intimidation = world.eventLog.find(
    (e) => e.kind === "intimidation" && e.actorIds[0] === aboutId && e.targetIds[0] === npc.id
  );
  if (intimidation && !cf.openedUp.includes(npc.id)) {
    return addStatement(cf, {
      npcId: npc.id, t: world.time, topic: "about-person", aboutNpcId: aboutId,
      question: `Tell me about ${fullName(about)}.`,
      answer: r.pick([
        `Look — I have nothing to say about ${about.first}. Nothing. Please leave it.`,
        `${about.first}? I don't… no. I can't help you with that. I'm sorry.`,
      ]),
      claims: [],
      guarded: true,
    });
  }
  if (intimidation && cf.openedUp.includes(npc.id)) {
    lines.push(
      `There's something you need to know. After it happened, ${about.first} cornered me — told me to forget what I saw. I've been terrified.`
    );
    const guilt = addEvidence(cf, {
      kind: "testimony",
      title: `${fullName(npc)}: ${about.first} warned them to stay quiet`,
      detail: `${fullName(npc)} testified that ${fullName(about)} confronted them after the murder (${fmtTimeLong(intimidation.t)}) and told them to forget what they had seen. Witness intimidation.`,
      discoveredAt: world.time,
      buildingId: intimidation.buildingId, itemId: null,
      npcIds: [aboutId],
      placesAtBuildingId: intimidation.buildingId,
      placesFrom: intimidation.t - 10,
      placesTo: intimidation.t + 10,
      consciousnessOfGuilt: true,
    });
    addRelationFact(cf, aboutId, npc.id, "blackmail", guilt.id, "warned them to stay quiet about the murder night");
  }

  // Impression.
  if (rel.friendship > 0.4) {
    lines.push(r.pick([
      `${about.first}? Good people. I'd vouch for ${about.gender === "f" ? "her" : "him"}.`,
      `${about.first} and I get along well. Always have.`,
      `I like ${about.first}. Can't say a bad word about ${about.gender === "f" ? "her" : "him"}.`,
    ]));
  } else if (rel.friendship < -0.3) {
    lines.push(r.pick([
      `I keep my distance from ${about.first}. Always have.`,
      `${about.first} and I don't see eye to eye. Never have.`,
      `I try not to have much to do with ${about.first}, if I'm honest.`,
    ]));
  } else {
    lines.push(r.pick([
      `I don't know ${about.first} well.`,
      `${about.first}? Not someone I know much about.`,
      `We're not close. I couldn't tell you much.`,
    ]));
  }

  // Secrets they know about this person — shared if gossipy or hostile, kept if loyal.
  const known = Object.values(world.secrets).filter(
    (s) => s.holderId === aboutId && (s.knownBy.includes(npc.id))
  );
  const shareThreshold = coop === "reluctant" ? 0.55 : 0.25;
  for (const s of known) {
    const willShare = npc.personality.gossip * 0.7 + Math.max(0, -rel.friendship) * 0.6 - Math.max(0, loyalty) * 0.8;
    if (willShare > shareThreshold || (coop !== "reluctant" && r.chance(Math.max(0, willShare)))) {
      lines.push(`You didn't hear this from me, but ${about.first} ${s.description}.`);
      const disclosure = addEvidence(cf, {
        kind: "testimony",
        title: `Word around town: ${about.first} ${s.description}`,
        detail: `${fullName(npc)} disclosed: ${fullName(about)} ${s.description}.`,
        discoveredAt: world.time,
        buildingId: null, itemId: null,
        npcIds: s.otherId ? [aboutId, s.otherId] : [aboutId],
        placesAtBuildingId: null, placesFrom: null, placesTo: null,
        motiveHint: true,
      });
      learnFactFromSecret(cf, s, disclosure.id);
    }
  }

  // Bad blood: witnessed clashes between this person and the victim — the
  // testimony that documents a motive.
  const crimeForFeud = world.crime;
  if (crimeForFeud && aboutId !== crimeForFeud.victimId) {
    const victimId = crimeForFeud.victimId;
    const feudMemories = npc.memories
      .filter((m) => {
        if (!m.aboutIds.includes(aboutId) || !m.aboutIds.includes(victimId)) return false;
        const ev = world.eventLog.find((e) => e.id === m.eventId);
        return ev !== undefined && ["argue", "fight", "loan-demand", "blackmail-demand", "flirt", "affair-meeting"].includes(ev.kind);
      })
      .sort((a, b) => b.strength - a.strength)
      .slice(0, coop === "reluctant" ? 1 : 2);
    for (const m of feudMemories) {
      const feudEv = world.eventLog.find((e) => e.id === m.eventId);
      const feudTold = feudEv ? narrateEvent(world, npc.id, feudEv) : m.summary;
      lines.push(`${capitalize(feudTold)}, ${describeWhen(m.t, "vague", r).toLowerCase()}.`);
      const feudEvidence = addEvidence(cf, {
        kind: "testimony",
        title: `${fullName(npc)} on ${about.first} and the victim: ${m.summary}`,
        detail: `${fullName(npc)} recalled: "${m.summary}" (${fmtTimeLong(m.t)}). Possible motive material.`,
        discoveredAt: world.time,
        buildingId: m.buildingId, itemId: null,
        npcIds: [aboutId, victimId],
        placesAtBuildingId: null, placesFrom: null, placesTo: null,
        motiveHint: true,
      });
      const ev = world.eventLog.find((e) => e.id === m.eventId);
      const feudish = ev && ["argue", "fight", "loan-demand", "blackmail-demand"].includes(ev.kind);
      addRelationFact(cf, aboutId, victimId, feudish ? "feud" : "romance", feudEvidence.id, m.summary);
    }
  }

  // Murder-night knowledge about this person (memories or cover).
  const crime = world.crime;
  if (crime) {
    const wFrom = crime.murderTime - 120;
    const wTo = crime.murderTime + 120;
    const sawThem = recallWindow(npc, wFrom, wTo).filter((x) => x.m.aboutIds.includes(aboutId));
    const sameHouse = npc.householdId === about.householdId;
    if (sawThem.length > 0) {
      const { m, q } = sawThem[0]!;
      const ev = world.eventLog.find((e) => e.id === m.eventId);
      const where = m.buildingId ? buildingById(world, m.buildingId).name : ev?.streetName ?? "somewhere";
      const nightTold = ev ? narrateEvent(world, npc.id, ev) : m.summary;
      lines.push(`That night? ${describeWhen(m.t, q, r)} I remember — ${nightTold}.`);
      if (ev && ev.buildingId && (ev.kind === "arrive" || ev.kind === "depart")) {
        claims.push(placementFromWitnessedEvent(world, npc, ev, m.t, q));
      } else {
        const spread = q === "vivid" ? 20 : 50;
        claims.push({
          npcId: aboutId, from: m.t - spread, to: m.t + spread,
          buildingId: m.buildingId ?? (ev?.streetName ? `street:${ev.streetName}` : null),
          description: `${npc.first} places ${about.first} at ${where} around ${fmtClock(m.t)}`,
        });
      }
    } else if (sameHouse) {
      // Did they actually notice the person leave? Household witnesses of depart events.
      const sawLeave = world.eventLog.some(
        (e) => e.kind === "depart" && e.actorIds[0] === aboutId && e.t >= wFrom && e.t <= wTo && e.witnessIds.includes(npc.id)
      );
      const covers = loyalty > 0.5 && npc.personality.honesty < 0.6;
      if (sawLeave && !covers) {
        const dep = world.eventLog.find(
          (e) => e.kind === "depart" && e.actorIds[0] === aboutId && e.t >= wFrom && e.t <= wTo && e.witnessIds.includes(npc.id)
        )!;
        lines.push(`${about.first} went out that evening, around ${fmtClock(dep.t)}. Didn't say where.`);
        claims.push({
          npcId: aboutId, from: dep.t, to: dep.t + 15, buildingId: null,
          description: `${npc.first} says ${about.first} left home around ${fmtClock(dep.t)}`,
        });
      } else {
        // Believes — or claims — they were home together.
        lines.push(`We were both home that night. All evening, far as I know.`);
        claims.push({
          npcId: aboutId, from: wFrom, to: wTo, buildingId: npc.homeId,
          description: `${npc.first} says ${about.first} was at home between ${fmtClock(wFrom)} and ${fmtClock(wTo)}`,
        });
      }
    } else {
      // Absence testimony: the speaker spent the window somewhere they'd
      // have seen X — and X never showed. Verified against the event log,
      // so a negative placement here can never wrongly break a true alibi.
      const absence = absenceTestimony(world, cf, npc, about, wFrom, wTo);
      if (absence) {
        lines.push(absence.line);
      }
    }
  }

  const st = addStatement(cf, {
    npcId: npc.id, t: world.time, topic: "about-person", aboutNpcId: aboutId,
    question: `Tell me about ${fullName(about)}.`,
    answer: coop === "reluctant"
      ? [lines.join(" "), guardedHedge(npc, r)].filter(Boolean).join(" ")
      : dress(npc, r, lines.join(" ")),
    claims,
    guarded: coop === "reluctant",
  });
  for (const c of claims) {
    addEvidence(cf, {
      kind: "testimony",
      title: `${fullName(npc)}: ${c.description}`,
      detail: `${fullName(npc)} testified: "${c.description}" (interviewed ${fmtTimeLong(world.time)})`,
      discoveredAt: world.time,
      buildingId: c.buildingId && !c.buildingId.startsWith("street:") ? c.buildingId : null,
      itemId: null,
      npcIds: [c.npcId],
      placesAtBuildingId: c.buildingId,
      placesFrom: c.from,
      placesTo: c.to,
    });
  }
  return st;
}

/**
 * Confront an NPC with a piece of evidence. If it contradicts one of their
 * claims they may crack: liars come clean about secrets; the killer shifts
 * ground but does not confess.
 */
export function confront(world: World, cf: CaseFile, npc: Npc, evidence: EvidenceEntry): Statement {
  const r = rngFor(world, npc, `confront:${evidence.id}`);
  const crime = world.crime;
  const contradictions = computeContradictions(cf).filter(
    (c) => c.evidenceId === evidence.id && statementBy(cf, c.statementId)?.npcId === npc.id
  );
  const isKiller = crime !== null && npc.id === crime.killerId;

  // Leverage: evidence that touches an uncooperative witness opens them up —
  // future questions get full answers. Intimidated witnesses count: fear
  // keeps them silent until the detective shows they already know enough.
  const coop = cooperationOf(world, cf, npc);
  const isIntimidated = world.eventLog.some(
    (e) => e.kind === "intimidation" && e.targetIds[0] === npc.id
  );
  const leverage = evidence.npcIds.includes(npc.id) || contradictions.length > 0;
  if ((coop !== "cooperative" || isIntimidated) && leverage && !cf.openedUp.includes(npc.id)) {
    cf.openedUp.push(npc.id);
    if (contradictions.length === 0) {
      return addStatement(cf, {
        npcId: npc.id, t: world.time, topic: "confront", aboutNpcId: null,
        question: `Explain this: ${evidence.title}`,
        answer: openedUpLine(npc, r),
        claims: [],
      });
    }
  }

  if (contradictions.length === 0) {
    return addStatement(cf, {
      npcId: npc.id, t: world.time, topic: "confront", aboutNpcId: null,
      question: `Explain this: ${evidence.title}`,
      answer: r.pick([
        `I don't see what that has to do with me.`,
        `You're reaching, detective.`,
        `That proves nothing about anything I've said.`,
      ]),
      claims: [],
    });
  }

  const alreadyCracked = cf.crackedOnce.includes(npc.id);
  const crackP = 0.35 + npc.personality.fearfulness * 0.4 - npc.personality.confidence * 0.3 + (alreadyCracked ? 0.3 : 0);

  if (!isKiller && r.chance(Math.max(0.15, crackP))) {
    // Come clean: reveal the real segment and the secret behind the lie.
    cf.crackedOnce.push(npc.id);
    const secretEvs = crime ? secretEventsIn(world, npc.id, crime.murderTime - 360, crime.murderTime + 240) : [];
    const secret = Object.values(world.secrets).find((s) => s.holderId === npc.id && ["affair", "theft", "being-blackmailed"].includes(s.kind));
    const truth = crime ? actualWhereabouts(world, npc.id, crime.murderTime - 120, crime.murderTime + 120) : [];
    const claims: Claim[] = truth.map((seg) => ({
      npcId: npc.id, from: seg.from, to: seg.to, buildingId: seg.buildingId,
      description: `${npc.first} now says they were at ${buildingById(world, seg.buildingId).name} between ${fmtClock(seg.from)} and ${fmtClock(seg.to)}`,
    }));
    const why = secret
      ? ` The truth is I ${secret.description.replace(/^is /, "was ").replace(/^owes/, "owe")}. That's why I lied. It has nothing to do with the murder.`
      : secretEvs.length > 0
        ? ` I wasn't honest because I was somewhere I shouldn't have been. But it's not what you think.`
        : ` I got scared and said something stupid. Here's the truth.`;
    if (secret) {
      const admission = addEvidence(cf, {
        kind: "testimony",
        title: `Admission under confrontation: ${fullName(npc)} ${secret.description}`,
        detail: `Confronted with "${evidence.title}", ${fullName(npc)} admitted: ${secret.description}.`,
        discoveredAt: world.time,
        buildingId: null, itemId: null,
        npcIds: secret.otherId ? [npc.id, secret.otherId] : [npc.id],
        placesAtBuildingId: null, placesFrom: null, placesTo: null,
        motiveHint: true,
      });
      learnFactFromSecret(cf, secret, admission.id);
    }
    return addStatement(cf, {
      npcId: npc.id, t: world.time, topic: "confront", aboutNpcId: null,
      question: `Explain this: ${evidence.title}`,
      answer: `Alright. Alright.${why}`,
      claims,
    });
  }

  if (isKiller) {
    // Shift the story once; stonewall after.
    if (!alreadyCracked) {
      cf.crackedOnce.push(npc.id);
      const claims: Claim[] = [{
        npcId: npc.id,
        from: crime!.murderTime - 90, to: crime!.murderTime + 90, buildingId: null,
        description: `${npc.first} now says they were "out walking, alone" around the time of the murder`,
      }];
      return addStatement(cf, {
        npcId: npc.id, t: world.time, topic: "confront", aboutNpcId: null,
        question: `Explain this: ${evidence.title}`,
        answer: r.pick([
          `Fine — I wasn't strictly accurate. I went out for air that night. Walked. Alone. That's not a crime.`,
          `So I stepped out. People step out. I didn't want to get dragged into this, that's all.`,
        ]),
        claims,
      });
    }
    return addStatement(cf, {
      npcId: npc.id, t: world.time, topic: "confront", aboutNpcId: null,
      question: `Explain this: ${evidence.title}`,
      answer: r.pick([
        `I've said everything I'm going to say without a lawyer.`,
        `We're done here, detective.`,
      ]),
      claims: [],
    });
  }

  return addStatement(cf, {
    npcId: npc.id, t: world.time, topic: "confront", aboutNpcId: null,
    question: `Explain this: ${evidence.title}`,
    answer: r.pick([
      `Whoever told you that is mistaken. Memories play tricks.`,
      `I know what I said, and I'm sticking to it.`,
    ]),
    claims: [],
  });
}

// -------------------------------------------------------------------- helpers

const ABSENCE_VENUE_TYPES = new Set(["bar", "cafe", "restaurant", "store", "park", "office", "factory", "warehouse", "hospital", "school"]);

/**
 * "She never came in that night." If the speaker spent a solid stretch of
 * the murder window somewhere they would have seen X — their own workplace,
 * or a public venue they were attentive in — and the event log confirms X
 * never set foot there, that is honest negative testimony. It produces a
 * negative placement that can break an alibi claiming that very venue.
 */
function absenceTestimony(
  world: World,
  cf: CaseFile,
  npc: Npc,
  about: Npc,
  wFrom: SimTime,
  wTo: SimTime
): { line: string } | null {
  const crime = world.crime;
  // The killer never volunteers their own true position for the window.
  if (crime && npc.id === crime.killerId) return null;
  // People with something to hide in the window won't pin themselves down either.
  if (secretEventsIn(world, npc.id, wFrom, wTo).length > 0) return null;

  const mySegs = actualWhereabouts(world, npc.id, wFrom, wTo);
  for (const seg of mySegs) {
    if (seg.to - seg.from < 60) continue;
    const b = buildingById(world, seg.buildingId);
    const isStaffHere = npc.workplaceId === b.id;
    const attentiveRegular = ABSENCE_VENUE_TYPES.has(b.type) && npc.personality.curiosity > 0.45;
    if (!isStaffHere && !attentiveRegular) continue;
    // Verify from the log: X truly never overlapped with the speaker there.
    const theirSegs = actualWhereabouts(world, about.id, seg.from, seg.to);
    const wasThere = theirSegs.some(
      (s) => s.buildingId === b.id && Math.min(s.to, seg.to) - Math.max(s.from, seg.from) > 0
    );
    if (wasThere) continue;

    const spanLabel = `${fmtClock(seg.from)}–${fmtClock(seg.to)}`;
    addEvidence(cf, {
      kind: "testimony",
      title: `${fullName(npc)}: ${about.first} was NOT at ${b.name} (${spanLabel})`,
      detail:
        `${fullName(npc)} ${isStaffHere ? `was working at ${b.name}` : `spent the evening at ${b.name}`} ` +
        `from ${fmtClock(seg.from)} to ${fmtClock(seg.to)} that night and is certain ${fullName(about)} never came in.`,
      discoveredAt: world.time,
      buildingId: b.id, itemId: null,
      npcIds: [about.id],
      placesAtBuildingId: null,
      placesFrom: seg.from,
      placesTo: seg.to,
      absentFromBuildingId: b.id,
    });
    const line = isStaffHere
      ? `${about.first}, at ${b.name}? No. I was working ${spanLabel} and ${about.gender === "f" ? "she" : "he"} never came in. I'd know.`
      : `I was at ${b.name} that whole stretch, ${spanLabel} — ${about.first} wasn't there. I'd have noticed.`;
    return { line };
  }
  return null;
}

function statementBy(cf: CaseFile, id: string): Statement | undefined {
  return cf.statements.find((s) => s.id === id);
}

function nameOf(world: World, id: NpcId): string {
  const n = world.npcs.find((x) => x.id === id);
  return n ? fullName(n) : "someone";
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * Turn a witnessed arrive/depart into a placement claim. Seeing someone
 * ARRIVE honestly implies they were out on the street just before; a
 * DEPART implies they were out just after. That inference is what breaks
 * "I was home all afternoon" against "I saw him come in at 17:10".
 */
function placementFromWitnessedEvent(
  world: World,
  witness: Npc,
  ev: SimEvent,
  t: SimTime,
  q: RecallQuality
): Claim {
  const subject = ev.actorIds[0]!;
  const b = buildingById(world, ev.buildingId!);
  const spread = q === "vivid" ? 15 : 45;
  if (ev.kind === "arrive") {
    return {
      npcId: subject, from: t - Math.max(30, spread), to: t - 2,
      buildingId: `street:on their way to ${b.name}`,
      description: `${witness.first} saw ${nameOf(world, subject)} come in to ${b.name} around ${fmtClock(t)} — so they had been out just before`,
    };
  }
  if (ev.kind === "depart") {
    return {
      npcId: subject, from: t + 2, to: t + Math.max(30, spread),
      buildingId: `street:having left ${b.name}`,
      description: `${witness.first} saw ${nameOf(world, subject)} leave ${b.name} around ${fmtClock(t)} — so they were out just after`,
    };
  }
  return {
    npcId: subject, from: t - spread, to: t + spread, buildingId: ev.buildingId,
    description: `${witness.first} places ${nameOf(world, subject)} at ${b.name} around ${fmtClock(t)}`,
  };
}

function describeWhen(t: SimTime, q: RecallQuality, r: Rng): string {
  if (q === "vivid") return `${fmtTimeLong(t)}`;
  const fudge = r.pick(["around", "maybe around", "sometime around"]);
  return `${fudge} ${fmtTime(Math.round(t / 60) * 60)}`;
}
