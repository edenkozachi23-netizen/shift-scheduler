import * as XLSX from "xlsx-js-style";

// ─── Input types ──────────────────────────────────────────────────────────────

export type ExportSlot = {
  employee: string;
  timeRange: string;      // "07:00–19:00"
  shortenedStart: boolean;
} | null;

export type ExportDay = {
  dayName: string;        // "ראשון"
  date: string;           // "20/4"
  morning: [ExportSlot, ExportSlot];
  evening: [ExportSlot, ExportSlot];
  status: "תקין" | "חוסר" | "הפרה";
};

export type ExportEmployeeStat = {
  name: string;
  total: number;
  morning: number;
  evening: number;
  friday: number;
  saturday: number;
  weekdayMorning: number;
  loadLevel: "קל" | "תקין" | "עמוס";
  hasFreeWeekend: boolean;
};

/**
 * Aggregated stats for a full calendar period (month or quarter).
 * `subLabels` are column headers — weeks for monthly, months for quarterly.
 * `avgDivisor` controls the "avg shifts / week" column (13 for quarter, 4 for month).
 */
export type ExportPeriodStats = {
  label: string;
  subLabels: string[];
  avgDivisor: number;
  rows: {
    name: string;
    subCounts: number[];   // shift count per sub-period (length = subLabels.length)
    total: number;
    morning: number;
    evening: number;
    friday: number;
    saturday: number;
    loadLevel: "קל" | "תקין" | "עמוס";
  }[];
};

export type ExportViolation = {
  severity: "קשה" | "רכה";
  ruleLabel: string;
  employee: string;
  location: string;
  explanation: string;
};

export type ExportShortage = {
  dayName: string;
  date: string;
  period: "בוקר" | "ערב";
  missingCount: number;
  reason: string;
};

export type ExportInsight = {
  topic: string;
  employees: string;
};

export type ExportInput = {
  periodLabel: string;
  days: ExportDay[];
  stats: ExportEmployeeStat[];
  violations: ExportViolation[];
  shortages: ExportShortage[];
  insights: ExportInsight[];
  /** Per-week breakdown for a full calendar month (optional). */
  monthlyStats?: ExportPeriodStats;
  /** Per-month breakdown for a full calendar quarter (optional). */
  quarterlyStats?: ExportPeriodStats;
  /** Per-month breakdown for a full calendar year (optional). */
  yearlyStats?: ExportPeriodStats;
};

// ─── Color palette ────────────────────────────────────────────────────────────

const C = {
  // Structure
  NAVY:        "1E3A5F",   // sheet title
  BLUE:        "2563EB",   // column headers
  BLUE_DIM:    "1E40AF",   // section sub-header

  // Period rows
  MORNING_HD:  "0369A1",   // morning header cell
  MORNING_BG:  "E0F2FE",   // morning data cell bg
  MORNING_BG2: "BAE6FD",   // morning alt row bg (slightly deeper)
  EVENING_HD:  "4338CA",   // evening header cell
  EVENING_BG:  "EDE9FE",   // evening data cell bg
  EVENING_BG2: "DDD6FE",   // evening alt row bg

  // Status
  OK_BG:       "DCFCE7",  OK_FG:   "166534",
  WARN_BG:     "FEF9C3",  WARN_FG: "713F12",
  ERR_BG:      "FEE2E2",  ERR_FG:  "991B1B",

  // Row tints (full rows)
  ERR_ROW:     "FEF2F2",
  WARN_ROW:    "FFFBEB",
  OK_ROW:      "F0FDF4",

  // Neutral
  DAY_BG:      "F1F5F9",   // day name cell bg
  DAY_BG2:     "E2E8F0",   // day name alt row bg
  ROW_ALT:     "F8FAFC",   // subtle alternating tint for non-schedule sheets

  // Text
  TEXT:        "0F172A",
  TEXT_MID:    "475569",
  TEXT_LIGHT:  "94A3B8",
  WHITE:       "FFFFFF",

  // Borders
  BORDER:      "CBD5E1",
  BORDER_MD:   "94A3B8",
};

