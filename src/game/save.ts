/**
 * Save system: multiple slots + autosave in localStorage, plus seed replay.
 *
 * The world serializes to plain JSON; the only non-JSON structure is the
 * road Map, converted to an array. Saves are only written during the
 * investigation (the pre-murder simulation is deterministic from the seed,
 * so "replay seed" reproduces the whole case from scratch).
 *
 * Saves are namespaced per profile (see game/profile.ts): a signed-in name,
 * or "guest". Every function here takes the profile key explicitly so this
 * module stays decoupled from session state and easy to test.
 */

import { log } from "../core/log";
import type { CityMap, RoadCell, World } from "../world/types";
import type { CaseFile } from "../investigation/casefile";
import type { GamePhase } from "./director";
import { GUEST_PROFILE } from "./profile";

const SAVE_VERSION = 1;
const KEY_PREFIX = "living-detective:save:";
export const AUTOSAVE_SLOT = "autosave";
export const SLOTS = [AUTOSAVE_SLOT, "slot-1", "slot-2", "slot-3"] as const;

function keyFor(profileKey: string, slot: string): string {
  return `${KEY_PREFIX}${profileKey}:${slot}`;
}

/**
 * `localStorage` itself doesn't exist in the Node test environment (or a
 * browser that blocks storage outright) — `typeof` is the one safe way to
 * probe an identifier that may not be declared at all, without throwing.
 * When it's genuinely absent, fall back to an in-memory map so this module
 * stays unit-testable and degrades gracefully instead of no-op'ing.
 *
 * This is deliberately narrower than a blanket try/catch around every call:
 * if `localStorage` DOES exist but a specific write throws for a real
 * operational reason (quota exceeded, private-mode restrictions), that
 * error must still propagate to the caller's own try/catch below — silently
 * rerouting it to memory would report a save as successful when it did not
 * actually persist, which is exactly the kind of fabricated success this
 * project's tests exist to catch.
 */
function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}
const memoryStore = new Map<string, string>();

function storageGet(key: string): string | null {
  return hasLocalStorage() ? localStorage.getItem(key) : (memoryStore.get(key) ?? null);
}
function storageSet(key: string, value: string): void {
  if (hasLocalStorage()) localStorage.setItem(key, value);
  else memoryStore.set(key, value);
}
function storageRemove(key: string): void {
  if (hasLocalStorage()) localStorage.removeItem(key);
  else memoryStore.delete(key);
}

interface SerializedWorld extends Omit<World, "city"> {
  city: Omit<CityMap, "roads"> & { roads: RoadCell[] };
}

export interface SaveBlob {
  version: number;
  savedAt: number; // wall clock ms
  label: string;
  world: SerializedWorld;
  casefile: CaseFile;
  phase: GamePhase;
}

export interface SaveSummary {
  slot: string;
  label: string;
  savedAt: number;
  seedPhrase: string;
}

function serializeWorld(world: World): SerializedWorld {
  return {
    ...world,
    city: { ...world.city, roads: [...world.city.roads.values()] },
  };
}

function deserializeWorld(s: SerializedWorld): World {
  const roads = new Map<string, RoadCell>();
  for (const cell of s.city.roads) roads.set(`${cell.x},${cell.y}`, cell);
  return { ...s, city: { ...s.city, roads } };
}

export function saveGame(profileKey: string, slot: string, world: World, casefile: CaseFile, phase: GamePhase, label: string): boolean {
  try {
    const blob: SaveBlob = {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      label,
      world: serializeWorld(world),
      casefile,
      phase,
    };
    storageSet(keyFor(profileKey, slot), JSON.stringify(blob));
    return true;
  } catch (err) {
    log.error("save", `Failed to save to ${profileKey}/${slot}: ${String(err)}`);
    return false;
  }
}

export function loadGame(profileKey: string, slot: string): { world: World; casefile: CaseFile; phase: GamePhase } | null {
  try {
    const raw = storageGet(keyFor(profileKey, slot));
    if (!raw) return null;
    const blob = JSON.parse(raw) as SaveBlob;
    if (blob.version !== SAVE_VERSION) {
      log.warn("save", `Save in ${profileKey}/${slot} has version ${blob.version}, expected ${SAVE_VERSION}; ignoring`);
      return null;
    }
    return { world: deserializeWorld(blob.world), casefile: blob.casefile, phase: blob.phase };
  } catch (err) {
    log.error("save", `Failed to load ${profileKey}/${slot}: ${String(err)}`);
    return null;
  }
}

export function listSaves(profileKey: string): SaveSummary[] {
  const out: SaveSummary[] = [];
  for (const slot of SLOTS) {
    try {
      const raw = storageGet(keyFor(profileKey, slot));
      if (!raw) continue;
      const blob = JSON.parse(raw) as SaveBlob;
      out.push({ slot, label: blob.label, savedAt: blob.savedAt, seedPhrase: blob.world.seedPhrase });
    } catch {
      // Corrupt slot — skip it rather than crash the menu.
    }
  }
  return out;
}

export function deleteSave(profileKey: string, slot: string): void {
  storageRemove(keyFor(profileKey, slot));
}

/** Erase every save slot for a profile. Returns true iff something actually existed to erase. */
export function wipeProfile(profileKey: string): boolean {
  let removedAny = false;
  for (const slot of SLOTS) {
    const key = keyFor(profileKey, slot);
    try {
      if (storageGet(key) !== null) {
        storageRemove(key);
        removedAny = true;
      }
    } catch {
      // No storage available — nothing to wipe.
    }
  }
  return removedAny;
}

/**
 * One-time migration: saves written before profiles existed lived directly
 * under `living-detective:save:${slot}` (no profile segment). Fold any such
 * leftovers into the guest namespace, then remove the legacy key, so
 * existing progress isn't silently orphaned by the new namespacing.
 */
export function migrateLegacySaves(): void {
  for (const slot of SLOTS) {
    const legacyKey = KEY_PREFIX + slot;
    try {
      const raw = storageGet(legacyKey);
      if (raw === null) continue;
      const guestKey = keyFor(GUEST_PROFILE, slot);
      if (storageGet(guestKey) === null) {
        storageSet(guestKey, raw);
      }
      storageRemove(legacyKey);
    } catch (err) {
      log.error("save", `Legacy save migration failed for ${slot}: ${String(err)}`);
    }
  }
}
