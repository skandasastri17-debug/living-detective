/**
 * Deterministic seeded PRNG (sfc32) with named sub-streams.
 *
 * Every random decision in the game flows through an Rng instance so that a
 * seed fully determines a city, its people, and its murder. Sub-streams keep
 * subsystems independent: adding a coin flip in city generation must not
 * reshuffle NPC personalities.
 */

export type Seed = number;

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** 32-bit string hash (FNV-1a) used to derive sub-stream seeds from labels. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private next: () => number;
  readonly seed: Seed;

  constructor(seed: Seed) {
    this.seed = seed >>> 0;
    // Mix the seed through four rounds of splitmix-style scrambling so
    // nearby seeds diverge immediately.
    let s = this.seed;
    const mix = () => {
      s = (s + 0x9e3779b9) | 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.next = sfc32(mix(), mix(), mix(), mix());
    for (let i = 0; i < 12; i++) this.next(); // warm up
  }

  /** Derive an independent deterministic sub-stream. */
  stream(label: string): Rng {
    return new Rng((this.seed ^ hashString(label)) >>> 0);
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform pick from a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("Rng.pick from empty array");
    return arr[Math.floor(this.next() * arr.length)]!;
  }

  /** Weighted pick; weights must be non-negative and not all zero. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    let total = 0;
    for (const [, w] of entries) total += w;
    if (total <= 0) throw new Error("Rng.weighted: total weight <= 0");
    let r = this.next() * total;
    for (const [v, w] of entries) {
      r -= w;
      if (r < 0) return v;
    }
    return entries[entries.length - 1]![0];
  }

  /** In-place Fisher–Yates shuffle; returns the same array. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }

  /** Approximate normal via central limit (mean 0, sd 1), clamped to ±3. */
  gaussian(): number {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += this.next();
    const g = (sum - 3) * (3 / 3); // 6-sample CLT, sd ≈ 0.707 → rescaled below
    return Math.max(-3, Math.min(3, g * 1.414));
  }

  /** Trait roll: value in [0,1] biased toward the middle. */
  trait(): number {
    return Math.max(0, Math.min(1, 0.5 + this.gaussian() * 0.18));
  }
}

/** Human-friendly seed of the form "ADJ-NOUN-1234" for the UI. */
const SEED_ADJ = ["FOG", "ASH", "RUST", "NEON", "IRON", "SALT", "COLD", "DIM", "PALE", "GRIM"];
const SEED_NOUN = ["HARBOR", "VERGE", "HOLLOW", "MERIDIAN", "LEDGER", "SIGNAL", "ARCADE", "TERMINAL", "GARDEN", "VAULT"];

export function randomSeedPhrase(entropy: number = Date.now()): string {
  const r = new Rng(entropy >>> 0);
  return `${r.pick(SEED_ADJ)}-${r.pick(SEED_NOUN)}-${r.int(100, 9999)}`;
}

export function seedFromPhrase(phrase: string): Seed {
  const n = Number(phrase);
  if (Number.isFinite(n) && phrase.trim() !== "") return n >>> 0;
  return hashString(phrase.trim().toUpperCase());
}
