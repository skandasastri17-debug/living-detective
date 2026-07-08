/**
 * Procedural city generation.
 *
 * Layout model: a Manhattan grid. Roads run on fixed lines spaced 7 cells
 * apart, which yields 6×6 interior blocks that subdivide into four 3×3 lots,
 * each guaranteed to touch a road (so every building gets a door). Streets
 * are named; travel paths are computed over road cells with BFS, so witness
 * sightings can say "on Mercer Street" and mean it.
 */

import { Rng } from "../core/rng";
import { log } from "../core/log";
import {
  BAR_NAMES, CAFE_NAMES, CITY_CORE, CITY_PREFIX, FACTORY_NAMES, OFFICE_NAMES,
  PARK_NAMES, RESTAURANT_NAMES, STORE_NAMES, STREET_NAMES, WAREHOUSE_NAMES,
} from "../data/names";
import { ITEM_DEFS, itemDef } from "../data/items";
import type {
  Building, BuildingId, BuildingType, CityMap, Item, ItemId, ItemKind, Lot,
  RoadCell, Room, World,
} from "./types";

export const GRID_W = 44;
export const GRID_H = 33;
const ROAD_XS = [3, 10, 17, 24, 31, 38];
const ROAD_YS = [3, 10, 17, 24, 31];

const ROOMS_BY_TYPE: Record<BuildingType, string[]> = {
  "house": ["Living room", "Kitchen", "Bedroom", "Hallway"],
  "apartment": ["Lobby"], // units appended per household
  "police-station": ["Front desk", "Bullpen", "Holding cell"],
  "hospital": ["Reception", "Ward", "Records office"],
  "store": ["Front", "Back room", "Storage"],
  "restaurant": ["Dining room", "Kitchen", "Back room"],
  "bar": ["Bar floor", "Back room", "Cellar"],
  "cafe": ["Front", "Back room"],
  "park": ["Grounds", "Bandstand", "Trash area"],
  "factory": ["Floor", "Workshop", "Office", "Locker room"],
  "office": ["Lobby", "Office floor", "Manager's office"],
  "warehouse": ["Loading dock", "Storage", "Office"],
  "school": ["Classroom A", "Classroom B", "Staff room"],
};

interface BuildingSpec {
  type: BuildingType;
  count: number;
  fullBlock?: boolean;
}

/** Commercial/civic composition of every city. Homes fill the remainder. */
const CITY_SPEC: BuildingSpec[] = [
  { type: "police-station", count: 1 },
  { type: "hospital", count: 1 },
  { type: "school", count: 1 },
  { type: "bar", count: 2 },
  { type: "cafe", count: 1 },
  { type: "restaurant", count: 2 },
  { type: "store", count: 2 },
  { type: "office", count: 2 },
  { type: "factory", count: 1 },
  { type: "warehouse", count: 1 },
  { type: "park", count: 2, fullBlock: true },
];

const CAMERA_CHANCE: Partial<Record<BuildingType, number>> = {
  "store": 0.85, "bar": 0.6, "office": 0.7, "warehouse": 0.5,
  "police-station": 1, "hospital": 1, "cafe": 0.4, "restaurant": 0.35,
};

const OPEN_HOURS: Record<BuildingType, [number, number]> = {
  "house": [0, 1440], "apartment": [0, 1440],
  "police-station": [0, 1440], "hospital": [0, 1440],
  "store": [8 * 60, 20 * 60], "restaurant": [11 * 60, 23 * 60],
  "bar": [17 * 60, 26 * 60], "cafe": [6 * 60, 18 * 60],
  "park": [0, 1440], "factory": [6 * 60, 18 * 60],
  "office": [8 * 60, 19 * 60], "warehouse": [6 * 60, 24 * 60],
  "school": [7 * 60, 17 * 60],
};

export const APARTMENT_UNITS = 5;
export const HOUSE_COUNT = 14;
export const APARTMENT_COUNT = 2;