// ─── Style primitives ─────────────────────────────────────────────────────────

function f(bold = false, sz = 10, color = C.TEXT): Record<string, unknown> {
  return { name: "Calibri", sz, bold, color: { rgb: color } };
}

function bg(rgb: string): Record<string, unknown> {
  return { fgColor: { rgb } };
}

function a(h: "center" | "right" | "left", v: "middle" | "top" = "top", wrap = false) {
  return { horizontal: h, vertical: v, wrapText: wrap };
}

const bThin = {
  top: { style: "thin", color: { rgb: C.BORDER } },
  bottom: { style: "thin", color: { rgb: C.BORDER } },
  left: { style: "thin", color: { rgb: C.BORDER } },
  right: { style: "thin", color: { rgb: C.BORDER } },
};

const bMed = {
  top: { style: "medium", color: { rgb: C.BORDER_MD } },
  bottom: { style: "medium", color: { rgb: C.BORDER_MD } },
  left: { style: "medium", color: { rgb: C.BORDER_MD } },
  right: { style: "medium", color: { rgb: C.BORDER_MD } },
};

// ─── Reusable style constants ─────────────────────────────────────────────────

/** Full-width title row: navy, white 13pt bold, centered */
const S_TITLE: Record<string, unknown> = {
  font: f(true, 13, C.WHITE), fill: bg(C.NAVY),
  alignment: a("center", "middle"), border: bMed,
};

/** Column header: blue, white 10pt bold, centered + wrapped */
const S_HEADER: Record<string, unknown> = {
  font: f(true, 10, C.WHITE), fill: bg(C.BLUE),
  alignment: a("center", "middle", true), border: bThin,
};

/** Morning period cell */
const S_MORNING: Record<string, unknown> = {
  font: f(true, 10, C.WHITE), fill: bg(C.MORNING_HD),
  alignment: a("center", "middle"), border: bThin,
};

/** Evening period cell */
const S_EVENING: Record<string, unknown> = {
  font: f(true, 10, C.WHITE), fill: bg(C.EVENING_HD),
  alignment: a("center", "middle"), border: bThin,
};

/** Status: OK / Warning / Error */
const S_OK: Record<string, unknown> = {
  font: f(true, 10, C.OK_FG), fill: bg(C.OK_BG),
  alignment: a("center", "middle"), border: bThin,
};
const S_WARN: Record<string, unknown> = {
  font: f(true, 10, C.WARN_FG), fill: bg(C.WARN_BG),
  alignment: a("center", "middle"), border: bThin,
};
const S_ERR: Record<string, unknown> = {
  font: f(true, 10, C.ERR_FG), fill: bg(C.ERR_BG),
  alignment: a("center", "middle"), border: bThin,
};
const S_YES: Record<string, unknown> = {
  font: f(true, 10, C.OK_FG), fill: bg(C.OK_BG),
  alignment: a("center", "top"), border: bThin,
};
const S_NO: Record<string, unknown> = {
  font: f(true, 10, C.ERR_FG), fill: bg(C.ERR_BG),
  alignment: a("center", "top"), border: bThin,
};

/** Load badge */
const LOAD: Record<"קל" | "תקין" | "עמוס", Record<string, unknown>> = {
  "קל":   { font: f(true, 10, C.OK_FG),   fill: bg(C.OK_BG),   alignment: a("center", "top"), border: bThin },
  "תקין": { font: f(true, 10, C.WARN_FG),  fill: bg(C.WARN_BG), alignment: a("center", "top"), border: bThin },
  "עמוס": { font: f(true, 10, C.ERR_FG),   fill: bg(C.ERR_BG),  alignment: a("center", "top"), border: bThin },
};

