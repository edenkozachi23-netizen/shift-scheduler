import { canAssignEmployeeToShift } from "./canAssignEmployeeToShift";
import {
  countEmployeeWeekendShifts,
  scoreEmployeeBalanceImpact,
} from "./scheduleRules";
import type { ShiftTemplate, Constraint, ScheduleEntry, ShiftCounts } from "./types";

export type { ShiftTemplate, Constraint, ScheduleEntry, ShiftCounts };

export type BlockedEntry = {
  employee: string;
  reason: string;
  ruleCode?: string;
};

export type PickResult = {
  best: string | null;
  allowed: string[];
  blocked: BlockedEntry[];
};

export function pickBestEmployeeForShift(
  employees: string[],
  targetDate: string,
  targetTemplate: ShiftTemplate,
  currentSchedule: ScheduleEntry[],
  constraints: Constraint[],
  shiftCounts: ShiftCounts
): PickResult {
  const allowed: string[] = [];
  const blocked: BlockedEntry[] = [];

  for (const emp of employees) {
    const result = canAssignEmployeeToShift(
      emp,
      targetDate,
      targetTemplate,
      currentSchedule,
      constraints
    );
    if (result.allowed) {
      allowed.push(emp);
    } else {
      blocked.push({ employee: emp, reason: result.reason ?? "לא ידוע", ruleCode: result.ruleCode });
    }
  }

  if (allowed.length === 0) {
    return { best: null, allowed, blocked };
  }

  // ── Fairness ranking (preference, not hard constraint) ─────────────────────
  //
  // Priority order (ascending = preferred):
  //   1. Fewest total assigned shifts  — overall workload fairness
  //   2. Fewest weekend shifts         — weekend burden fairness
  //   3. Fewest shifts in target period — morning/evening balance
  //   4. Hebrew alphabetical           — deterministic tie-break
  //
  // shiftCounts is used for key 1 because it is updated incrementally within
  // the slot loop (more accurate than re-counting from currentSchedule).
  // Keys 2 and 3 scan currentSchedule which reflects all prior assignments.

  const sorted = [...allowed].sort((a, b) => {
    // 1. Total fairness
    const totalDiff = (shiftCounts[a] ?? 0) - (shiftCounts[b] ?? 0);
    if (totalDiff !== 0) return totalDiff;

    // 2. Weekend fairness
    const weekendDiff =
      countEmployeeWeekendShifts(a, currentSchedule) -
      countEmployeeWeekendShifts(b, currentSchedule);
    if (weekendDiff !== 0) return weekendDiff;

    // 3. Morning/evening balance
    const balanceDiff =
      scoreEmployeeBalanceImpact(a, targetTemplate.period, currentSchedule) -
      scoreEmployeeBalanceImpact(b, targetTemplate.period, currentSchedule);
    if (balanceDiff !== 0) return balanceDiff;

    // 4. Deterministic tie-break
    return a.localeCompare(b, "he");
  });

  return { best: sorted[0], allowed: sorted, blocked };
}
