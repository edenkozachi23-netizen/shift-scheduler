import type { ScheduleEntry, ShiftPeriod } from "./types";

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** Parse an ISO date string into local-time year/month/day parts. */
function parseISO(dateStr: string): [number, number, number] {
  const [y, m, d] = dateStr.split("-").map(Number);
  return [y, m, d];
}

/** Format a local Date object as "YYYY-MM-DD". */
function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Add `n` days to an ISO date string using local time (avoids UTC midnight drift).
 */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = parseISO(dateStr);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return toISO(dt);
}

/**
 * Returns 0 (Sunday) … 6 (Saturday) for the given ISO date, in local time.
 */
export function getDayOfWeek(dateStr: string): number {
  const [y, m, d] = parseISO(dateStr);
  return new Date(y, m - 1, d).getDay();
}

/**
 * Returns the ISO date of the Sunday that starts the calendar week
 * containing `dateStr`.
 */
export function getWeekStart(dateStr: string): string {
  const dow = getDayOfWeek(dateStr);
  return addDays(dateStr, -dow);
}

// ─── Counting helpers ─────────────────────────────────────────────────────────

/**
 * Count how many shifts `employee` has in the Sun–Sat week that starts on
 * `weekStart` (ISO date), across the given schedule.
 */
export function countShiftsInWeek(
  employee: string,
  weekStart: string,
  schedule: ScheduleEntry[]
): number {
  const weekEnd = addDays(weekStart, 6);
  return schedule.reduce((total, entry) => {
    if (entry.date < weekStart || entry.date > weekEnd) return total;
    const hit = entry.assignments.some((a) => a.employeeId === employee);
    return total + (hit ? 1 : 0);
  }, 0);
}

/**
 * Count how many *evening* (night) shifts `employee` has in the rolling
 * `windowDays`-day window that ends on `targetDate` (inclusive).
 *
 * The window spans [targetDate − (windowDays − 1), targetDate].
 */
export function countNightShiftsInWindow(
  employee: string,
  targetDate: string,
  windowDays: number,
  schedule: ScheduleEntry[]
): number {
  const windowStart = addDays(targetDate, -(windowDays - 1));
  return schedule.reduce((total, entry) => {
    if (entry.period !== "evening") return total;
    if (entry.date < windowStart || entry.date > targetDate) return total;
    const hit = entry.assignments.some((a) => a.employeeId === employee);
    return total + (hit ? 1 : 0);
  }, 0);
}

// ─── Final-schedule hard-limit checks ────────────────────────────────────────

/**
 * Returns true if `employee` actually has MORE than `maxShifts` shifts in any
 * single Sun–Sat week in the final schedule.
 *
 * Being *blocked* from a 6th shift is not a violation — it means the rule
 * worked. This check only fires when the limit was somehow exceeded in the
 * output.
 */
export function employeeExceedsWeeklyLimit(
  employee: string,
  schedule: ScheduleEntry[],
  maxShifts: number
): boolean {
  const weekStarts = new Set<string>();
  for (const entry of schedule) {
    if (entry.assignments.some((a) => a.employeeId === employee)) {
      weekStarts.add(getWeekStart(entry.date));
    }
  }
  for (const ws of Array.from(weekStarts)) {
    if (countShiftsInWeek(employee, ws, schedule) > maxShifts) return true;
  }
  return false;
}

/**
 * Returns true if `employee` actually has MORE than `maxNightShifts` evening
 * shifts in any rolling `windowDays`-day window in the final schedule.
 *
 * Same as above — only fires when the cap was actually exceeded in the output,
 * not merely when the employee was blocked during selection.
 */
export function employeeExceedsNightLimit(
  employee: string,
  schedule: ScheduleEntry[],
  maxNightShifts: number,
  windowDays: number
): boolean {
  for (const entry of schedule) {
    if (entry.period !== "evening") continue;
    if (!entry.assignments.some((a) => a.employeeId === employee)) continue;
    const count = countNightShiftsInWindow(employee, entry.date, windowDays, schedule);
    if (count > maxNightShifts) return true;
  }
  return false;
}

// ─── Post-generation soft-rule checks ────────────────────────────────────────

