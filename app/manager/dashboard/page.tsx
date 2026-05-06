"use client";

import { useState, useEffect } from "react";
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

const EMPLOYEES = ["עדן", "נועה", "שחר", "מאיה", "רון", "דניאל", "יובל", "עמית"];
const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

// ─── Date helpers ─────────────────────────────────────────────────────────────

function offsetDate(start: string, days: number): string {
  const [y, m, d] = start.split("-").map(Number);
  const result = new Date(y, m - 1, d + days);
  return `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, "0")}-${String(result.getDate()).padStart(2, "0")}`;
}

function getUpcomingWeekStart(): string {
  const today = new Date();
  const dow = today.getDay();
  const daysUntilSunday = dow === 0 ? 7 : 7 - dow;
  const sunday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysUntilSunday);
  return `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, "0")}-${String(sunday.getDate()).padStart(2, "0")}`;
}

function formatDateShort(dateStr: string): string {
  const [, month, day] = dateStr.split("-");
  return `${parseInt(day)}/${parseInt(month)}`;
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

function engineToUISchedule(entries: ScheduleEntry[], startDate: string): Schedule {
  return Array.from({ length: 7 }, (_, i) => {
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
  constraints: Constraint[]
): ShortageReason {
  const shift = entries.find((e) => e.date === date && e.period === period);
  const assigned = new Set(shift?.assignments.map((a) => a.employeeId) ?? []);
  const candidates = EMPLOYEES.filter((e) => !assigned.has(e));
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
  entries: ScheduleEntry[]
): MissingItem[] {
  const items: MissingItem[] = [];
  schedule.forEach((day, i) => {
    const date  = offsetDate(startDate, i);
    const label = `${DAYS[i]} ${formatDateShort(date)}`;
    const mFilled = day.morning.filter(slotFilled).length;
    const eFilled = day.evening.filter(slotFilled).length;
    if (mFilled < 2) {
      const raw = analyzeShiftShortage(date, "morning", entries, []);
      items.push({
        text:   `יום ${label} — בוקר — ${mFilled === 1 ? "חסר עובד 1" : "חסרים 2 עובדים"}`,
        reason: raw === "available" ? null : raw,
      });
    }
    if (eFilled < 2) {
      const raw = analyzeShiftShortage(date, "evening", entries, []);
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

  const allStats = computeEmployeeStats(entries, EMPLOYEES);
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
  /**
   * Short reason strings for every rule that flags this specific slot.
   * Empty array (or undefined) means no violation.
   */
  violationReasons?: string[];
  onChange: (v: SlotValue) => void;
};

function SlotCell({ value, period, editMode, excludeEmployee, violationReasons, onChange }: SlotProps) {
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
          {EMPLOYEES.filter((emp) => emp !== excludeEmployee).map((emp) => (
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
  const [editMode, setEditMode] = useState(false);
  const [shiftTypes, setShiftTypes] = useState<ShiftType[]>([]);
  const [shiftTypesError, setShiftTypesError] = useState<string | null>(null);
  const [shiftTypesLoading, setShiftTypesLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // ── Historical / aggregated stats ─────────────────────────────────────────
  const [generating, setGenerating]         = useState(false);
  const [generateError, setGenerateError]   = useState<string | null>(null);
  const [constraintInfo, setConstraintInfo] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
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
    const startDate = getUpcomingWeekStart();
    const endDate   = offsetDate(startDate, 6);

    setGenerating(true);
    setGenerateError(null);
    setConstraintInfo(null);
    try {
      const res = await fetch(
        `/api/employee-constraints?from=${startDate}&to=${endDate}`
      );
      const json = await res.json();
      if (!res.ok) {
        setGenerateError(
          `לא ניתן לטעון אילוצי עובדים — ${json.error ?? `HTTP ${res.status}`}. הסידור לא נוצר.`
        );
        return;
      }

      const constraints: Constraint[] = (json as ConstraintRow[]).map((r) => ({
        employee:       r.employee_id,
        date:           r.date_iso,
        constraintType: r.constraint_type as ConstraintType,
        note:           r.note,
      }));

      const uniqueEmployees = new Set(constraints.map((c) => c.employee)).size;
      setConstraintInfo(
        constraints.length === 0
          ? `לא נמצאו אילוצים לשבוע ${formatDateShort(startDate)}–${formatDateShort(endDate)}`
          : `נטענו ${constraints.length} אילוצים מ-${uniqueEmployees} עובדים לשבוע ${formatDateShort(startDate)}–${formatDateShort(endDate)}`
      );

      const result = generateSchedule(
        buildShiftSlots(startDate, endDate),
        EMPLOYEES,
        constraints
      );
      setSchedule(engineToUISchedule(result.schedule, startDate));
      setScheduleStartDate(startDate);
      setEditMode(false);
    } catch (err) {
      setGenerateError(
        err instanceof Error ? err.message : "שגיאה בלתי צפויה — הסידור לא נוצר"
      );
    } finally {
      setGenerating(false);
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
  }

  // ── Derived values — recalculated on every schedule state change ───────────
  const entries = schedule && scheduleStartDate
    ? uiScheduleToEntries(schedule, scheduleStartDate)
    : null;

  const stats    = schedule ? computeStats(schedule) : null;
  const missing  = schedule && scheduleStartDate && entries
    ? getMissingList(schedule, scheduleStartDate, entries)
    : [];
  const coverage = entries ? validateShiftCoverage(entries) : null;

  const scheduleValidation = entries && scheduleStartDate
    ? validateSchedule(
        entries,
        EMPLOYEES,
        scheduleStartDate,
        offsetDate(scheduleStartDate, 6)
      )
    : null;

  const employeeStats   = entries ? computeEmployeeStats(entries, EMPLOYEES) : null;
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
      const periodLabel = `${formatDateShort(scheduleStartDate)} – ${formatDateShort(offsetDate(scheduleStartDate, 6))}`;

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
        const mFilled = day.morning.filter((v) => v !== "").length;
        const eFilled = day.evening.filter((v) => v !== "").length;
        let status: "תקין" | "חוסר" | "הפרה" = "תקין";
        if (mFilled < 2 || eFilled < 2) {
          status = "חוסר";
        } else if (hardSlots.has(`${date}|morning`) || hardSlots.has(`${date}|evening`)) {
          status = "הפרה";
        }
        return {
          dayName: DAYS[i],
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
      const body = {
        weekStart: scheduleStartDate,
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

      setMonthlyData  (buildPeriodStats(month.label,   mEntries, "week"));
      setQuarterlyData(buildPeriodStats(quarter.label, qEntries, "month"));
      setYearlyData   (buildPeriodStats(year.label,    yEntries, "month"));
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

        {/* Actions */}
        <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
          <h2 className="text-xl font-semibold text-gray-700">פעולות</h2>
          {generateError && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              {generateError}
            </div>
          )}
          {constraintInfo && !generateError && (
            <div className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
              {constraintInfo}
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              onClick={generateNewSchedule}
              disabled={generating}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
            >
              {generating ? "טוען אילוצים..." : "צור סידור עבודה"}
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

          {editMode && (
            <p className="text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
              מצב עריכה פעיל — שנה עובדים ומשמרות בעזרת התפריטים בטבלה. בדיקת תקינות מתעדכנת בזמן אמת.
            </p>
          )}
          {schedule && stats && (stats.missingShifts > 0 || (scheduleValidation && scheduleValidation.hardCount > 0)) && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              הסידור מכיל בעיות — הקובץ יכלול את כל החוסרים וההפרות
            </p>
          )}
        </section>

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

        {/* Weekly Schedule */}
        {schedule && scheduleStartDate && (
          <section className="bg-white rounded-2xl shadow-md p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-xl font-semibold text-gray-700">סידור עבודה שבועי</h2>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-400">
                  {formatDateShort(scheduleStartDate)} – {formatDateShort(offsetDate(scheduleStartDate, 6))}
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

            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="w-full border-collapse min-w-[700px]">
                <thead>
                  <tr>
                    <th className="w-14 bg-gray-800 text-white text-xs font-semibold px-2 py-3 text-center border-l border-gray-600">
                      משמרת
                    </th>
                    {schedule.map((_, di) => {
                      const date = offsetDate(scheduleStartDate, di);
                      const isFri = di === 5;
                      const isSat = di === 6;
                      return (
                        <th
                          key={di}
                          className={`text-white text-xs font-semibold px-2 py-3 text-center border-l border-gray-600 ${
                            isSat ? "bg-gray-600" : isFri ? "bg-gray-700" : "bg-gray-800"
                          }`}
                        >
                          <div>{DAYS[di]}</div>
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
                      {schedule.map((day, di) => {
                        const date = offsetDate(scheduleStartDate, di);
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
                                violationReasons={getSlotViolations(date, period, slots[0])}
                                onChange={(v) => updateSlot(di, period, 0, v)}
                              />
                              <SlotCell
                                value={slots[1]}
                                period={period}
                                editMode={editMode}
                                excludeEmployee={slots[0] !== "" ? slots[0].employee : undefined}
                                violationReasons={getSlotViolations(date, period, slots[1])}
                                onChange={(v) => updateSlot(di, period, 1, v)}
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
                      {schedule.map((_, di) => {
                        const date = offsetDate(scheduleStartDate, di);
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
        )}

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
                  <div className="overflow-x-auto rounded-xl border border-gray-200">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className={`bg-${accent}-700 text-white text-xs`}>
                          <th className="text-right px-4 py-2.5 font-semibold whitespace-nowrap">עובד</th>
                          {data.subLabels.map((lbl) => (
                            <th key={lbl} className="text-center px-3 py-2.5 font-semibold whitespace-nowrap">{lbl}</th>
                          ))}
                          <th className="text-center px-3 py-2.5 font-semibold">סה״כ</th>
                          <th className="text-center px-3 py-2.5 font-semibold">בוקר</th>
                          <th className="text-center px-3 py-2.5 font-semibold">ערב</th>
                          <th className="text-center px-3 py-2.5 font-semibold">שישי</th>
                          <th className="text-center px-3 py-2.5 font-semibold">שבת</th>
                          <th className="text-center px-3 py-2.5 font-semibold whitespace-nowrap">ממוצע/שבוע</th>
                          <th className="text-center px-3 py-2.5 font-semibold">עומס</th>
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

      </div>
    </div>
  );
}
