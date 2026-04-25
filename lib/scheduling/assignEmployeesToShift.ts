import { pickBestEmployeeForShift } from "./pickBestEmployeeForShift";
import { pickBestTemplateForAssignment } from "./pickBestTemplateForAssignment";
import { getWeekStart, countShiftsInWeek } from "./scheduleRules";
import type {
  ShiftPeriod,
  Assignment,
  Constraint,
  ScheduleEntry,
  ShiftCounts,
  AssignShiftResult,
  SlotPickDetail,
} from "./types";

export type { ShiftPeriod, Assignment, Constraint, ScheduleEntry, ShiftCounts, AssignShiftResult };

const SLOTS_PER_SHIFT = 2;

export function assignEmployeesToShift(
  targetDate: string,
  targetPeriod: ShiftPeriod,
  employees: string[],
  currentSchedule: ScheduleEntry[],
  constraints: Constraint[],
  shiftCounts: ShiftCounts
): AssignShiftResult {
  const assignments: Assignment[] = [];
  const picks: SlotPickDetail[] = [];

  // Clone schedule so we never mutate the caller's array
  let workingSchedule: ScheduleEntry[] = currentSchedule.map((e) => ({
    ...e,
    assignments: [...e.assignments],
  }));

  // Ensure the target shift entry exists in the working copy
  const targetExists = workingSchedule.some(
    (e) => e.date === targetDate && e.period === targetPeriod
  );
  if (!targetExists) {
    workingSchedule.push({ date: targetDate, period: targetPeriod, assignments: [] });
  }

  for (let slot = 1; slot <= SLOTS_PER_SHIFT; slot++) {
    // Pick the best template for this slot.
    // For evening shifts, this considers same-day morning end times so that
    // uncovered handoff times are preferred first.
    const templatePick = pickBestTemplateForAssignment(
      targetPeriod,
      targetDate,
      workingSchedule
    );
    const template = templatePick.template;

    const pick = pickBestEmployeeForShift(
      employees,
      targetDate,
      template,
      workingSchedule,
      constraints,
      shiftCounts
    );

    picks.push({
      slot: slot as 1 | 2,
      selected: pick.best,
      assignedTemplate: pick.best !== null ? template : null,
      templatePickReason: pick.best !== null ? templatePick.reason : null,
      coveredEndTime: pick.best !== null ? templatePick.coveredEndTime : null,
      blockedDuringPick: pick.blocked,
    });

    if (pick.best === null) break;

    // Check if this assignment is the employee's 5th shift this week
    // (workingSchedule reflects all prior assignments but NOT this one yet)
    const weekStart = getWeekStart(targetDate);
    const weekCountBefore = countShiftsInWeek(pick.best, weekStart, workingSchedule);
    const isFifthShift = weekCountBefore === 4; // about to become the 5th

    const newAssignment: Assignment = {
      employeeId: pick.best,
      shiftTemplateId: template.shiftTemplateId,
      shiftLabelHe: template.shiftLabelHe,
      startTime: template.startTime,
      endTime: template.endTime,
      ...(isFifthShift ? { shortenedStart: true } : {}),
    };

    assignments.push(newAssignment);

    // Update working schedule so:
    //   (a) next employee pick sees this slot as taken
    //   (b) next template pick sees this start time as already covered
    workingSchedule = workingSchedule.map((e) =>
      e.date === targetDate && e.period === targetPeriod
        ? { ...e, assignments: [...e.assignments, newAssignment] }
        : e
    );

    // Update working counts so fairness sort stays accurate for slot 2
    shiftCounts = { ...shiftCounts, [pick.best]: (shiftCounts[pick.best] ?? 0) + 1 };
  }

  return {
    date: targetDate,
    period: targetPeriod,
    assignments,
    isFull: assignments.length === SLOTS_PER_SHIFT,
    missing: SLOTS_PER_SHIFT - assignments.length,
    picks,
  };
}
