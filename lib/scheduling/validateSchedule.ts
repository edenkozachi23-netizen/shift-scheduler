import type { ScheduleEntry } from "./types";
import {
  getWeekStart,
  addDays,
  getDayOfWeek,
  countShiftsInWeek,
  countNightShiftsInWindow,
  hasWeekdayMorning,
  hasFreeWeekend,
} from "./scheduleRules";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ViolationCode =
  | "weekly-limit"       // > 5 shifts in any Sun–Sat week
  | "night-limit"        // > 8 evening shifts in any rolling 14-day window
  | "duplicate-in-shift" // same employee appears twice in one shift slot
  | "same-day-double"    // employee has morning + evening on the same calendar day
  | "back-to-back"       // employee has evening on day D and morning on day D+1
  | "no-weekday-morning" // employee has no morning shift on a weekday in the period
  | "no-free-weekend";   // employee has no Fri+Sat fully free in the period

export type ViolationSeverity = "hard" | "soft";

export const VIOLATION_SEVERITY: Record<ViolationCode, ViolationSeverity> = {
  "duplicate-in-shift": "hard",
  "same-day-double":    "hard",
  "back-to-back":       "hard",
  "weekly-limit":       "hard",
  "night-limit":        "hard",
  "no-weekday-morning": "soft",
  "no-free-weekend":    "soft",
};

export const VIOLATION_LABEL: Record<ViolationCode, string> = {
  "duplicate-in-shift": "כפילות במשמרת",
  "same-day-double":    "בוקר + ערב ביום אחד",
  "back-to-back":       "ערב → בוקר ללא מנוחה",
  "weekly-limit":       "חריגה ממכסה שבועית",
  "night-limit":        "חריגה ממכסת משמרות לילה",
  "no-weekday-morning": "אין בוקר בחול בתקופה",
  "no-free-weekend":    "אין סוף שבוע פנוי בתקופה",
};

/**
 * Short per-rule reason string shown inline inside each red-marked slot cell.
 * Deliberately terse — the full detail is in the validation summary panel.
 */
export const SLOT_REASON: Record<ViolationCode, string> = {
  "duplicate-in-shift": "כפילות: עובד מופיע פעמיים",
  "same-day-double":    "בוקר + ערב ביום אחד",
  "back-to-back":       "ערב → בוקר ללא מנוחה",
  "weekly-limit":       "חריגה ממכסה שבועית (>5)",
  "night-limit":        "חריגה ממכסת לילה (>8 ב-14 יום)",
  "no-weekday-morning": "אין בוקר בחול בתקופה",
  "no-free-weekend":    "אין סוף שבוע פנוי בתקופה",
};

export type ScheduleViolation = {
  employee: string;
  ruleCode: ViolationCode;
  severity: ViolationSeverity;
  message: string;
  /** (date, period) pairs whose cell should be highlighted in the UI. */
  affectedSlots: { date: string; period: "morning" | "evening" }[];
};

