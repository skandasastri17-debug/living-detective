/**
 * Investigative actions: everything the detective can physically do.
 *
 * Each function is a projection of world truth into the case file. Nothing
 * is invented here — scene reports read the actual scene state, prints read
 * actual traces plus routine owner use, records read the actual logs the
 * simulation wrote.
 */

import { Rng, hashString } from "../core/rng";
import { fmtClock, fmtTime, fmtTimeLong } from "../core/time";
import type { Building, Item, Npc, NpcId, World } from "../world/types";
import { buildingById, fullName, itemById, roomById } from "../world/types";
import { addEvidence, addRelationFact, learnFactFromSecret, type CaseFile, type EvidenceEntry } from "./casefile";

function victimOf(world: World): Npc {
  const crime = world.crime;
  if (!crime) throw new Error("No crime yet");
  return world.npcs.find((n) => n.id === crime.victimId)!;
}

/** Personal carried items — only the owner routinely handles these. */
const PERSONAL_KINDS = new Set(["wallet", "phone", "keys", "watch", "necklace"]);

/**
 * All prints "on" an item: explicit event traces, the owner's routine use,
 * and — for shared household items like kitchen knives — the routine use of
 * everyone in the owner's household. Nobody's prints appear without a
 * believable origin.
 */
export function printsOn(world: World, item: Item): Array<{ npcId: NpcId; note: string }> {
  const out: Array<{ npcId: NpcId; note: string }> = [];
  // A deliberate wipe removes routine-use prints along with everything else;
  // only traces deposited AFTER the wipe (which are all that remain in
  // item.fingerprints) can appear.
  if (item.ownerId && !item.wipedAt) {
    out.push({ npcId: item.ownerId, note: "routine use (owner)" });
    if (!PERSONAL_KINDS.has(item.kind)) {
      const owner = world.npcs.find((n) => n.id === item.ownerId);
      if (owner) {
        for (const n of world.npcs) {
          if (n.id !== owner.id && n.householdId === owner.householdId) {
            out.push({ npcId: n.id, note: "routine use (household)" });
          }
        }
      }
    }
  }
  for (const tr of item.fingerprints) {
    if (!out.some((x) => x.npcId === tr.npcId)) {
      out.push({ npcId: tr.npcId, note: `fresh — deposited ${fmtTimeLong(tr.t)}` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the scene

export function examineScene(world: World, cf: CaseFile): EvidenceEntry[] {
  const crime = world.crime!;
  const scene = world.scene!;
  const victim = victimOf(world);
  const b = buildingById(world, scene.buildingId);
  const room = roomById(world, scene.roomId);
  const out: EvidenceEntry[] = [];

  out.push(addEvidence(cf, {
    kind: "scene-report",
    title: `Crime scene: ${room.name}, ${b.name}`,
    detail: `${fullName(victim)} was found in the ${room.name.toLowerCase()} of ${b.name}. ` +
      (scene.bloodOfVictim ? `Significant blood traces belong to the victim. ` : ``) +
      `No signs of forced entry. The scene suggests the victim knew, or at least admitted, the attacker.`,
    discoveredAt: world.time,
    buildingId: b.id, itemId: null, npcIds: [victim.id],
    placesAtBuildingId: b.id, placesFrom: crime.murderTime - 30, placesTo: crime.murderTime + 30,
  }));

  for (const fp of scene.footprints) {
    out.push(addEvidence(cf, {
      kind: "footprint",
      title: `Footprints at the scene — size ${fp.shoeSize}`,
      detail: `A clear set of size-${fp.shoeSize} shoe impressions near the body, distinct from the victim's (size ${victim.shoeSize}). Compare against suspects' shoe sizes.`,
      discoveredAt: world.time,
      buildingId: b.id, itemId: null, npcIds: [],
      placesAtBuildingId: null, placesFrom: null, placesTo: null,
    }));
  }

  // Items present in the scene room.
  for (const iid of room.itemIds) {
    const item = itemById(world, iid);
    out.push(...examineItem(world, cf, item, b));
  }
  return out;
}

/** Examine one item: produces item/weapon evidence + fingerprint entries. */
export function examineItem(world: World, cf: CaseFile, item: Item, where: Building): EvidenceEntry[] {
  const out: EvidenceEntry[] = [];
  const crime = world.crime;
  const bloodied = item.bloodOfNpcId !== null;
  const victimName = crime ? fullName(world.npcs.find((n) => n.id === crime.victimId)!) : "";

  if (bloodied) {
    // Whose is it? Household items are identifiable (the household can be
    // asked, distinctive wear, purchase history) — ownership is generation
    // truth, so naming the source household is honest projection. This is
    // the classic "the knife came from the accused's own kitchen" link, and
    // it survives gloves and wiping.
    const owner = item.ownerId ? world.npcs.find((n) => n.id === item.ownerId) : null;
    const householdIds: NpcId[] = owner && !PERSONAL_KINDS.has(item.kind)
      ? world.npcs.filter((n) => n.householdId === owner.householdId).map((n) => n.id)
      : owner ? [owner.id] : [];
    out.push(addEvidence(cf, {
      kind: "weapon",
      title: `${item.name} — traces of blood`,
      detail: `${item.name} found in the ${roomLabelOf(world, item)} of ${where.name}. Lab confirms the blood is ${victimName}'s. This is consistent with the murder weapon.` +
        (owner ? ` The item is identified as belonging to ${fullName(owner)}${householdIds.length > 1 ? "'s household" : ""}.` : ``) +
        (item.hiddenAt ? ` It appears to have been deliberately discarded (${item.hiddenAt}).` : ``),
      discoveredAt: world.time,
      buildingId: where.id, itemId: item.id,
      npcIds: crime ? [...new Set([crime.victimId, ...householdIds])] : householdIds,
      placesAtBuildingId: null, placesFrom: null, placesTo: null,
      itemLink: true,
    }));
  }

  // The victim's own phone is a shortcut into their life: examining it
  // surfaces their call history on the spot (same truth as a records pull).
  if (item.kind === "phone" && crime && item.ownerId === crime.victimId) {
    out.push(pullPhoneRecords(world, cf, crime.victimId));
  }

  // Deliberate wiping is itself forensic evidence — someone with something
  // to hide handled this AFTER the murder.
  if (item.wipedAt) {
    out.push(addEvidence(cf, {
      kind: "item",
      title: `${item.name} — wiped clean`,
      detail: `The surfaces of ${item.name.toLowerCase()} show deliberate, recent wiping. ` +
        `Someone cleaned this on purpose${item.fingerprints.length > 0 ? " — but not perfectly. A fresh print survives." : "."} ` +
        `Wiping down ${bloodied ? "a murder weapon" : "evidence"} after the fact is the act of someone with a great deal to lose.`,
      discoveredAt: world.time,
      buildingId: where.id, itemId: item.id,
      npcIds: [],
      placesAtBuildingId: null, placesFrom: null, placesTo: null,
      consciousnessOfGuilt: true,
    }));
  }

  const prints = printsOn(world, item);
  for (const p of prints) {
    const person = world.npcs.find((n) => n.id === p.npcId);
    if (!person) continue;
    // Only interesting prints become evidence: on bloodied items, valuables, or non-owner prints.
    const interesting = bloodied || (item.ownerId !== null && p.npcId !== item.ownerId) || ["cash-box", "necklace", "watch", "wallet"].includes(item.kind);
    if (!interesting) continue;
    out.push(addEvidence(cf, {
      kind: "fingerprint",
      title: `Prints on ${item.name}: ${fullName(person)}`,
      detail: `Fingerprints belonging to ${fullName(person)} on ${item.name} (${p.note}).` +
        (bloodied ? ` Given the blood evidence, this directly ties ${fullName(person)} to the weapon.` : ``),
      discoveredAt: world.time,
      buildingId: where.id, itemId: item.id, npcIds: [p.npcId],
      placesAtBuildingId: null, placesFrom: null, placesTo: null,
      itemLink: bloodied,
    }));
  }
  return out;
}

function roomLabelOf(world: World, item: Item): string {
  if (!item.roomId) return "unknown place";
  return roomById(world, item.roomId).name.toLowerCase();
}

// ------------------------------------------------------------------- autopsy

export function readAutopsy(world: World, cf: CaseFile): EvidenceEntry {
  const crime = world.crime!;
  const victim = victimOf(world);
  const r = new Rng((world.seed ^ hashString("autopsy")) >>> 0);
  const before = 25 + r.int(0, 35);
  const after = 25 + r.int(0, 35);
  const from = crime.murderTime - before;
  const to = crime.murderTime + after;

  const weapon = crime.weaponItemId ? world.items[crime.weaponItemId] : null;
  const cause = !weapon
    ? "manual strangulation; bruising consistent with hands"
    : weapon.lethality >= 0.85
      ? `sharp-force trauma; wound profile consistent with a blade such as a ${weapon.name.toLowerCase()}`
      : `blunt-force trauma; injuries consistent with a heavy object such as a ${weapon.name.toLowerCase()}`;

  cf.autopsyDone = true;
  const struggleDna = world.scene?.struggleDnaOfNpcId != null;
  return addEvidence(cf, {
    kind: "autopsy",
    title: `Autopsy report — ${fullName(victim)}`,
    detail: `Cause of death: ${cause}. Estimated time of death between ${fmtTimeLong(from)} and ${fmtClock(to)}. ` +
      `${crime.premeditated ? "Single decisive attack; little sign of prolonged struggle." : "Signs of a sudden, frenzied attack."}` +
      (struggleDna
        ? ` The victim fought back: biological material recovered from under the fingernails. The lab can compare it against a named individual (bring them a suspect).`
        : ``),
    discoveredAt: world.time,
    buildingId: crime.sceneBuildingId, itemId: null, npcIds: [victim.id],
    placesAtBuildingId: crime.sceneBuildingId, placesFrom: from, placesTo: to,
  });
}

/**
 * DNA comparison: only possible when the autopsy recovered material, and
 * only against a NAMED suspect — the lab confirms or clears, it never goes
 * fishing. Truth comes straight from the scene state (murder-event
 * provenance); a mismatch is honestly exculpatory.
 */
export function compareDna(world: World, cf: CaseFile, suspectId: NpcId): EvidenceEntry {
  const scene = world.scene;
  if (!cf.autopsyDone) throw new Error("The lab needs the autopsy first");
  if (!scene || scene.struggleDnaOfNpcId == null) throw new Error("No biological material was recovered");
  const suspect = world.npcs.find((n) => n.id === suspectId)!;
  const victim = victimOf(world);
  const match = scene.struggleDnaOfNpcId === suspectId;
  return addEvidence(cf, {
    kind: "dna",
    title: match
      ? `DNA match: material under ${victim.first}'s nails is ${fullName(suspect)}'s`
      : `DNA comparison: ${fullName(suspect)} excluded`,
    detail: match
      ? `Lab comparison confirms the biological material recovered from under ${fullName(victim)}'s fingernails belongs to ${fullName(suspect)}. The victim marked their killer.`
      : `Lab comparison against ${fullName(suspect)} is negative. Whoever ${fullName(victim)} fought with, it was not ${suspect.first}.`,
    discoveredAt: world.time,
    buildingId: null, itemId: null,
    npcIds: match ? [suspectId, victim.id] : [suspectId],
    placesAtBuildingId: match ? world.crime!.sceneBuildingId : null,
    placesFrom: match ? world.crime!.murderTime - 15 : null,
    placesTo: match ? world.crime!.murderTime + 15 : null,
    itemLink: match,
    consciousnessOfGuilt: false,
  });
}

// ------------------------------------------------------------------ searches

export function searchBuilding(world: World, cf: CaseFile, buildingId: string): EvidenceEntry[] {
  const b = buildingById(world, buildingId);
  const out: EvidenceEntry[] = [];
  if (!cf.searchedBuildings.includes(buildingId)) cf.searchedBuildings.push(buildingId);

  for (const room of b.rooms) {
    for (const iid of room.itemIds) {
      const item = itemById(world, iid);
      // Notable finds only: blood, weapons out of place, stolen goods, documents.
      if (item.bloodOfNpcId) {
        out.push(...examineItem(world, cf, item, b));
        continue;
      }
      if (item.ownerId) {
        const owner = world.npcs.find((n) => n.id === item.ownerId);
        const ownerLivesHere = owner && owner.homeId === b.id;
        const ownerWorksHere = owner && owner.workplaceId === b.id;
        if (owner && !ownerLivesHere && !ownerWorksHere && ["wallet", "necklace", "watch", "phone", "keys"].includes(item.kind)) {
          out.push(addEvidence(cf, {
            kind: "item",
            title: `${item.name} found at ${b.name}`,
            detail: `${item.name} — belonging to ${fullName(owner)} — turned up in the ${room.name.toLowerCase()} of ${b.name}. It has no business being here.`,
            discoveredAt: world.time,
            buildingId: b.id, itemId: item.id, npcIds: [owner.id],
            placesAtBuildingId: null, placesFrom: null, placesTo: null,
          }));
          out.push(...examineItem(world, cf, item, b));
        }
      }
      // Documents reveal resident secrets with a physical anchor.
      if (["letter", "ledger", "note", "photo"].includes(item.kind)) {
        out.push(...readDocument(world, cf, item, b, room.name));
      }
    }
  }
  if (out.length === 0) {
    out.push(addEvidence(cf, {
      kind: "document",
      title: `Search notes — ${b.name}`,
      detail: `A thorough search of ${b.name} turned up nothing of evidentiary value.`,
      discoveredAt: world.time,
      buildingId: b.id, itemId: null, npcIds: [],
      placesAtBuildingId: null, placesFrom: null, placesTo: null,
    }));
  }
  return out;
}

/** Letters/ledgers surface long-running secrets of the people who live/work here. */
function readDocument(world: World, cf: CaseFile, item: Item, b: Building, roomName: string): EvidenceEntry[] {
  const out: EvidenceEntry[] = [];
  const residents = [...b.residentIds, ...b.employeeIds]
    .map((id) => world.npcs.find((n) => n.id === id))
    .filter((n): n is Npc => n !== undefined);
  for (const person of residents) {
    for (const sid of person.secretIds) {
      const s = world.secrets[sid];
      if (!s) continue;
      const match =
        (item.kind === "letter" && s.kind === "affair") ||
        (item.kind === "ledger" && (s.kind === "heavy-debt" || s.kind === "blackmail")) ||
        (item.kind === "note" && s.kind === "being-blackmailed");
      if (!match) continue;
      const other = s.otherId ? world.npcs.find((n) => n.id === s.otherId) : null;
      const entry = addEvidence(cf, {
        kind: "document",
        title: `${item.name} in the ${roomName.toLowerCase()} of ${b.name}`,
        detail:
          item.kind === "letter"
            ? `A personal letter, unsigned but unambiguous: ${fullName(person)} ${s.description}.${other ? ` The handwriting matches ${fullName(other)}.` : ""}`
            : item.kind === "ledger"
              ? `Careful figures in a private ledger: ${fullName(person)} ${s.description}.`
              : `A short, unsigned note. Its meaning is plain: ${fullName(person)} ${s.description}.`,
        discoveredAt: world.time,
        buildingId: b.id, itemId: item.id,
        npcIds: other ? [person.id, other.id] : [person.id],
        placesAtBuildingId: null, placesFrom: null, placesTo: null,
        motiveHint: true,
      });
      learnFactFromSecret(cf, s, entry.id);
      out.push(entry);
    }
  }
  return out;
}

// -------------------------------------------------------------------- records

export function pullPhoneRecords(world: World, cf: CaseFile, npcId: NpcId): EvidenceEntry {
  const person = world.npcs.find((n) => n.id === npcId)!;
  if (!cf.phoneRecordsPulled.includes(npcId)) cf.phoneRecordsPulled.push(npcId);
  const calls = world.phoneLog
    .filter((c) => c.fromId === npcId || c.toId === npcId)
    .slice(-40);
  const lines = calls.map((c) => {
    const from = world.npcs.find((n) => n.id === c.fromId)!;
    const to = world.npcs.find((n) => n.id === c.toId)!;
    const dir = c.fromId === npcId ? `→ ${fullName(to)}` : `← ${fullName(from)}`;
    return `${fmtTime(c.t)}  ${dir}  ${c.durationMin === 0 ? "no answer" : `${c.durationMin} min`}`;
  });
  const involved = new Set<NpcId>([npcId]);
  for (const c of calls) { involved.add(c.fromId); involved.add(c.toId); }
  return addEvidence(cf, {
    kind: "phone-records",
    title: `Phone records — ${fullName(person)}`,
    detail: lines.length > 0 ? lines.join("\n") : "No calls on record.",
    discoveredAt: world.time,
    buildingId: null, itemId: null, npcIds: [...involved],
    placesAtBuildingId: null, placesFrom: null, placesTo: null,
  });
}

export function pullFinancialRecords(world: World, cf: CaseFile, npcId: NpcId): EvidenceEntry {
  const person = world.npcs.find((n) => n.id === npcId)!;
  if (!cf.financialRecordsPulled.includes(npcId)) cf.financialRecordsPulled.push(npcId);
  const txns = world.transactions
    .filter((t) => t.fromId === npcId || t.toId === npcId)
    .slice(-50);
  let motiveHint = false;
  const lines = txns.map((t) => {
    const from = t.fromId ? fullName(world.npcs.find((n) => n.id === t.fromId)!) : "—";
    const to = t.toId ? fullName(world.npcs.find((n) => n.id === t.toId)!) : "—";
    if (t.memo.includes("cash withdrawal") || t.memo.includes("knife") || t.memo.includes("hammer")) motiveHint = true;
    return `${fmtTime(t.t)}  ${from} → ${to}  $${t.amount}  (${t.memo})`;
  });
  const involved = new Set<NpcId>([npcId]);
  for (const t of txns) { if (t.fromId) involved.add(t.fromId); if (t.toId) involved.add(t.toId); }
  // Outstanding debts are part of the financial picture.
  const debts: string[] = [];
  const debtEdges: Array<{ otherId: NpcId; label: string }> = [];
  for (const other of world.npcs) {
    const rel = person.relationships[other.id];
    if (rel && rel.debt > 0) {
      debts.push(`OUTSTANDING: owes ${fullName(other)} $${rel.debt}`);
      debtEdges.push({ otherId: other.id, label: `owes ${fullName(other)} $${rel.debt}` });
      involved.add(other.id);
      motiveHint = true;
    }
    const relBack = other.relationships[person.id];
    if (relBack && relBack.debt > 0) {
      debts.push(`OUTSTANDING: ${fullName(other)} owes them $${relBack.debt}`);
      debtEdges.push({ otherId: other.id, label: `${fullName(other)} owes them $${relBack.debt}` });
      involved.add(other.id);
      motiveHint = true;
    }
  }
  const entry = addEvidence(cf, {
    kind: "financial-records",
    title: `Financial records — ${fullName(person)}`,
    detail: [...debts, ...lines].join("\n") || "Nothing notable.",
    discoveredAt: world.time,
    buildingId: null, itemId: null, npcIds: [...involved],
    placesAtBuildingId: null, placesFrom: null, placesTo: null,
    motiveHint,
  });
  for (const e of debtEdges) addRelationFact(cf, npcId, e.otherId, "debt", entry.id, e.label);
  return entry;
}

export function pullCameraLogs(world: World, cf: CaseFile, buildingId: string): EvidenceEntry[] {
  const b = buildingById(world, buildingId);
  const crime = world.crime!;
  if (!cf.cameraLogsPulled.includes(buildingId)) cf.cameraLogsPulled.push(buildingId);
  const out: EvidenceEntry[] = [];
  if (!b.hasCamera) {
    out.push(addEvidence(cf, {
      kind: "camera-log",
      title: `Camera check — ${b.name}`,
      detail: `${b.name} has no camera coverage.`,
      discoveredAt: world.time,
      buildingId: b.id, itemId: null, npcIds: [],
      placesAtBuildingId: null, placesFrom: null, placesTo: null,
    }));
    return out;
  }
  const entries = world.cameraLog.filter((e) => e.buildingId === buildingId);
  const lines = entries.slice(-60).map((e) => {
    const n = world.npcs.find((x) => x.id === e.npcId)!;
    return `${fmtTime(e.t)}  ${fullName(n)}  ${e.direction === "in" ? "ENTERS" : "EXITS"}`;
  });
  out.push(addEvidence(cf, {
    kind: "camera-log",
    title: `Camera footage — ${b.name}`,
    detail: lines.join("\n") || "No entries in the retention window.",
    discoveredAt: world.time,
    buildingId: b.id, itemId: null,
    npcIds: [...new Set(entries.map((e) => e.npcId))],
    placesAtBuildingId: null, placesFrom: null, placesTo: null,
  }));
  // Hits near the murder window become placement-grade entries.
  const from = crime.murderTime - 240;
  const to = crime.murderTime + 240;
  for (const e of entries.filter((e) => e.t >= from && e.t <= to)) {
    const n = world.npcs.find((x) => x.id === e.npcId)!;
    out.push(addEvidence(cf, {
      kind: "camera-log",
      title: `Camera: ${fullName(n)} ${e.direction === "in" ? "entering" : "leaving"} ${b.name} at ${fmtTime(e.t)}`,
      detail: `Timestamped footage from ${b.name} shows ${fullName(n)} ${e.direction === "in" ? "entering" : "leaving"} at ${fmtTimeLong(e.t)}.`,
      discoveredAt: world.time,
      buildingId: b.id, itemId: null, npcIds: [e.npcId],
      placesAtBuildingId: b.id, placesFrom: e.t - 10, placesTo: e.t + 10,
    }));
  }
  return out;
}