/** Plain right-aligned data cell, optional alt-row tint */
function sDR(alt = false): Record<string, unknown> {
  return { font: f(), fill: alt ? bg(C.ROW_ALT) : bg(C.WHITE),
           alignment: a("right", "top", true), border: bThin };
}
function sDC(alt = false): Record<string, unknown> {
  return { font: f(), fill: alt ? bg(C.ROW_ALT) : bg(C.WHITE),
           alignment: a("center", "top"), border: bThin };
}
function sDCBold(alt = false): Record<string, unknown> {
  return { font: f(true), fill: alt ? bg(C.ROW_ALT) : bg(C.WHITE),
           alignment: a("center", "top"), border: bThin };
}

// ─── Worksheet utilities ──────────────────────────────────────────────────────

function setColWidths(ws: XLSX.WorkSheet, widths: number[]): void {
  ws["!cols"] = widths.map((w) => ({ wch: w }));
}

function setRowHeights(ws: XLSX.WorkSheet, heights: number[]): void {
  ws["!rows"] = heights.map((h) => ({ hpt: h }));
}

function setRTL(ws: XLSX.WorkSheet): void {
  (ws as Record<string, unknown>)["!views"] = [{ rightToLeft: true }];
}

function applyStyles(
  ws: XLSX.WorkSheet,
  getStyle: (row: number, col: number) => Record<string, unknown>
): void {
  const ref = ws["!ref"];
  if (!ref) return;
  const range = XLSX.utils.decode_range(ref);
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { v: "", t: "s" };
      (ws[addr] as XLSX.CellObject).s = getStyle(r, c);
    }
  }
}

// ─── Cell formatters ──────────────────────────────────────────────────────────

/** Two slots combined into one cell (name + time, one employee per line). */
function fmtPeriod(s1: ExportSlot, s2: ExportSlot): string {
  const lines: string[] = [];
  for (const s of [s1, s2]) {
    if (!s) continue;
    const tag = s.shortenedStart ? "  ✦" : "";
    lines.push(`${s.employee}   ${s.timeRange}${tag}`);
  }
  return lines.join("\n") || "—";
}

// ─── Sheet 1 — "סידור שבועי"  (days = columns, periods = rows) ───────────────
//
//  Layout mirrors the web app table:
//
//  Row 0  Title (merged)
//  Row 1  [משמרת | ראשון\n20/4 | שני\n21/4 | ... | שבת\n26/4]
//  Row 2  [בוקר  | emp1\nemp2  | emp1\nemp2  | ...           ]  ← sky blue
//  Row 3  [ערב   | emp1\nemp2  | emp1\nemp2  | ...           ]  ← indigo
//  Row 4  [סטטוס | ✓ תקין     | ✓ תקין     | ...           ]

