"use client";

import { useState, useEffect } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { generateSchedule, buildShiftSlots } from "@/lib/scheduling/generateSchedule";
import { SHIFT_TEMPLATES, SHIFT_TEMPLATE_MAP } from "@/lib/scheduling/shiftTemplates";
import { validateShiftCoverage } from "@/lib/scheduling/validateShiftCoverage";
import { validateSchedule, VIOLATION_LABEL } from "@/lib/scheduling/validateSchedule";
import type { ScheduleViolation, ViolationCode } from "@/lib/scheduling/validateSchedule";
import type { ScheduleEntry, Constraint, ConstraintType } from "@/lib/scheduling/types";
import { canAssignEmployeeToShift } from "@/lib/scheduling/canAssignEmployeeToShift";
import {
  exportScheduleToExcel,
  type ExportDay,
  type ExportSlot,
  type ExportInput,
  type ExportEmployeeStat,
  type ExportPeriodStats,
  type ExportViolation,
  type ExportInsight,
} from "@/lib/export/exportScheduleToExcel";
import { EMPLOYEES as ALL_EMPLOYEES } from "@/lib/employees";

// ─── Supabase shift type (from API) ──────────────────────────────────────────

type ShiftType = {
  id: number;
  name: string;
  period: string;
  start_time: string;
  end_time: string;
};

// ─── UI schedule types ────────────────────────────────────────────────────────

type SlotValue = { employee: string; templateId: string; shortenedStart?: boolean } | "";
type Shift = [SlotValue, SlotValue];
type DaySchedule = { morning: Shift; evening: Shift };
type Schedule = DaySchedule[];

const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

// ─── Date helpers ─────────────────────────────────────────────────────────────

function offsetDate(start: string, days: number): string {
  const [y, m, d] = start.split("-").map(Number);
  const result = new Date(y, m - 1, d + days);
  return `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, "0")}-${String(result.getDate()).padStart(2, "0")}`;
}


function formatDateShort(dateStr: string): string {
  const [, month, day] = dateStr.split("-");
  return `${parseInt(day)}/${parseInt(month)}`;
}

/** Returns the scheduling period (20th of previous/current month → 19th of current/next month).
 *  Mirrors the employee dashboard logic: if today >= 20, the active schedule period is
 *  20th this month → 19th next month. Otherwise it's 20th last month → 19th this month. */
function getSchedulingPeriod(): { start: string; end: string } {
  const today = new Date();
  const year  = today.getFullYear();
  const month = today.getMonth() + 1; // 1-based
  const day   = today.getDate();
  if (day >= 20) {
    // Active schedule: 20th this month → 19th next month
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear  = month === 12 ? year + 1 : year;
    return {
      start: `${year}-${String(month).padStart(2, "0")}-20`,
      end:   `${nextYear}-${String(nextMonth).padStart(2, "0")}-19`,
    };
  } else {
    // Active schedule: 20th last month → 19th this month
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;
    return {
      start: `${prevYear}-${String(prevMonth).padStart(2, "0")}-20`,
      end:   `${year}-${String(month).padStart(2, "0")}-19`,
    };
  }
}

// ─── Engine ↔ UI schedule conversion ─────────────────────────────────────────

function engineEntryToShift(entry: ScheduleEntry | undefined): Shift {
  const a0 = entry?.assignments[0];
  const a1 = entry?.assignments[1];
  return [
    a0 ? { employee: a0.employeeId, templateId: a0.shiftTemplateId, shortenedStart: a0.shortenedStart } : "",
    a1 ? { employee: a1.employeeId, templateId: a1.shiftTemplateId, shortenedStart: a1.shortenedStart } : "",
  ];
}

function dateDiffDays(start: string, end: string): number {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const s = new Date(sy, sm - 1, sd);
  const e = new Date(ey, em - 1, ed);
  return Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24));
}

function engineToUISchedule(entries: ScheduleEntry[], startDate: string, endDate?: string): Schedule {
  const days = endDate ? dateDiffDays(startDate, endDate) + 1 : 7;
  return Array.from({ length: days }, (_, i) => {
    const date = offsetDate(startDate, i);
    return {
      morning: engineEntryToShift(entries.find((e) => e.date === date && e.period === "morning")),
      evening: engineEntryToShift(entries.find((e) => e.date === date && e.period === "evening")),
    };
  });
}

function uiScheduleToEntries(schedule: Schedule, startDate: string): ScheduleEntry[] {
  return schedule.flatMap((day, i) => {
    const date = offsetDate(startDate, i);
    return (["morning", "evening"] as const).map((period) => ({
      date,
      period,
      assignments: day[period]
        .filter((v): v is Exclude<SlotValue, ""> => v !== "")
        .map((v) => {
          const tpl = SHIFT_TEMPLATE_MAP[v.templateId];
          return {
            employeeId: v.employee,
            shiftTemplateId: v.templateId,
            shiftLabelHe: tpl?.shiftLabelHe ?? v.templateId,
            startTime: tpl?.startTime ?? "",
            endTime: tpl?.endTime ?? "",
            shortenedStart: v.shortenedStart,
          };
        }),
    }));
  });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function slotFilled(v: SlotValue): boolean {
  return v !== "";
}

function computeStats(schedule: Schedule) {
  let morningFull = 0;
  let eveningFull = 0;
  let missingShifts = 0;
  const workers = new Set<string>();
  schedule.forEach((day) => {
    const mFilled = day.morning.filter(slotFilled).length;
    const eFilled = day.evening.filter(slotFilled).length;
    if (mFilled === 2) morningFull++;
    if (eFilled === 2) eveningFull++;
    if (mFilled < 2) missingShifts++;
    if (eFilled < 2) missingShifts++;
    [...day.morning, ...day.evening]
      .filter((v): v is { employee: string; templateId: string } => v !== "")
      .forEach((v) => workers.add(v.employee));
  });
  return { morningFull, eveningFull, missingShifts, activeWorkers: workers.size };
}

// ─── Shortage analysis ────────────────────────────────────────────────────────

type ShortageReason = "legality" | "constraints" | "available";

const SHORTAGE_REASON_LABEL: Record<"legality" | "constraints", string> = {
  legality:    "מגבלות חוקיות",
  constraints: "אילוצי עובדים",
};

/**
 * For a slot that is not fully staffed, determine why no more employees can be
 * assigned. Tries each unassigned employee against every period template and
 * classifies the dominant block reason.
 *
 * Returns:
 *   "legality"    — everyone is blocked by scheduling rules (back-to-back,
 *                   weekly/night limit, etc.)
 *   "constraints" — majority blocked by employee availability constraints
 *   "available"   — at least one employee CAN legally fill the slot (slot is
 *                   empty due to a manual edit or other non-rule cause)
 */
function analyzeShiftShortage(
  date: string,
  period: "morning" | "evening",
  entries: ScheduleEntry[],
  constraints: Constraint[],
  employeeList: string[]
): ShortageReason {
  const shift = entries.find((e) => e.date === date && e.period === period);
  const assigned = new Set(shift?.assignments.map((a) => a.employeeId) ?? []);
  const candidates = employeeList.filter((e) => !assigned.has(e));
  if (candidates.length === 0) return "available";

  const periodTemplates = SHIFT_TEMPLATES.filter((t) => t.period === period);
  let constraintBlocks = 0;
  let legalityBlocks = 0;

  for (const emp of candidates) {
    let firstBlockCode: string | undefined;
    for (const tpl of periodTemplates) {
      const result = canAssignEmployeeToShift(emp, date, tpl, entries, constraints);
      if (result.allowed) return "available"; // someone CAN be assigned
      firstBlockCode ??= result.ruleCode;    // keep first block reason
    }
    if (firstBlockCode === "constraint-all-day" || firstBlockCode === "constraint-template") {
      constraintBlocks++;
    } else {
      legalityBlocks++;
    }
  }

  return constraintBlocks > legalityBlocks ? "constraints" : "legality";
}

type MissingItem = {
  text: string;
  reason: "legality" | "constraints" | null; // null = slot empty but someone is available (manual edit)
};

function getMissingList(
  schedule: Schedule,
  startDate: string,
  entries: ScheduleEntry[],
  employeeList: string[]
): MissingItem[] {
  const items: MissingItem[] = [];
  schedule.forEach((day, i) => {
    const date  = offsetDate(startDate, i);
    const [dy, dm, dd] = date.split("-").map(Number);
    const dow   = new Date(dy, dm - 1, dd).getDay();
    const label = `${DAYS[dow]} ${formatDateShort(date)}`;
    const mFilled = day.morning.filter(slotFilled).length;
    const eFilled = day.evening.filter(slotFilled).length;
    if (mFilled < 2) {
      const raw = analyzeShiftShortage(date, "morning", entries, [], employeeList);
      items.push({
        text:   `יום ${label} — בוקר — ${mFilled === 1 ? "חסר עובד 1" : "חסרים 2 עובדים"}`,
        reason: raw === "available" ? null : raw,
      });
    }
    if (eFilled < 2) {
      const raw = analyzeShiftShortage(date, "evening", entries, [], employeeList);
      items.push({
        text:   `יום ${label} — ערב — ${eFilled === 1 ? "חסר עובד 1" : "חסרים 2 עובדים"}`,
        reason: raw === "available" ? null : raw,
      });
    }
  });
  return items;
}

function shiftBg(filled: number) {
  if (filled === 0) return "bg-red-100 border-red-300";
  if (filled === 1) return "bg-orange-50 border-orange-200";
  return "bg-gray-50 border-gray-200";
}

// ─── Employee statistics ───────────────────────────────────────────────────────

type EmployeeStats = {
  name: string;
  total: number;
  morning: number;
  evening: number;
  friday: number;          // DOW 5
  saturday: number;        // DOW 6
  weekdayMorning: number;  // morning shifts on Sun–Thu (DOW 0–4)
};

/**
 * Derive per-employee shift counts from the flat ScheduleEntry list.
 * DOW convention: 0=Sun, 1=Mon, …, 5=Fri, 6=Sat (local time).
 */
function computeEmployeeStats(entries: ScheduleEntry[], employees: string[]): EmployeeStats[] {
  return employees.map((name) => {
    let total = 0, morning = 0, evening = 0, friday = 0, saturday = 0, weekdayMorning = 0;
    for (const entry of entries) {
      if (!entry.assignments.some((a) => a.employeeId === name)) continue;
      total++;
      const [y, m, d] = entry.date.split("-").map(Number);
      const dow = new Date(y, m - 1, d).getDay();
      if (entry.period === "morning") {
        morning++;
        if (dow <= 4) weekdayMorning++; // Sun(0)–Thu(4)
      } else {
        evening++;
      }
      if (dow === 5) friday++;
      if (dow === 6) saturday++;
    }
    return { name, total, morning, evening, friday, saturday, weekdayMorning };
  });
}

type LoadLevel = "low" | "medium" | "high";

/**
 * Load level thresholds (weekly schedule — typically 3–4 shifts per employee):
 *   high   ("עמוס") — 5+ total shifts  OR  3+ weekend shifts
 *   medium ("תקין") — 3–4 total shifts  OR  1–2 weekend shifts   ← normal range
 *   low    ("קל")   — 0–2 total shifts
 */
function getLoadLevel(s: EmployeeStats): LoadLevel {
  const weekend = s.friday + s.saturday;
  if (s.total >= 5 || weekend >= 3) return "high";
  if (s.total >= 3 || weekend >= 1) return "medium";
  return "low";
}

const LOAD_STYLE: Record<LoadLevel, { badge: string; dot: string; label: string }> = {
  low:    { badge: "bg-green-100 text-green-700 border-green-200",   dot: "bg-green-500",  label: "קל"   },
  medium: { badge: "bg-blue-100 text-blue-700 border-blue-200",      dot: "bg-blue-500",   label: "תקין" },
  high:   { badge: "bg-red-100 text-red-700 border-red-200",         dot: "bg-red-500",    label: "עמוס" },
};

type Insight = { message: string };

/**
 * Produce a compact list of actionable observations.
 *   1. High-load employees   (total ≥5 or 3+ weekend)
 *   2. No weekday morning    (active, but 0 morning shifts on Sun–Thu)
 *   3. Heavy weekend         (2+ Fri/Sat shifts)
 *   4. Lightest loaded       (active employees at the minimum total, when the
 *                             spread between min and max is ≥2 shifts)
 */
function computeInsights(stats: EmployeeStats[]): Insight[] {
  const active = stats.filter((s) => s.total > 0);
  if (active.length === 0) return [];
  const out: Insight[] = [];

  // 1 — high load
  const highLoad = active.filter((s) => getLoadLevel(s) === "high");
  if (highLoad.length > 0)
    out.push({ message: `עומס גבוה: ${highLoad.map((s) => s.name).join(", ")}` });

  // 2 — no weekday morning
  const noWeekdayMorning = active.filter((s) => s.weekdayMorning === 0);
  if (noWeekdayMorning.length > 0)
    out.push({ message: `ללא בוקר בחול: ${noWeekdayMorning.map((s) => s.name).join(", ")}` });

  // 3 — heavy weekend
  const heavyWeekend = active.filter((s) => (s.friday + s.saturday) >= 2);
  if (heavyWeekend.length > 0)
    out.push({ message: `2+ משמרות סוף שבוע: ${heavyWeekend.map((s) => s.name).join(", ")}` });

  // 4 — lightest loaded (only useful when there is a meaningful spread ≥2)
  const maxTotal = Math.max(...active.map((s) => s.total));
  const minTotal = Math.min(...active.map((s) => s.total));
  if (maxTotal - minTotal >= 2) {
    const lightest = active.filter((s) => s.total === minTotal);
    out.push({ message: `עומס קל — זמינים לשיבוץ נוסף: ${lightest.map((s) => s.name).join(", ")}` });
  }

  return out;
}

/** Same insights as computeInsights, but shaped as ExportInsight[] for the Excel report. */
function computeExportInsights(stats: EmployeeStats[]): ExportInsight[] {
  const active = stats.filter((s) => s.total > 0);
  if (active.length === 0) return [];
  const out: ExportInsight[] = [];

  const highLoad = active.filter((s) => getLoadLevel(s) === "high");
  if (highLoad.length > 0)
    out.push({ topic: "עומס גבוה", employees: highLoad.map((s) => s.name).join(", ") });

  const noWeekdayMorning = active.filter((s) => s.weekdayMorning === 0);
  if (noWeekdayMorning.length > 0)
    out.push({ topic: "ללא בוקר בחול", employees: noWeekdayMorning.map((s) => s.name).join(", ") });

  const heavyWeekend = active.filter((s) => (s.friday + s.saturday) >= 2);
  if (heavyWeekend.length > 0)
    out.push({ topic: "2+ משמרות סוף שבוע", employees: heavyWeekend.map((s) => s.name).join(", ") });

  const maxTotal = Math.max(...active.map((s) => s.total));
  const minTotal = Math.min(...active.map((s) => s.total));
  if (maxTotal - minTotal >= 2) {
    const lightest = active.filter((s) => s.total === minTotal);
    out.push({ topic: "עומס קל — זמינים לשיבוץ נוסף", employees: lightest.map((s) => s.name).join(", ") });
  }

  return out;
}

// ─── Saved-entry helpers (for historical stats) ───────────────────────────────

type SavedRow = {
  date: string;
  period: string;
  employee_id: string;
  shift_template_id: string;
};

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const MONTH_NAMES_HE = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

function getMonthRange(d: Date): { start: string; end: string; label: string } {
  const year = d.getFullYear();
  const month = d.getMonth();
  return {
    start: isoDate(new Date(year, month, 1)),
    end:   isoDate(new Date(year, month + 1, 0)),
    label: `${MONTH_NAMES_HE[month]} ${year}`,
  };
}

function getQuarterRange(d: Date): { start: string; end: string; label: string } {
  const year = d.getFullYear();
  const q = Math.floor(d.getMonth() / 3);
  return {
    start: isoDate(new Date(year, q * 3, 1)),
    end:   isoDate(new Date(year, q * 3 + 3, 0)),
    label: `רבעון ${q + 1} / ${year}`,
  };
}

function getYearRange(d: Date): { start: string; end: string; label: string } {
  const year = d.getFullYear();
  return {
    start: `${year}-01-01`,
    end:   `${year}-12-31`,
    label: `${year}`,
  };
}

/** Convert flat API rows → ScheduleEntry[] (grouped by date+period). */
function savedToEntries(rows: SavedRow[]): ScheduleEntry[] {
  const map = new Map<string, ScheduleEntry>();
  for (const row of rows) {
    const key = `${row.date}|${row.period}`;
    if (!map.has(key)) {
      map.set(key, {
        date:   row.date,
        period: row.period as "morning" | "evening",
        assignments: [],
      });
    }
    const tpl = SHIFT_TEMPLATE_MAP[row.shift_template_id];
    map.get(key)!.assignments.push({
      employeeId:      row.employee_id,
      shiftTemplateId: row.shift_template_id,
      shiftLabelHe:    tpl?.shiftLabelHe ?? row.shift_template_id,
      startTime:       tpl?.startTime ?? "",
      endTime:         tpl?.endTime   ?? "",
    });
  }
  return Array.from(map.values());
}

/** Returns the ISO date of the Sunday that starts the week containing `iso`. */
function getWeekStartLocal(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - dt.getDay()); // back to Sunday
  return isoDate(dt);
}

