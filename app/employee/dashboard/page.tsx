"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { ConstraintType } from "@/lib/scheduling/types";
import { SHIFT_TEMPLATE_MAP } from "@/lib/scheduling/shiftTemplates";
import { createClient } from "@/lib/supabase/client";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CONSTRAINTS = 10;

const DAYS_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

// ─── Types ────────────────────────────────────────────────────────────────────

const CONSTRAINT_OPTIONS: { value: ConstraintType; label: string }[] = [
  { value: "all-day",         label: "כל היום" },
  { value: "morning-07-19",   label: "בוקר (לא יכול בכלל)" },
  { value: "morning-from-08", label: "בוקר רק מ-08:00" },
  { value: "evening-19-07",   label: "ערב (לא יכול בכלל)" },
  { value: "evening-from-20", label: "ערב רק מ-20:00" },
];

const CONSTRAINT_LABELS: Record<ConstraintType, string> = {
  "all-day":         "כל היום",
  "morning-07-19":   "בוקר (לא יכול בכלל)",
  "morning-08-20":   "בוקר (לא יכול בכלל)",
  "morning-from-08": "בוקר רק מ-08:00",
  "evening-19-07":   "ערב (לא יכול בכלל)",
  "evening-20-08":   "ערב (לא יכול בכלל)",
  "evening-from-20": "ערב רק מ-20:00",
};

type DbConstraint = {
  id: string;
  date_iso: string;
  constraint_type: ConstraintType;
  note: string;
};

type Constraint = {
  id: string;
  date: string;          // display "12/4/2026"
  dateISO: string;
  constraintType: ConstraintType;
  note: string;
};

function dbToConstraint(db: DbConstraint): Constraint {
  const [y, m, d] = db.date_iso.split("-").map(Number);
  return {
    id:             db.id,
    date:           `${d}/${m}/${y}`,
    dateISO:        db.date_iso,
    constraintType: db.constraint_type,
    note:           db.note ?? "",
  };
}

// ─── Schedule entry (from saved_schedule_entries API) ─────────────────────────

type ScheduleRow = {
  date: string;
  period: "morning" | "evening";
  employee_id: string;
  shift_template_id: string;
};

type ShiftEntry = {
  date: string;
  period: "morning" | "evening";
  timeRange: string;
  dayName: string;
  isFriday: boolean;
  isSaturday: boolean;
};

// ─── Scheduling period helpers ────────────────────────────────────────────────

type SchedulingPeriod = {
  start: string;  // "YYYY-MM-DD", always the 20th
  end: string;    // "YYYY-MM-DD", always the 19th
  label: string;
};

function getSchedulingPeriod(isoDate: string): SchedulingPeriod {
  const [year, month, day] = isoDate.split("-").map(Number);
  let start: string, end: string;
  if (day >= 20) {
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear  = month === 12 ? year + 1 : year;
    start = `${year}-${String(month).padStart(2, "0")}-20`;
    end   = `${nextYear}-${String(nextMonth).padStart(2, "0")}-19`;
  } else {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;
    start = `${prevYear}-${String(prevMonth).padStart(2, "0")}-20`;
    end   = `${year}-${String(month).padStart(2, "0")}-19`;
  }
  return { start, end, label: formatPeriodLabel(start, end) };
}