/** Generation-time tuning handed in by the director (from difficulty). */
export interface CityGenTuning {
  cameraChanceMul: number;
  extraHouses: number;
}

export const DEFAULT_TUNING: CityGenTuning = { cameraChanceMul: 1, extraHouses: 0 };

function roadKey(x: number, y: number): string {
  return `${x},${y}`;
}

function buildRoads(rng: Rng): Map<string, RoadCell> {
  const roads = new Map<string, RoadCell>();
  const names = rng.shuffle([...STREET_NAMES]);
  let ni = 0;
  for (const x of ROAD_XS) {
    const streetName = `${names[ni++ % names.length]} Street`;
    for (let y = 0; y < GRID_H; y++) roads.set(roadKey(x, y), { x, y, streetName });
  }
  for (const y of ROAD_YS) {
    const streetName = `${names[ni++ % names.length]} Avenue`;
    for (let x = 0; x < GRID_W; x++) {
      const k = roadKey(x, y);
      // Intersections keep the Street name set in the vertical pass.
      if (!roads.has(k)) roads.set(k, { x, y, streetName });
    }
  }
  return roads;
}

interface LotSlot {
  lot: Lot;
  door: { x: number; y: number };
  blockId: string;
}

/** Enumerate all 3×3 lots inside blocks, each with a door on an adjacent road. */
function enumerateLots(): LotSlot[] {
  const slots: LotSlot[] = [];
  for (let bi = 0; bi < ROAD_XS.length - 1; bi++) {
    for (let bj = 0; bj < ROAD_YS.length - 1; bj++) {
      const x0 = ROAD_XS[bi]! + 1;
      const y0 = ROAD_YS[bj]! + 1;
      const blockId = `${bi},${bj}`;
      // four 3×3 quadrants of the 6×6 block
      for (const [qx, qy] of [[0, 0], [3, 0], [0, 3], [3, 3]] as const) {
        const lot: Lot = { x: x0 + qx, y: y0 + qy, w: 3, h: 3 };
        // door on the road side this quadrant touches
        let door: { x: number; y: number };
        if (qx === 0 && qy === 0) door = { x: x0 - 1, y: lot.y + 1 };
        else if (qx === 3 && qy === 0) door = { x: lot.x + 1, y: y0 - 1 };
        else if (qx === 0 && qy === 3) door = { x: lot.x + 1, y: y0 + 6 };
        else door = { x: x0 + 6, y: lot.y + 1 };
        slots.push({ lot, door, blockId });
      }
    }
  }
  return slots;
}

function businessName(rng: Rng, type: BuildingType, used: Set<string>): string {
  const pools: Partial<Record<BuildingType, readonly string[]>> = {
    "bar": BAR_NAMES, "cafe": CAFE_NAMES, "restaurant": RESTAURANT_NAMES,
    "store": STORE_NAMES, "office": OFFICE_NAMES, "factory": FACTORY_NAMES,
    "warehouse": WAREHOUSE_NAMES, "park": PARK_NAMES,
  };
  const pool = pools[type];
  if (pool) {
    const avail = pool.filter((n) => !used.has(n));
    const name = avail.length > 0 ? rng.pick(avail) : `${rng.pick(pool)} II`;
    used.add(name);
    return name;
  }
  const civic: Partial<Record<BuildingType, string>> = {
    "police-station": "Precinct 9", "hospital": "St. Bride's Hospital", "school": "Wren Street School",
  };
  return civic[type] ?? type;
}

export interface CityGenResult {
  city: CityMap;
  items: Record<ItemId, Item>;
  nextRoomId: number;
  nextItemId: number;
  nextBuildingId: number;
}

/**
 * Generate the city map with buildings, rooms and environmental items.
 * Ownership/residents/employees are assigned later by npcgen.
 */
