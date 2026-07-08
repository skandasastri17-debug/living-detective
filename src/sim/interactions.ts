/**
 * Interpersonal interactions between co-located NPCs.
 *
 * Each tick, NPCs sharing a building may interact. Which interaction fires
 * is a utility-weighted choice over the pair's relationship state, traits,
 * needs and venue. Every interaction emits a SimEvent (with witnesses),
 * updates relationships, and can mint or spread secrets — this is where
 * motives grow.
 */

import { Rng } from "../core/rng";
import type { SimEngine } from "./engine";
import type { Building, Npc, Secret, SecretId } from "../world/types";
import { fullName, itemById, relationshipBetween } from "../world/types";

type InteractionKind =
  | "chat" | "gossip" | "argue" | "fight" | "flirt" | "affair-meeting"
  | "loan-demand" | "blackmail-demand" | "theft";

interface Option {
  kind: InteractionKind;
  weight: number;
}

/** Build the utility-weighted options for actor→target in this venue. */
function options(engine: SimEngine, a: Npc, b: Npc, venue: Building): Option[] {
  const world = engine.world;
  const rel = relationshipBetween(a, b.id);
  const opts: Option[] = [];
  const privacy = venue.type === "house" || venue.type === "apartment" ? 1 : venue.type === "park" ? 0.6 : 0.25;

  // Chat — the default social act, likelier between friends.
  opts.push({ kind: "chat", weight: 0.5 + Math.max(0, rel.friendship) * 1.2 });

  // Gossip — needs the trait and something to tell.
  if (a.personality.gossip > 0.45 && knowsAnySecretToShare(world.secrets, a, b)) {
    opts.push({ kind: "gossip", weight: a.personality.gossip * 1.1 });
  }

  // Argue — dislike, debt pressure, jealousy, stress.
  const friction =
    Math.max(0, -rel.friendship) * 1.5 +
    rel.jealousy * 0.8 +
    (rel.debt > 0 ? 0.5 : 0) +
    a.stress * 0.5;
  if (friction > 0.25) opts.push({ kind: "argue", weight: friction * (0.5 + a.personality.aggression) });

  // Fight — rare escalation; needs aggression and real animosity.
  if (rel.friendship < -0.45 && a.personality.aggression > 0.6) {
    opts.push({ kind: "fight", weight: (a.personality.aggression - 0.5) * Math.max(0, -rel.friendship) * 0.8 });
  }

  // Flirt — attraction; inhibited if actor's partner is present.
  const partnerHere = a.partnerId !== null && engine.occupants(venue.id).some((n) => n.id === a.partnerId);
  if (rel.attraction > 0.35 && !partnerHere && b.alive) {
    opts.push({ kind: "flirt", weight: rel.attraction * (0.4 + a.personality.confidence * 0.8) });
  }

  // Affair meeting — established affair pair, in private.
  if (hasAffairWith(world.secrets, a, b.id) && privacy > 0.5) {
    opts.push({ kind: "affair-meeting", weight: 1.4 });
  }

  // Loan demand — b owes a money; pressure builds with amount.
  const owedToA = relationshipBetween(b, a.id).debt;
  if (owedToA > 300) {
    opts.push({ kind: "loan-demand", weight: 0.4 + Math.min(1.2, owedToA / 1500) });
  }

  // Blackmail — a knows one of b's secrets, is broke or greedy, dishonest.
  if (a.personality.honesty < 0.35 && knowsBlackmailableSecret(world.secrets, a, b)) {
    const need = a.cash < a.income * 2 ? 1 : 0.4;
    opts.push({ kind: "blackmail-demand", weight: 0.6 * need * (1 - a.personality.honesty) });
  }

  // Theft — dishonest + broke + venue has something to take + few people.
  if (a.personality.honesty < 0.3 && a.cash < a.income * 1.5 && engine.occupants(venue.id).length <= 2) {
    opts.push({ kind: "theft", weight: 0.35 * (1 - a.personality.honesty) });
  }

  return opts;
}

function knowsAnySecretToShare(secrets: Record<SecretId, Secret>, teller: Npc, listener: Npc): boolean {
  return Object.values(secrets).some(
    (s) =>
      s.holderId !== teller.id &&
      s.holderId !== listener.id &&
      s.knownBy.includes(teller.id) &&
      !s.knownBy.includes(listener.id)
  );
}

function hasAffairWith(secrets: Record<SecretId, Secret>, a: Npc, bId: string): boolean {
  return a.secretIds.some((sid) => {
    const s = secrets[sid];
    return s !== undefined && s.kind === "affair" && s.otherId === bId;
  });
}