function buildScheduleSheet(days: ExportDay[], periodLabel: string): XLSX.WorkSheet {
  const NC = days.length + 1; // label col + N day cols

  const ws = XLSX.utils.aoa_to_sheet([
    // Row 0 — title
    [`סידור עבודה  ·  ${periodLabel}`, ...Array(NC - 1).fill("")],
    // Row 1 — day headers
    ["משמרת", ...days.map((d) => `${d.dayName}\n${d.date}`)],
    // Row 2 — morning
    ["בוקר",  ...days.map((d) => fmtPeriod(d.morning[0], d.morning[1]))],
    // Row 3 — evening
    ["ערב",   ...days.map((d) => fmtPeriod(d.evening[0], d.evening[1]))],
    // Row 4 — status
    ["סטטוס", ...days.map((d) =>
      d.status === "תקין" ? "✓  תקין" :
      d.status === "חוסר" ? "⚠  חוסר" : "✗  הפרה"
    )],
  ]);

  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: NC - 1 } }];

  setColWidths(ws, [10, ...Array(days.length).fill(22)]);
  setRowHeights(ws, [
    30,   // title
    28,   // day headers (day name + date, 2 lines)
    52,   // morning (up to 2 employees × 2 lines)
    52,   // evening
    20,   // status
  ]);
  setRTL(ws);

  applyStyles(ws, (r, c) => {
    if (r === 0) return S_TITLE;

    const dayIdx = c - 1;
    const isFri  = dayIdx >= 0 && days[dayIdx]?.dayName === "שישי";
    const isSat  = dayIdx >= 0 && days[dayIdx]?.dayName === "שבת";

    // ── Row 1: day-name headers ──────────────────────────────────────────────
    if (r === 1) {
      if (c === 0) return {              // "משמרת" corner cell
        font: f(true, 10, C.WHITE), fill: bg(C.NAVY),
        alignment: a("center", "middle"), border: bThin,
      };
      return {
        font: f(true, 11, C.WHITE),
        fill: bg(isSat ? "4B5563" : isFri ? "374151" : C.NAVY),
        alignment: a("center", "middle", true),
        border: bThin,
      };
    }

    // ── Row 2: morning ───────────────────────────────────────────────────────
    if (r === 2) {
      if (c === 0) return S_MORNING;
      const { status } = days[dayIdx];
      if (status === "הפרה") return { font: f(), fill: bg(C.ERR_ROW),  alignment: a("right", "top", true), border: bThin };
      if (status === "חוסר") return { font: f(), fill: bg(C.WARN_ROW), alignment: a("right", "top", true), border: bThin };
      return { font: f(), fill: bg(isFri || isSat ? C.MORNING_BG2 : C.MORNING_BG), alignment: a("right", "top", true), border: bThin };
    }

    // ── Row 3: evening ───────────────────────────────────────────────────────
    if (r === 3) {
      if (c === 0) return S_EVENING;
      const { status } = days[dayIdx];
      if (status === "הפרה") return { font: f(), fill: bg(C.ERR_ROW),  alignment: a("right", "top", true), border: bThin };
      if (status === "חוסר") return { font: f(), fill: bg(C.WARN_ROW), alignment: a("right", "top", true), border: bThin };
      return { font: f(), fill: bg(isFri || isSat ? C.EVENING_BG2 : C.EVENING_BG), alignment: a("right", "top", true), border: bThin };
    }

    // ── Row 4: status ────────────────────────────────────────────────────────
    if (r === 4) {
      if (c === 0) return { font: f(true, 10, C.WHITE), fill: bg(C.BLUE), alignment: a("center", "middle"), border: bThin };
      const { status } = days[dayIdx];
      if (status === "תקין") return S_OK;
      if (status === "חוסר") return S_WARN;
      return S_ERR;
    }

    return sDC();
  });

  return ws;
}

// ─── Sheet 2 — "נתוני עובדים" ────────────────────────────────────────────────