export function generateCity(rng: Rng, tuning: CityGenTuning = DEFAULT_TUNING): CityGenResult {
  const r = rng.stream("citygen");
  const roads = buildRoads(r.stream("roads"));
  const cityName = `${r.pick(CITY_PREFIX)} ${r.pick(CITY_CORE)}`;

  const slots = r.shuffle(enumerateLots());
  const buildings: Building[] = [];
  const items: Record<ItemId, Item> = {};
  const usedNames = new Set<string>();
  let nextBuilding = 0;
  let nextRoom = 0;
  let nextItem = 0;

  const takenBlocks = new Set<string>();
  const takenSlots = new Set<LotSlot>();

  const makeRooms = (bid: BuildingId, names: string[]): Room[] =>
    names.map((name) => ({ id: `room:${nextRoom++}`, buildingId: bid, name, itemIds: [] }));

  const placeEnvironmentalItems = (b: Building, rr: Rng): void => {
    for (const room of b.rooms) {
      for (const def of ITEM_DEFS) {
        const byRoom = def.roomAffinity.some((k) => room.name.includes(k));
        const byBuilding = def.buildingAffinity.includes(b.type);
        if (!byRoom && !byBuilding) continue;
        // Room-affinity items are likely; building-affinity items sparse.
        const p = byRoom ? 0.75 : 0.18;
        if (!rr.chance(p)) continue;
        const id: ItemId = `item:${nextItem++}`;
        items[id] = {
          id, kind: def.kind, name: def.label, ownerId: null,
          roomId: room.id, carrierId: null, lethality: def.lethality,
          fingerprints: [], bloodOfNpcId: null, bloodEventId: null, hiddenAt: null,
        };
        room.itemIds.push(id);
      }
    }
  };

  const addBuilding = (type: BuildingType, slot: LotSlot, fullBlock: boolean): Building => {
    const id: BuildingId = `bld:${nextBuilding++}`;
    const [openMin, closeMin] = OPEN_HOURS[type];
    const lot: Lot = fullBlock
      ? { x: Math.floor((slot.lot.x - 1) / 7) * 7 + 4, y: Math.floor((slot.lot.y - 1) / 7) * 7 + 4, w: 6, h: 6 }
      : slot.lot;
    const b: Building = {
      id, type,
      name: businessName(r.stream(`name:${id}`), type, usedNames),
      lot, door: slot.door,
      ownerId: null, employeeIds: [], residentIds: [],
      openMin, closeMin,
      isPublic: type !== "house" && type !== "apartment" && type !== "warehouse" && type !== "factory",
      hasCamera: r.stream(`cam:${id}`).chance(Math.min(1, (CAMERA_CHANCE[type] ?? 0) * tuning.cameraChanceMul)),
      lightLevel: type === "park" ? 0.25 : type === "warehouse" ? 0.4 : 0.8,
      rooms: [],
    };
    b.rooms = makeRooms(id, [...ROOMS_BY_TYPE[type]]);
    placeEnvironmentalItems(b, r.stream(`items:${id}`));
    buildings.push(b);
    return b;
  };

  // 1) Civic + commercial buildings on shuffled lots.
  for (const spec of CITY_SPEC) {
    for (let i = 0; i < spec.count; i++) {
      const slot = slots.find((s) => !takenSlots.has(s) && !takenBlocks.has(s.blockId));
      if (!slot) throw new Error("citygen: ran out of lots for commercial spec");
      if (spec.fullBlock) {
        // Consume the whole block.
        for (const s of slots) if (s.blockId === slot.blockId) takenSlots.add(s);
        takenBlocks.add(slot.blockId);
      } else {
        takenSlots.add(slot);
      }
      addBuilding(spec.type, slot, spec.fullBlock ?? false);
    }
  }

  // 2) Homes: houses + apartment buildings.
  const homeSlots = slots.filter((s) => !takenSlots.has(s) && !takenBlocks.has(s.blockId));
  let hs = 0;
  for (let i = 0; i < APARTMENT_COUNT; i++) {
    const slot = homeSlots[hs++];
    if (!slot) throw new Error("citygen: ran out of lots for apartments");
    const b = addBuilding("apartment", slot, false);
    const road = roads.get(roadKey(slot.door.x, slot.door.y));
    b.name = `${10 + i * 12} ${road?.streetName ?? "Grid"} Apartments`;
    for (let u = 1; u <= APARTMENT_UNITS; u++) {
      const room: Room = { id: `room:${nextRoom++}`, buildingId: b.id, name: `Apartment ${u}`, itemIds: [] };
      b.rooms.push(room);
    }
    // Apartments get home items in each unit.
    const rr = r.stream(`aptitems:${b.id}`);
    for (const room of b.rooms) {
      if (!room.name.startsWith("Apartment")) continue;
      for (const kind of ["kitchen-knife", "photo", "letter", "book"] as ItemKind[]) {
        if (kind !== "kitchen-knife" && !rr.chance(0.55)) continue;
        const def = itemDef(kind);
        const id: ItemId = `item:${nextItem++}`;
        items[id] = {
          id, kind, name: def.label, ownerId: null, roomId: room.id, carrierId: null,
          lethality: def.lethality, fingerprints: [], bloodOfNpcId: null, bloodEventId: null, hiddenAt: null,
        };
        room.itemIds.push(id);
      }
    }
  }
  for (let i = 0; i < HOUSE_COUNT + tuning.extraHouses; i++) {
    const slot = homeSlots[hs++];
    if (!slot) break; // fewer houses in a tight map is acceptable
    const b = addBuilding("house", slot, false);
    const road = roads.get(roadKey(slot.door.x, slot.door.y));
    b.name = `${3 + i * 4} ${road?.streetName ?? "Grid"}`;
    if (r.stream(`study:${b.id}`).chance(0.5)) {
      const room: Room = { id: `room:${nextRoom++}`, buildingId: b.id, name: "Study", itemIds: [] };
      b.rooms.push(room);
      placeEnvironmentalItems({ ...b, rooms: [room] } as Building, r.stream(`studyitems:${b.id}`));
    }
  }

  const city: CityMap = { name: cityName, width: GRID_W, height: GRID_H, roads, buildings };
  log.info("citygen", `Generated ${cityName}: ${buildings.length} buildings, ${Object.keys(items).length} items, ${roads.size} road cells`);
  return { city, items, nextRoomId: nextRoom, nextItemId: nextItem, nextBuildingId: nextBuilding };
}

