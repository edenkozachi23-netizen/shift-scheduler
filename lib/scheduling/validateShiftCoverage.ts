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

    const morningEndTimes = morningEntry
      ? Array.from(new Set(morningEntry.assignments.map((a) => a.endTime)))
      : [];
    const eveningStartTimes = eveningEntry
      ? Array.from(new Set(eveningEntry.assignments.map((a) => a.startTime)))
      : [];

    const missingCoverage = morningEndTimes.filter(
      (endTime) => !eveningStartTimes.includes(endTime)
    );

    const hasStaff = morningEndTimes.length > 0 && eveningStartTimes.length > 0;

    return {
      date,
      valid: hasStaff && missingCoverage.length === 0,
      morningEndTimes,
      eveningStartTimes,
      missingCoverage: hasStaff ? missingCoverage : ["חסרה משמרת בוקר או ערב"],
    };
  });

  return {
    valid: days.every((d) => d.valid),
    days,
  };
}
