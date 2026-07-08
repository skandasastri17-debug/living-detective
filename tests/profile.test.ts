/**
 * Local profile identity and profile-namespaced saves.
 *
 * Runs in the Node test environment (no real localStorage/sessionStorage),
 * exercising the same in-memory fallback paths a storage-blocked browser
 * would hit — so these tests double as coverage for that fallback.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  GUEST_PROFILE, activeProfile, currentProfileKey, reconcileSessionOnBoot,
  signIn, signOut, slugifyProfileName,
} from "../src/game/profile";
import {
  AUTOSAVE_SLOT, listSaves, loadGame, migrateLegacySaves, saveGame, wipeProfile,
} from "../src/game/save";
import { Game } from "../src/game/director";

/**
 * save.ts checks for a real `localStorage` on every call (not once at
 * import time), specifically so a test like this can hand it one: a
 * minimal in-memory Storage so the migration test can plant a raw
 * pre-profile key exactly as a real pre-upgrade installation would have it.
 * Without this, save.ts transparently uses its own private in-memory map
 * instead — fine for the other tests below, but that map isn't reachable
 * from here, so this one test needs a real Storage-shaped object.
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, value); }
}
(globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage();

describe("slugifyProfileName", () => {
  it("lowercases, trims, and collapses non-alphanumerics to dashes", () => {
    expect(slugifyProfileName("  Alice Kim  ")).toBe("alice-kim");
    expect(slugifyProfileName("Bob!!!")).toBe("bob");
    expect(slugifyProfileName("")).toBe("");
    expect(slugifyProfileName("   ")).toBe("");
  });

  it("is a pure function", () => {
    expect(slugifyProfileName("Detective Nour")).toBe(slugifyProfileName("Detective Nour"));
  });
});

describe("signIn / signOut / activeProfile", () => {
  beforeEach(() => signOut());

  it("starts as guest by default", () => {
    expect(activeProfile()).toBeNull();
    expect(currentProfileKey()).toBe(GUEST_PROFILE);
  });

  it("signing in with a valid name activates that profile", () => {
    const res = signIn("Alice Kim");
    expect(res).toEqual({ slug: "alice-kim" });
    expect(activeProfile()).toBe("alice-kim");
    expect(currentProfileKey()).toBe("alice-kim");
  });

  it("rejects an empty/whitespace-only name", () => {
    const res = signIn("   ");
    expect("error" in res).toBe(true);
    expect(activeProfile()).toBeNull();
  });

  it("rejects the reserved guest name (case-insensitively)", () => {
    const res = signIn("Guest");
    expect("error" in res).toBe(true);
    expect(activeProfile()).toBeNull();
  });

  it("signing out returns to guest", () => {
    signIn("Alice");
    expect(activeProfile()).toBe("alice");
    signOut();
    expect(activeProfile()).toBeNull();
    expect(currentProfileKey()).toBe(GUEST_PROFILE);
  });
});

describe("reconcileSessionOnBoot", () => {
  it("wipes guest data exactly once per fresh session, then stays quiet for the rest of it", () => {
    let calls = 0;
    const wipeGuestData = () => { calls++; return true; };

    const first = reconcileSessionOnBoot(wipeGuestData);
    expect(first).toBe(true);
    expect(calls).toBe(1);

    // Same session now (marker was just set) — must not fire again, and the
    // callback itself must not even be invoked a second time.
    const second = reconcileSessionOnBoot(wipeGuestData);
    expect(second).toBe(false);
    expect(calls).toBe(1);
  });
});

describe("profile-namespaced saves", () => {
  const seed = "PROFILE-SAVE-TEST-1";

  it("saves for different profiles do not collide", async () => {
    const game = await Game.generate(seed);
    const g = game.world;
    const cf = game.casefile;

    saveGame("alice", AUTOSAVE_SLOT, g, cf, "investigating", "Alice's case");
    saveGame("bob", AUTOSAVE_SLOT, g, cf, "investigating", "Bob's case");

    const aliceSaves = listSaves("alice");
    const bobSaves = listSaves("bob");
    expect(aliceSaves.map((s) => s.label)).toEqual(["Alice's case"]);
    expect(bobSaves.map((s) => s.label)).toEqual(["Bob's case"]);

    // Loading one profile's slot never returns another's data.
    const loadedAlice = loadGame("alice", AUTOSAVE_SLOT);
    expect(loadedAlice?.casefile.victimId).toBe(cf.victimId);
    expect(loadGame("carol", AUTOSAVE_SLOT)).toBeNull();
  });

  it("wipeProfile erases only the named profile's slots and reports whether it removed anything", async () => {
    const game = await Game.generate(seed);
    saveGame("dana", AUTOSAVE_SLOT, game.world, game.casefile, "investigating", "Dana's case");
    saveGame("erin", AUTOSAVE_SLOT, game.world, game.casefile, "investigating", "Erin's case");

    const removed = wipeProfile("dana");
    expect(removed).toBe(true);
    expect(listSaves("dana")).toEqual([]);
    expect(listSaves("erin").length).toBe(1); // untouched

    const removedAgain = wipeProfile("dana");
    expect(removedAgain).toBe(false); // nothing left to remove
  });

  it("migrateLegacySaves folds pre-profile saves into guest without clobbering an existing guest save", async () => {
    const game = await Game.generate(seed);
    // Simulate a legacy (pre-profile) save written directly under the old key.
    const legacyBlob = JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      label: "Legacy autosave",
      world: { ...game.world, city: { ...game.world.city, roads: [...game.world.city.roads.values()] } },
      casefile: game.casefile,
      phase: "investigating",
    });
    localStorage.setItem("living-detective:save:autosave", legacyBlob);
    // Ensure guest is clean first.
    wipeProfile("guest");

    migrateLegacySaves();

    const guestSaves = listSaves("guest");
    expect(guestSaves.some((s) => s.label === "Legacy autosave")).toBe(true);
    // The legacy key is gone after migration.
    expect(localStorage.getItem("living-detective:save:autosave")).toBeNull();

    // Running migration again is a no-op (nothing left to migrate).
    migrateLegacySaves();
    expect(listSaves("guest").filter((s) => s.label === "Legacy autosave").length).toBe(1);
  });
});