// ------------------------------------------------------------- road pathfinding

/** BFS shortest path between two road cells; returns inclusive cell list. */
export function roadPath(
  city: CityMap,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Array<{ x: number; y: number }> {
  if (from.x === to.x && from.y === to.y) return [from];
  const start = roadKey(from.x, from.y);
  const goal = roadKey(to.x, to.y);
  if (!city.roads.has(start) || !city.roads.has(goal)) {
    throw new Error(`roadPath: endpoint not on road (${start} → ${goal})`);
  }
  const prev = new Map<string, string>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === goal) break;
    const [cx, cy] = cur.split(",").map(Number) as [number, number];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nk = roadKey(cx + dx, cy + dy);
      if (seen.has(nk) || !city.roads.has(nk)) continue;
      seen.add(nk);
      prev.set(nk, cur);
      queue.push(nk);
    }
  }
  if (!prev.has(goal)) throw new Error(`roadPath: no route ${start} → ${goal}`);
  const path: Array<{ x: number; y: number }> = [];
  let cur = goal;
  while (cur !== start) {
    const [x, y] = cur.split(",").map(Number) as [number, number];
    path.push({ x, y });
    cur = prev.get(cur)!;
  }
  path.push(from);
  path.reverse();
  return path;
}

export function streetNameAt(world: World, x: number, y: number): string {
  return world.city.roads.get(roadKey(x, y))?.streetName ?? "an unnamed street";
}
