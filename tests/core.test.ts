import { describe, expect, it } from "vitest";
import { Rng, hashString, seedFromPhrase } from "../src/core/rng";
import { EventBus } from "../src/core/events";
import { at, dayOf, fmtTime, hourOf, minuteOfDay } from "../src/core/time";

describe("Rng", () => {
  it("is deterministic for the same seed", () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    for (let i = 0; i < 100; i++) expect(a.float()).toBe(b.float());
  });

  it("diverges for different seeds", () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const seqA = Array.from({ length: 8 }, () => a.float());
    const seqB = Array.from({ length: 8 }, () => b.float());
    expect(seqA).not.toEqual(seqB);
  });

  it("sub-streams are independent of consumption order", () => {
    const root1 = new Rng(99);
    const s1a = root1.stream("alpha");
    root1.stream("beta").float(); // consume beta first
    const v1 = s1a.float();

    const root2 = new Rng(99);
    const v2 = root2.stream("alpha").float();
    expect(v1).toBe(v2);
  });

  it("int respects bounds", () => {
    const r = new Rng(7);
    for (let i = 0; i < 500; i++) {
      const v = r.int(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
    }
  });

  it("weighted picks respect zero weights", () => {
    const r = new Rng(11);
    for (let i = 0; i < 200; i++) {
      expect(r.weighted([["a", 0], ["b", 1]] as const)).toBe("b");
    }
  });

  it("hashString is stable", () => {
    expect(hashString("living")).toBe(hashString("living"));
    expect(hashString("living")).not.toBe(hashString("detective"));
  });

  it("seedFromPhrase accepts numbers and phrases", () => {
    expect(seedFromPhrase("12345")).toBe(12345);
    expect(seedFromPhrase("FOG-HARBOR-1")).toBe(seedFromPhrase("fog-harbor-1"));
  });
});

describe("EventBus", () => {
  it("delivers events and supports unsubscribe", () => {
    const bus = new EventBus<{ ping: number }>();
    const seen: number[] = [];
    const off = bus.on("ping", (n) => seen.push(n));
    bus.emit("ping", 1);
    off();
    bus.emit("ping", 2);
    expect(seen).toEqual([1]);
  });

  it("isolates handler failures", () => {
    const bus = new EventBus<{ boom: null }>();
    const seen: string[] = [];
    bus.on("boom", () => { throw new Error("bad handler"); });
    bus.on("boom", () => seen.push("ok"));
    bus.emit("boom", null);
    expect(seen).toEqual(["ok"]);
  });
});

describe("time", () => {
  it("computes day/hour/minute correctly", () => {
    const t = at(2, 20, 40); // Wednesday 20:40
    expect(dayOf(t)).toBe(2);
    expect(hourOf(t)).toBe(20);
    expect(minuteOfDay(t)).toBe(20 * 60 + 40);
    expect(fmtTime(t)).toBe("Wed 20:40");
  });
});
