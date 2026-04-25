import { SHIFT_TEMPLATES } from "./shiftTemplates";
import type { ShiftPeriod, ShiftTemplate, ScheduleEntry } from "./types";

export type TemplatePick = {
  template: ShiftTemplate;
  reason: "coverage" | "fallback";
  coveredEndTime: string | null; // the morning end time this evening template covers, or null
};

/**
 * Selects the best shift template for a new assignment slot.
 *
 * Morning:  always returns the first morning template (no optimization yet).
 * Evening:  prefers templates whose startTime covers an uncovered morning end time
 *           from the same day, ensuring every employee handoff time is matched.
 *
 * "Uncovered" means no currently-assigned evening slot already starts at that time.
 * If multiple uncovered end times exist, we iterate them in order and take the
 * first template that matches — giving deterministic results.
 *
 * Falls back to the first evening template if all end times are already covered
 * or there are no morning assignments to check.
 */
export function pickBestTemplateForAssignment(
  period: ShiftPeriod,
  targetDate: string,
  currentSchedule: ScheduleEntry[]
): TemplatePick {
  const periodTemplates = SHIFT_TEMPLATES.filter((t) => t.period === period);

  // Morning: no coverage-driven selection yet
  if (period === "morning") {
    return { template: periodTemplates[0], reason: "fallback", coveredEndTime: null };
  }

  // Evening: gather morning end times and already-covered evening start times
  const morningEntry = currentSchedule.find(
    (e) => e.date === targetDate && e.period === "morning"
  );
  const eveningEntry = currentSchedule.find(
    (e) => e.date === targetDate && e.period === "evening"
  );

  const morningEndTimes = morningEntry
    ? morningEntry.assignments.map((a) => a.endTime)
    : [];
  const coveredStartTimes = new Set(
    eveningEntry ? eveningEntry.assignments.map((a) => a.startTime) : []
  );

  // Walk uncovered end times in the order they appear in morning assignments
  // (preserves determinism without any extra sort)
  const seen = new Set<string>();
  for (const endTime of morningEndTimes) {
    if (seen.has(endTime)) continue;
    seen.add(endTime);
    if (coveredStartTimes.has(endTime)) continue; // already covered by a previous slot

    const match = periodTemplates.find((t) => t.startTime === endTime);
    if (match) {
      return { template: match, reason: "coverage", coveredEndTime: endTime };
    }
  }

  // Fallback: use first template in list
  return { template: periodTemplates[0], reason: "fallback", coveredEndTime: null };
}
