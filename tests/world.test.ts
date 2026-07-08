import { describe, expect, it } from "vitest";
import { Rng } from "../src/core/rng";
import { generateCity, roadPath } from "../src/world/citygen";
import { generatePopulation } from "../src/world/npcgen";
import { occupationById } from "../src/data/occupations";

function makeWorldParts(seed = 42) {
  const rng = new Rng(seed);
  const cityRes = generateCity(rng);
  const popRes = generatePopulation(rng, cityRes.city.buildings, cityRes.nextItemId);
  return { cityRes, popRes };
}

describe("citygen", () => {
  it("is deterministic for a given seed", () => {
    const a = makeWorldParts(7).cityRes;
    const b = makeWorldParts(7).cityRes;
    expect(a.city.name).toBe(b.city.name);
    expect(a.city.buildings.map((x) => x.name)).toEqual(b.city.buildings.map((x) => x.name));
  });

  it("places all required civic and commercial buildings", () => {
    const { cityRes } = makeWorldParts();
    const types = cityRes.city.buildings.map((b) => b.type);
    for (const required of ["police-station", "hospital", "school", "bar", "cafe", "restaurant", "store", "office", "factory", "warehouse", "park", "house", "apartment"]) {
      expect(types, `missing ${required}`).toContain(required);
    }
  });

  it("gives every building a door on a road and at least one room", () => {
    const { cityRes } = makeWorldParts();
    for (const b of cityRes.city.buildings) {
      expect(cityRes.city.roads.has(`${b.door.x},${b.door.y}`), `${b.name} door not on road`).toBe(true);
      expect(b.rooms.length).toBeGreaterThan(0);
    }
  });

  it("finds a road path between any two building doors", () => {
    const { cityRes } = makeWorldParts();
    const bs = cityRes.city.buildings;
    for (let i = 0; i < 10; i++) {
      const a = bs[i % bs.length]!;
      const b = bs[(i * 7 + 3) % bs.length]!;
      const path = roadPath(cityRes.city, a.door, b.door);
      expect(path.length).toBeGreaterThan(0);
      expect(path[0]).toEqual(a.door);
      expect(path[path.length - 1]).toEqual(b.door);
    }
  });

  it("places environmental items with correct room provenance", () => {
    const { cityRes } = makeWorldParts();
    for (const [id, item] of Object.entries(cityRes.items)) {
      expect(item.roomId, `${id} must sit in a room`).not.toBeNull();
      const room = cityRes.city.buildings.flatMap((b) => b.rooms).find((r) => r.id === item.roomId);
      expect(room, `${id} room exists`).toBeDefined();
      expect(room!.itemIds).toContain(id);
    }
  });
});

describe("npcgen", () => {
  it("everyone has a home, and workers have a workplace matching their job", () => {
    const { cityRes, popRes } = makeWorldParts();
    for (const n of popRes.npcs) {
      const home = cityRes.city.buildings.find((b) => b.id === n.homeId);
      expect(home, `${n.first} has a home`).toBeDefined();
      expect(home!.residentIds).toContain(n.id);
      const def = occupationById(n.occupation);
      if (def.workplaceType !== null && n.workplaceId) {
        const wp = cityRes.city.buildings.find((b) => b.id === n.workplaceId)!;
        expect(wp.type).toBe(def.workplaceType);
        expect(wp.employeeIds).toContain(n.id);
      }
    }
  });

  it("gives everyone a schedule that includes sleep at home", () => {
    const { popRes } = makeWorldParts();
    for (const n of popRes.npcs) {
      const sleepBlocks = n.schedule.filter((b) => b.kind === "sleep");
      expect(sleepBlocks.length).toBeGreaterThanOrEqual(2);
      for (const b of sleepBlocks) expect(b.buildingId).toBe(n.homeId);
    }
  });

  it("partners are mutual and cohabiting", () => {
    const { popRes } = makeWorldParts();
    for (const n of popRes.npcs) {
      if (!n.partnerId) continue;
      const p = popRes.npcs.find((x) => x.id === n.partnerId)!;
      expect(p.partnerId).toBe(n.id);
      expect(p.householdId).toBe(n.householdId);
    }
  });

  it("mints personal items owned and carried by their NPC", () => {
    const { popRes } = makeWorldParts();
    for (const n of popRes.npcs) {
      expect(n.inventoryIds.length).toBeGreaterThanOrEqual(3);
      for (const iid of n.inventoryIds) {
        const item = popRes.items[iid];
        expect(item).toBeDefined();
        expect(item!.ownerId).toBe(n.id);
        expect(item!.carrierId).toBe(n.id);
      }
    }
  });

  it("seeds at least one affair and one debt secret", () => {
    const { popRes } = makeWorldParts();
    const kinds = Object.values(popRes.secrets).map((s) => s.kind);
    expect(kinds).toContain("affair");
    expect(kinds).toContain("heavy-debt");
  });
});