/**
 * Groups ScheduleEntry[] by week (monthly) or month (quarterly) and builds
 * the ExportPeriodStats structure consumed by the Excel builder and the UI.
 */
function buildPeriodStats(
  label: string,
  entries: ScheduleEntry[],
  groupBy: "week" | "month",
  employeeList: string[]
): ExportPeriodStats {
  const LOAD_HE: Record<LoadLevel, "קל" | "תקין" | "עמוס"> = {
    low: "קל", medium: "תקין", high: "עמוס",
  };

  // Group entries into sub-periods
  const groups = new Map<string, ScheduleEntry[]>();
  for (const e of entries) {
    const key = groupBy === "week"
      ? getWeekStartLocal(e.date)          // "YYYY-MM-DD" of Sunday
      : e.date.slice(0, 7);               // "YYYY-MM"
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  const sortedKeys = Array.from(groups.keys()).sort();

  // Sub-period column labels
  const subLabels = sortedKeys.map((k) => {
    if (groupBy === "week") {
      return `${formatDateShort(k)}–${formatDateShort(offsetDate(k, 6))}`;
    }
    const [, mo] = k.split("-").map(Number);
    return MONTH_NAMES_HE[mo - 1];
  });

  const allStats = computeEmployeeStats(entries, employeeList);
  const avgDivisor = groupBy === "week" ? sortedKeys.length : 13;

  const rows = allStats
    .filter((s) => s.total > 0)
    .map((s) => ({
      name:      s.name,
      subCounts: sortedKeys.map((k) =>
        (groups.get(k) ?? []).filter((e) =>
          e.assignments.some((a) => a.employeeId === s.name)
        ).length
      ),
      total:     s.total,
      morning:   s.morning,
      evening:   s.evening,
      friday:    s.friday,
      saturday:  s.saturday,
      loadLevel: LOAD_HE[getLoadLevel(s)],
    }));

  return { label, subLabels, avgDivisor, rows };
}

// ─── SlotCell ─────────────────────────────────────────────────────────────────

type SlotProps = {
  value: SlotValue;
  period: "morning" | "evening";
  editMode: boolean;
  excludeEmployee?: string;
  employeeList: string[];
  violationReasons?: string[];
  onChange: (v: SlotValue) => void;
};

function SlotCell({ value, period, editMode, excludeEmployee, employeeList, violationReasons, onChange }: SlotProps) {
  const periodTemplates = SHIFT_TEMPLATES.filter((t) => t.period === period);
  const violating = (violationReasons?.length ?? 0) > 0;

  if (editMode) {
    const empVal = value === "" ? "" : value.employee;
    const tplVal = value === "" ? periodTemplates[0].shiftTemplateId : value.templateId;
    return (
      <div className="flex flex-col gap-0.5">
        <select
          value={empVal}
          onChange={(e) => {
            const emp = e.target.value;
            if (!emp) onChange("");
            else onChange({ employee: emp, templateId: tplVal });
          }}
          className={`w-full border rounded px-1 py-0.5 text-xs text-gray-800 bg-white focus:outline-none focus:ring-1 ${
            violating
              ? "border-red-400 bg-red-50 focus:ring-red-400"
              : "border-gray-300 focus:ring-blue-400"
          }`}
        >
          <option value="">— ריק —</option>
          {employeeList.filter((emp) => emp !== excludeEmployee).map((emp) => (
            <option key={emp} value={emp}>{emp}</option>
          ))}
        </select>
        {empVal && (
          <select
            value={tplVal}
            onChange={(e) => onChange({ employee: empVal, templateId: e.target.value })}
            className="w-full border border-blue-200 rounded px-1 py-0.5 text-xs text-blue-700 bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400"
          >
            {periodTemplates.map((t) => (
              <option key={t.shiftTemplateId} value={t.shiftTemplateId}>
                {t.shiftLabelHe}
              </option>
            ))}
          </select>
        )}
        {/* Shortened 5th shift indicator */}
        {value !== "" && value.shortenedStart && (
          <div className="text-xs text-blue-600 font-medium">משמרת מקוצרת</div>
        )}
        {/* Inline reason(s) in edit mode */}
        {violating && violationReasons!.map((r, i) => (
          <div key={i} className="text-xs text-red-500 leading-tight">{r}</div>
        ))}
      </div>
    );
  }

  if (value === "") {
    return <span className="text-xs text-red-400 italic">—</span>;
  }

  const template = SHIFT_TEMPLATE_MAP[value.templateId];
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`text-xs font-medium flex items-center gap-1 ${violating ? "text-red-600" : "text-gray-700"}`}>
        {violating && (
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
        )}
        {value.employee}
        {template && (
          <span className={`font-normal ${violating ? "text-red-400" : "text-gray-400"}`}>
            — {template.shiftLabelHe}
          </span>
        )}
      </span>
      {/* Shortened 5th shift indicator */}
      {value.shortenedStart && (
        <span className="text-xs text-blue-600 font-medium pr-2.5">משמרת מקוצרת</span>
      )}
      {/* Inline reason(s) in view mode */}
      {violating && violationReasons!.map((r, i) => (
        <span key={i} className="text-xs text-red-500 leading-tight pr-2.5">{r}</span>
      ))}
    </div>
  );
}

