/**
 * Population generation: households, jobs, personalities, schedules,
 * relationships, finances, possessions, and pre-existing secrets.
 *
 * Everything here happened "before day 0" — long-running facts of these
 * people's lives (marriages, grudges, debts, an affair). Facts created
 * during the simulated week instead carry event provenance.
 */

import { Rng } from "../core/rng";
import { log } from "../core/log";
import { FIRST_F, FIRST_M, LAST } from "../data/names";
import { OCCUPATIONS, occupationById } from "../data/occupations";
import { itemDef } from "../data/items";
import type {
  Building, Gender, Item, ItemId, ItemKind, Npc, NpcId, OccupationId,
  Personality, Relationship, ScheduleBlock, Secret, SecretId,
} from "./types";
import { relationshipBetween } from "./types";
import { APARTMENT_UNITS } from "./citygen";

export interface NpcGenResult {
  npcs: Npc[];
  secrets: Record<SecretId, Secret>;
  /** Personal possessions minted for the population (wallets, phones…). */
  items: Record<ItemId, Item>;
  nextNpcId: number;
  nextItemId: number;
  nextSecretId: number;
}

function makePersonality(r: Rng): Personality {
  return {
    honesty: r.trait(), aggression: r.trait(), empathy: r.trait(),
    curiosity: r.trait(), fearfulness: r.trait(), confidence: r.trait(),
    gossip: r.trait(), memoryQuality: r.trait(),
  };
}

/** Set both directions of a relationship with per-direction jitter. */
function bond(a: Npc, b: Npc, base: Partial<Relationship>, r: Rng): void {
  const jitter = (v: number | undefined, amt: number) =>
    v === undefined ? undefined : Math.max(-1, Math.min(1, v + (r.float() - 0.5) * amt));
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const rel = relationshipBetween(x, y.id);
    if (base.friendship !== undefined) rel.friendship = jitter(base.friendship, 0.2)!;
    if (base.trust !== undefined) rel.trust = Math.max(0, jitter(base.trust, 0.2)!);
    if (base.attraction !== undefined) rel.attraction = Math.max(0, jitter(base.attraction, 0.2)!);
    if (base.respect !== undefined) rel.respect = Math.max(0, jitter(base.respect, 0.2)!);
    if (base.jealousy !== undefined) rel.jealousy = Math.max(0, jitter(base.jealousy, 0.1)!);
  }
}

/**
 * Assign ownership of environmental items: householders own what's in their
 * homes (their unit, for apartments); business owners own what's in their
 * venues. This is what makes "routine use" fingerprints — and traceable
 * stolen goods — possible with honest provenance.
 */
export function assignItemOwnership(buildings: Building[], npcs: Npc[], items: Record<ItemId, Item>): void {
  for (const b of buildings) {
    if (b.type === "house") {
      const headId = b.residentIds[0];
      if (!headId) continue;
      for (const room of b.rooms) {
        for (const iid of room.itemIds) {
          const item = items[iid];
          if (item) item.ownerId = headId;
        }
      }
    } else if (b.type === "apartment") {
      const units = b.rooms.filter((r) => r.name.startsWith("Apartment"));
      for (const room of units) {
        const unitIdx = units.indexOf(room);
        // Same stable household↔unit mapping used by the crime planner.
        const head = b.residentIds
          .map((id) => npcs.find((n) => n.id === id))
          .find((n) => n && n.householdId % units.length === unitIdx);
        if (!head) continue;
        for (const iid of room.itemIds) {
          const item = items[iid];
          if (item) item.ownerId = head.id;
        }
      }
    } else if (b.ownerId) {
      for (const room of b.rooms) {
        for (const iid of room.itemIds) {
          const item = items[iid];
          if (item) item.ownerId = b.ownerId;
        }
      }
    }
  }
}

