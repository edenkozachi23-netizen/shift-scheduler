export type ShiftPeriod = "morning" | "evening";

export type ShiftTemplate = {
  shiftTemplateId: string;   // e.g. "morning-07-19"
  shiftCode: string;         // e.g. "M1"
  shiftLabelHe: string;      // e.g. "בוקר 07:00–19:00"
  period: ShiftPeriod;
  startTime: string;         // "07:00"
  endTime: string;           // "19:00"
};

// Each assigned employee carries their own shift template
export type Assignment = {
  employeeId: string;
  shiftTemplateId: string;
  shiftLabelHe: string;
  startTime: string;
  endTime: string;
  /** Set to true when this is the employee's 5th shift in the calendar week (shortened start rule). */
  shortenedStart?: boolean;
};

// Employees submit unavailability per exact shift template, or for the full day.
// "all-day"       blocks every shift template on that date.
// Exact template IDs block only that specific template — the other template
// in the same period remains available.
export type ConstraintType =
  | "all-day"
  | "morning-07-19"
  | "morning-08-20"
  | "evening-19-07"
  | "evening-20-08"
  | "morning-from-07"   // can work morning but only from 07:00
  | "morning-from-08"   // can work morning but only from 08:00 (blocks morning-07-19)
  | "evening-from-19"   // can work evening but only from 19:00
  | "evening-from-20";  // can work evening but only from 20:00 (blocks evening-19-07)

export type Constraint = {
  employee: string;
  date: string;              // "YYYY-MM-DD"
  constraintType: ConstraintType;
  note?: string;
};

// A shift is identified by date + period.
// Assignments hold all employee–template pairings for that shift (max 2).
export type ScheduleEntry = {
  date: string;              // "YYYY-MM-DD"
  period: ShiftPeriod;       // "morning" | "evening" — used for back-to-back rules
  assignments: Assignment[]; // max 2
};

export type CanAssignResult = {
  allowed: boolean;
  reason?: string;
  ruleCode?: string;
};

// key: employee name, value: total shifts assigned so far
export type ShiftCounts = Record<string, number>;

export type SlotPickDetail = {
  slot: 1 | 2;
  selected: string | null;
  assignedTemplate: ShiftTemplate | null;
  templatePickReason: "coverage" | "fallback" | null;
  coveredEndTime: string | null;       // the morning end time this evening template covers, if any
  blockedDuringPick: { employee: string; reason: string; ruleCode?: string }[];
};

export type AssignShiftResult = {
  date: string;
  period: ShiftPeriod;
  assignments: Assignment[];  // 0, 1, or 2
  isFull: boolean;
  missing: number;            // 0, 1, or 2
  picks: SlotPickDetail[];
};

// A shift slot to fill: just date + period.
// Template selection happens inside assignEmployeesToShift.
export type ShiftSlot = {
  date: string;              // "YYYY-MM-DD"
  period: ShiftPeriod;
};

export type ShortageEntry = {
  date: string;
  period: ShiftPeriod;
  missing: number;
};

export type EmployeeViolations = {
  /** Employee hit the weekly 5-shift cap at least once */
  exceededWeeklyLimit: boolean;
  /** Employee hit the 14-day rolling night-shift cap at least once */
  exceededNightLimit: boolean;
  /** Employee has no free Fri+Sat pair in the scheduling period */
  noWeekendFree: boolean;
  /** Employee has no weekday morning shift in the scheduling period */
  noWeekdayMorning: boolean;
};

export type ViolationsMap = Record<string, EmployeeViolations>;

export type GenerateScheduleResult = {
  schedule: ScheduleEntry[];
  shiftCounts: ShiftCounts;
  shortages: ShortageEntry[];
  violations: ViolationsMap;
  totalShifts: number;
  totalFilled: number;
  totalMissingSlots: number;
};
