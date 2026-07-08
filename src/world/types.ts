/**
 * World model — the single source of truth for the simulation.
 *
 * Design rule (the game's core philosophy): nothing in the investigation
 * layer may exist without provenance. Fingerprints reference the touch event
 * that deposited them; memories reference the event that was witnessed;
 * records reference the call/purchase/entry that generated them. The
 * investigation layer is a *read-only projection* of this truth.
 */

import type { SimTime } from "../core/time";

// ---------------------------------------------------------------- identifiers

export type NpcId = string; // "npc:12"
export type BuildingId = string; // "bld:7"
export type RoomId = string; // "room:7.2"
export type ItemId = string; // "item:143"
export type EventId = string; // "ev:2041"
export type SecretId = string; // "sec:3"

// ---------------------------------------------------------------------- city

export type BuildingType =
  | "house"
  | "apartment"
  | "police-station"
  | "hospital"
  | "store"
  | "restaurant"
  | "bar"
  | "cafe"
  | "park"
  | "factory"
  | "office"
  | "warehouse"
  | "school";

export interface Lot {
  x: number; // grid cell coords (top-left)
  y: number;
  w: number;
  h: number;
}

export interface Room {
  id: RoomId;
  buildingId: BuildingId;
  name: string; // "Kitchen", "Bar floor", "Storage"
  itemIds: ItemId[];
}

export interface Building {
  id: BuildingId;
  type: BuildingType;
  name: string; // "The Rusty Anchor", "14 Elm Street"
  lot: Lot;
  /** Road cell adjacent to the entrance; travel paths terminate here. */
  door: { x: number; y: number };
  ownerId: NpcId | null;
  employeeIds: NpcId[];
  residentIds: NpcId[]; // for homes
  openMin: number; // minute-of-day; 0/1440 for always
  closeMin: number;
  isPublic: boolean;
  hasCamera: boolean; // logs entries/exits
  lightLevel: number; // 0..1, affects witness reliability at night
  rooms: Room[];
}

export interface RoadCell {
  x: number;
  y: number;
  streetName: string;
}

export interface CityMap {
  name: string;
  width: number; // grid cells
  height: number;
  /** Keyed "x,y" → street name for every road cell. */
  roads: Map<string, RoadCell>;
  buildings: Building[];
}

// --------------------------------------------------------------------- items

export type ItemKind =
  | "kitchen-knife"
  | "hunting-knife"
  | "wrench"
  | "hammer"
  | "crowbar"
  | "bat"
  | "scissors"
  | "letter-opener"
  | "trophy"
  | "rope"
  | "wallet"
  | "phone"
  | "keys"
  | "watch"
  | "necklace"
  | "cash-box"
  | "ledger"
  | "photo"
  | "letter"
  | "note"
  | "book"
  | "bottle"
  | "glass"
  | "coat"
  | "umbrella"
  | "toolbox"
  | "first-aid-kit"
  | "register";

export interface FingerprintTrace {
  npcId: NpcId;
  t: SimTime; // when deposited (latest touch wins for freshness)
  eventId: EventId; // provenance: the touch/use event
}

export interface Item {
  id: ItemId;
  kind: ItemKind;
  name: string;
  ownerId: NpcId | null;
  /** Exactly one of roomId / carrierId is set. */
  roomId: RoomId | null;
  carrierId: NpcId | null;
  lethality: number; // 0 = harmless, 1 = very lethal
  fingerprints: FingerprintTrace[];
  /** Victim blood on the item (murder weapons); provenance to the murder event. */
  bloodOfNpcId: NpcId | null;
  bloodEventId: EventId | null;
  hiddenAt: string | null; // e.g. "park trash bin" — set when disposed of
  /** Deliberately wiped clean — visible to forensics as recent tampering. */
  wipedAt?: SimTime | null;
  wipedEventId?: EventId | null;
}

// ---------------------------------------------------------------------- NPCs

export type Gender = "m" | "f";

export interface Personality {
  honesty: number; // 0..1 — willingness to tell the truth / not steal
  aggression: number;
  empathy: number;
  curiosity: number; // notices things; better witness
  fearfulness: number;
  confidence: number;
  gossip: number; // spreads what they know
  memoryQuality: number; // slows memory decay
}

export type OccupationId =
  | "bartender"
  | "server"
  | "cook"
  | "shop-clerk"
  | "shop-owner"
  | "office-worker"
  | "office-manager"
  | "factory-worker"
  | "factory-foreman"
  | "warehouse-hand"
  | "doctor"
  | "nurse"
  | "teacher"
  | "police-officer"
  | "barista"
  | "landlord"
  | "unemployed"
  | "retired"
  | "writer";

export type ActivityKind =
  | "sleep"
  | "work"
  | "meal"
  | "leisure"
  | "social"
  | "errand"
  | "home";