function buildStatsSheet(stats: ExportEmployeeStat[], periodLabel: string): XLSX.WorkSheet {
  const NC = 9;
  const title = `נתוני עובדים  ·  ${periodLabel}`;
  const headers = ["שם עובד", 'סה"כ', "בוקר", "ערב", "שישי", "שבת", "בוקר א'–ה'", "עומס", "סוף שבוע פנוי"];

  const active = stats.filter((s) => s.total > 0);
  const rows = active.map((s) => [
    s.name, s.total, s.morning, s.evening,
    s.friday, s.saturday, s.weekdayMorning,
    s.loadLevel,
    s.hasFreeWeekend ? "✓  כן" : "✗  לא",
  ]);

  const ws = XLSX.utils.aoa_to_sheet([
    [title, ...Array(NC - 1).fill("")],
    headers,
    ...rows,
  ]);

  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: NC - 1 } }];
  setColWidths(ws, [16, 8, 8, 8, 8, 8, 12, 12, 14]);
  setRowHeights(ws, [30, 22, ...active.map(() => 22)]);
  setRTL(ws);

  applyStyles(ws, (r, c) => {
    if (r === 0) return S_TITLE;
    if (r === 1) return S_HEADER;

    const s   = active[r - 2];
    const alt = (r - 2) % 2 === 1;

    // Load level badge
    if (c === 7) return LOAD[s.loadLevel];
    // Free weekend
    if (c === 8) return s.hasFreeWeekend ? S_YES : S_NO;
    // Total — colored to match load level
    if (c === 1) return LOAD[s.loadLevel];
    // Weekend columns — tinted if > 0
    if (c === 4 || c === 5) {
      const n = c === 4 ? s.friday : s.saturday;
      if (n >= 2) return { font: f(true, 10, C.ERR_FG),  fill: bg(C.ERR_BG),  alignment: a("center", "top"), border: bThin };
      if (n === 1) return { font: f(true, 10, C.WARN_FG), fill: bg(C.WARN_BG), alignment: a("center", "top"), border: bThin };
      return sDC(alt);
    }
    // Weekday mornings — red if 0
    if (c === 6) {
      if (s.weekdayMorning === 0)
        return { font: f(true, 10, C.ERR_FG), fill: bg(C.ERR_BG), alignment: a("center", "top"), border: bThin };
      return sDC(alt);
    }
    // Employee name
    if (c === 0) return sDR(alt);
    return sDC(alt);
  });

  return ws;
}

// ─── Sheet 3 — "בדיקת תקינות" ────────────────────────────────────────────────

function buildValidationSheet(violations: ExportViolation[], periodLabel: string): XLSX.WorkSheet {
  const NC = 5;
  const title = `בדיקת תקינות  ·  ${periodLabel}`;
  const headers = ["חומרה", "כלל", "עובד", "מיקום", "הסבר"];

  const isEmpty = violations.length === 0;
  const rows: string[][] = isEmpty
    ? [["✓", "אין הפרות", "—", "—", "הסידור תקין לחלוטין"]]
    : violations.map((v) => [
        v.severity === "קשה" ? "✗  קשה" : "!  רכה",
        v.ruleLabel, v.employee, v.location, v.explanation,
      ]);

  const ws = XLSX.utils.aoa_to_sheet([
    [title, ...Array(NC - 1).fill("")],
    headers,
    ...rows,
  ]);

  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: NC - 1 } }];
  setColWidths(ws, [10, 24, 13, 26, 44]);
  setRowHeights(ws, [30, 22, ...rows.map(() => 24)]);
  setRTL(ws);

  applyStyles(ws, (r, c) => {
    if (r === 0) return S_TITLE;
    if (r === 1) return S_HEADER;
    if (isEmpty) return S_OK;

    const v      = violations[r - 2];
    const isHard = (v.severity === "קשה");
    const rowBg  = isHard ? C.ERR_ROW : C.WARN_ROW;

    if (c === 0) return isHard ? S_ERR : S_WARN;
    if (c === 2) return { font: f(true, 10, isHard ? C.ERR_FG : C.WARN_FG),
                          fill: bg(rowBg), alignment: a("center", "top"), border: bThin };
    return { font: f(false, 10, C.TEXT), fill: bg(rowBg),
             alignment: a("right", "top", true), border: bThin };
  });

  return ws;
}

// ─── Sheet 4 — "חוסרים" ──────────────────────────────────────────────────────

