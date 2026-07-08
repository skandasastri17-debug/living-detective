/** Occupation definitions: where people work, when, and for how much. */

import type { BuildingType, OccupationId } from "../world/types";

export interface OccupationDef {
  id: OccupationId;
  label: string;
  workplaceType: BuildingType | null; // null = no workplace
  /**
   * Work window, minute-of-day. endMin > 1440 means the shift wraps past
   * midnight (e.g. a bar shift 17:00–02:00 is startMin 1020, endMin 1560);
   * schedule building splits it into two blocks. Individual NPCs get
   * jittered copies.
   */
  startMin: number;
  endMin: number;
  workDays: number[]; // 0=Mon
  weeklyIncome: number;
  /** How many of this role a single workplace supports. */
  slotsPerBuilding: number;
}

const h = (x: number) => x * 60;

export const OCCUPATIONS: OccupationDef[] = [
  { id: "bartender", label: "Bartender", workplaceType: "bar", startMin: h(17), endMin: h(26), workDays: [1, 2, 3, 4, 5], weeklyIncome: 620, slotsPerBuilding: 2 },
  { id: "server", label: "Server", workplaceType: "restaurant", startMin: h(11), endMin: h(21), workDays: [0, 2, 3, 4, 5], weeklyIncome: 540, slotsPerBuilding: 2 },
  { id: "cook", label: "Cook", workplaceType: "restaurant", startMin: h(10), endMin: h(20), workDays: [0, 1, 3, 4, 6], weeklyIncome: 640, slotsPerBuilding: 1 },
  { id: "barista", label: "Barista", workplaceType: "cafe", startMin: h(6), endMin: h(14), workDays: [0, 1, 2, 3, 4], weeklyIncome: 480, slotsPerBuilding: 2 },
  { id: "shop-clerk", label: "Shop Clerk", workplaceType: "store", startMin: h(9), endMin: h(18), workDays: [0, 1, 2, 3, 5], weeklyIncome: 520, slotsPerBuilding: 2 },
  { id: "shop-owner", label: "Shop Owner", workplaceType: "store", startMin: h(8), endMin: h(19), workDays: [0, 1, 2, 3, 4, 5], weeklyIncome: 900, slotsPerBuilding: 1 },
  { id: "office-worker", label: "Office Worker", workplaceType: "office", startMin: h(9), endMin: h(17), workDays: [0, 1, 2, 3, 4], weeklyIncome: 850, slotsPerBuilding: 4 },
  { id: "office-manager", label: "Office Manager", workplaceType: "office", startMin: h(8), endMin: h(18), workDays: [0, 1, 2, 3, 4], weeklyIncome: 1400, slotsPerBuilding: 1 },
  { id: "factory-worker", label: "Factory Worker", workplaceType: "factory", startMin: h(7), endMin: h(16), workDays: [0, 1, 2, 3, 4], weeklyIncome: 700, slotsPerBuilding: 4 },
  { id: "factory-foreman", label: "Factory Foreman", workplaceType: "factory", startMin: h(6), endMin: h(16), workDays: [0, 1, 2, 3, 4], weeklyIncome: 1100, slotsPerBuilding: 1 },
  { id: "warehouse-hand", label: "Warehouse Hand", workplaceType: "warehouse", startMin: h(14), endMin: h(23), workDays: [0, 1, 2, 4, 5], weeklyIncome: 640, slotsPerBuilding: 2 },
  { id: "doctor", label: "Doctor", workplaceType: "hospital", startMin: h(8), endMin: h(18), workDays: [0, 1, 2, 3, 4], weeklyIncome: 2100, slotsPerBuilding: 1 },
  { id: "nurse", label: "Nurse", workplaceType: "hospital", startMin: h(7), endMin: h(19), workDays: [1, 2, 4, 5, 6], weeklyIncome: 950, slotsPerBuilding: 2 },
  { id: "teacher", label: "Teacher", workplaceType: "school", startMin: h(8), endMin: h(16), workDays: [0, 1, 2, 3, 4], weeklyIncome: 780, slotsPerBuilding: 3 },
  { id: "police-officer", label: "Police Officer", workplaceType: "police-station", startMin: h(8), endMin: h(18), workDays: [0, 1, 2, 3, 4], weeklyIncome: 880, slotsPerBuilding: 2 },
  { id: "landlord", label: "Landlord", workplaceType: null, startMin: h(10), endMin: h(12), workDays: [0, 3], weeklyIncome: 1600, slotsPerBuilding: 0 },
  { id: "writer", label: "Writer", workplaceType: null, startMin: h(9), endMin: h(15), workDays: [0, 1, 2, 3, 4], weeklyIncome: 450, slotsPerBuilding: 0 },
  { id: "unemployed", label: "Unemployed", workplaceType: null, startMin: 0, endMin: 0, workDays: [], weeklyIncome: 180, slotsPerBuilding: 0 },
  { id: "retired", label: "Retired", workplaceType: null, startMin: 0, endMin: 0, workDays: [], weeklyIncome: 320, slotsPerBuilding: 0 },
];

export function occupationById(id: OccupationId): OccupationDef {
  const d = OCCUPATIONS.find((o) => o.id === id);
  if (!d) throw new Error(`Unknown occupation ${id}`);
  return d;
}