export interface ScheduleBlock {
  /** Minute-of-day range [startMin, endMin); may wrap past midnight via two blocks. */
  startMin: number;
  endMin: number;
  days: number[]; // 0=Mon … 6=Sun
  kind: ActivityKind;
  /** Fixed building, or null → resolved per-day (leisure venue, friend visit). */
  buildingId: BuildingId | null;
}

export type SecretKind =
  | "affair"
  | "theft"
  | "heavy-debt"
  | "blackmail" // holder is blackmailing someone
  | "being-blackmailed"
  | "fired"
  | "addiction"
  | "criminal-past";

export interface Secret {
  id: SecretId;
  kind: SecretKind;
  holderId: NpcId; // whose secret it is
  otherId: NpcId | null; // affair partner / blackmailer / victim of theft…
  knownBy: NpcId[]; // who else knows (grows via gossip/witnessing)
  originEventId: EventId | null; // provenance where applicable
  description: string;
}

export type MemorySource = "participant" | "witness" | "heard" | "gossip";

export interface MemoryRecord {
  eventId: EventId;
  t: SimTime;
  source: MemorySource;
  /** 0..1; decays over time, modulated by personality.memoryQuality. */
  strength: number;
  aboutIds: NpcId[];
  buildingId: BuildingId | null;
  summary: string;
}

export interface Relationship {
  friendship: number; // -1..1 (negative = dislike/hatred)
  trust: number; // 0..1
  attraction: number; // 0..1
  jealousy: number; // 0..1
  fear: number; // 0..1
  respect: number; // 0..1
  /** Dollars this NPC owes the other (positive = I owe them). */
  debt: number;
  interactions: number;
  lastInteraction: SimTime;
}

export type NpcPosition =
  | { kind: "building"; buildingId: BuildingId; roomId: RoomId | null }
  | { kind: "street"; x: number; y: number; toBuildingId: BuildingId; path: Array<{ x: number; y: number }>; step: number };

export interface Npc {
  id: NpcId;
  first: string;
  last: string;
  gender: Gender;
  age: number;
  occupation: OccupationId;
  workplaceId: BuildingId | null;
  homeId: BuildingId;
  householdId: number;
  partnerId: NpcId | null; // spouse/partner living together
  income: number; // weekly $
  cash: number; // savings
  personality: Personality;
  mood: number; // -1..1
  stress: number; // 0..1
  health: number; // 0..1
  shoeSize: number; // footprint evidence
  walkingSpeed: number; // road cells per tick
  schedule: ScheduleBlock[];
  relationships: Record<NpcId, Relationship>;
  memories: MemoryRecord[];
  inventoryIds: ItemId[];
  phoneContactIds: NpcId[];
  secretIds: SecretId[];
  habits: string[]; // flavor + interview color ("evening runs in Dover Park")
  alive: boolean;
  position: NpcPosition;
  activity: ActivityKind;
  /**
   * Temporary destination override (crime execution, discovery errands).
   * Movement honors it over the schedule until `until`, then clears it.
   */
  scheduleOverride: { buildingId: BuildingId; until: SimTime; activity: ActivityKind } | null;
}

// ----------------------------------------------------------------- sim events

export type SimEventKind =
  | "arrive"
  | "depart"
  | "chat"
  | "argue"
  | "fight"
  | "flirt"
  | "affair-meeting"
  | "gossip"
  | "theft"
  | "loan"
  | "loan-demand"
  | "blackmail-demand"
  | "purchase"
  | "phone-call"
  | "touch-item"
  | "take-item"
  | "drop-item"
  | "sighting" // street-level: A saw B on X street
  | "murder"
  | "scream-heard"
  | "body-discovered"
  | "missed-work"
  | "wipe-item" // deliberate destruction of traces
  | "intimidation"; // leaning on a witness

export interface SimEvent {
  id: EventId;
  t: SimTime;
  kind: SimEventKind;
  buildingId: BuildingId | null;
  roomId: RoomId | null;
  streetName: string | null;
  actorIds: NpcId[]; // who did it
  targetIds: NpcId[]; // who/what it was done to
  itemId: ItemId | null;
  amount: number | null; // money where relevant
  witnessIds: NpcId[]; // bystanders who perceived it (computed at emission)
  summary: string; // human-readable truth, used by reveal & dev console
}

// -------------------------------------------------------------------- records

export interface PhoneCallRecord {
  t: SimTime;
  fromId: NpcId;
  toId: NpcId;
  durationMin: number;
  eventId: EventId;
}

export interface TransactionRecord {
  t: SimTime;
  fromId: NpcId | null; // null = external (salary payer)
  toId: NpcId | null;
  amount: number;
  memo: string;
  buildingId: BuildingId | null;
  eventId: EventId;
}

