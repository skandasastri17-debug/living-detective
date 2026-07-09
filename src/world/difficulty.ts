/**
 * Difficulty presets.
 *
 * Difficulty is world-generation input, not UI sugar: it is stored on the
 * world, so seed + difficulty reproduces the identical case. Every knob maps
 * to an honest simulation parameter — harder cities have fewer cameras,
 * faster-fading memories, more careful killers, and cagier witnesses. No
 * knob ever fabricates or deletes evidence directly.
 */

import type { World } from "./types";

export type DifficultyId = "rookie" | "detective" | "inspector";

export interface DifficultyDef {
  id: DifficultyId;
  label: string;
  blurb: string;
  /** Multiplier on each building type's camera chance. */
  cameraChanceMul: number;
  /** Added to the nightly memory keep factor (positive = slower fading). */
  memoryKeepBonus: number;
  /**
   * Killer competence in [-0.25, +0.25]: shifts glove/premeditation
   * thresholds, disposal choices, tamper nerve and panic-print chance.
   */
  killerCompetence: number;
  /** Subtracted from witness cooperation scores. */
  cooperationPenalty: number;
  /** Extra houses in the city (more people to sift through). */
  extraHouses: number;
}

export const DIFFICULTIES: Record<DifficultyId, DifficultyDef> = {
  rookie: {
    id: "rookie",
    label: "Rookie",
    blurb: "More cameras, sharper memories, a sloppier killer. A fair first case.",
    cameraChanceMul: 1.35,
    memoryKeepBonus: 0.05,
    killerCompetence: -0.2,
    cooperationPenalty: 0,
    extraHouses: 0,
  },
  detective: {
    id: "detective",
    label: "Detective",
    blurb: "The intended experience. The town as it is.",
    cameraChanceMul: 1,
    memoryKeepBonus: 0,
    killerCompetence: 0,
    cooperationPenalty: 0,
    extraHouses: 0,
  },
  inspector: {
    id: "inspector",
    label: "Hard-Boiled",
    blurb: "Sparse cameras, fading memories, a careful killer, cagey witnesses.",
    cameraChanceMul: 0.55,
    memoryKeepBonus: -0.05,
    killerCompetence: 0.2,
    cooperationPenalty: 0.08,
    extraHouses: 2,
  },
};

export const DEFAULT_DIFFICULTY: DifficultyId = "detective";

/** The world's difficulty definition (old saves default to Detective). */
export function difficultyOf(world: Pick<World, "difficulty">): DifficultyDef {
  return DIFFICULTIES[world.difficulty ?? DEFAULT_DIFFICULTY];
}