// ─── Validation panel ─────────────────────────────────────────────────────────

/**
 * Human-readable explanation for each soft rule, shown as a second line in the
 * violation card so the manager knows exactly what constraint was missed.
 */
const SOFT_VIOLATION_DESCRIPTION: Partial<Record<ViolationCode, string>> = {
  "no-weekday-morning": "אין משמרת בוקר בין ראשון לחמישי",
  "no-free-weekend":    "אין סוף שבוע פנוי (שישי + שבת)",
};

type ValidationPanelProps = {
  hardCount: number;
  softCount: number;
  violations: ScheduleViolation[];
};

function ValidationPanel({ hardCount, softCount, violations }: ValidationPanelProps) {
  if (hardCount + softCount === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700 font-medium">
        <span>✓</span>
        <span>הסידור תקין — אין הפרות כללים</span>
      </div>
    );
  }

  const hardViolations = violations.filter((v) => v.severity === "hard");
  const softViolations = violations.filter((v) => v.severity === "soft");

  function renderViolation(v: ScheduleViolation, key: number) {
    const isHard = v.severity === "hard";
    const base = isHard
      ? { bg: "bg-red-50 border-red-300",    label: "text-red-700",    sub: "text-red-500",    emp: "text-red-600"    }
      : { bg: "bg-amber-50 border-amber-300", label: "text-amber-800",  sub: "text-amber-700",  emp: "text-amber-800"  };

    const locationParts = v.affectedSlots.map(
      (s) => `${formatDateShort(s.date)} ${s.period === "morning" ? "בוקר" : "ערב"}`
    );
    const location = v.ruleCode === "back-to-back"
      ? locationParts.join(" ← ")
      : locationParts.join(", ");

    const softDesc = !isHard ? SOFT_VIOLATION_DESCRIPTION[v.ruleCode] : undefined;

    return (
      <div key={key} className={`border rounded-lg px-3 py-2 text-xs ${base.bg}`}>
        {/* Row 1: rule label (left) + employee name (right) */}
        <div className="flex items-center justify-between gap-2">
          <span className={`font-bold ${base.label}`}>
            {isHard ? "✗" : "!"} {VIOLATION_LABEL[v.ruleCode]}
          </span>
          <span className={`font-semibold shrink-0 ${base.emp}`}>{v.employee}</span>
        </div>
        {/* Soft rules: always show explicit description prominently */}
        {softDesc && (
          <div className={`mt-1 font-medium ${base.sub}`}>{softDesc}</div>
        )}
        {/* Slot locations for hard violations */}
        {location && (
          <div className={`mt-0.5 ${base.sub}`}>{location}</div>
        )}
        {/* Fallback: soft rules with no description yet */}
        {!softDesc && !location && (
          <div className={`mt-0.5 ${base.sub}`}>
            {v.message.replace(`${v.employee} — `, "")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary badge row */}
      <div className="flex flex-wrap gap-2 text-xs font-medium">
        {hardCount > 0 && (
          <span className="px-2.5 py-1 bg-red-100 text-red-700 border border-red-200 rounded-full">
            {hardCount} הפר{hardCount === 1 ? "ה" : "ות"} קשה{hardCount !== 1 ? "ות" : ""}
          </span>
        )}
        {softCount > 0 && (
          <span className="px-2.5 py-1 bg-amber-100 text-amber-800 border border-amber-300 rounded-full font-semibold">
            {softCount} אזהר{softCount === 1 ? "ה" : "ות"} רכ{softCount === 1 ? "ה" : "ות"}
          </span>
        )}
      </div>

      {hardViolations.length > 0 && (
        <div className="space-y-1.5">
          {hardViolations.map((v, i) => renderViolation(v, i))}
        </div>
      )}

      {softViolations.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide">אזהרות — אינן חוסמות</p>
          {softViolations.map((v, i) => renderViolation(v, hardViolations.length + i))}
        </div>
      )}
    </div>
  );
}

// ─── Employee stats panel ─────────────────────────────────────────────────────

type EmployeeStatsPanelProps = {
  stats: EmployeeStats[];
  insights: Insight[];
  /** Employees who have at least one soft rule violation (no-weekday-morning / no-free-weekend). */
  softViolatingEmployees: Set<string>;
};

function EmployeeStatsPanel({ stats, insights, softViolatingEmployees }: EmployeeStatsPanelProps) {
  const active = stats.filter((s) => s.total > 0);

  return (
    <div className="space-y-4">
      {/* Stats table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800 text-white text-xs">
              <th className="text-right px-4 py-3 font-semibold">עובד</th>
              <th className="text-center px-3 py-3 font-semibold">סה״כ</th>
              <th className="text-center px-3 py-3 font-semibold">בוקר</th>
              <th className="text-center px-3 py-3 font-semibold">ערב</th>
              <th className="text-center px-3 py-3 font-semibold">שישי</th>
              <th className="text-center px-3 py-3 font-semibold">שבת</th>
              <th className="text-center px-3 py-3 font-semibold">בוקר א׳–ה׳</th>
              <th className="text-center px-3 py-3 font-semibold">עומס</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s, idx) => {
              const level = getLoadLevel(s);
              const style = LOAD_STYLE[level];
              return (
                <tr
                  key={s.name}
                  className={`border-b border-gray-100 last:border-0 transition-colors ${
                    s.total === 0
                      ? "opacity-35"
                      : idx % 2 === 0
                      ? "bg-white hover:bg-blue-50"
                      : "bg-gray-50 hover:bg-blue-50"
                  }`}
                >
                  <td className="px-4 py-3 font-medium text-gray-800 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      {s.name}
                      {softViolatingEmployees.has(s.name) && (
                        <span
                          className="text-xs font-bold text-amber-600 bg-amber-100 border border-amber-300 rounded-full w-4 h-4 flex items-center justify-center leading-none shrink-0"
                          title="הפרת כלל רך: ללא בוקר בחול או ללא סוף שבוע פנוי"
                        >!</span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-center font-bold text-gray-800 tabular-nums">{s.total}</td>
                  <td className="px-3 py-3 text-center text-gray-500 tabular-nums">{s.morning}</td>
                  <td className="px-3 py-3 text-center text-gray-500 tabular-nums">{s.evening}</td>
                  <td className="px-3 py-3 text-center text-gray-500 tabular-nums">{s.friday}</td>
                  <td className="px-3 py-3 text-center text-gray-500 tabular-nums">{s.saturday}</td>
                  <td className="px-3 py-3 text-center text-gray-500 tabular-nums">{s.weekdayMorning}</td>
                  <td className="px-3 py-3 text-center">
                    {s.total > 0 ? (
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border ${style.badge}`}>
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
                        {style.label}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Insights */}
      {insights.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">תובנות</p>
          {insights.map((ins, i) => (
            <div key={i} className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <span className="shrink-0 font-bold mt-px">!</span>
              <span>{ins.message}</span>
            </div>
          ))}
        </div>
      ) : active.length > 0 ? (
        <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          ✓ העומס מאוזן — אין המלצות לשיפור
        </div>
      ) : null}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Profile = {
  id: string;
  email: string;
  fullName: string;
  displayName: string;
  role: string;
};

export default function ManagerDashboardPage() {
  const router = useRouter();

  // ── Employees (loaded from DB, seeded from static list) ──────────────────
  const [employees, setEmployees] = useState<string[]>(ALL_EMPLOYEES);

  // ── Tab navigation ────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<"schedule" | "employees" | "shifts">("schedule");

  // ── Employee management ───────────────────────────────────────────────────
  type ManagedUser = { id: string; name: string; role: string; is_active: boolean };
  const [managedUsers, setManagedUsers]   = useState<ManagedUser[]>([]);
  const [managedLoading, setManagedLoading] = useState(false);
  const [managedError, setManagedError]   = useState<string | null>(null);
  const [togglingUser, setTogglingUser]   = useState<string | null>(null);

  // ── Publish schedule ──────────────────────────────────────────────────────
  const [publishing, setPublishing]       = useState(false);
  const [publishResult, setPublishResult] = useState<string | null>(null);

  // ── Shift-type management ─────────────────────────────────────────────────
  type ShiftTypeRow = { id: number; name: string; period: string; start_time: string; end_time: string };
  const [shiftTypeRows,        setShiftTypeRows]        = useState<ShiftTypeRow[]>([]);
  const [shiftTypesTabLoading, setShiftTypesTabLoading] = useState(false);
  const [shiftTypesTabError,   setShiftTypesTabError]   = useState<string | null>(null);
  const [editingShiftType,     setEditingShiftType]     = useState<ShiftTypeRow | null>(null);
  const [newShiftType,         setNewShiftType]         = useState<Omit<ShiftTypeRow, "id">>({ name: "", period: "morning", start_time: "", end_time: "" });
  const [addingShiftType,      setAddingShiftType]      = useState(false);
  const [shiftTypesSaving,     setShiftTypesSaving]     = useState(false);

  // ── Upcoming-week constraints overview ────────────────────────────────────
  type WeekConstraintRow = { id: string; employee_id: string; date_iso: string; constraint_type: string; note: string };
  const [weekConstraints,        setWeekConstraints]        = useState<WeekConstraintRow[]>([]);
  const [weekConstraintsLoading, setWeekConstraintsLoading] = useState(false);
  const [weekConstraintsError,   setWeekConstraintsError]   = useState<string | null>(null);

  // ── Auth / profile ─────────────────────────────────────────────────────────
  const [profile, setProfile]           = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  useEffect(() => {
    fetch("/api/profile")
      .then(async (res) => {
        if (!res.ok) { router.replace("/login"); return; }
        const json = await res.json() as Profile;
        if (json.role !== "manager") {
          router.replace("/employee/dashboard");
          return;
        }
        setProfile(json);
        fetch("/api/employees")
          .then((r) => r.ok ? r.json() : [])
          .then((names: string[]) => {
            if (names.length > 0) setEmployees(names);
          })
          .catch(() => undefined);
      })
      .catch(() => router.replace("/login"))
      .finally(() => setProfileLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
  }

  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [scheduleStartDate, setScheduleStartDate] = useState<string | null>(null);
  const [scheduleEndDate, setScheduleEndDate] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [shiftTypes, setShiftTypes] = useState<ShiftType[]>([]);
  const [shiftTypesError, setShiftTypesError] = useState<string | null>(null);
  const [shiftTypesLoading, setShiftTypesLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // ── Historical / aggregated stats ─────────────────────────────────────────
  const [generating, setGenerating]           = useState(false);
  const [generateError, setGenerateError]     = useState<string | null>(null);
  const [generateWarning, setGenerateWarning] = useState<string | null>(null);
  const [constraintInfo, setConstraintInfo]   = useState<string | null>(null);
  const [missingConstraints, setMissingConstraints] = useState<string[]>([]);
  const [generateSummary, setGenerateSummary] = useState<string | null>(null);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [loadSavedError, setLoadSavedError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [activeWeekTab, setActiveWeekTab] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  const [monthlyData,   setMonthlyData]   = useState<ExportPeriodStats | null>(null);
  const [quarterlyData, setQuarterlyData] = useState<ExportPeriodStats | null>(null);
  const [yearlyData,    setYearlyData]    = useState<ExportPeriodStats | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [histError,   setHistError]   = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/shift-types")
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) {
          setShiftTypesError(json.error ?? `HTTP ${res.status}`);
        } else {
          setShiftTypes(json);
        }
      })
      .catch((err: Error) => setShiftTypesError(err.message))
      .finally(() => setShiftTypesLoading(false));
  }, []);

  // Row shape returned by GET /api/employee-constraints?from=&to= (manager mode)
  type ConstraintRow = {
    employee_id:     string;
    date_iso:        string;
    constraint_type: string;
    note:            string;
  };

  async function generateNewSchedule() {
    console.log("[GEN] generate button clicked");
    const { start: startDate, end: endDate } = getSchedulingPeriod();
    console.log("[GEN] startDate:", startDate, "endDate:", endDate);

    setGenerateError(null);
    setGenerateWarning(null);
    setConstraintInfo(null);
    setMissingConstraints([]);
    setGenerateSummary(null);

    // ── PHASE 1: Show empty editable grid IMMEDIATELY (no network wait) ──────
    // flushSync forces React to commit these state updates to the DOM before
    // any async work begins — bypasses React 18 automatic batching.
    const baseEmployees = employees.length > 0 ? [...employees] : [...ALL_EMPLOYEES];
    const totalDays = dateDiffDays(startDate, endDate) + 1;
    console.log("[GEN] totalDays:", totalDays, "baseEmployees:", baseEmployees);
    const emptyGrid: Schedule = Array.from({ length: totalDays }, () => ({
      morning: ["", ""] as Shift,
      evening: ["", ""] as Shift,
    }));
    console.log("[GEN] empty grid created, length:", emptyGrid.length);

    flushSync(() => {
      setEmployees(baseEmployees);
      setSchedule(emptyGrid);
      setScheduleStartDate(startDate);
      setScheduleEndDate(endDate);
      setEditMode(true);
      setIsDirty(false);
      setActiveWeekTab(0);
    });
    console.log("[GEN] Phase 1 flushed — grid should be visible now");

    // ── PHASE 2: Fetch constraints and auto-fill in the background ───────────
    setGenerating(true);
    try {
      // Resolve fresh employee list
      let allActiveEmployees = baseEmployees;
      try {
        const empRes = await fetch("/api/employees");
        if (empRes.ok) {
          const freshNames = (await empRes.json()) as string[];
          console.log("[GEN] employees loaded:", freshNames);
          if (freshNames.length > 0) {
            allActiveEmployees = freshNames;
            setEmployees(freshNames);
          }
        }
      } catch { /* keep baseEmployees */ }

      // Fetch constraints — non-fatal
      let constraints: Constraint[] = [];
      try {
        const res = await fetch(`/api/employee-constraints?from=${startDate}&to=${endDate}`);
        const json = await res.json();
        if (res.ok) {
          constraints = (json as ConstraintRow[]).map((r) => ({
            employee:       r.employee_id,
            date:           r.date_iso,
            constraintType: r.constraint_type as ConstraintType,
            note:           r.note,
          }));
          console.log("[GEN] constraints loaded:", constraints.length);
        } else {
          console.log("[GEN] constraints API error:", json);
          setGenerateWarning("לא ניתן לטעון אילוצים — הסידור נוצר ללא אילוצים");
        }
      } catch (e) {
        console.log("[GEN] constraints fetch threw:", e);
        setGenerateWarning("שגיאת רשת — הסידור נוצר ללא אילוצים");
      }

      const employeesWithConstraints = new Set(constraints.map((c) => c.employee));
      setMissingConstraints(allActiveEmployees.filter((e) => !employeesWithConstraints.has(e)));
      setConstraintInfo(
        constraints.length === 0
          ? `לא נמצאו אילוצים לתקופה ${formatDateShort(startDate)}–${formatDateShort(endDate)} — כל העובדים פנויים`
          : `נטענו ${constraints.length} אילוצים מ-${employeesWithConstraints.size} עובדים`
      );

      // Auto-generate assignments
      console.log("[GEN] calling generateSchedule with", allActiveEmployees.length, "employees");
      const result = generateSchedule(buildShiftSlots(startDate, endDate), allActiveEmployees, constraints);
      const filledSlots = result.schedule.reduce((sum, e) => sum + e.assignments.length, 0);
      console.log("[GEN] generateSchedule result: filledSlots =", filledSlots, "entries =", result.schedule.length);

      const uiSchedule = engineToUISchedule(result.schedule, startDate, endDate);
      console.log("[GEN] mapped UI schedule length:", uiSchedule.length, "— calling setSchedule");
      setSchedule(uiSchedule);
      setIsDirty(false);
      const emptySlots = totalDays * 4 - filledSlots;
      setGenerateSummary(
        filledSlots === 0
          ? `הסידור ריק — ניתן למלא ידנית (${totalDays} ימים, ${allActiveEmployees.length} עובדים)`
          : emptySlots === 0
          ? `הסידור מלא — ${filledSlots} שיבוצים (${totalDays} ימים)`
          : `${filledSlots} שיבוצים אוטומטיים · ${emptySlots} חסרים להשלמה ידנית`
      );
      console.log("[GEN] done ✓");
    } catch (err) {
      console.error("[GEN] caught error:", err);
      setGenerateWarning(err instanceof Error ? err.message : "שגיאה בייצור אוטומטי — ניתן למלא ידנית");
    } finally {
      setGenerating(false);
    }
  }

  async function handleLoadSaved() {
    if (isDirty && !window.confirm("יש שינויים לא שמורים בסידור הנוכחי. לטעון בכל זאת?")) return;
    setLoadingSaved(true);
    setLoadSavedError(null);
    try {
      const { start: periodStart, end: periodEnd } = getSchedulingPeriod();
      const res = await fetch(`/api/schedule-entries?from=${periodStart}&to=${periodEnd}`);
      const json = await res.json();
      if (!res.ok) { setLoadSavedError(json.error ?? `HTTP ${res.status}`); return; }
      const dbEntries = json as { date: string; period: string; employee_id: string; shift_template_id: string }[];
      if (dbEntries.length === 0) { setLoadSavedError("לא נמצא סידור שמור לתקופה הנוכחית (20 לחודש – 19 לחודש הבא)"); return; }
      const totalDays = dateDiffDays(periodStart, periodEnd) + 1;
      const uiSched: Schedule = Array.from({ length: totalDays }, (_, i) => {
        const date = offsetDate(periodStart, i);
        const dayEntries = dbEntries.filter((e) => e.date === date);
        const toSlots = (period: "morning" | "evening"): Shift => {
          const slots = dayEntries.filter((e) => e.period === period);
          return [
            slots[0] ? { employee: slots[0].employee_id, templateId: slots[0].shift_template_id } : "",
            slots[1] ? { employee: slots[1].employee_id, templateId: slots[1].shift_template_id } : "",
          ];
        };
        return { morning: toSlots("morning"), evening: toSlots("evening") };
      });
      setSchedule(uiSched);
      setScheduleStartDate(periodStart);
      setScheduleEndDate(periodEnd);
      setEditMode(false);
      setGenerateSummary(null);
      setIsDirty(false);
    } finally {
      setLoadingSaved(false);
    }
  }

  function updateSlot(
    dayIdx: number,
    period: "morning" | "evening",
    slotIdx: 0 | 1,
    value: SlotValue
  ) {
    if (!schedule) return;
    setSchedule(
      schedule.map((day, i) => {
        if (i !== dayIdx) return day;
        const shift = [...day[period]] as Shift;
        shift[slotIdx] = value;
        return { ...day, [period]: shift };
      })
    );
    setIsDirty(true);
  }

  // ── Derived values — recalculated on every schedule state change ───────────
  const entries = schedule && scheduleStartDate
    ? uiScheduleToEntries(schedule, scheduleStartDate)
    : null;

  const stats    = schedule ? computeStats(schedule) : null;
  const missing  = schedule && scheduleStartDate && entries
    ? getMissingList(schedule, scheduleStartDate, entries, employees)
    : [];
  const coverage = entries ? validateShiftCoverage(entries) : null;

  const scheduleValidation = entries && scheduleStartDate
    ? validateSchedule(
        entries,
        employees,
        scheduleStartDate,
        scheduleEndDate ?? offsetDate(scheduleStartDate, schedule ? schedule.length - 1 : 6)
      )
    : null;

  const employeeStats   = entries ? computeEmployeeStats(entries, employees) : null;
  const employeeInsights = employeeStats ? computeInsights(employeeStats) : [];
  const softViolatingEmployees: Set<string> = scheduleValidation
    ? new Set(scheduleValidation.violations.filter((v) => v.severity === "soft").map((v) => v.employee))
    : new Set<string>();

  /**
   * Export is only allowed when:
   *   1. A schedule exists and is fully staffed (no missing slots)
   *   2. A schedule exists (export allowed even with violations or missing slots)
   */
  const canExport = schedule !== null && scheduleValidation !== null;

  function handleExport() {
    if (!schedule || !scheduleStartDate || !employeeStats || !scheduleValidation) return;
    setExporting(true);
    try {
      const periodLabel = `${formatDateShort(scheduleStartDate)} – ${formatDateShort(scheduleEndDate ?? offsetDate(scheduleStartDate, schedule.length - 1))}`;

      // Collect hard-violation slot keys for per-day status computation
      const hardSlots = new Set<string>(); // "date|period"
      for (const v of scheduleValidation.violations) {
        if (v.severity === "hard") {
          for (const s of v.affectedSlots) hardSlots.add(`${s.date}|${s.period}`);
        }
      }

      const toSlot = (v: SlotValue): ExportSlot => {
        if (v === "") return null;
        const tpl = SHIFT_TEMPLATE_MAP[v.templateId];
        return {
          employee: v.employee,
          timeRange: tpl ? `${tpl.startTime}–${tpl.endTime}` : v.templateId,
          shortenedStart: v.shortenedStart ?? false,
        };
      };

      const days: ExportDay[] = schedule.map((day, i) => {
        const date = offsetDate(scheduleStartDate, i);
        const [edy, edm, edd] = date.split("-").map(Number);
        const dow = new Date(edy, edm - 1, edd).getDay();
        const mFilled = day.morning.filter((v) => v !== "").length;
        const eFilled = day.evening.filter((v) => v !== "").length;
        let status: "תקין" | "חוסר" | "הפרה" = "תקין";
        if (mFilled < 2 || eFilled < 2) {
          status = "חוסר";
        } else if (hardSlots.has(`${date}|morning`) || hardSlots.has(`${date}|evening`)) {
          status = "הפרה";
        }
        return {
          dayName: DAYS[dow],
          date:    formatDateShort(date),
          morning: [toSlot(day.morning[0]), toSlot(day.morning[1])],
          evening: [toSlot(day.evening[0]), toSlot(day.evening[1])],
          status,
        };
      });

      const LOAD_HE: Record<LoadLevel, "קל" | "תקין" | "עמוס"> = {
        low: "קל", medium: "תקין", high: "עמוס",
      };

      const exportStats: ExportEmployeeStat[] = employeeStats
        .filter((s) => s.total > 0)
        .map((s) => ({
          name:           s.name,
          total:          s.total,
          morning:        s.morning,
          evening:        s.evening,
          friday:         s.friday,
          saturday:       s.saturday,
          weekdayMorning: s.weekdayMorning,
          loadLevel:      LOAD_HE[getLoadLevel(s)],
          hasFreeWeekend: s.friday === 0 && s.saturday === 0,
        }));

      const violations: ExportViolation[] = scheduleValidation.violations.map((v) => {
        const parts = v.affectedSlots.map(
          (s) => `${formatDateShort(s.date)} ${s.period === "morning" ? "בוקר" : "ערב"}`
        );
        return {
          severity:  v.severity === "hard" ? "קשה" : "רכה",
          ruleLabel: VIOLATION_LABEL[v.ruleCode],
          employee:  v.employee,
          location:  v.ruleCode === "back-to-back" ? parts.join(" ← ") : (parts.join(", ") || "—"),
          explanation: v.message,
        };
      });

      const input: ExportInput = {
        periodLabel,
        days,
        stats:     exportStats,
        violations,
        shortages: [],
        insights:  computeExportInsights(employeeStats),
        ...(monthlyData   ? { monthlyStats:   monthlyData   } : {}),
        ...(quarterlyData ? { quarterlyStats: quarterlyData } : {}),
        ...(yearlyData    ? { yearlyStats:    yearlyData    } : {}),
      };

      exportScheduleToExcel(input);
    } finally {
      setExporting(false);
    }
  }

  // ── Save current schedule to DB ────────────────────────────────────────────
  async function handleSave() {
    if (!entries || !scheduleStartDate) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { end: periodEnd } = getSchedulingPeriod();
      const body = {
        weekStart: scheduleStartDate,
        periodEnd,
        entries: entries
          .filter((e) => e.assignments.length > 0)
          .flatMap((e) =>
            e.assignments.map((a) => ({
              date:            e.date,
              period:          e.period,
              employeeId:      a.employeeId,
              shiftTemplateId: a.shiftTemplateId,
            }))
          ),
      };
      const res = await fetch("/api/schedule-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) { setSaveError(json.error ?? `HTTP ${res.status}`); return; }
      setIsDirty(false);
      setLastSaved(new Date().toLocaleTimeString("he-IL"));
      await loadHistoricalStats();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "שגיאה בשמירה");
    } finally {
      setSaving(false);
    }
  }

  // ── Load monthly + quarterly stats from saved entries ───────────────────────
  async function loadHistoricalStats() {
    if (!scheduleStartDate) return;
    setHistLoading(true);
    setHistError(null);
    try {
      const [y, m, d] = scheduleStartDate.split("-").map(Number);
      const refDate = new Date(y, m - 1, d);
      const month   = getMonthRange(refDate);
      const quarter = getQuarterRange(refDate);

      const year = getYearRange(refDate);

      const [mRes, qRes, yRes] = await Promise.all([
        fetch(`/api/schedule-entries?from=${month.start}&to=${month.end}`),
        fetch(`/api/schedule-entries?from=${quarter.start}&to=${quarter.end}`),
        fetch(`/api/schedule-entries?from=${year.start}&to=${year.end}`),
      ]);
      const [mJson, qJson, yJson] = await Promise.all([mRes.json(), qRes.json(), yRes.json()]);
      if (!mRes.ok) throw new Error(mJson.error ?? `HTTP ${mRes.status}`);
      if (!qRes.ok) throw new Error(qJson.error ?? `HTTP ${qRes.status}`);
      if (!yRes.ok) throw new Error(yJson.error ?? `HTTP ${yRes.status}`);

      const mEntries = savedToEntries(mJson as SavedRow[]);
      const qEntries = savedToEntries(qJson as SavedRow[]);
      const yEntries = savedToEntries(yJson as SavedRow[]);

      setMonthlyData  (buildPeriodStats(month.label,   mEntries, "week",  employees));
      setQuarterlyData(buildPeriodStats(quarter.label, qEntries, "month", employees));
      setYearlyData   (buildPeriodStats(year.label,    yEntries, "month", employees));
    } catch (err) {
      setHistError(err instanceof Error ? err.message : "שגיאה בטעינת נתונים היסטוריים");
    } finally {
      setHistLoading(false);
    }
  }

  /**
   * Returns the short reason strings for a specific slot, or [] if none.
   * Used to pass `violationReasons` into each SlotCell.
   */
  function getSlotViolations(
    date: string,
    period: "morning" | "evening",
    slot: SlotValue
  ): string[] {
    if (!scheduleValidation || slot === "") return [];
    return (
      scheduleValidation.violatingSlotReasons.get(`${date}|${period}|${slot.employee}`) ?? []
    );
  }

  async function loadManagedUsers() {
    setManagedLoading(true);
    setManagedError(null);
    try {
      const res = await fetch("/api/manage-employees");
      const json = await res.json();
      if (!res.ok) { setManagedError(json.error ?? `HTTP ${res.status}`); return; }
      setManagedUsers(json as ManagedUser[]);
    } catch (err) {
      setManagedError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setManagedLoading(false);
    }
  }

  async function handleToggleActive(userId: string, currentActive: boolean) {
    setTogglingUser(userId);
    setManagedError(null);
    try {
      const res = await fetch("/api/manage-employees", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: userId, is_active: !currentActive }),
      });
      const json = await res.json();
      if (!res.ok) { setManagedError(json.error ?? `HTTP ${res.status}`); return; }
      setManagedUsers((prev) =>
        prev.map((u) => u.id === userId ? { ...u, is_active: !currentActive } : u)
      );
      fetch("/api/employees").then((r) => r.ok ? r.json() : []).then((names: string[]) => { if (names.length > 0) setEmployees(names); }).catch(() => undefined);
    } finally {
      setTogglingUser(null);
    }
  }

  async function handleChangeRole(userId: string, newRole: string) {
    setTogglingUser(userId);
    setManagedError(null);
    try {
      const res = await fetch("/api/manage-employees", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: userId, role: newRole }),
      });
      const json = await res.json();
      if (!res.ok) { setManagedError(json.error ?? `HTTP ${res.status}`); return; }
      setManagedUsers((prev) =>
        prev.map((u) => u.id === userId ? { ...u, role: newRole } : u)
      );
    } finally {
      setTogglingUser(null);
    }
  }

  async function handlePublish() {
    if (!scheduleStartDate) return;
    setPublishing(true);
    setPublishResult(null);
    try {
      const res = await fetch("/api/publish-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week_start: scheduleStartDate }),
      });
      const json = await res.json() as { ok: boolean; emailsSent?: number; emailError?: string; error?: string };
      if (!res.ok) {
        setPublishResult(`שגיאה: ${json.error ?? res.status}`);
        return;
      }
      const emailNote = json.emailsSent
        ? ` · נשלחו ${json.emailsSent} התראות במייל`
        : json.emailError
        ? ` · שגיאה בשליחת מיילים: ${json.emailError}`
        : "";
      setPublishResult(`הסידור לשבוע ${formatDateShort(scheduleStartDate)} פורסם — העובדים יראו אותו מעכשיו${emailNote}`);
    } catch (err) {
      setPublishResult(err instanceof Error ? err.message : "שגיאה בפרסום");
    } finally {
      setPublishing(false);
    }
  }

  async function loadShiftTypeRows() {
    setShiftTypesTabLoading(true);
    setShiftTypesTabError(null);
    try {
      const res  = await fetch("/api/shift-types");
      const json = await res.json();
      if (!res.ok) { setShiftTypesTabError(json.error ?? `HTTP ${res.status}`); return; }
      setShiftTypeRows(json as ShiftTypeRow[]);
    } catch (err) {
      setShiftTypesTabError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setShiftTypesTabLoading(false);
    }
  }

  async function handleSaveShiftType(row: ShiftTypeRow) {
    setShiftTypesSaving(true);
    try {
      const res = await fetch("/api/shift-types", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
      });
      if (res.ok) {
        setShiftTypeRows((prev) => prev.map((r) => r.id === row.id ? row : r));
        setEditingShiftType(null);
      } else {
        const j = await res.json();
        setShiftTypesTabError(j.error ?? "שגיאה בעדכון");
      }
    } finally {
      setShiftTypesSaving(false);
    }
  }

  async function handleAddShiftType() {
    setShiftTypesSaving(true);
    try {
      const res = await fetch("/api/shift-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newShiftType),
      });
      const j = await res.json();
      if (res.ok) {
        setShiftTypeRows((prev) => [...prev, j as ShiftTypeRow]);
        setNewShiftType({ name: "", period: "morning", start_time: "", end_time: "" });
        setAddingShiftType(false);
      } else {
        setShiftTypesTabError(j.error ?? "שגיאה בהוספה");
      }
    } finally {
      setShiftTypesSaving(false);
    }
  }

  async function handleDeleteShiftType(id: number) {
    if (!window.confirm("למחוק את סוג המשמרת הזה?")) return;
    const res = await fetch(`/api/shift-types?id=${id}`, { method: "DELETE" });
    if (res.ok) {
      setShiftTypeRows((prev) => prev.filter((r) => r.id !== id));
    } else {
      const j = await res.json();
      setShiftTypesTabError(j.error ?? "שגיאה במחיקה");
    }
  }

  async function loadWeekConstraints() {
    const { start: wStart, end: wEnd } = getSchedulingPeriod();
    setWeekConstraintsLoading(true);
    setWeekConstraintsError(null);
    try {
      const res  = await fetch(`/api/employee-constraints?from=${wStart}&to=${wEnd}`);
      const json = await res.json();
      if (!res.ok) { setWeekConstraintsError(json.error ?? `HTTP ${res.status}`); return; }
      const rows = json as WeekConstraintRow[];
      setWeekConstraints(rows);
      // Merge constraint submitters into employee list — always prefer DB names over static fallback
      if (rows.length > 0) {
        const names = Array.from(new Set(rows.map((r) => r.employee_id)))
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b, "he"));
        if (names.length > 0) {
          setEmployees((prev) => {
            // Merge: union of API names and constraint names, removing static-only placeholders
            const merged = Array.from(new Set([...prev, ...names]))
              .sort((a, b) => a.localeCompare(b, "he"));
            return merged;
          });
        }
      }
    } catch (err) {
      setWeekConstraintsError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setWeekConstraintsLoading(false);
    }
  }

  // Load constraints as soon as the manager profile is confirmed
  useEffect(() => {
    if (profile) void loadWeekConstraints();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  // Refresh employee list every 60 s so new registrations appear without a page reload
  useEffect(() => {
    if (!profile) return;
    const id = setInterval(() => {
      fetch("/api/employees").then((r) => r.ok ? r.json() : null).then((names: string[] | null) => {
        if (names && names.length > 0) setEmployees(names);
      }).catch(() => undefined);
    }, 60_000);
    return () => clearInterval(id);
  }, [profile]);

  // Warn before closing/refreshing with unsaved edits
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (isDirty) e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  if (profileLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500 text-sm">טוען...</div>
      </div>
    );
  }

  return (
    <div dir="rtl" className="min-h-screen bg-gray-50 flex flex-col items-center py-12 px-4">
      <div className="w-full max-w-5xl space-y-8">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-800">אזור מנהל</h1>
            <p className="text-gray-500 mt-1">ניהול סידור עבודה</p>
          </div>
          {profile && (
            <div className="flex items-center gap-3 mt-1">
              <div className="text-right">
                <p className="text-sm font-semibold text-gray-700">{profile.fullName}</p>
                <p className="text-xs text-gray-400">{profile.email}</p>
              </div>
              <button
                onClick={handleLogout}
                className="text-sm text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded-lg px-3 py-1.5 transition-colors"
              >
                יציאה
              </button>
            </div>
          )}
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setActiveTab("schedule")}
            className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "schedule"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            סידור עבודה
          </button>
          <button
            onClick={() => {
              setActiveTab("employees");
              if (managedUsers.length === 0) void loadManagedUsers();
            }}
            className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "employees"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            ניהול עובדים
          </button>
          <button
            onClick={() => {
              setActiveTab("shifts");
              if (shiftTypeRows.length === 0) void loadShiftTypeRows();
            }}
            className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "shifts"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            סוגי משמרות
          </button>
        </div>

        {activeTab === "schedule" && (<>
        {/* Actions */}
        <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-xl font-semibold text-gray-700">פעולות</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                רצף מומלץ: <span className="font-medium text-blue-700">① צור</span> → <span className="font-medium text-yellow-700">② ערוך</span> → <span className="font-medium text-purple-700">③ שמור</span> → <span className="font-medium text-emerald-700">④ פרסם</span>
              </p>
            </div>
            {/* Employee count badge */}
            <div className="flex items-center gap-2">
              <span className={`text-xs font-medium px-3 py-1.5 rounded-full border ${
                employees.length > 0
                  ? "bg-green-50 text-green-700 border-green-200"
                  : "bg-red-50 text-red-700 border-red-200"
              }`}>
                {employees.length > 0 ? `✓ ${employees.length} עובדים טעונים` : "⚠ אין עובדים טעונים"}
              </span>
              <button
                onClick={() => {
                  fetch("/api/employees")
                    .then((r) => r.ok ? r.json() : [])
                    .then((names: string[]) => { if (names.length > 0) setEmployees(names); })
                    .catch(() => undefined);
                }}
                className="text-xs text-gray-500 hover:text-blue-600 border border-gray-200 hover:border-blue-300 rounded-lg px-2 py-1 transition-colors"
              >
                טען מחדש
              </button>
            </div>
          </div>
          {employees.length === 0 && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              <p className="font-semibold">לא נמצאו עובדים — הסידור לא יוכל להיווצר אוטומטית.</p>
              <p className="mt-1">ודאי שהעובדים נרשמו למערכת ושהרצת את ה-SQL migration ב-Supabase.</p>
            </div>
          )}
          {generateError && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              {generateError}
            </div>
          )}
          {generateWarning && (
            <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              ⚠ {generateWarning}
            </div>
          )}
          {constraintInfo && !generateError && (
            <div className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
              {constraintInfo}
            </div>
          )}
          {missingConstraints.length > 0 && !generateError && (
            <div className="text-sm text-amber-800 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3">
              <p className="font-semibold mb-1">⚠️ לא הגישו אילוצים לתקופה הנוכחית ({missingConstraints.length} עובדים):</p>
              <p>{missingConstraints.join(" · ")}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              onClick={generateNewSchedule}
              disabled={generating}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
            >
              {generating ? "ממלא אוטומטית..." : "צור סידור עבודה"}
            </button>
            <button
              onClick={handleLoadSaved}
              disabled={loadingSaved}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
            >
              {loadingSaved ? "טוען..." : "טען סידור שמור"}
            </button>
            <button
              onClick={() => schedule && setEditMode((v) => !v)}
              disabled={!schedule}
              className={`px-5 py-2 font-medium rounded-lg transition-colors text-white ${
                !schedule
                  ? "bg-gray-300 cursor-not-allowed"
                  : editMode
                  ? "bg-yellow-500 hover:bg-yellow-600"
                  : "bg-gray-600 hover:bg-gray-700"
              }`}
            >
              {editMode ? "סיים עריכה" : "ערוך סידור"}
            </button>
            <button
              onClick={handleExport}
              disabled={!canExport || exporting}
              className={`px-5 py-2 font-medium rounded-lg transition-colors ${
                canExport
                  ? "bg-green-600 hover:bg-green-700 text-white"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
              }`}
            >
              {exporting ? "מייצא..." : "ייצא לאקסל"}
            </button>
            <button
              onClick={handleSave}
              disabled={!schedule || saving}
              className={`px-5 py-2 font-medium rounded-lg transition-colors ${
                schedule
                  ? "bg-purple-600 hover:bg-purple-700 text-white"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
              }`}
            >
              {saving ? "שומר..." : "שמור סידור"}
            </button>
            <button
              onClick={handlePublish}
              disabled={!schedule || publishing}
              className={`px-5 py-2 font-medium rounded-lg transition-colors ${
                schedule
                  ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
              }`}
            >
              {publishing ? "מפרסם..." : "פרסם סידור"}
            </button>
          </div>

          {/* Save status */}
          {lastSaved && !saveError && (
            <p className="text-sm text-purple-700 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">
              ✓ הסידור נשמר בהצלחה בשעה {lastSaved}
            </p>
          )}
          {saveError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              שגיאה בשמירה: {saveError}
            </p>
          )}
          {publishResult && (
            <p className={`text-sm rounded-lg px-3 py-2 border ${
              publishResult.startsWith("שגיאה")
                ? "text-red-700 bg-red-50 border-red-200"
                : "text-emerald-700 bg-emerald-50 border-emerald-200"
            }`}>
              {publishResult.startsWith("שגיאה") ? "" : "✓ "}{publishResult}
            </p>
          )}
          {generateSummary && !generateError && (
            <p className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
              {generateSummary}
            </p>
          )}
          {loadSavedError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {loadSavedError}
            </p>
          )}

          {editMode && (
            <p className="text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
              מצב עריכה פעיל — שנה עובדים ומשמרות בעזרת התפריטים בטבלה. בדיקת תקינות מתעדכנת בזמן אמת.
            </p>
          )}
          {isDirty && (
            <div className="flex items-center justify-between gap-3 text-sm text-orange-700 bg-orange-50 border border-orange-300 rounded-lg px-3 py-2">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0 animate-pulse" />
                יש שינויים לא שמורים — לחץ "שמור סידור" כדי לשמור
              </span>
              <button
                onClick={handleLoadSaved}
                disabled={loadingSaved}
                className="shrink-0 text-xs font-medium text-orange-800 underline hover:text-orange-900 disabled:opacity-50"
              >
                שחזר לאחרון שמור
              </button>
            </div>
          )}
          {schedule && stats && (stats.missingShifts > 0 || (scheduleValidation && scheduleValidation.hardCount > 0)) && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              הסידור מכיל בעיות — הקובץ יכלול את כל החוסרים וההפרות
            </p>
          )}
        </section>

        {/* Constraints Overview */}
        {(() => {
          const { start: cStart, end: cEnd } = getSchedulingPeriod();
          return (
        <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h2 className="text-xl font-semibold text-gray-700">אילוצי עובדים לתקופה הקרובה</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {formatDateShort(cStart)} – {formatDateShort(cEnd)}
              </p>
            </div>
            <button
              onClick={() => void loadWeekConstraints()}
              disabled={weekConstraintsLoading}
              className="px-4 py-1.5 text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-300 rounded-lg transition-colors"
            >
              {weekConstraintsLoading ? "טוען..." : "רענן"}
            </button>
          </div>

          {weekConstraintsError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {weekConstraintsError}
            </p>
          )}

          {weekConstraintsLoading && weekConstraints.length === 0 ? (
            <p className="text-gray-400 text-sm">טוען אילוצים...</p>
          ) : weekConstraints.length === 0 ? (
            <div className="text-sm text-gray-400 bg-gray-50 border border-gray-200 rounded-xl px-4 py-6 text-center">
              לא הוגשו אילוצים לתקופה הקרובה — כל העובדים פנויים
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">
                {weekConstraints.length} אילוצים מ-{Array.from(new Set(weekConstraints.map((c) => c.employee_id))).length} עובדים
              </p>
              <div className="space-y-3">
                {Array.from(new Set(weekConstraints.map((c) => c.employee_id))).sort().map((emp) => {
                  const empConstraints = weekConstraints
                    .filter((x) => x.employee_id === emp)
                    .sort((a, b) => a.date_iso.localeCompare(b.date_iso));
                  return (
                    <div key={emp} className="rounded-xl border border-gray-200 overflow-hidden">
                      <div className="bg-gray-100 px-4 py-2 font-medium text-gray-800 text-sm border-b border-gray-200">
                        {emp} <span className="text-xs font-normal text-gray-500">({empConstraints.length} אילוצים)</span>
                      </div>
                      <div className="p-3 flex flex-wrap gap-2">
                        {empConstraints.map((c) => {
                          const [cy, cm, cd] = c.date_iso.split("-").map(Number);
                          const dow = new Date(cy, cm - 1, cd).getDay();
                          const isAllDay  = c.constraint_type === "all-day";
                          const isMorning = c.constraint_type.startsWith("morning");
                          const badgeCls  = isAllDay  ? "bg-red-100 text-red-700 border-red-200"
                                          : isMorning ? "bg-amber-100 text-amber-700 border-amber-200"
                                          :             "bg-indigo-100 text-indigo-700 border-indigo-200";
                          const label = isAllDay ? "כל היום" : isMorning ? "בוקר" : "ערב";
                          return (
                            <div key={c.date_iso} className={`inline-flex flex-col items-center px-2 py-1 rounded border text-xs ${badgeCls}`}>
                              <span className="font-semibold">{DAYS[dow]} {formatDateShort(c.date_iso)}</span>
                              <span>{label}</span>
                              {c.note && <span className="text-gray-600 font-normal">{c.note}</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
          );
        })()}

        {/* Status Cards */}
        <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
          <h2 className="text-xl font-semibold text-gray-700">סטטוס משמרות</h2>
          {stats ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "משמרות בוקר מאוישות", value: stats.morningFull },
                { label: "משמרות ערב מאוישות",  value: stats.eveningFull },
                { label: "משמרות חסרות",         value: stats.missingShifts },
                { label: "עובדים פעילים",         value: stats.activeWorkers },
              ].map((card, i) => (
                <div key={i} className="bg-gray-50 border border-gray-200 rounded-xl px-5 py-4 flex flex-col gap-1">
                  <span className={`text-2xl font-bold ${i === 2 && stats.missingShifts > 0 ? "text-red-500" : "text-blue-600"}`}>
                    {card.value}
                  </span>
                  <span className="text-sm text-gray-600">{card.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-400 text-sm">לחץ על "צור סידור עבודה" כדי לטעון נתונים</p>
          )}
        </section>

        {/* Monthly Schedule — 4 weekly tabs */}
        {schedule && scheduleStartDate && (() => {
          const totalDays = schedule.length;
          const weekChunks = [
            { start: 0,  end: Math.min(7,  totalDays) },
            { start: 7,  end: Math.min(14, totalDays) },
            { start: 14, end: Math.min(21, totalDays) },
            { start: 21, end: totalDays },
          ].filter((c) => c.start < totalDays);

          const safeTab = Math.min(activeWeekTab, weekChunks.length - 1);
          const { start: tabStart, end: tabEnd } = weekChunks[safeTab];
          const tabSchedule = schedule.slice(tabStart, tabEnd);

          const tabLabel = (c: { start: number; end: number }) => {
            const from = formatDateShort(offsetDate(scheduleStartDate, c.start));
            const to   = formatDateShort(offsetDate(scheduleStartDate, c.end - 1));
            return `${from} – ${to}`;
          };

          return (
            <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="text-xl font-semibold text-gray-700">סידור עבודה חודשי</h2>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-400">
                    {formatDateShort(scheduleStartDate)} – {formatDateShort(scheduleEndDate ?? offsetDate(scheduleStartDate, totalDays - 1))}
                  </span>
                  {coverage && (
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${
                      coverage.valid
                        ? "bg-green-50 border-green-200 text-green-700"
                        : "bg-red-50 border-red-200 text-red-600"
                    }`}>
                      {coverage.valid
                        ? "✓ כל המעברים תקינים"
                        : `✗ ${coverage.days.filter((d) => !d.valid).length} ימים עם בעיית מעבר`}
                    </span>
                  )}
                </div>
              </div>

              {/* Week tabs */}
              <div className="flex gap-1 border-b border-gray-200 pb-0">
                {weekChunks.map((chunk, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveWeekTab(i)}
                    className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                      safeTab === i
                        ? "border-blue-500 text-blue-600 bg-blue-50"
                        : "border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    שבוע {i + 1}
                    <span className="block text-xs font-normal text-gray-400">{tabLabel(chunk)}</span>
                  </button>
                ))}
              </div>

              <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="w-full border-collapse min-w-[700px]">
                  <thead>
                    <tr>
                      <th className="w-14 bg-gray-800 text-white text-xs font-semibold px-2 py-3 text-center border-l border-gray-600">
                        משמרת
                      </th>
                      {tabSchedule.map((_, di) => {
                        const date = offsetDate(scheduleStartDate, tabStart + di);
                        const [dy, dm, dd] = date.split("-").map(Number);
                        const dow = new Date(dy, dm - 1, dd).getDay();
                        const isFri = dow === 5;
                        const isSat = dow === 6;
                        return (
                          <th
                            key={di}
                            className={`text-white text-xs font-semibold px-2 py-3 text-center border-l border-gray-600 ${
                              isSat ? "bg-gray-600" : isFri ? "bg-gray-700" : "bg-gray-800"
                            }`}
                          >
                            <div>{DAYS[dow]}</div>
                            <div className="font-normal text-gray-300 mt-0.5">{formatDateShort(date)}</div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {(["morning", "evening"] as const).map((period) => (
                      <tr key={period} className="border-b-2 border-gray-200">
                        <td className={`text-white text-xs font-bold text-center px-2 py-3 ${
                          period === "morning" ? "bg-sky-600" : "bg-indigo-600"
                        }`}>
                          {period === "morning" ? "בוקר" : "ערב"}
                        </td>
                        {tabSchedule.map((day, di) => {
                          const absIdx = tabStart + di;
                          const date = offsetDate(scheduleStartDate, absIdx);
                          const slots = day[period];
                          const filled = slots.filter(slotFilled).length;
                          return (
                            <td
                              key={di}
                              className={`px-2 py-2 border-l border-gray-100 align-top ${shiftBg(filled)}`}
                            >
                              <div className="space-y-1.5 min-h-[52px]">
                                <SlotCell
                                  value={slots[0]}
                                  period={period}
                                  editMode={editMode}
                                  excludeEmployee={slots[1] !== "" ? slots[1].employee : undefined}
                                  employeeList={employees}
                                  violationReasons={getSlotViolations(date, period, slots[0])}
                                  onChange={(v) => updateSlot(absIdx, period, 0, v)}
                                />
                                <SlotCell
                                  value={slots[1]}
                                  period={period}
                                  editMode={editMode}
                                  excludeEmployee={slots[0] !== "" ? slots[0].employee : undefined}
                                  employeeList={employees}
                                  violationReasons={getSlotViolations(date, period, slots[1])}
                                  onChange={(v) => updateSlot(absIdx, period, 1, v)}
                                />
                                {filled < 2 && (
                                  <div className="text-xs text-red-500 font-semibold pt-0.5">
                                    {filled === 0 ? "חסרים 2" : "חסר 1"}
                                  </div>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {coverage && (
                      <tr className="bg-gray-50">
                        <td className="text-xs font-bold text-gray-500 text-center px-2 py-2 bg-gray-100">
                          מעבר
                        </td>
                        {tabSchedule.map((_, di) => {
                          const date = offsetDate(scheduleStartDate, tabStart + di);
                          const covDay = coverage.days.find((d) => d.date === date);
                          return (
                            <td key={di} className="border-l border-gray-100 px-2 py-2 text-center">
                              {covDay && (
                                covDay.valid
                                  ? <span className="text-xs text-green-600 font-medium">✓</span>
                                  : <span className="text-xs text-red-500 font-medium">{covDay.missingCoverage.join(", ")}</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })()}

        {/* Live Rule Validation */}
        {scheduleValidation && (
          <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-xl font-semibold text-gray-700">בדיקת תקינות</h2>
              {scheduleValidation.valid ? (
                <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-green-50 border border-green-200 text-green-700">
                  ✓ תקין
                </span>
              ) : (
                <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-red-50 border border-red-200 text-red-600">
                  {scheduleValidation.hardCount + scheduleValidation.softCount} בעיות
                </span>
              )}
            </div>
            <ValidationPanel
              hardCount={scheduleValidation.hardCount}
              softCount={scheduleValidation.softCount}
              violations={scheduleValidation.violations}
            />
          </section>
        )}

        {/* Employee Statistics */}
        {employeeStats && (
          <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
            <h2 className="text-xl font-semibold text-gray-700">נתוני עובדים</h2>
            <EmployeeStatsPanel stats={employeeStats} insights={employeeInsights} softViolatingEmployees={softViolatingEmployees} />
          </section>
        )}

        {/* Historical Statistics */}
        {schedule && (
          <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h2 className="text-xl font-semibold text-gray-700">נתונים היסטוריים</h2>
                <p className="text-xs text-gray-400 mt-0.5">מבוסס על סידורים ששמרת — לחץ על "שמור סידור" בתום כל שבוע</p>
              </div>
              <button
                onClick={loadHistoricalStats}
                disabled={histLoading}
                className="px-4 py-1.5 text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-300 rounded-lg transition-colors"
              >
                {histLoading ? "טוען..." : "רענן נתונים"}
              </button>
            </div>

            {histError && (
              <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                שגיאה: {histError}
              </p>
            )}

            {[
              { data: monthlyData,   accent: "purple", title: "חודשי" },
              { data: quarterlyData, accent: "indigo", title: "רבעוני" },
              { data: yearlyData,    accent: "slate",  title: "שנתי"   },
            ].map(({ data, accent, title }) =>
              data && data.rows.length > 0 ? (
                <div key={title} className="space-y-2">
                  <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
                    {title} — {data.label}
                  </h3>
                  <p className="text-xs text-gray-400 mb-1">
                    עמודות התת-תקופות (שבועות / חודשים) מציגות מספר משמרות. עמד מעל כותרת עמודה לקבלת הסבר מלא.
                  </p>
                  <div className="overflow-x-auto rounded-xl border border-gray-200">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className={`bg-${accent}-700 text-white text-xs`}>
                          <th className="text-right px-4 py-2.5 font-semibold whitespace-nowrap">עובד</th>
                          {data.subLabels.map((lbl) => (
                            <th key={lbl} title="מספר משמרות בתת-תקופה זו" className="text-center px-3 py-2.5 font-semibold whitespace-nowrap cursor-help">{lbl}</th>
                          ))}
                          <th title="סך כל המשמרות בתקופה" className="text-center px-3 py-2.5 font-semibold cursor-help">סה״כ</th>
                          <th title="מספר משמרות בוקר (07:00–19:00 או 08:00–20:00)" className="text-center px-3 py-2.5 font-semibold cursor-help">בוקר</th>
                          <th title="מספר משמרות ערב (19:00–07:00 או 20:00–08:00)" className="text-center px-3 py-2.5 font-semibold cursor-help">ערב</th>
                          <th title="מספר משמרות בימי שישי" className="text-center px-3 py-2.5 font-semibold cursor-help">שישי</th>
                          <th title="מספר משמרות בימי שבת" className="text-center px-3 py-2.5 font-semibold cursor-help">שבת</th>
                          <th title="ממוצע משמרות לשבוע בתקופה זו" className="text-center px-3 py-2.5 font-semibold whitespace-nowrap cursor-help">ממוצע/שבוע</th>
                          <th title="רמת עומס: עמוס = 5+ משמרות | תקין = 3–4 | קל = 0–2" className="text-center px-3 py-2.5 font-semibold cursor-help">עומס</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((s, idx) => {
                          const maxSub = Math.max(...s.subCounts, 0);
                          const avg = data.avgDivisor > 0 ? (s.total / data.avgDivisor).toFixed(1) : "—";
                          return (
                            <tr key={s.name} className={`border-b border-gray-100 last:border-0 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50"} hover:bg-${accent}-50 transition-colors`}>
                              <td className="px-4 py-2.5 font-medium text-gray-800 whitespace-nowrap">{s.name}</td>
                              {s.subCounts.map((n, ci) => (
                                <td key={ci} className={`px-3 py-2.5 text-center tabular-nums font-medium ${n === maxSub && n > 0 ? "text-blue-700" : "text-gray-500"}`}>{n}</td>
                              ))}
                              <td className="px-3 py-2.5 text-center font-bold tabular-nums text-gray-800">{s.total}</td>
                              <td className="px-3 py-2.5 text-center tabular-nums text-gray-500">{s.morning}</td>
                              <td className="px-3 py-2.5 text-center tabular-nums text-gray-500">{s.evening}</td>
                              <td className="px-3 py-2.5 text-center tabular-nums text-gray-500">{s.friday}</td>
                              <td className="px-3 py-2.5 text-center tabular-nums text-gray-500">{s.saturday}</td>
                              <td className="px-3 py-2.5 text-center tabular-nums text-gray-500">{avg}</td>
                              <td className="px-3 py-2.5 text-center">
                                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                                  s.loadLevel === "עמוס" ? "bg-red-100 text-red-700 border-red-200" :
                                  s.loadLevel === "תקין" ? "bg-blue-100 text-blue-700 border-blue-200" :
                                  "bg-green-100 text-green-700 border-green-200"
                                }`}>{s.loadLevel}</span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex gap-4 mt-2 text-xs text-gray-400">
                    <span><span className="inline-block w-2 h-2 rounded-full bg-red-400 mr-1" />עמוס — 5+ משמרות בשבוע</span>
                    <span><span className="inline-block w-2 h-2 rounded-full bg-blue-400 mr-1" />תקין — 3–4 משמרות בשבוע</span>
                    <span><span className="inline-block w-2 h-2 rounded-full bg-green-400 mr-1" />קל — 0–2 משמרות בשבוע</span>
                  </div>
                </div>
              ) : null
            )}

            {!histLoading && !histError && !monthlyData && !quarterlyData && !yearlyData && (
              <p className="text-sm text-gray-400">
                אין נתונים שמורים עדיין. לחץ "שמור סידור" בתום כל שבוע כדי לצבור היסטוריה.
              </p>
            )}
          </section>
        )}

        {/* Shift Types from Supabase */}
        <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
          <h2 className="text-xl font-semibold text-gray-700">סוגי משמרות מהמערכת</h2>
          {shiftTypesLoading ? (
            <p className="text-gray-400 text-sm">טוען...</p>
          ) : shiftTypesError ? (
            <p className="text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm font-medium">
              שגיאה בטעינת סוגי משמרות: {shiftTypesError}
            </p>
          ) : shiftTypes.length === 0 ? (
            <p className="text-gray-400 text-sm">לא נמצאו סוגי משמרות</p>
          ) : (
            <div className="rounded-xl overflow-hidden border border-gray-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-800 text-white text-xs">
                    <th className="text-right px-4 py-3 font-semibold">שם</th>
                    <th className="text-center px-3 py-3 font-semibold">תקופה</th>
                    <th className="text-center px-3 py-3 font-semibold">התחלה</th>
                    <th className="text-center px-3 py-3 font-semibold">סיום</th>
                  </tr>
                </thead>
                <tbody>
                  {shiftTypes.map((st, idx) => (
                    <tr
                      key={st.id}
                      className={`border-b border-gray-100 last:border-0 ${
                        idx % 2 === 0 ? "bg-white" : "bg-gray-50"
                      } hover:bg-blue-50 transition-colors`}
                    >
                      <td className="px-4 py-3 font-semibold text-gray-800">{st.name}</td>
                      <td className="px-3 py-3 text-center">
                        <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                          st.period === "morning"
                            ? "bg-sky-100 text-sky-700"
                            : "bg-indigo-100 text-indigo-700"
                        }`}>
                          {st.period === "morning" ? "בוקר" : "ערב"}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center font-mono text-gray-600">{st.start_time}</td>
                      <td className="px-3 py-3 text-center font-mono text-gray-600">{st.end_time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Missing Shifts */}
        <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
          <h2 className="text-xl font-semibold text-gray-700">חוסרים</h2>
          {missing.length === 0 ? (
            <p className="text-gray-400 text-sm">
              {schedule ? "אין חוסרים — הסידור מלא!" : "לחץ על \"צור סידור עבודה\" כדי לטעון נתונים"}
            </p>
          ) : (
            <ul className="space-y-2">
              {missing.map((item, i) => (
                <li key={i} className="flex items-center justify-between gap-3 bg-red-50 border border-red-300 text-red-700 font-medium rounded-lg px-4 py-3 text-sm">
                  <span>{item.text}</span>
                  {item.reason && (
                    <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full border ${
                      item.reason === "constraints"
                        ? "bg-blue-50 text-blue-700 border-blue-200"
                        : "bg-orange-50 text-orange-700 border-orange-200"
                    }`}>
                      {SHORTAGE_REASON_LABEL[item.reason]}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        </>)}

        {activeTab === "shifts" && (
          <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h2 className="text-xl font-semibold text-gray-700">סוגי משמרות</h2>
                <p className="text-xs text-gray-400 mt-0.5">שינויים כאן משפיעים על הטבלה בלבד — לא על מחולל הסידור (שמשתמש בתבניות המוקדות)</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => void loadShiftTypeRows()} disabled={shiftTypesTabLoading}
                  className="px-4 py-1.5 text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-300 rounded-lg transition-colors">
                  {shiftTypesTabLoading ? "טוען..." : "רענן"}
                </button>
                <button onClick={() => setAddingShiftType(true)} disabled={addingShiftType}
                  className="px-4 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
                  + הוסף משמרת
                </button>
              </div>
            </div>

            {shiftTypesTabError && (
              <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{shiftTypesTabError}</p>
            )}

            {addingShiftType && (
              <div className="border border-blue-200 bg-blue-50 rounded-xl p-4 space-y-3">
                <p className="text-sm font-semibold text-blue-800">משמרת חדשה</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <input value={newShiftType.name} onChange={(e) => setNewShiftType((p) => ({ ...p, name: e.target.value }))}
                    placeholder="שם (למשל: בוקר ראשי)"
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 col-span-2" />
                  <select value={newShiftType.period} onChange={(e) => setNewShiftType((p) => ({ ...p, period: e.target.value }))}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400">
                    <option value="morning">בוקר</option>
                    <option value="evening">ערב</option>
                  </select>
                  <input value={newShiftType.start_time} onChange={(e) => setNewShiftType((p) => ({ ...p, start_time: e.target.value }))}
                    placeholder="התחלה (07:00)" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
                  <input value={newShiftType.end_time} onChange={(e) => setNewShiftType((p) => ({ ...p, end_time: e.target.value }))}
                    placeholder="סיום (19:00)" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => void handleAddShiftType()} disabled={shiftTypesSaving || !newShiftType.name}
                    className="px-4 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded-lg transition-colors">
                    {shiftTypesSaving ? "שומר..." : "הוסף"}
                  </button>
                  <button onClick={() => setAddingShiftType(false)}
                    className="px-4 py-1.5 text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-300 rounded-lg transition-colors">
                    ביטול
                  </button>
                </div>
              </div>
            )}

            {shiftTypesTabLoading && shiftTypeRows.length === 0 ? (
              <p className="text-gray-400 text-sm">טוען...</p>
            ) : shiftTypeRows.length === 0 ? (
              <p className="text-gray-400 text-sm">לא נמצאו סוגי משמרות</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-800 text-white text-xs">
                      <th className="text-right px-4 py-3 font-semibold">שם</th>
                      <th className="text-center px-3 py-3 font-semibold">תקופה</th>
                      <th className="text-center px-3 py-3 font-semibold">התחלה</th>
                      <th className="text-center px-3 py-3 font-semibold">סיום</th>
                      <th className="text-center px-3 py-3 font-semibold">פעולות</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shiftTypeRows.map((st, idx) => (
                      <tr key={st.id} className={`border-b border-gray-100 last:border-0 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50"}`}>
                        {editingShiftType?.id === st.id ? (
                          <>
                            <td className="px-3 py-2">
                              <input value={editingShiftType.name}
                                onChange={(e) => setEditingShiftType((p) => p ? { ...p, name: e.target.value } : p)}
                                className="border border-gray-300 rounded px-2 py-1 text-xs w-full focus:outline-none focus:ring-1 focus:ring-blue-400" />
                            </td>
                            <td className="px-3 py-2 text-center">
                              <select value={editingShiftType.period}
                                onChange={(e) => setEditingShiftType((p) => p ? { ...p, period: e.target.value } : p)}
                                className="border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400">
                                <option value="morning">בוקר</option>
                                <option value="evening">ערב</option>
                              </select>
                            </td>
                            <td className="px-3 py-2 text-center">
                              <input value={editingShiftType.start_time}
                                onChange={(e) => setEditingShiftType((p) => p ? { ...p, start_time: e.target.value } : p)}
                                className="border border-gray-300 rounded px-2 py-1 text-xs w-20 text-center focus:outline-none focus:ring-1 focus:ring-blue-400" />
                            </td>
                            <td className="px-3 py-2 text-center">
                              <input value={editingShiftType.end_time}
                                onChange={(e) => setEditingShiftType((p) => p ? { ...p, end_time: e.target.value } : p)}
                                className="border border-gray-300 rounded px-2 py-1 text-xs w-20 text-center focus:outline-none focus:ring-1 focus:ring-blue-400" />
                            </td>
                            <td className="px-3 py-2 text-center">
                              <div className="flex gap-1 justify-center">
                                <button onClick={() => void handleSaveShiftType(editingShiftType)} disabled={shiftTypesSaving}
                                  className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors disabled:opacity-50">שמור</button>
                                <button onClick={() => setEditingShiftType(null)}
                                  className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-200 rounded transition-colors">ביטול</button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-4 py-3 font-semibold text-gray-800">{st.name}</td>
                            <td className="px-3 py-3 text-center">
                              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${st.period === "morning" ? "bg-sky-100 text-sky-700" : "bg-indigo-100 text-indigo-700"}`}>
                                {st.period === "morning" ? "בוקר" : "ערב"}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-center font-mono text-gray-600">{st.start_time}</td>
                            <td className="px-3 py-3 text-center font-mono text-gray-600">{st.end_time}</td>
                            <td className="px-3 py-3 text-center">
                              <div className="flex gap-1 justify-center">
                                <button onClick={() => setEditingShiftType(st)}
                                  className="px-2 py-1 text-xs bg-gray-50 hover:bg-gray-100 text-gray-700 border border-gray-200 rounded transition-colors">ערוך</button>
                                <button onClick={() => void handleDeleteShiftType(st.id)}
                                  className="px-2 py-1 text-xs bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded transition-colors">מחק</button>
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {activeTab === "employees" && (
          <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-xl font-semibold text-gray-700">ניהול עובדים</h2>
              <button
                onClick={() => void loadManagedUsers()}
                disabled={managedLoading}
                className="px-4 py-1.5 text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-300 rounded-lg transition-colors"
              >
                {managedLoading ? "טוען..." : "רענן"}
              </button>
            </div>
            {managedError && (
              <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{managedError}</p>
            )}
            {managedLoading && managedUsers.length === 0 ? (
              <p className="text-gray-400 text-sm">טוען עובדים...</p>
            ) : managedUsers.length === 0 ? (
              <p className="text-gray-400 text-sm">לא נמצאו משתמשים</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-800 text-white text-xs">
                      <th className="text-right px-4 py-3 font-semibold">שם</th>
                      <th className="text-center px-3 py-3 font-semibold">תפקיד</th>
                      <th className="text-center px-3 py-3 font-semibold">סטטוס</th>
                      <th className="text-center px-3 py-3 font-semibold">פעולות</th>
                    </tr>
                  </thead>
                  <tbody>
                    {managedUsers.map((u, idx) => (
                      <tr
                        key={u.id}
                        className={`border-b border-gray-100 last:border-0 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50"}`}
                      >
                        <td className="px-4 py-3 font-medium text-gray-800">{u.name || "—"}</td>
                        <td className="px-3 py-3 text-center">
                          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                            u.role === "manager"
                              ? "bg-purple-100 text-purple-700"
                              : "bg-blue-100 text-blue-700"
                          }`}>
                            {u.role === "manager" ? "מנהל" : "עובד"}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-center">
                          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                            u.is_active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                          }`}>
                            {u.is_active ? "פעיל" : "לא פעיל"}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-center">
                          <div className="flex gap-2 justify-center">
                            <button
                              onClick={() => void handleToggleActive(u.id, u.is_active)}
                              disabled={togglingUser === u.id}
                              className={`px-3 py-1 text-xs font-medium rounded-lg border transition-colors disabled:opacity-50 ${
                                u.is_active
                                  ? "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"
                                  : "bg-green-50 text-green-700 border-green-200 hover:bg-green-100"
                              }`}
                            >
                              {u.is_active ? "השבת" : "הפעל"}
                            </button>
                            <button
                              onClick={() => void handleChangeRole(u.id, u.role === "manager" ? "employee" : "manager")}
                              disabled={togglingUser === u.id}
                              className="px-3 py-1 text-xs font-medium rounded-lg border bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100 transition-colors disabled:opacity-50"
                            >
                              {u.role === "manager" ? "הפוך לעובד" : "הפוך למנהל"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-gray-400">
              השבתת עובד מונעת ממנו להופיע בסידורים עתידיים. שינוי תפקיד לא משפיע על ההרשאות בזמן אמת — רק לאחר כניסה מחדש.
            </p>
          </section>
        )}

      </div>
    </div>
  );
}
