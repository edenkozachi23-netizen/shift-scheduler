import type {
  ShiftTemplate,
  Constraint,
  ScheduleEntry,
  CanAssignResult,
} from "./types";
import {
  getWeekStart,
  countShiftsInWeek,
  countNightShiftsInWindow,
} from "./scheduleRules";

export type { ShiftTemplate, Constraint, ScheduleEntry, CanAssignResult };

const MAX_WEEKLY_SHIFTS = 5;
const MAX_NIGHT_SHIFTS_IN_WINDOW = 8;
const NIGHT_WINDOW_DAYS = 14;

export function canAssignEmployeeToShift(
  employee: string,
  targetDate: string,
  targetTemplate: ShiftTemplate,
  currentSchedule: ScheduleEntry[],
  constraints: Constraint[]
): CanAssignResult {
  const { period: targetPeriod } = targetTemplate;

  // Rule 1: all-day constraint — blocks every shift template on this date
  const hasAllDayConstraint = constraints.some(
    (c) =>
      c.employee === employee &&
      c.date === targetDate &&
      c.constraintType === "all-day"
  );
  if (hasAllDayConstraint) {
    return {
      allowed: false,
      reason: `ל-${employee} יש אילוץ יום שלם בתאריך ${targetDate}`,
      ruleCode: "constraint-all-day",
    };
  }

  // Rule 2: period constraint — any template constraint whose period prefix matches
  //         the target period blocks the employee from that entire period.
  //         e.g. "morning-07-19" OR "morning-08-20" both block ALL morning assignments.
  //         "morning-from-08" and "evening-from-20" are soft start-time preferences
  //         handled by Rule 2.5 and must NOT be caught here.
  const periodPrefix = targetTemplate.period + "-";
  const matchingPeriodConstraints = constraints.filter(
    (c) =>
      c.employee === employee &&
      c.date === targetDate &&
      c.constraintType !== "all-day" &&
      c.constraintType !== "morning-from-08" &&
      c.constraintType !== "evening-from-20" &&
      c.constraintType.startsWith(periodPrefix)
  );
  if (matchingPeriodConstraints.length > 0) {
    const periodHe = targetTemplate.period === "morning" ? "בוקר" : "ערב";
    return {
      allowed: false,
      reason: `ל-${employee} יש אילוץ ל${periodHe} בתאריך ${targetDate}`,
      ruleCode: "constraint-template",
    };
  }

  // Rule 2.5: start-time preference — can work the period but only from the
  //           later start time; blocks the earlier template only.
  const hasStartTimeConstraint = constraints.some(
    (c) =>
      c.employee === employee &&
      c.date === targetDate &&
      (
        (c.constraintType === "morning-from-08" && targetTemplate.shiftTemplateId === "morning-07-19") ||
        (c.constraintType === "evening-from-20" && targetTemplate.shiftTemplateId === "evening-19-07")
      )
  );
  if (hasStartTimeConstraint) {
    const fromTime = targetTemplate.shiftTemplateId === "morning-07-19" ? "08:00" : "20:00";
    return {
      allowed: false,
      reason: `${employee} זמין/ה רק מ-${fromTime} בתאריך ${targetDate}`,
      ruleCode: "start-time-preference",
    };
  }

  // Shift is identified by date + period (not by templateId)
  const targetShift = currentSchedule.find(
    (s) => s.date === targetDate && s.period === targetPeriod
  );

  // Rule 3: employee is already assigned to this shift (any template slot)
  if (targetShift?.assignments.some((a) => a.employeeId === employee)) {
    return {
      allowed: false,
      reason: `${employee} כבר משובץ/ת למשמרת זו`,
      ruleCode: "duplicate-shift",
    };
  }

  // Rule 4: shift already has 2 assignments (full)
  if (targetShift && targetShift.assignments.length >= 2) {
    return {
      allowed: false,
      reason: `משמרת ${targetPeriod === "morning" ? "הבוקר" : "הערב"} בתאריך ${targetDate} כבר מלאה`,
      ruleCode: "shift-full",
    };
  }

  // Rule 5: consecutive-shift rest — two sub-checks, both unconditional on period.
  //
  // 5a — overnight: blocked if employee worked evening the *previous* day.
  //      (evening ends ~07:00; morning starts 07:00–08:00 → zero rest)
  //      Only meaningful when assigning morning, but we check for both periods
  //      so the guard is never silently skipped if slot order changes.
  const prevDate = getPreviousDate(targetDate);
  const workedPrevEvening = currentSchedule.some(
    (s) =>
      s.date === prevDate &&
      s.period === "evening" &&
      s.assignments.some((a) => a.employeeId === employee)
  );
  if (workedPrevEvening) {
    return {
      allowed: false,
      reason: `${employee} עבד/ה ערב ב-${prevDate} — אין לשבץ לבוקר למחרת`,
      ruleCode: "back-to-back",
    };
  }

  // 5b — same-day cross-period: blocked if employee already has a shift of the
  //      *other* period on this calendar date.
  //      Covers morning→evening (the primary case) AND, as a belt-and-suspenders
  //      guard, evening→morning should the processing order ever differ.
  const otherPeriod = targetPeriod === "morning" ? "evening" : "morning";
  const workedSameDayOtherPeriod = currentSchedule.some(
    (s) =>
      s.date === targetDate &&
      s.period === otherPeriod &&
      s.assignments.some((a) => a.employeeId === employee)
  );
  if (workedSameDayOtherPeriod) {
    const otherPeriodHe = otherPeriod === "morning" ? "בוקר" : "ערב";
    return {
      allowed: false,
      reason: `${employee} כבר עבד/ה ${otherPeriodHe} ב-${targetDate} — אין לשבץ גם ל${targetPeriod === "evening" ? "ערב" : "בוקר"}`,
      ruleCode: "back-to-back",
    };
  }

  // Rule 6: weekly shift limit — max 5 shifts per Sun–Sat calendar week
  const weekStart = getWeekStart(targetDate);
  const weekCount = countShiftsInWeek(employee, weekStart, currentSchedule);
  if (weekCount >= MAX_WEEKLY_SHIFTS) {
    return {
      allowed: false,
      reason: `${employee} הגיע/ה למכסת ${MAX_WEEKLY_SHIFTS} משמרות בשבוע (${weekStart})`,
      ruleCode: "weekly-limit",
    };
  }

  // Rule 7: night shift limit — max 8 evening shifts in any rolling 14-day window
  if (targetPeriod === "evening") {
    const nightCount = countNightShiftsInWindow(
      employee,
      targetDate,
      NIGHT_WINDOW_DAYS,
      currentSchedule
    );
    if (nightCount >= MAX_NIGHT_SHIFTS_IN_WINDOW) {
      return {
        allowed: false,
        reason: `${employee} הגיע/ה למכסת ${MAX_NIGHT_SHIFTS_IN_WINDOW} משמרות לילה ב-${NIGHT_WINDOW_DAYS} ימים`,
        ruleCode: "night-limit",
      };
    }
  }

  return { allowed: true };
}

function getPreviousDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
