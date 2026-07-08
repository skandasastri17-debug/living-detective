/** Settings persistence (with Node fallback) and the colorblind edge styles. */

import { describe, expect, it } from "vitest";
import { loadSettings, updateSettings } from "../src/ui/settings";
import { edgeStyle } from "../src/ui/panels/relationsPanel";

describe("settings", () => {
  it("round-trips through the fallback store when localStorage is absent", () => {
    const first = loadSettings();
    expect(first.colorblind).toBe(false);
    const updated = updateSettings({ colorblind: true, tutorialSeen: true });
    expect(updated.colorblind).toBe(true);
    expect(loadSettings().colorblind).toBe(true);
    updateSettings({ colorblind: false, tutorialSeen: false });
  });
});

describe("colorblind edge styles", () => {
  const kinds = ["partner", "household", "colleagues", "feud", "affair", "debt", "blackmail", "romance", "theft-victim"] as const;

  it("default palette uses solid lines; colorblind mode differentiates by pattern too", () => {
    for (const k of kinds) {
      expect(edgeStyle(k, false).dash).toEqual([]);
    }
    // In colorblind mode, kinds that share a hue must differ by dash.
    const cb = kinds.map((k) => ({ k, ...edgeStyle(k, true) }));
    for (const a of cb) {
      for (const b of cb) {
        if (a.k === b.k) continue;
        const sameColor = a.color === b.color;
        const sameDash = JSON.stringify(a.dash) === JSON.stringify(b.dash);
        // Romance/affair intentionally share both (same semantic family), as
        // do household/colleagues (both "public" ties, drawn faint+dashed).
        const sameFamily =
          (["romance", "affair"].includes(a.k) && ["romance", "affair"].includes(b.k)) ||
          (["household", "colleagues"].includes(a.k) && ["household", "colleagues"].includes(b.k));
        if (sameColor && !sameFamily) {
          expect(sameDash, `${a.k} vs ${b.k} share hue AND pattern`).toBe(false);
        }
      }
    }
  });

  it("is a pure function", () => {
    expect(edgeStyle("feud", true)).toEqual(edgeStyle("feud", true));
    expect(edgeStyle("feud", false).color).not.toBe(edgeStyle("feud", true).color);
  });
});