/**
 * Returns true if `employee` has at least one morning shift on a weekday
 * (Sun–Thu, DOW 0–4) within [periodStart, periodEnd].
 */
export function hasWeekdayMorning(
  employee: string,
  schedule: ScheduleEntry[],
  periodStart: string,
  periodEnd: string
): boolean {
  return schedule.some((entry) => {
    if (entry.period !== "morning") return false;
    if (entry.date < periodStart || entry.date > periodEnd) return false;
    const dow = getDayOfWeek(entry.date);
    if (dow === 5 || dow === 6) return false; // Friday or Saturday
    return entry.assignments.some((a) => a.employeeId === employee);
  });
}

/**
 * Returns true if `employee` has at least one Fri+Sat pair where they work
 * ZERO shifts on both days, within the scheduling period.
 *
 * We iterate every Friday in [periodStart, periodEnd] and check that the
 * employee has no assignments on that Friday AND the following Saturday.
 */
export function hasFreeWeekend(
  employee: string,
  schedule: ScheduleEntry[],
  periodStart: string,
  periodEnd: string
): boolean {
  // Build a set of dates the employee works
  const workedDates = new Set<string>();
  for (const entry of schedule) {
    if (entry.assignments.some((a) => a.employeeId === employee)) {
      workedDates.add(entry.date);
    }
  }

  // Walk every day in the period and check each Friday
  let cursor = periodStart;
  while (cursor <= periodEnd) {
    const dow = getDayOfWeek(cursor);
    if (dow === 5) {
      // cursor is a Friday
      const saturday = addDays(cursor, 1);
      if (saturday <= periodEnd) {
        if (!workedDates.has(cursor) && !workedDates.has(saturday)) {
          return true;
        }
      }
    }
    cursor = addDays(cursor, 1);
  }
  return false;
}

// ─── Fairness scoring helpers ─────────────────────────────────────────────────
// Used by pickBestEmployeeForShift to rank valid candidates.
// These are PREFERENCES, not hard constraints — they influence sort order only.

/**
 * Total shifts assigned to `employee` in `schedule`.
 * (Mirrors shiftCounts but derived from the schedule directly — use shiftCounts
 *  for the primary sort since it is updated incrementally within a slot loop.)
 */
export function countEmployeeTotalShifts(
  employee: string,
  schedule: ScheduleEntry[]
): number {
  return schedule.reduce(
    (n, e) => n + (e.assignments.some((a) => a.employeeId === employee) ? 1 : 0),
    0
  );
}

/**
 * Number of weekend (Friday DOW=5 or Saturday DOW=6) shifts assigned to
 * `employee` in `schedule`.
 */
export function countEmployeeWeekendShifts(
  employee: string,
  schedule: ScheduleEntry[]
): number {
  return schedule.reduce((n, e) => {
    const dow = getDayOfWeek(e.date);
    if (dow !== 5 && dow !== 6) return n;
    return n + (e.assignments.some((a) => a.employeeId === employee) ? 1 : 0);
  }, 0);
}

/** Number of morning shifts assigned to `employee` in `schedule`. */
export function countEmployeeMorningShifts(
  employee: string,
  schedule: ScheduleEntry[]
): number {
  return schedule.reduce(
    (n, e) =>
      e.period === "morning" && e.assignments.some((a) => a.employeeId === employee)
        ? n + 1
        : n,
    0
  );
}

/** Number of evening shifts assigned to `employee` in `schedule`. */
export function countEmployeeEveningShifts(
  employee: string,
  schedule: ScheduleEntry[]
): number {
  return schedule.reduce(
    (n, e) =>
      e.period === "evening" && e.assignments.some((a) => a.employeeId === employee)
        ? n + 1
        : n,
    0
  );
}

/**
 * Returns the employee's current count of shifts in `targetPeriod`.
 * Lower score = employee has done this period less = assigning them improves
 * morning/evening balance.
 */
export function scoreEmployeeBalanceImpact(
  employee: string,
  targetPeriod: ShiftPeriod,
  schedule: ScheduleEntry[]
): number {
  return targetPeriod === "morning"
    ? countEmployeeMorningShifts(employee, schedule)
    : countEmployeeEveningShifts(employee, schedule);
}
