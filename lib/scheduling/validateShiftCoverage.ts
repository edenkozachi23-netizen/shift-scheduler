import type { ScheduleEntry } from "./types";

export type DayCoverageResult = {
  date: string;
  valid: boolean;
  morningEndTimes: string[];
  eveningStartTimes: string[];
  missingCoverage: string[]; // morning end times not matched by any evening start time
};

export type CoverageResult = {
  valid: boolean;
  days: DayCoverageResult[];
};

export function validateShiftCoverage(schedule: ScheduleEntry[]): CoverageResult {
  const dates = Array.from(new Set(schedule.map((e) => e.date))).sort();

  const days: DayCoverageResult[] = dates.map((date) => {
    const morningEntry = schedule.find((e) => e.date === date && e.period === "morning");
    const eveningEntry = schedule.find((e) => e.date === date && e.period === "evening");

    const morningCount = morningEntry?.assignments.length ?? 0;
    const eveningCount = eveningEntry?.assignments.length ?? 0;

    const morningEndTimes = morningEntry
      ? Array.from(new Set(morningEntry.assignments.map((a) => a.endTime)))
      : [];
    const eveningStartTimes = eveningEntry
      ? Array.from(new Set(eveningEntry.assignments.map((a) => a.startTime)))
      : [];

    const missingCoverage = morningEndTimes.filter(
      (endTime) => !eveningStartTimes.includes(endTime)
    );

    const fullyStaffed = morningCount >= 2 && eveningCount >= 2;
    const errors: string[] = [];
    if (morningCount < 2) errors.push(`בוקר ${morningCount}/2 עובדים`);
    if (eveningCount < 2) errors.push(`ערב ${eveningCount}/2 עובדים`);
    if (fullyStaffed && missingCoverage.length > 0) errors.push(...missingCoverage.map((t) => `מעבר חסר בשעה ${t}`));

    return {
      date,
      valid: fullyStaffed && missingCoverage.length === 0,
      morningEndTimes,
      eveningStartTimes,
      missingCoverage: errors,
    };
  });

  return {
    valid: days.every((d) => d.valid),
    days,
  };
}