function buildShortagesSheet(shortages: ExportShortage[], periodLabel: string): XLSX.WorkSheet {
  const NC = 5;
  const title = `חוסרים  ·  ${periodLabel}`;
  const headers = ["יום", "תאריך", "משמרת", "כמות חסרה", "סיבה"];

  const isEmpty = shortages.length === 0;
  const rows: (string | number)[][] = isEmpty
    ? [["—", "—", "—", "—", "הסידור מלא — אין חוסרים ✓"]]
    : shortages.map((s) => [s.dayName, s.date, s.period, s.missingCount, s.reason || "—"]);

  const ws = XLSX.utils.aoa_to_sheet([
    [title, ...Array(NC - 1).fill("")],
    headers,
    ...rows,
  ]);

  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: NC - 1 } }];
  setColWidths(ws, [12, 10, 10, 12, 28]);
  setRowHeights(ws, [30, 22, ...rows.map(() => 20)]);
  setRTL(ws);

  applyStyles(ws, (r, c) => {
    if (r === 0) return S_TITLE;
    if (r === 1) return S_HEADER;
    if (isEmpty) return S_OK;

    const s   = shortages[r - 2];
    const alt = (r - 2) % 2 === 1;

    if (c === 2) return s.period === "בוקר" ? S_MORNING : S_EVENING;
    if (c === 3) return { font: f(true, 10, C.ERR_FG), fill: bg(C.ERR_BG),
                          alignment: a("center", "top"), border: bThin };
    return sDR(alt);
  });

  return ws;
}

// ─── Sheet 5 — "תובנות" ──────────────────────────────────────────────────────

function buildInsightsSheet(insights: ExportInsight[], periodLabel: string): XLSX.WorkSheet {
  const NC = 2;
  const title = `תובנות מנהל  ·  ${periodLabel}`;
  const headers = ["נושא", "עובדים"];

  const isEmpty = insights.length === 0;
  const rows: string[][] = isEmpty
    ? [["הכל תקין ✓", "אין תובנות לשיפור — עומס מאוזן"]]
    : insights.map((i) => [i.topic, i.employees]);

  const ws = XLSX.utils.aoa_to_sheet([
    [title, ...Array(NC - 1).fill("")],
    headers,
    ...rows,
  ]);

  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: NC - 1 } }];
  setColWidths(ws, [32, 44]);
  setRowHeights(ws, [30, 22, ...rows.map(() => 24)]);
  setRTL(ws);

  applyStyles(ws, (r, c) => {
    if (r === 0) return S_TITLE;
    if (r === 1) return S_HEADER;
    if (isEmpty) return S_OK;

    const topic = insights[r - 2]?.topic ?? "";
    const rowBg = topic.includes("גבוה")                ? C.ERR_ROW
                : (topic.includes("קל") || topic.includes("זמינ")) ? C.OK_ROW
                : C.WARN_ROW;
    const fgCol = topic.includes("גבוה")                ? C.ERR_FG
                : (topic.includes("קל") || topic.includes("זמינ")) ? C.OK_FG
                : C.WARN_FG;

    if (c === 0) return { font: f(true, 10, fgCol),  fill: bg(rowBg), alignment: a("right", "top", true), border: bThin };
    return           { font: f(false, 10, C.TEXT), fill: bg(rowBg), alignment: a("right", "top", true), border: bThin };
  });

  return ws;
}

// ─── Sheet 6/7 — period stats (monthly weeks / quarterly months) ─────────────
//
// Layout:
//   Row 0 — title (merged)
//   Row 1 — [שם | sub1 | sub2 | ... | סה"כ | בוקר | ערב | שישי | שבת | ממוצע/שבוע | עומס]
//   Row 2+ — data