export type ScheduleValidationResult = {
  valid: boolean;
  hardCount: number;
  softCount: number;
  violations: ScheduleViolation[];
  /**
   * Fast membership check for per-slot UI highlighting.
   * Key format: `${date}|${period}|${employeeId}`
   */
  violatingSlotKeys: Set<string>;
  /**
   * Maps the same key to the list of short reason strings to display
   * inline inside each red-marked cell. One entry per applicable rule.
   * Key format: `${date}|${period}|${employeeId}`
   */
  violatingSlotReasons: Map<string, string[]>;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_WEEKLY  = 5;
const MAX_NIGHT   = 8;
const NIGHT_WINDOW = 14;

// ─── Main validator ───────────────────────────────────────────────────────────

/**
 * Validates a schedule against all hard and soft rules, returning structured
 * violations and a Set for O(1) per-slot lookup in the UI.
 *
 * @param schedule     The ScheduleEntry[] to validate (can be mid-edit)
 * @param employees    Full employee list (used for period-wide soft rules)
 * @param periodStart  ISO date of the first day in the displayed range
 * @param periodEnd    ISO date of the last day in the displayed range
 */
export function validateSchedule(
  schedule: ScheduleEntry[],
  employees: string[],
  periodStart: string,
  periodEnd: string
): ScheduleValidationResult {
  const violations: ScheduleViolation[] = [];

  // ── R1: no duplicate employee in the same shift ────────────────────────────
  for (const entry of schedule) {
    const seen = new Map<string, number>();
    for (const a of entry.assignments) {
      seen.set(a.employeeId, (seen.get(a.employeeId) ?? 0) + 1);
    }
    seen.forEach((count, emp) => {
      if (count > 1) {
        violations.push({
          employee: emp,
          ruleCode: "duplicate-in-shift",
          severity: "hard",
          message: `${emp} מופיע/ה פעמיים באותה משמרת — ${entry.date} ${entry.period === "morning" ? "בוקר" : "ערב"}`,
          affectedSlots: [{ date: entry.date, period: entry.period }],
        });
      }
    });
  }

  // Build date set once for per-employee loops
  const allDates = Array.from(new Set(schedule.map((e) => e.date))).sort();

  for (const employee of employees) {
    // Does this employee appear anywhere in the current schedule?
    const isActive = schedule.some((e) =>
      e.assignments.some((a) => a.employeeId === employee)
    );

    // ── R2: same-day morning + evening ──────────────────────────────────────
    for (const date of allDates) {
      const hasMorning = schedule.some(
        (e) =>
          e.date === date &&
          e.period === "morning" &&
          e.assignments.some((a) => a.employeeId === employee)
      );
      const hasEvening = schedule.some(
        (e) =>
          e.date === date &&
          e.period === "evening" &&
          e.assignments.some((a) => a.employeeId === employee)
      );
      if (hasMorning && hasEvening) {
        violations.push({
          employee,
          ruleCode: "same-day-double",
          severity: "hard",
          message: `${employee} — בוקר + ערב באותו יום (${formatDate(date)})`,
          affectedSlots: [
            { date, period: "morning" },
            { date, period: "evening" },
          ],
        });
      }
    }

    // ── R3: back-to-back evening → next morning ──────────────────────────────
    for (const entry of schedule) {
      if (entry.period !== "evening") continue;
      if (!entry.assignments.some((a) => a.employeeId === employee)) continue;
      const nextDay = addDays(entry.date, 1);
      const workedNextMorning = schedule.some(
        (e) =>
          e.date === nextDay &&
          e.period === "morning" &&
          e.assignments.some((a) => a.employeeId === employee)
      );
      if (workedNextMorning) {
        violations.push({
          employee,
          ruleCode: "back-to-back",
          severity: "hard",
          message: `${employee} — ערב ${formatDate(entry.date)} ואחריו בוקר ${formatDate(nextDay)} (אין מנוחה)`,
          affectedSlots: [
            { date: entry.date, period: "evening" },
            { date: nextDay, period: "morning" },
          ],
        });
      }
    }

    // ── R4: weekly shift limit ───────────────────────────────────────────────
    const weekStarts = new Set<string>();
    for (const entry of schedule) {
      if (entry.assignments.some((a) => a.employeeId === employee)) {
        weekStarts.add(getWeekStart(entry.date));
      }
    }
    for (const ws of Array.from(weekStarts)) {
      const count = countShiftsInWeek(employee, ws, schedule);
      if (count > MAX_WEEKLY) {
        const weekEnd = addDays(ws, 6);
        const affectedSlots = schedule
          .filter(
            (e) =>
              e.date >= ws &&
              e.date <= weekEnd &&
              e.assignments.some((a) => a.employeeId === employee)
          )
          .map((e) => ({ date: e.date, period: e.period as "morning" | "evening" }));
        violations.push({
          employee,
          ruleCode: "weekly-limit",
          severity: "hard",
          message: `${employee} — ${count} משמרות בשבוע ${formatDate(ws)}–${formatDate(weekEnd)} (מותר ${MAX_WEEKLY})`,
          affectedSlots,
        });
      }
    }

    // ── R5: night shift limit (rolling 14-day window) ─────────────────────────
    // Find the worst window; report once per employee (not once per evening date).
    let maxNightCount = 0;
    let worstWindowEnd = "";
    for (const entry of schedule) {
      if (entry.period !== "evening") continue;
      if (!entry.assignments.some((a) => a.employeeId === employee)) continue;
      const count = countNightShiftsInWindow(employee, entry.date, NIGHT_WINDOW, schedule);
      if (count > maxNightCount) {
        maxNightCount = count;
        worstWindowEnd = entry.date;
      }
    }
    if (maxNightCount > MAX_NIGHT) {
      const windowStart = addDays(worstWindowEnd, -(NIGHT_WINDOW - 1));
      const affectedSlots = schedule
        .filter(
          (e) =>
            e.period === "evening" &&
            e.date >= windowStart &&
            e.date <= worstWindowEnd &&
            e.assignments.some((a) => a.employeeId === employee)
        )
        .map((e) => ({ date: e.date, period: "evening" as const }));
      violations.push({
        employee,
        ruleCode: "night-limit",
        severity: "hard",
        message: `${employee} — ${maxNightCount} משמרות לילה ב-${NIGHT_WINDOW} יום (מותר ${MAX_NIGHT})`,
        affectedSlots,
      });
    }

    // ── R6 + R7: period-wide soft rules (only for active employees) ──────────
    if (isActive) {
      if (!hasWeekdayMorning(employee, schedule, periodStart, periodEnd)) {
        violations.push({
          employee,
          ruleCode: "no-weekday-morning",
          severity: "soft",
          message: `${employee} — אין משמרת בוקר בימי חול בתקופה`,
          affectedSlots: [],
        });
      }

      if (!hasFreeWeekend(employee, schedule, periodStart, periodEnd)) {
        // Mark every Fri+Sat the employee works so the cells are highlighted
        const affectedSlots: { date: string; period: "morning" | "evening" }[] = [];
        for (const entry of schedule) {
          const dow = getDayOfWeek(entry.date);
          if (dow !== 5 && dow !== 6) continue;
          if (!entry.assignments.some((a) => a.employeeId === employee)) continue;
          affectedSlots.push({ date: entry.date, period: entry.period });
        }
        violations.push({
          employee,
          ruleCode: "no-free-weekend",
          severity: "soft",
          message: `${employee} — אין סוף שבוע פנוי (שישי + שבת) בתקופה`,
          affectedSlots,
        });
      }
    }
  }

  // ── Build slot-key + per-slot reason lookups ──────────────────────────────
  const violatingSlotKeys = new Set<string>();
  const violatingSlotReasons = new Map<string, string[]>();

  for (const v of violations) {
    const shortReason = SLOT_REASON[v.ruleCode];
    for (const slot of v.affectedSlots) {
      const key = `${slot.date}|${slot.period}|${v.employee}`;
      violatingSlotKeys.add(key);
      const existing = violatingSlotReasons.get(key) ?? [];
      // Avoid duplicate reason lines when the same rule fires for the same slot
      if (!existing.includes(shortReason)) existing.push(shortReason);
      violatingSlotReasons.set(key, existing);
    }
  }

  const hardCount = violations.filter((v) => v.severity === "hard").length;
  const softCount = violations.filter((v) => v.severity === "soft").length;

  return {
    valid: violations.length === 0,
    hardCount,
    softCount,
    violations,
    violatingSlotKeys,
    violatingSlotReasons,
  };
}

// ─── Local helper ─────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${parseInt(d)}/${parseInt(m)}`;
}