function knowsBlackmailableSecret(secrets: Record<SecretId, Secret>, a: Npc, b: Npc): Secret | boolean {
  const s = Object.values(secrets).find(
    (s) =>
      s.holderId === b.id &&
      (s.kind === "affair" || s.kind === "theft" || s.kind === "criminal-past") &&
      s.knownBy.includes(a.id) &&
      // don't re-blackmail: existing being-blackmailed secret with a as blackmailer
      !Object.values(secrets).some((x) => x.kind === "being-blackmailed" && x.holderId === b.id && x.otherId === a.id)
  );
  return s ?? false;
}

/** Minimum minutes between interaction beats for the same pair. */
const PAIR_COOLDOWN_MIN = 120;

/** Attempt one interaction for actor a toward target b. Returns true if one fired. */
export function tryInteraction(engine: SimEngine, a: Npc, b: Npc, venue: Building, r: Rng): boolean {
  const rel = relationshipBetween(a, b.id);
  // People who just had a scene together don't immediately have another.
  if (rel.lastInteraction >= 0 && engine.world.time - rel.lastInteraction < PAIR_COOLDOWN_MIN) return false;
  const opts = options(engine, a, b, venue);
  const total = opts.reduce((s, o) => s + o.weight, 0);
  // Interaction frequency: not every co-location produces a beat.
  if (total <= 0 || !r.chance(Math.min(0.5, total * 0.22))) return false;
  const kind = r.weighted(opts.map((o) => [o.kind, o.weight] as const));
  perform(engine, kind, a, b, venue, r);
  const now = engine.world.time;
  const relAB = relationshipBetween(a, b.id);
  const relBA = relationshipBetween(b, a.id);
  relAB.interactions++; relBA.interactions++;
  relAB.lastInteraction = now; relBA.lastInteraction = now;
  return true;
}

