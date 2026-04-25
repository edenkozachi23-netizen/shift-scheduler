import { assignEmployeesToShift } from "./assignEmployeesToShift";
import {
  hasWeekdayMorning,
  hasFreeWeekend,
  employeeExceedsWeeklyLimit,
  employeeExceedsNightLimit,
} from "./scheduleRules";
import type {
  ShiftPeriod,
  ShiftSlot,
  Constraint,
  ScheduleEntry,
  ShiftCounts,
  ShortageEntry,
  EmployeeViolations,
  ViolationsMap,
  GenerateScheduleResult,
} from "./types";

export type { ShiftSlot, GenerateScheduleResult, ShortageEntry, Constraint, ShiftPeriod };

export function generateSchedule(
  shiftSlots: ShiftSlot[],
  employees: string[],
  constraints: Constraint[]
): GenerateScheduleResult {
  // Sort by date, then morning before evening within the same date
  const sortedSlots = [...shiftSlots].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.period === "morning" ? -1 : 1;
  });

  const schedule: ScheduleEntry[] = [];
  let shiftCounts: ShiftCounts = Object.fromEntries(employees.map((e) => [e, 0]));
  const shortages: ShortageEntry[] = [];

  for (const slot of sortedSlots) {
    const result = assignEmployeesToShift(
      slot.date,
      slot.period,
      employees,
      schedule,       // grows each iteration — back-to-back rules work across all days
      constraints,
      shiftCounts
    );

    schedule.push({
      date: slot.date,
      period: slot.period,
      assignments: result.assignments,
    });

    for (const a of result.assignments) {
      shiftCounts = { ...shiftCounts, [a.employeeId]: (shiftCounts[a.employeeId] ?? 0) + 1 };
    }

    if (!result.isFull) {
      shortages.push({ date: slot.date, period: slot.period, missing: result.missing });
    }
  }

  // ── Post-generation violation checks ───────────────────────────────────────
  const periodStart = sortedSlots.length > 0 ? sortedSlots[0].date : "";
  const periodEnd   = sortedSlots.length > 0 ? sortedSlots[sortedSlots.length - 1].date : "";

  // All four violation flags are derived from the final schedule state.
  // "blocked during selection" is NOT a violation — it means the hard rule
  // fired correctly and the employee was kept within limits.
  const violations: ViolationsMap = Object.fromEntries(
    employees.map((emp): [string, EmployeeViolations] => [
      emp,
      {
        exceededWeeklyLimit: employeeExceedsWeeklyLimit(emp, schedule, 5),
        exceededNightLimit:  employeeExceedsNightLimit(emp, schedule, 8, 14),
        noWeekendFree:    periodStart
          ? !hasFreeWeekend(emp, schedule, periodStart, periodEnd)
          : false,
        noWeekdayMorning: periodStart
          ? !hasWeekdayMorning(emp, schedule, periodStart, periodEnd)
          : false,
      },
    ])
  );

  return {
    schedule,
    shiftCounts,
    shortages,
    violations,
    totalShifts: schedule.length,
    totalFilled: schedule.filter((e) => e.assignments.length === 2).length,
    totalMissingSlots: shortages.reduce((sum, s) => sum + s.missing, 0),
  };
}

// Build one morning + one evening slot per day in the date range.
// Uses local-time arithmetic to avoid UTC-midnight drift across timezones.
export function buildShiftSlots(startDate: string, endDate: string): ShiftSlot[] {
  const slots: ShiftSlot[] = [];
  const periods: ShiftPeriod[] = ["morning", "evening"];

  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const cursor = new Date(sy, sm - 1, sd);
  const end    = new Date(ey, em - 1, ed);

  while (cursor <= end) {
    const y   = cursor.getFullYear();
    const m   = String(cursor.getMonth() + 1).padStart(2, "0");
    const d   = String(cursor.getDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${d}`;
    for (const period of periods) {
      slots.push({ date: dateStr, period });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return slots;
}