function buildPeriodStatsSheet(period: ExportPeriodStats, periodType?: string): XLSX.WorkSheet {
  const { label, subLabels, avgDivisor, rows } = period;
  const NS  = subLabels.length;
  const NC  = 1 + NS + 5 + 1 + 1;   // name + subs + total+mor+eve+fri+sat + avg + load

  const subKind  = avgDivisor <= 5 ? "שבועות" : "חודשים";
  const typeLabel = periodType ?? "";

  // Row 0 — title
  // Row 1 — subtitle (period type + sub-column explanation)
  // Row 2 — headers
  // Row 3+ — data
  // Last row — legend

  const legendNote = "קוד צבע עומס:  🔴 עמוס = 5+ משמרות/שבוע  |  🔵 תקין = 3–4  |  🟢 קל = 0–2  |  עמודות שישי/שבת מסומנות אדום כשגבוהות";

  const aoa = [
    [`משמרות לפי עובד — ${typeLabel}  ·  ${label}`, ...Array(NC - 1).fill("")],
    [`כל עמודה מציגה מספר משמרות ב${subKind}. עמודת "שיא" בכחול = ${subKind.slice(0, -2)} הכי עמוס לאותו עובד.`, ...Array(NC - 1).fill("")],
    ["שם עובד", ...subLabels, 'סה"כ', "בוקר", "ערב", "שישי", "שבת", "ממוצע\n/שבוע", "עומס"],
    ...rows.map((r) => [
      r.name, ...r.subCounts,
      r.total, r.morning, r.evening, r.friday, r.saturday,
      avgDivisor > 0 ? +(r.total / avgDivisor).toFixed(1) : 0,
      r.loadLevel,
    ]),
    [legendNote, ...Array(NC - 1).fill("")],
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const dataStart = 3;
  const legendRow = dataStart + rows.length;

  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: NC - 1 } },   // title
    { s: { r: 1, c: 0 }, e: { r: 1, c: NC - 1 } },   // subtitle
    { s: { r: legendRow, c: 0 }, e: { r: legendRow, c: NC - 1 } }, // legend
  ];

  setColWidths(ws, [18, ...Array(NS).fill(11), 8, 8, 8, 8, 8, 12, 10]);
  setRowHeights(ws, [32, 20, 28, ...rows.map(() => 22), 24]);
  setRTL(ws);

  const COL_TOTAL = 1 + NS;
  const COL_MOR   = COL_TOTAL + 1;
  const COL_EVE   = COL_TOTAL + 2;
  const COL_FRI   = COL_TOTAL + 3;
  const COL_SAT   = COL_TOTAL + 4;
  const COL_AVG   = COL_TOTAL + 5;
  const COL_LOAD  = COL_TOTAL + 6;

  applyStyles(ws, (r, c) => {
    if (r === 0) return S_TITLE;

    if (r === 1) return {   // subtitle row
      font: f(false, 9, C.TEXT_MID), fill: bg("EFF6FF"),
      alignment: a("right", "middle", true), border: bThin,
    };

    if (r === 2) {          // header row
      if (c >= 1 && c <= NS) return {
        font: f(true, 9, C.WHITE), fill: bg(C.BLUE_DIM),
        alignment: a("center", "middle", true), border: bThin,
      };
      // Morning / Evening header tints
      if (c === COL_MOR) return { font: f(true, 9, C.WHITE), fill: bg(C.MORNING_HD), alignment: a("center", "middle"), border: bThin };
      if (c === COL_EVE) return { font: f(true, 9, C.WHITE), fill: bg(C.EVENING_HD), alignment: a("center", "middle"), border: bThin };
      return S_HEADER;
    }

    if (r === legendRow) return {   // legend row
      font: f(false, 9, C.TEXT_MID), fill: bg("F8FAFC"),
      alignment: a("right", "middle", true), border: bThin,
    };

    const rowIdx = r - dataStart;
    if (rowIdx < 0 || rowIdx >= rows.length) return sDC();
    const row = rows[rowIdx];
    const alt = rowIdx % 2 === 1;

    if (c === 0)         return sDR(alt);
    if (c === COL_LOAD)  return LOAD[row.loadLevel];
    if (c === COL_TOTAL) return LOAD[row.loadLevel];

    if (c >= 1 && c <= NS) {
      const maxCount = Math.max(...row.subCounts);
      const val = row.subCounts[c - 1];
      if (val === maxCount && maxCount > 0)
        return { font: f(true, 10, C.NAVY), fill: alt ? bg(C.MORNING_BG2) : bg(C.MORNING_BG), alignment: a("center", "top"), border: bThin };
      return sDC(alt);
    }

    if (c === COL_MOR) return { font: f(false, 10, C.TEXT), fill: bg(alt ? C.MORNING_BG2 : C.MORNING_BG), alignment: a("center", "top"), border: bThin };
    if (c === COL_EVE) return { font: f(false, 10, C.TEXT), fill: bg(alt ? C.EVENING_BG2 : C.EVENING_BG), alignment: a("center", "top"), border: bThin };

    if (c === COL_FRI || c === COL_SAT) {
      const n = c === COL_FRI ? row.friday : row.saturday;
      if (n >= avgDivisor)                   return { font: f(true, 10, C.ERR_FG),  fill: bg(C.ERR_BG),  alignment: a("center", "top"), border: bThin };
      if (n >= Math.ceil(avgDivisor / 2))    return { font: f(true, 10, C.WARN_FG), fill: bg(C.WARN_BG), alignment: a("center", "top"), border: bThin };
      return sDC(alt);
    }

    if (c === COL_AVG) {
      const avg = avgDivisor > 0 ? row.total / avgDivisor : 0;
      if (avg >= 5)   return { font: f(true, 10, C.ERR_FG),  fill: bg(C.ERR_BG),  alignment: a("center", "top"), border: bThin };
      if (avg >= 3.5) return { font: f(true, 10, C.WARN_FG), fill: bg(C.WARN_BG), alignment: a("center", "top"), border: bThin };
      return sDCBold(alt);
    }

    return sDC(alt);
  });

  return ws;
}