export function generatePopulation(rng: Rng, buildings: Building[], startItemId: number): NpcGenResult {
  const r = rng.stream("npcgen");
  const npcs: Npc[] = [];
  const secrets: Record<SecretId, Secret> = {};
  let nextNpc = 0;
  let nextItem = startItemId;
  let nextSecret = 0;
  let householdCounter = 0;

  const usedNames = new Set<string>();
  const lastNamePool = r.shuffle([...LAST]);
  let lastIdx = 0;

  const pickName = (rr: Rng, gender: Gender, forcedLast?: string): [string, string] => {
    for (let tries = 0; tries < 50; tries++) {
      const first = rr.pick(gender === "m" ? FIRST_M : FIRST_F);
      const last = forcedLast ?? lastNamePool[(lastIdx + tries) % lastNamePool.length]!;
      if (!usedNames.has(`${first} ${last}`)) {
        usedNames.add(`${first} ${last}`);
        if (!forcedLast) lastIdx++;
        return [first, last];
      }
    }
    throw new Error("npcgen: name pool exhausted");
  };

  const homes = buildings.filter((b) => b.type === "house" || b.type === "apartment");

  const makeNpc = (rr: Rng, homeId: string, householdId: number, opts: { gender?: Gender; last?: string; ageMin?: number; ageMax?: number } = {}): Npc => {
    const gender: Gender = opts.gender ?? (rr.chance(0.5) ? "m" : "f");
    const [first, last] = pickName(rr, gender, opts.last);
    const age = rr.int(opts.ageMin ?? 23, opts.ageMax ?? 74);
    const npc: Npc = {
      id: `npc:${nextNpc++}`,
      first, last, gender, age,
      occupation: "unemployed", workplaceId: null,
      homeId, householdId, partnerId: null,
      income: 0, cash: 0,
      personality: makePersonality(rr.stream("pers")),
      mood: 0, stress: rr.float() * 0.3, health: 0.7 + rr.float() * 0.3,
      shoeSize: gender === "m" ? rr.int(9, 13) : rr.int(6, 10),
      walkingSpeed: age > 65 ? rr.int(7, 9) : rr.int(9, 14),
      schedule: [], relationships: {}, memories: [],
      inventoryIds: [], phoneContactIds: [], secretIds: [],
      habits: [], alive: true,
      position: { kind: "building", buildingId: homeId, roomId: null },
      activity: "home",
      scheduleOverride: null,
    };
    return npc;
  };

  // ---- 1) Households -------------------------------------------------------
  interface HomeUnit { buildingId: string; roomName: string | null }
  const units: HomeUnit[] = [];
  for (const h of homes) {
    if (h.type === "house") units.push({ buildingId: h.id, roomName: null });
    else for (let u = 1; u <= APARTMENT_UNITS; u++) units.push({ buildingId: h.id, roomName: `Apartment ${u}` });
  }

  for (const unit of units) {
    const hr = r.stream(`hh:${unit.buildingId}:${unit.roomName ?? "house"}`);
    const householdId = householdCounter++;
    const kind = hr.weighted([["single", 0.4], ["couple", 0.38], ["roommates", 0.22]] as const);
    const members: Npc[] = [];
    if (kind === "single") {
      members.push(makeNpc(hr.stream("a"), unit.buildingId, householdId));
    } else if (kind === "couple") {
      const a = makeNpc(hr.stream("a"), unit.buildingId, householdId, { ageMin: 25, ageMax: 70 });
      const sameSex = hr.chance(0.12);
      const b = makeNpc(hr.stream("b"), unit.buildingId, householdId, {
        gender: sameSex ? a.gender : a.gender === "m" ? "f" : "m",
        last: hr.chance(0.7) ? a.last : undefined,
        ageMin: Math.max(23, a.age - 8), ageMax: Math.min(76, a.age + 8),
      });
      a.partnerId = b.id; b.partnerId = a.id;
      bond(a, b, { friendship: 0.7, trust: 0.85, attraction: 0.7, respect: 0.6 }, hr.stream("bond"));
      members.push(a, b);
    } else {
      const a = makeNpc(hr.stream("a"), unit.buildingId, householdId, { ageMin: 23, ageMax: 40 });
      const b = makeNpc(hr.stream("b"), unit.buildingId, householdId, { ageMin: 23, ageMax: 40 });
      bond(a, b, { friendship: 0.45, trust: 0.6, respect: 0.45 }, hr.stream("bond"));
      members.push(a, b);
    }
    for (const m of members) {
      npcs.push(m);
      const home = homes.find((h) => h.id === unit.buildingId)!;
      home.residentIds.push(m.id);
    }
  }

  // ---- 2) Jobs -------------------------------------------------------------
  for (const n of npcs) {
    if (n.age >= 66) { n.occupation = "retired"; }
  }
  // Landlord: oldest wealthy-ish house dweller under 66 owns the apartments.
  const landlordCandidates = npcs.filter((n) => n.age >= 45 && n.age < 66 && homes.find((h) => h.id === n.homeId)?.type === "house");
  if (landlordCandidates.length > 0) {
    const landlord = r.stream("landlord").pick(landlordCandidates);
    landlord.occupation = "landlord";
    for (const b of buildings) if (b.type === "apartment") b.ownerId = landlord.id;
  }

  interface JobSlot { occupation: OccupationId; buildingId: string; priority: number }
  const slots: JobSlot[] = [];
  for (const b of buildings) {
    const defs = OCCUPATIONS.filter((o) => o.workplaceType === b.type);
    for (const def of defs) {
      for (let i = 0; i < def.slotsPerBuilding; i++) {
        // First slot of each (building, occupation) is priority so every venue is staffed.
        slots.push({ occupation: def.id, buildingId: b.id, priority: i === 0 ? 0 : 1 });
      }
    }
  }
  const slotOrder = r.stream("slots").shuffle(slots).sort((a, b) => a.priority - b.priority);
  const workforce = r.stream("workforce").shuffle(npcs.filter((n) => n.occupation === "unemployed"));
  let si = 0;
  for (const worker of workforce) {
    // ~8% stay out of traditional work: writers / unemployed.
    const wr = r.stream(`job:${worker.id}`);
    if (wr.chance(0.08)) {
      worker.occupation = wr.chance(0.5) ? "writer" : "unemployed";
      continue;
    }
    const slot = slotOrder[si++];
    if (!slot) { worker.occupation = wr.chance(0.4) ? "writer" : "unemployed"; continue; }
    worker.occupation = slot.occupation;
    worker.workplaceId = slot.buildingId;
    const b = buildings.find((x) => x.id === slot.buildingId)!;
    b.employeeIds.push(worker.id);
    // Manager-tier roles own/run the business.
    if (["shop-owner", "office-manager", "factory-foreman"].includes(slot.occupation) && !b.ownerId) {
      b.ownerId = worker.id;
    }
  }
  // Any business without an explicit owner is run by its first employee.
  for (const b of buildings) {
    if (b.ownerId === null && b.employeeIds.length > 0 && !["police-station", "hospital", "school"].includes(b.type)) {
      b.ownerId = b.employeeIds[0]!;
    }
  }
  // House owners: first resident.
  for (const b of buildings) {
    if (b.type === "house" && b.residentIds.length > 0) b.ownerId = b.residentIds[0]!;
  }

  // ---- 3) Finances ---------------------------------------------------------
  for (const n of npcs) {
    const def = occupationById(n.occupation);
    n.income = Math.round(def.weeklyIncome * (0.9 + r.stream(`inc:${n.id}`).float() * 0.25));
    n.cash = Math.round(n.income * (1.5 + r.stream(`cash:${n.id}`).float() * 6.5));
  }

  // ---- 4) Schedules --------------------------------------------------------
  const leisureVenues = buildings.filter((b) => ["bar", "cafe", "restaurant", "park"].includes(b.type));
  for (const n of npcs) {
    const sr = r.stream(`sched:${n.id}`);
    const sched: ScheduleBlock[] = [];
    const wake = 330 + sr.int(0, 180); // 05:30–08:30
    const sleepStart = 1290 + sr.int(0, 150); // 21:30–24:00
    // Sleep wraps midnight: two blocks.
    sched.push({ startMin: sleepStart, endMin: 1440, days: [0, 1, 2, 3, 4, 5, 6], kind: "sleep", buildingId: n.homeId });
    sched.push({ startMin: 0, endMin: wake, days: [0, 1, 2, 3, 4, 5, 6], kind: "sleep", buildingId: n.homeId });

    const def = occupationById(n.occupation);
    if (def.workplaceType !== null && n.workplaceId) {
      const jitter = sr.int(-20, 20);
      let s = def.startMin + jitter;
      let e = def.endMin + jitter;
      if (e > 1440) {
        sched.push({ startMin: s, endMin: 1440, days: def.workDays, kind: "work", buildingId: n.workplaceId });
        // Post-midnight tail lands on the *next* calendar day.
        const nextDays = def.workDays.map((d) => (d + 1) % 7);
        sched.push({ startMin: 0, endMin: e - 1440, days: nextDays, kind: "work", buildingId: n.workplaceId });
      } else {
        sched.push({ startMin: s, endMin: e, days: def.workDays, kind: "work", buildingId: n.workplaceId });
      }
    } else if (n.occupation === "landlord") {
      // Rounds at the apartment buildings twice a week.
      const apts = buildings.filter((b) => b.type === "apartment");
      if (apts.length > 0) {
        sched.push({ startMin: 600, endMin: 720, days: [0, 3], kind: "work", buildingId: sr.pick(apts).id });
      }
    }

    // Favourite venues (stable — this is what neighbors will tell you about).
    const fav = sr.pick(leisureVenues);
    const fav2 = sr.pick(leisureVenues);
    // Evening leisure on 2–4 days.
    const evenings = sr.shuffle([0, 1, 2, 3, 4, 5, 6]).slice(0, sr.int(2, 4));
    const goOut = 1140 + sr.int(0, 90); // 19:00–20:30
    sched.push({ startMin: goOut, endMin: Math.min(goOut + sr.int(90, 180), sleepStart - 10), days: evenings, kind: "social", buildingId: sr.chance(0.65) ? fav.id : null });
    // Weekend daytime leisure.
    sched.push({ startMin: 660 + sr.int(0, 120), endMin: 900 + sr.int(0, 60), days: [5, 6], kind: "leisure", buildingId: sr.chance(0.5) ? fav2.id : null });
    // Errand: store run once a week.
    const stores = buildings.filter((b) => b.type === "store");
    if (stores.length > 0) {
      sched.push({ startMin: 1020 + sr.int(0, 60), endMin: 1080 + sr.int(0, 60), days: [sr.int(0, 6)], kind: "errand", buildingId: sr.pick(stores).id });
    }
    n.schedule = sched;

    if (fav.type === "bar") n.habits.push(`regular at ${fav.name}`);
    else if (fav.type === "park") n.habits.push(`evening walks in ${fav.name}`);
    else n.habits.push(`often at ${fav.name} in the evening`);
  }

  // ---- 5) Social graph -----------------------------------------------------
  const gr = r.stream("graph");
  // Coworkers.
  for (const b of buildings) {
    for (let i = 0; i < b.employeeIds.length; i++) {
      for (let j = i + 1; j < b.employeeIds.length; j++) {
        const a = npcs.find((n) => n.id === b.employeeIds[i])!;
        const c = npcs.find((n) => n.id === b.employeeIds[j])!;
        if (gr.chance(0.15)) {
          // Workplace friction.
          bond(a, c, { friendship: -0.35, trust: 0.25, respect: 0.2 }, gr.stream(`cw:${a.id}:${c.id}`));
        } else {
          bond(a, c, { friendship: 0.3, trust: 0.5, respect: 0.45 }, gr.stream(`cw:${a.id}:${c.id}`));
        }
      }
    }
  }
  // Friendships across town.
  for (const n of npcs) {
    const fr = gr.stream(`fr:${n.id}`);
    const others = npcs.filter((o) => o.id !== n.id && o.householdId !== n.householdId);
    for (let k = 0; k < fr.int(1, 3); k++) {
      const o = fr.pick(others);
      bond(n, o, { friendship: 0.5, trust: 0.6, respect: 0.5 }, fr.stream(`b:${k}`));
    }
  }
  // Grudges: 3–5 hostile pairs.
  const grudgeCount = gr.int(3, 5);
  for (let k = 0; k < grudgeCount; k++) {
    const a = gr.pick(npcs);
    const b = gr.pick(npcs.filter((o) => o.householdId !== a.householdId));
    bond(a, b, { friendship: -0.6, trust: 0.1, respect: 0.15 }, gr.stream(`g:${k}`));
  }
  // Exes: 2–3 pairs with lingering attraction and jealousy.
  for (let k = 0; k < gr.int(2, 3); k++) {
    const a = gr.pick(npcs.filter((n) => n.age >= 25));
    const b = gr.pick(npcs.filter((o) => o.householdId !== a.householdId && o.age >= 25));
    bond(a, b, { friendship: 0.1, trust: 0.3, attraction: 0.5, jealousy: 0.5 }, gr.stream(`ex:${k}`));
  }
  // Debts: 2–3 loans from wealthy to strapped.
  const wealthy = [...npcs].sort((a, b) => b.cash - a.cash).slice(0, 6);
  const strapped = [...npcs].sort((a, b) => a.cash - b.cash).slice(0, 8);
  for (let k = 0; k < gr.int(2, 3); k++) {
    const lender = gr.pick(wealthy);
    const debtor = gr.pick(strapped.filter((s) => s.id !== lender.id));
    const amount = gr.int(6, 24) * 100;
    relationshipBetween(debtor, lender.id).debt += amount;
    relationshipBetween(debtor, lender.id).fear = Math.min(1, relationshipBetween(debtor, lender.id).fear + 0.3);
    const sid: SecretId = `sec:${nextSecret++}`;
    secrets[sid] = {
      id: sid, kind: "heavy-debt", holderId: debtor.id, otherId: lender.id,
      knownBy: [], originEventId: null,
      description: `owes ${lender.first} ${lender.last} $${amount} and is behind on payments`,
    };
    debtor.secretIds.push(sid);
  }
  // One pre-existing affair (attached person + outside partner) — a reliable red herring.
  const attached = npcs.filter((n) => n.partnerId !== null);
  if (attached.length > 0) {
    const ar = gr.stream("affair");
    const a = ar.pick(attached);
    const candidates = npcs.filter((o) => o.id !== a.id && o.id !== a.partnerId && o.householdId !== a.householdId);
    const b = ar.pick(candidates);
    bond(a, b, { friendship: 0.4, trust: 0.6, attraction: 0.8 }, ar.stream("bond"));
    const sid: SecretId = `sec:${nextSecret++}`;
    secrets[sid] = {
      id: sid, kind: "affair", holderId: a.id, otherId: b.id,
      knownBy: [], originEventId: null,
      description: `is having an affair with ${b.first} ${b.last}`,
    };
    a.secretIds.push(sid);
    const sid2: SecretId = `sec:${nextSecret++}`;
    secrets[sid2] = {
      id: sid2, kind: "affair", holderId: b.id, otherId: a.id,
      knownBy: [], originEventId: null,
      description: `is having an affair with ${a.first} ${a.last}`,
    };
    b.secretIds.push(sid2);
  }
  // A criminal past or two.
  for (let k = 0; k < gr.int(1, 2); k++) {
    const n = gr.pick(npcs);
    const sid: SecretId = `sec:${nextSecret++}`;
    secrets[sid] = {
      id: sid, kind: "criminal-past", holderId: n.id, otherId: null,
      knownBy: [], originEventId: null,
      description: `served time years ago under a different name`,
    };
    n.secretIds.push(sid);
  }

  // ---- 6) Possessions & contacts -------------------------------------------
  const itemsOut: Record<ItemId, Item> = {};
  for (const n of npcs) {
    const pr = r.stream(`poss:${n.id}`);
    const personal: ItemKind[] = ["wallet", "phone", "keys"];
    if (pr.chance(0.4)) personal.push("watch");
    if (n.gender === "f" && pr.chance(0.35)) personal.push("necklace");
    for (const kind of personal) {
      const def = itemDef(kind);
      const id: ItemId = `item:${nextItem++}`;
      itemsOut[id] = {
        id, kind, name: `${n.first}'s ${def.label.toLowerCase()}`, ownerId: n.id,
        roomId: null, carrierId: n.id, lethality: def.lethality,
        fingerprints: [], bloodOfNpcId: null, bloodEventId: null, hiddenAt: null,
      };
      n.inventoryIds.push(id);
    }
    // Phone contacts: household, partner, coworkers, friends.
    const contacts = new Set<NpcId>();
    if (n.partnerId) contacts.add(n.partnerId);
    for (const o of npcs) {
      if (o.id === n.id) continue;
      if (o.householdId === n.householdId) contacts.add(o.id);
      const rel = n.relationships[o.id];
      if (rel && (rel.friendship > 0.25 || rel.debt !== 0)) contacts.add(o.id);
    }
    if (n.workplaceId) {
      const b = buildings.find((x) => x.id === n.workplaceId)!;
      for (const e of b.employeeIds) if (e !== n.id) contacts.add(e);
    }
    n.phoneContactIds = [...contacts];
  }

  log.info("npcgen", `Generated ${npcs.length} residents in ${householdCounter} households; ${Object.keys(secrets).length} pre-existing secrets`);
  return { npcs, secrets, items: itemsOut, nextNpcId: nextNpc, nextItemId: nextItem, nextSecretId: nextSecret };
}
