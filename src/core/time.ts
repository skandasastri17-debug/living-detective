/**
 * Simulation time. One unit = one minute of city time.
 *
 * The sim advances in TICK_MINUTES steps. Days start at minute 0 = 00:00.
 * All timestamps in the event log, memories, records and evidence are
 * absolute sim-minutes, so cross-referencing timelines is pure arithmetic.
 */

export type SimTime = number; // absolute minutes since sim start

export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
export const TICK_MINUTES = 10;

export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export function dayOf(t: SimTime): number {
  return Math.floor(t / MINUTES_PER_DAY);
}

export function minuteOfDay(t: SimTime): number {
  return ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function hourOf(t: SimTime): number {
  return Math.floor(minuteOfDay(t) / MINUTES_PER_HOUR);
}

export function at(day: number, hour: number, minute = 0): SimTime {
  return day * MINUTES_PER_DAY + hour * MINUTES_PER_HOUR + minute;
}

export function dayName(t: SimTime): string {
  return DAY_NAMES[dayOf(t) % 7]!;
}

/** "Tue 20:40" */
export function fmtTime(t: SimTime): string {
  const m = minuteOfDay(t);
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${dayName(t).slice(0, 3)} ${hh}:${mm}`;
}

/** "Tuesday, Day 3, 20:40" */
export function fmtTimeLong(t: SimTime): string {
  const m = minuteOfDay(t);
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${dayName(t)}, Day ${dayOf(t) + 1}, ${hh}:${mm}`;
}

/** "20:40" */
export function fmtClock(t: SimTime): string {
  const m = minuteOfDay(t);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Whole-hour clock label for a minute-of-day value, e.g. 1230 → "20:30". */
export function fmtMinuteOfDay(mod: number): string {
  return `${String(Math.floor(mod / 60)).padStart(2, "0")}:${String(mod % 60).padStart(2, "0")}`;
}

export function isNight(t: SimTime): boolean {
  const h = hourOf(t);
  return h >= 22 || h < 6;
}