function formatPeriodLabel(start: string, end: string): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return `${d}/${m}/${y}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

function todayISO(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

function isoPlus(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function countInPeriod(constraints: Constraint[], period: SchedulingPeriod): number {
  return constraints.filter(
    (c) => c.dateISO >= period.start && c.dateISO <= period.end
  ).length;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Profile = {
  id:          string;
  fullName:    string;
  displayName: string;
  email:       string;
  role:        string;
};

export default function EmployeeDashboardPage() {
  const router = useRouter();

  // ── Auth / profile ─────────────────────────────────────────────────────────
  const [profile, setProfile]               = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  // Employee identity comes from the authenticated session — not a dropdown.
  const selectedEmployee = profile?.displayName ?? "";

  // Constraint form state
  const [date, setDate]                       = useState("");
  const [constraintType, setConstraintType]   = useState<ConstraintType>("all-day");
  const [note, setNote]                       = useState("");
  const [dateError, setDateError]             = useState(false);
  const [datePastError, setDatePastError]     = useState(false);

  // Constraint data state
  const [constraints, setConstraints]         = useState<Constraint[]>([]);
  const [loading, setLoading]                 = useState(false);
  const [loadError, setLoadError]             = useState<string | null>(null);
  const [submitting, setSubmitting]           = useState(false);
  const [submitError, setSubmitError]         = useState<string | null>(null);
  const [deleteId, setDeleteId]               = useState<string | null>(null); // optimistic

  // Upcoming schedule state
  const [shifts, setShifts]                   = useState<ShiftEntry[]>([]);
  const [shiftsLoading, setShiftsLoading]     = useState(false);
  const [shiftsError, setShiftsError]         = useState<string | null>(null);

  // ── Fetch profile on mount ─────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/profile")
      .then(async (res) => {
        if (!res.ok) { router.replace("/login"); return; }
        const json = await res.json() as Profile;
        if (json.role !== "employee") {
          router.replace("/manager/dashboard");
          return;
        }
        setProfile(json);
      })
      .catch(() => router.replace("/login"))
      .finally(() => setProfileLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Logout ─────────────────────────────────────────────────────────────────
  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
  }

  // ── Load constraints from API ──────────────────────────────────────────────
  // No employeeId param — the API derives identity from the session.
  const loadConstraints = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/employee-constraints");
      const json = await res.json();
      if (!res.ok) { setLoadError(json.error ?? `HTTP ${res.status}`); setConstraints([]); return; }
      setConstraints((json as DbConstraint[]).map(dbToConstraint));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "שגיאה בטעינה");
      setConstraints([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Load upcoming shifts from saved schedule entries ───────────────────────
  const loadShifts = useCallback(async (employeeId: string) => {
    setShiftsLoading(true);
    setShiftsError(null);
    try {
      const from = todayISO();
      const to   = isoPlus(from, 27); // next 4 weeks
      const res  = await fetch(`/api/schedule-entries?from=${from}&to=${to}`);
      const json = await res.json();
      if (!res.ok) { setShiftsError(json.error ?? `HTTP ${res.status}`); setShifts([]); return; }

      const mine: ShiftEntry[] = (json as ScheduleRow[])
        .filter((r) => r.employee_id === employeeId)
        .sort((a, b) => a.date.localeCompare(b.date) || (a.period === "morning" ? -1 : 1))
        .map((r) => {
          const tpl = SHIFT_TEMPLATE_MAP[r.shift_template_id];
          const [y, m, d] = r.date.split("-").map(Number);
          const dow = new Date(y, m - 1, d).getDay();
          return {
            date:       r.date,
            period:     r.period,
            timeRange:  tpl ? `${tpl.startTime}–${tpl.endTime}` : r.shift_template_id,
            dayName:    DAYS_HE[dow],
            isFriday:   dow === 5,
            isSaturday: dow === 6,
          };
        });
      setShifts(mine);
    } catch (err) {
      setShiftsError(err instanceof Error ? err.message : "שגיאה בטעינת סידור");
      setShifts([]);
    } finally {
      setShiftsLoading(false);
    }
  }, []);

  // Load data once the profile (and thus displayName) is known
  useEffect(() => {
    if (!selectedEmployee) return;
    loadConstraints();
    loadShifts(selectedEmployee);
  }, [selectedEmployee, loadConstraints, loadShifts]);

  // ── Derived: period info ───────────────────────────────────────────────────
  const today          = todayISO();
  const currentPeriod  = getSchedulingPeriod(today);
  const selectedPeriod = date ? getSchedulingPeriod(date) : null;
  const periodCount    = selectedPeriod ? countInPeriod(constraints, selectedPeriod) : 0;
  const periodRemaining = MAX_CONSTRAINTS - periodCount;
  const atPeriodLimit   = selectedPeriod !== null && periodCount >= MAX_CONSTRAINTS;

  // ── Upcoming constraints (today and forward) ───────────────────────────────
  const upcomingConstraints = constraints
    .filter((c) => c.dateISO >= today)
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO));

  const pastConstraints = constraints
    .filter((c) => c.dateISO < today)
    .sort((a, b) => b.dateISO.localeCompare(a.dateISO)); // newest first

  // ── Conflict detection: saved shifts that clash with submitted constraints ──
  const conflictingShifts = shifts.filter((s) =>
    constraints.some((c) => {
      if (c.dateISO !== s.date) return false;
      if (c.constraintType === "all-day") return true;
      const constraintPeriod = c.constraintType.startsWith("morning") ? "morning" : "evening";
      return constraintPeriod === s.period;
    })
  );

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!date) { setDateError(true); return; }
    if (date < today) { setDatePastError(true); return; }
    setDateError(false);
    setDatePastError(false);
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/employee-constraints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateISO: date, constraintType, note }),
      });
      const json = await res.json();
      if (!res.ok) { setSubmitError(json.error ?? `HTTP ${res.status}`); return; }
      await loadConstraints();
      setDate("");
      setConstraintType("all-day");
      setNote("");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "שגיאה בשמירה");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  async function handleDelete(id: string) {
    setDeleteId(id);
    setConstraints((prev) => prev.filter((c) => c.id !== id));
    try {
      const res = await fetch(
        `/api/employee-constraints?id=${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) await loadConstraints();
    } catch {
      await loadConstraints();
    } finally {
      setDeleteId(null);
    }
  }

  // ── Format helpers ─────────────────────────────────────────────────────────
  function fmtDateDisplay(iso: string) {
    const [y, m, d] = iso.split("-").map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    return `${DAYS_HE[dow]}, ${d}/${m}/${y}`;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  // Show spinner while profile is loading
  if (profileLoading) {
    return (
      <div dir="rtl" className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-400 text-sm">טוען פרופיל...</p>
      </div>
    );
  }

  // Profile is null only if a redirect is already in flight — render nothing.
  if (!profile) return null;

  return (
    <div dir="rtl" className="min-h-screen bg-gray-50">

      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-gray-800">אזור עובד</h1>
            <p className="text-xs text-gray-400 mt-0.5">הגשת אילוצים וצפייה בסידור</p>
          </div>
          {/* Authenticated identity */}
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-sm font-semibold text-gray-800">{profile.fullName || profile.displayName}</p>
              <p className="text-xs text-gray-400">{profile.email}</p>
            </div>
            <button
              onClick={handleLogout}
              className="text-xs text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-300 rounded-lg px-3 py-1.5 transition-colors"
            >
              יציאה
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">

        {/* ── Upcoming Schedule ──────────────────────────────────────────── */}
        <section className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">המשמרות שלי — 4 שבועות קרובים</h2>
            <button
              onClick={() => loadShifts(selectedEmployee)}
              disabled={shiftsLoading}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium"
            >
              {shiftsLoading ? "טוען..." : "רענן"}
            </button>
          </div>

          <div className="px-5 py-4">
            {conflictingShifts.length > 0 && (
              <div className="mb-3 text-sm text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2.5 space-y-1">
                <p className="font-semibold">שים לב — ישנן משמרות שמורות שמתנגשות עם האילוצים שלך:</p>
                {conflictingShifts.map((s, i) => {
                  const [y, m, d] = s.date.split("-").map(Number);
                  return (
                    <p key={i} className="text-xs">
                      • {s.dayName} {d}/{m}/{y} — {s.period === "morning" ? "בוקר" : "ערב"} ({s.timeRange})
                    </p>
                  );
                })}
                <p className="text-xs text-amber-700 mt-1">המנהל צריך לצור סידור חדש כדי שהאילוצים ייושמו.</p>
              </div>
            )}
            {shiftsLoading ? (
              <p className="text-sm text-gray-400">טוען...</p>
            ) : shiftsError ? (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                שגיאה: {shiftsError}
              </p>
            ) : shifts.length === 0 ? (
              <p className="text-sm text-gray-400">אין משמרות שמורות בארבעת השבועות הקרובים.</p>
            ) : (
              <div className="space-y-1.5">
                {shifts.map((s, i) => (
                  <div
                    key={i}
                    className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 border text-sm ${
                      s.isSaturday
                        ? "bg-gray-100 border-gray-300 text-gray-600"
                        : s.isFriday
                        ? "bg-gray-50 border-gray-200 text-gray-700"
                        : s.period === "morning"
                        ? "bg-sky-50 border-sky-200 text-sky-800"
                        : "bg-indigo-50 border-indigo-200 text-indigo-800"
                    }`}
                  >
                    <span className="font-medium">{s.dayName}, {s.date.split("-").reverse().slice(0, 2).map(Number).join("/")}</span>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        s.period === "morning"
                          ? "bg-sky-200 text-sky-800"
                          : "bg-indigo-200 text-indigo-800"
                      }`}>
                        {s.period === "morning" ? "בוקר" : "ערב"}
                      </span>
                      <span className="font-mono text-xs">{s.timeRange}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ── Constraint Form ────────────────────────────────────────────── */}
        <section className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-800">הגשת אילוץ</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              תקופת תזמון נוכחית: {currentPeriod.label}
            </p>
          </div>

          <div className="px-5 py-4 space-y-4">
            {/* Period indicator — updates as the date picker changes */}
            {selectedPeriod && (
              <div className={`text-sm px-4 py-3 rounded-xl border space-y-0.5 ${
                atPeriodLimit
                  ? "bg-red-50 text-red-600 border-red-200"
                  : periodRemaining <= 3
                  ? "bg-amber-50 text-amber-700 border-amber-200"
                  : "bg-blue-50 text-blue-700 border-blue-200"
              }`}>
                <div className="font-medium">
                  תקופה: <span className="font-bold">{selectedPeriod.label}</span>
                </div>
                <div className="text-xs">
                  שימוש: <span className="font-bold">{periodCount}</span> / {MAX_CONSTRAINTS}
                  {periodRemaining > 0 && (
                    <span className="mr-2">· נותרו <span className="font-bold">{periodRemaining}</span></span>
                  )}
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">תאריך</label>
                <input
                  type="date"
                  value={date}
                  min={today}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setDateError(false);
                    setDatePastError(false);
                  }}
                  className={`border rounded-xl px-3 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-400 ${
                    dateError || datePastError ? "border-red-400 bg-red-50" : "border-gray-300"
                  }`}
                />
                {dateError && (
                  <span className="text-red-500 text-xs">יש לבחור תאריך לפני השליחה</span>
                )}
                {datePastError && (
                  <span className="text-red-500 text-xs">לא ניתן להגיש אילוץ על תאריך שעבר</span>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">סוג אילוץ</label>
                <select
                  value={constraintType}
                  onChange={(e) => setConstraintType(e.target.value as ConstraintType)}
                  className="border border-gray-300 rounded-xl px-3 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  {CONSTRAINT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">הערה <span className="font-normal text-gray-400">(אופציונלי)</span></label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="סיבה, פרטים נוספים..."
                  maxLength={120}
                  className="border border-gray-300 rounded-xl px-3 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>

              {submitError && (
                <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                  שגיאה בשמירה: {submitError}
                </p>
              )}

              <button
                type="submit"
                disabled={atPeriodLimit || submitting}
                className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-2.5 transition-colors"
              >
                {submitting
                  ? "שומר..."
                  : atPeriodLimit
                  ? "הגעת למגבלת האילוצים לתקופה זו"
                  : "שלח אילוץ"}
              </button>
            </form>
          </div>
        </section>

        {/* ── Constraints List ───────────────────────────────────────────── */}
        <section className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-800">האילוצים שלי</h2>
          </div>

          <div className="px-5 py-4">
            {loading ? (
              <p className="text-sm text-gray-400">טוען...</p>
            ) : loadError ? (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                שגיאה בטעינה: {loadError}
              </p>
            ) : constraints.length === 0 ? (
              <p className="text-sm text-gray-400">לא הוגשו אילוצים עדיין.</p>
            ) : (
              <div className="space-y-4">
                {/* Upcoming */}
                {upcomingConstraints.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">עתידיים</p>
                    {upcomingConstraints.map((c) => (
                      <ConstraintRow
                        key={c.id}
                        constraint={c}
                        deleting={deleteId === c.id}
                        dayLabel={fmtDateDisplay(c.dateISO)}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                )}

                {/* Past */}
                {pastConstraints.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">עברו</p>
                    {pastConstraints.map((c) => (
                      <ConstraintRow
                        key={c.id}
                        constraint={c}
                        deleting={deleteId === c.id}
                        dayLabel={fmtDateDisplay(c.dateISO)}
                        onDelete={handleDelete}
                        past
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

      </div>
    </div>
  );
}

// ─── ConstraintRow sub-component ─────────────────────────────────────────────

const CONSTRAINT_LABELS_LOCAL: Record<ConstraintType, string> = CONSTRAINT_LABELS;

type ConstraintRowProps = {
  constraint: Constraint;
  deleting: boolean;
  dayLabel: string;
  past?: boolean;
  onDelete: (id: string) => void;
};

function ConstraintRow({ constraint: c, deleting, dayLabel, past, onDelete }: ConstraintRowProps) {
  const isPeriodMorning = c.constraintType.startsWith("morning");
  const isPeriodEvening = c.constraintType.startsWith("evening");

  return (
    <div className={`flex items-start justify-between gap-2 rounded-xl px-3.5 py-3 border text-sm transition-opacity ${
      past || deleting
        ? "opacity-50 bg-gray-50 border-gray-200"
        : "bg-white border-gray-200 hover:border-blue-200"
    }`}>
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-gray-800">{dayLabel}</span>
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            isPeriodMorning ? "bg-sky-100 text-sky-700" :
            isPeriodEvening ? "bg-indigo-100 text-indigo-700" :
            "bg-red-100 text-red-700"
          }`}>
            {CONSTRAINT_LABELS_LOCAL[c.constraintType]}
          </span>
        </div>
        {c.note && (
          <span className="text-xs text-gray-400 truncate">{c.note}</span>
        )}
      </div>
      {!past && (
        <button
          onClick={() => onDelete(c.id)}
          disabled={deleting}
          className="shrink-0 text-xs font-medium text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 rounded-lg px-2 py-1 transition-colors disabled:opacity-50"
        >
          מחק
        </button>
      )}
    </div>
  );
}