export interface CameraLogEntry {
  t: SimTime;
  buildingId: BuildingId;
  npcId: NpcId;
  direction: "in" | "out";
  eventId: EventId;
}

// --------------------------------------------------------------------- crime

export type MotiveKind =
  | "money"
  | "jealousy"
  | "revenge"
  | "blackmail"
  | "fear-of-exposure"
  | "passion"
  | "business-rivalry"
  | "inheritance";

export interface CrimeRecord {
  killerId: NpcId;
  victimId: NpcId;
  motive: MotiveKind;
  /** Events that built the motive — the "why" is fully explainable. */
  motiveEventIds: EventId[];
  motiveSummary: string;
  weaponItemId: ItemId;
  premeditated: boolean;
  woreGloves: boolean;
  murderEventId: EventId;
  murderTime: SimTime;
  sceneBuildingId: BuildingId;
  sceneRoomId: RoomId;
  weaponDisposal: "left-at-scene" | "hidden" | "taken-home";
  discoveryEventId: EventId | null;
  discoveredBy: NpcId | null;
  discoveryTime: SimTime | null;
  /** The alibi lie the killer will tell (fabricated but checkable). */
  alibiClaim: string;
  /**
   * Counter-play state: pressure the killer feels from the investigation
   * and the tampering they have committed (all as real sim events).
   */
  pressure?: number;
  coverup?: {
    movedWeapon: boolean;
    wipedWeapon: boolean;
    intimidatedId: NpcId | null;
    intimidationEventId: EventId | null;
    revisitedScene: boolean;
    lastActionDay: number;
  };
}

// --------------------------------------------------------------------- scene

export interface FootprintTrace {
  npcId: NpcId; // truth; player only sees shoe size until matched
  shoeSize: number;
  eventId: EventId;
}

export interface CrimeSceneState {
  buildingId: BuildingId;
  roomId: RoomId;
  bloodOfVictim: boolean;
  footprints: FootprintTrace[];
  /** Items of interest present in the scene room at discovery. */
  sceneItemIds: ItemId[];
  /**
   * A frenzied struggle leaves the killer's DNA under the victim's nails
   * (provenance: the murder event). Comparison requires naming a suspect.
   */
  struggleDnaOfNpcId?: NpcId | null;
  struggleDnaEventId?: EventId | null;
}

// --------------------------------------------------------------------- world

export interface World {
  seedPhrase: string;
  seed: number;
  /** Difficulty preset id; part of generation input (seed+difficulty = case). */
  difficulty?: "rookie" | "detective" | "inspector";
  cityName: string;
  city: CityMap;
  npcs: Npc[];
  items: Record<ItemId, Item>;
  secrets: Record<SecretId, Secret>;
  eventLog: SimEvent[];
  phoneLog: PhoneCallRecord[];
  transactions: TransactionRecord[];
  cameraLog: CameraLogEntry[];
  time: SimTime;
  crime: CrimeRecord | null;
  scene: CrimeSceneState | null;
  nextIds: { npc: number; building: number; room: number; item: number; event: number; secret: number };
}

// ------------------------------------------------------------------- helpers

export function npcById(world: World, id: NpcId): Npc {
  const n = world.npcs.find((x) => x.id === id);
  if (!n) throw new Error(`Unknown NPC ${id}`);
  return n;
}

export function buildingById(world: World, id: BuildingId): Building {
  const b = world.city.buildings.find((x) => x.id === id);
  if (!b) throw new Error(`Unknown building ${id}`);
  return b;
}

export function roomById(world: World, id: RoomId): Room {
  for (const b of world.city.buildings) {
    const r = b.rooms.find((x) => x.id === id);
    if (r) return r;
  }
  throw new Error(`Unknown room ${id}`);
}

export function itemById(world: World, id: ItemId): Item {
  const it = world.items[id];
  if (!it) throw new Error(`Unknown item ${id}`);
  return it;
}

export function eventById(world: World, id: EventId): SimEvent {
  const e = world.eventLog.find((x) => x.id === id);
  if (!e) throw new Error(`Unknown event ${id}`);
  return e;
}

export function fullName(n: Npc): string {
  return `${n.first} ${n.last}`;
}

export function relationshipBetween(a: Npc, bId: NpcId): Relationship {
  let rel = a.relationships[bId];
  if (!rel) {
    rel = {
      friendship: 0,
      trust: 0.3,
      attraction: 0,
      jealousy: 0,
      fear: 0,
      respect: 0.3,
      debt: 0,
      interactions: 0,
      lastInteraction: -1,
    };
    a.relationships[bId] = rel;
  }
  return rel;
}

/** NPCs currently inside a building. */
export function occupantsOf(world: World, buildingId: BuildingId): Npc[] {
  return world.npcs.filter(
    (n) => n.alive && n.position.kind === "building" && n.position.buildingId === buildingId
  );
}
