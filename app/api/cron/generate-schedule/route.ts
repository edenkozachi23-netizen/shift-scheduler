import { NextResponse } from "next/server";
import { generateSchedule, buildShiftSlots } from "@/lib/scheduling/generateSchedule";
import type { Constraint, ConstraintType } from "@/lib/scheduling/types";
import { EMPLOYEES } from "@/lib/employees";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const CRON_SECRET  = process.env.CRON_SECRET;

function getUpcomingWeekStart(): string {
  const today = new Date();
  const dow   = today.getDay();
  const days  = dow === 0 ? 7 : 7 - dow;
  const d     = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function offsetDate(start: string, n: number): string {
  const [y, m, d] = start.split("-").map(Number);
  const r = new Date(y, m - 1, d + n);
  return `${r.getFullYear()}-${String(r.getMonth() + 1).padStart(2, "0")}-${String(r.getDate()).padStart(2, "0")}`;
}

const dbHeaders = (extra?: Record<string, string>) => ({
  apikey:          SUPABASE_KEY,
  Authorization:   `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json",
  Accept:          "application/json",
  ...extra,
});

export async function GET(request: Request) {
  // Verify Vercel cron secret when set
  if (CRON_SECRET) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const weekStart = getUpcomingWeekStart();
  const weekEnd   = offsetDate(weekStart, 6);

  // 0. Fetch active employees from DB
  const eRes = await fetch(
    `${SUPABASE_URL}/rest/v1/users?role=eq.employee&is_active=eq.true&select=name&order=name.asc`,
    { headers: dbHeaders(), cache: "no-store" }
  );
  if (!eRes.ok) {
    return NextResponse.json({ error: "Failed to fetch employees" }, { status: 500 });
  }
  const empRows = await eRes.json() as { name: string }[];
  const employeeList: string[] = empRows.map((r) => r.name);

  // 1. Fetch constraints for the upcoming week
  const cRes = await fetch(
    `${SUPABASE_URL}/rest/v1/employee_constraints` +
    `?date_iso=gte.${weekStart}&date_iso=lte.${weekEnd}` +
    `&select=employee_id,date_iso,constraint_type,note&order=date_iso.asc`,
    { headers: dbHeaders(), cache: "no-store" }
  );
  if (!cRes.ok) {
    return NextResponse.json({ error: `Failed to fetch constraints: ${await cRes.text()}` }, { status: 500 });
  }
  const rawConstraints = await cRes.json() as {
    employee_id: string; date_iso: string; constraint_type: string; note: string;
  }[];
  const constraints: Constraint[] = rawConstraints.map((r) => ({
    employee:       r.employee_id,
    date:           r.date_iso,
    constraintType: r.constraint_type as ConstraintType,
    note:           r.note,
  }));

  // 2. Generate schedule
  const result = generateSchedule(buildShiftSlots(weekStart, weekEnd), employeeList, constraints);

  // 3. Replace saved entries for this week
  const del = await fetch(
    `${SUPABASE_URL}/rest/v1/saved_schedule_entries?date=gte.${weekStart}&date=lte.${weekEnd}`,
    { method: "DELETE", headers: dbHeaders() }
  );
  if (!del.ok) {
    return NextResponse.json({ error: `Delete failed: ${await del.text()}` }, { status: 500 });
  }

  const rows = result.schedule.flatMap((entry) =>
    entry.assignments.map((a) => ({
      date:              entry.date,
      period:            entry.period,
      employee_id:       a.employeeId,
      shift_template_id: a.shiftTemplateId,
      week_start:        weekStart,
    }))
  );

  if (rows.length > 0) {
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/saved_schedule_entries`, {
      method:  "POST",
      headers: dbHeaders({ Prefer: "return=minimal" }),
      body:    JSON.stringify(rows),
    });
    if (!ins.ok) {
      return NextResponse.json({ error: `Insert failed: ${await ins.text()}` }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok:                true,
    weekStart,
    weekEnd,
    constraintsLoaded: constraints.length,
    entriesSaved:      rows.length,
    shortages:         result.shortages.length,
  });
}