// ─── Main export function ─────────────────────────────────────────────────────

/**
 * Generates a 5–8 sheet manager-level XLSX report and triggers a browser download.
 * Sheets 6–8 (monthly / quarterly / yearly) are appended only when data is provided.
 */
export function exportScheduleToExcel(input: ExportInput): void {
  const { periodLabel } = input;
  const wb = XLSX.utils.book_new();

  // Split into 7-day chunks; last chunk may be shorter if period isn't divisible by 7
  const total = input.days.length;
  const chunks: { start: number; end: number }[] = [];
  for (let s = 0; s < total; s += 7) {
    chunks.push({ start: s, end: Math.min(s + 7, total) });
  }

  chunks.forEach((chunk, i) => {
    const weekDays = input.days.slice(chunk.start, chunk.end);
    const from = weekDays[0].date;
    const to   = weekDays[weekDays.length - 1].date;
    // Excel sheet names cannot contain / \ ? * [ ] : — replace / with .
    const safeName = (d: string) => d.replace(/\//g, ".");
    const sheetName = `שבוע ${i + 1} (${safeName(from)}-${safeName(to)})`;
    const weekLabel = `שבוע ${i + 1}  ·  ${from} – ${to}`;
    XLSX.utils.book_append_sheet(wb, buildScheduleSheet(weekDays, weekLabel), sheetName);
  });

  // Monthly stats always present (computed from current schedule if no history)
  if (input.monthlyStats)   XLSX.utils.book_append_sheet(wb, buildPeriodStatsSheet(input.monthlyStats,   "חודשי"),   "משמרות - חודשי");
  if (input.quarterlyStats) XLSX.utils.book_append_sheet(wb, buildPeriodStatsSheet(input.quarterlyStats, "רבעוני"), "משמרות - רבעוני");
  if (input.yearlyStats)    XLSX.utils.book_append_sheet(wb, buildPeriodStatsSheet(input.yearlyStats,    "שנתי"),   "משמרות - שנתי");

  XLSX.utils.book_append_sheet(wb, buildStatsSheet(input.stats, periodLabel),           "נתוני עובדים");
  XLSX.utils.book_append_sheet(wb, buildValidationSheet(input.violations, periodLabel), "בדיקת תקינות");
  XLSX.utils.book_append_sheet(wb, buildShortagesSheet(input.shortages, periodLabel),   "חוסרים");
  XLSX.utils.book_append_sheet(wb, buildInsightsSheet(input.insights, periodLabel),     "תובנות");

  XLSX.writeFile(wb, `schedule_${periodLabel.replace(/\//g, "-")}.xlsx`);
}