function perform(engine: SimEngine, kind: InteractionKind, a: Npc, b: Npc, venue: Building, r: Rng): void {
  const world = engine.world;
  const relAB = relationshipBetween(a, b.id);
  const relBA = relationshipBetween(b, a.id);
  const here = ` at ${venue.name}`;

  switch (kind) {
    case "chat": {
      engine.emit({
        kind: "chat", buildingId: venue.id, actorIds: [a.id], targetIds: [b.id],
        summary: `${fullName(a)} chatted with ${fullName(b)}${here}`,
      });
      relAB.friendship = clamp1(relAB.friendship + 0.03);
      relBA.friendship = clamp1(relBA.friendship + 0.03);
      relAB.trust = clamp01(relAB.trust + 0.02);
      relBA.trust = clamp01(relBA.trust + 0.02);
      a.mood = clamp1(a.mood + 0.05);
      b.mood = clamp1(b.mood + 0.05);
      break;
    }
    case "gossip": {
      const secret = Object.values(world.secrets).find(
        (s) => s.holderId !== a.id && s.holderId !== b.id && s.knownBy.includes(a.id) && !s.knownBy.includes(b.id)
      );
      if (!secret) return;
      const subject = world.npcs.find((n) => n.id === secret.holderId)!;
      secret.knownBy.push(b.id);
      engine.emit({
        kind: "gossip", buildingId: venue.id, actorIds: [a.id], targetIds: [b.id, subject.id],
        summary: `${fullName(a)} told ${fullName(b)} that ${subject.first} ${subject.last} ${secret.description}`,
      });
      relAB.friendship = clamp1(relAB.friendship + 0.02);
      break;
    }
    case "argue": {
      const topic =
        relAB.debt > 0 || relBA.debt > 0 ? "about money" :
        relAB.jealousy > 0.4 ? "about a relationship" :
        "heatedly";
      engine.emit({
        kind: "argue", buildingId: venue.id, actorIds: [a.id], targetIds: [b.id],
        summary: `${fullName(a)} argued ${topic} with ${fullName(b)}${here}`,
      });
      relAB.friendship = clamp1(relAB.friendship - 0.08);
      relBA.friendship = clamp1(relBA.friendship - 0.08);
      relAB.trust = clamp01(relAB.trust - 0.04);
      relBA.trust = clamp01(relBA.trust - 0.04);
      a.stress = clamp01(a.stress + 0.08);
      b.stress = clamp01(b.stress + 0.1);
      a.mood = clamp1(a.mood - 0.08);
      b.mood = clamp1(b.mood - 0.08);
      break;
    }
    case "fight": {
      engine.emit({
        kind: "fight", buildingId: venue.id, actorIds: [a.id], targetIds: [b.id],
        summary: `${fullName(a)} got into a physical fight with ${fullName(b)}${here}`,
      });
      relAB.friendship = clamp1(relAB.friendship - 0.2);
      relBA.friendship = clamp1(relBA.friendship - 0.25);
      relBA.fear = clamp01(relBA.fear + 0.2);
      a.stress = clamp01(a.stress + 0.15);
      b.stress = clamp01(b.stress + 0.2);
      b.health = clamp01(b.health - 0.08);
      break;
    }
    case "flirt": {
      engine.emit({
        kind: "flirt", buildingId: venue.id, actorIds: [a.id], targetIds: [b.id],
        summary: `${fullName(a)} flirted with ${fullName(b)}${here}`,
      });
      relAB.attraction = clamp01(relAB.attraction + 0.05);
      if (r.chance(0.3 + b.personality.confidence * 0.3)) {
        relBA.attraction = clamp01(relBA.attraction + 0.06);
      }
      // Jealousy: partner of either may hear of it via witnesses later (gossip path);
      // direct witnesses who are partners react immediately in emit()'s witness hook.
      break;
    }
    case "affair-meeting": {
      engine.emit({
        kind: "affair-meeting", buildingId: venue.id, actorIds: [a.id], targetIds: [b.id],
        summary: `${fullName(a)} met ${fullName(b)} privately${here}`,
      });
      relAB.attraction = clamp01(relAB.attraction + 0.03);
      relBA.attraction = clamp01(relBA.attraction + 0.03);
      a.stress = clamp01(a.stress + 0.03);
      break;
    }
    case "loan-demand": {
      const owed = relationshipBetween(b, a.id).debt;
      engine.emit({
        kind: "loan-demand", buildingId: venue.id, actorIds: [a.id], targetIds: [b.id], amount: owed,
        summary: `${fullName(a)} demanded ${fullName(b)} repay the $${owed} owed${here}`,
      });
      relBA.fear = clamp01(relBA.fear + 0.12);
      relBA.friendship = clamp1(relBA.friendship - 0.1);
      b.stress = clamp01(b.stress + 0.15);
      break;
    }
    case "blackmail-demand": {
      const secret = knowsBlackmailableSecret(world.secrets, a, b);
      if (typeof secret === "boolean") return;
      const amount = Math.max(200, Math.round(b.income * (1 + r.float())) );
      const ev = engine.emit({
        kind: "blackmail-demand", buildingId: venue.id, actorIds: [a.id], targetIds: [b.id], amount,
        summary: `${fullName(a)} demanded $${amount} from ${fullName(b)} to stay quiet about what they know`,
      });
      // Mint the paired secrets with provenance.
      const sid1 = engine.mintSecret({
        kind: "blackmail", holderId: a.id, otherId: b.id, originEventId: ev.id,
        description: `is blackmailing ${fullName(b)} over the fact that ${fullName(b)} ${secret.description}`,
      });
      const sid2 = engine.mintSecret({
        kind: "being-blackmailed", holderId: b.id, otherId: a.id, originEventId: ev.id,
        description: `is being blackmailed by ${fullName(a)}`,
      });
      void sid1; void sid2;
      relBA.fear = clamp01(relBA.fear + 0.3);
      relBA.friendship = clamp1(relBA.friendship - 0.35);
      b.stress = clamp01(b.stress + 0.3);
      // Sometimes the victim pays — a transaction the player can find.
      if (r.chance(0.5) && b.cash >= amount) {
        engine.transfer(b, a, amount, "cash withdrawal", venue.id);
      }
      break;
    }
    case "theft": {
      // Steal a valuable from the venue or from b's carried items.
      const venueItems = venue.rooms.flatMap((room) => room.itemIds)
        .map((id) => itemById(world, id))
        .filter((it) => ["cash-box", "necklace", "watch", "wallet", "register"].includes(it.kind) && it.kind !== "register");
      const carried = b.inventoryIds.map((id) => itemById(world, id)).filter((it) => ["wallet", "necklace", "watch"].includes(it.kind));
      const pool = venueItems.length > 0 ? venueItems : carried;
      if (pool.length === 0) return;
      const item = r.pick(pool);
      const ev = engine.emit({
        kind: "theft", buildingId: venue.id, actorIds: [a.id], targetIds: item.ownerId ? [item.ownerId] : [b.id], itemId: item.id,
        summary: `${fullName(a)} stole ${item.name} ${item.roomId ? `from ${venue.name}` : `from ${fullName(b)}`}`,
      });
      // Item changes hands; thief's prints land on it (provenance = the theft).
      if (item.roomId) {
        const room = venue.rooms.find((rm) => rm.id === item.roomId);
        if (room) room.itemIds = room.itemIds.filter((id) => id !== item.id);
      }
      if (item.carrierId) {
        const holder = world.npcs.find((n) => n.id === item.carrierId);
        if (holder) holder.inventoryIds = holder.inventoryIds.filter((id) => id !== item.id);
      }
      item.roomId = null;
      item.carrierId = a.id;
      a.inventoryIds.push(item.id);
      item.fingerprints.push({ npcId: a.id, t: world.time, eventId: ev.id });
      engine.mintSecret({
        kind: "theft", holderId: a.id, otherId: item.ownerId ?? b.id, originEventId: ev.id,
        description: `stole ${item.name}`,
      });
      a.cash += item.kind === "cash-box" ? 300 : 0;
      break;
    }
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v));
}
