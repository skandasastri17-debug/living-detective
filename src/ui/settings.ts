/**
 * Player settings, persisted in localStorage (with an in-memory fallback so
 * the module also works under Node tests). Difficulty is deliberately NOT
 * here — it is world-generation input chosen per case on the menu.
 */

export interface PlayerSettings {
  /** Try to start ambience automatically on the first user gesture. */
  audioAutoStart: boolean;
  /** Colorblind-safe palette + line patterns in the Relations graph. */
  colorblind: boolean;
  /** Player has seen the field-manual tutorial at least once. */
  tutorialSeen: boolean;
}

const DEFAULTS: PlayerSettings = {
  audioAutoStart: false,
  colorblind: false,
  tutorialSeen: false,
};

const KEY = "living-detective:settings";

let memoryFallback: PlayerSettings | null = null;

export function loadSettings(): PlayerSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PlayerSettings>) };
  } catch {
    return memoryFallback ? { ...memoryFallback } : { ...DEFAULTS };
  }
}

export function saveSettings(s: PlayerSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    memoryFallback = { ...s };
  }
}

export function updateSettings(patch: Partial<PlayerSettings>): PlayerSettings {
  const next = { ...loadSettings(), ...patch };
  saveSettings(next);
  return next;
}
