import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateSchedule, buildShiftSlots } from "@/lib/scheduling/generateSchedule";
import type { Constraint, ConstraintType } from "@/lib/scheduling/types";
import { EMPLOYEES } from "@/lib/employees";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getSchedulingPeriod(): { start: string; end: string } {
  const today  = new Date();
  const year   = today.getFullYear();
  const month  = today.getMonth() + 1;
  const day    = today.getDate();
  const pad    = (n: number) => String(n).padStart(2, "0");
  if (day >= 20) {
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear  = month === 12 ? year + 1 : year;
    return { start: `${year}-${pad(month)}-20`, end: `${nextYear}-${pad(nextMonth)}-19` };
  } else {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;
    return { start: `${prevYear}-${pad(prevMonth)}-20`, end: `${year}-${pad(month)}-19` };
  }
}


const dbHeaders = (extra?: Record<string, string>) => ({
  apikey:         SUPABASE_KEY,
  Authorization:  `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Accept:         "application/json",
  ...extra,
});

export async function POST(_request: Request) {
  // Verify manager session
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (user.user_metadata?.role !== "manager") {
    return NextResponse.json({ error: "Forbidden — manager role required" }, { status: 403 });
  }

  const { start: weekStart, end: weekEnd } = getSchedulingPeriod();

  // 0. Fetch active employees — try service role (auth.users) first, then public.users, then static list
  let employeeList: string[] = [];

  if (SERVICE_KEY) {
    const authRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?per_page=200`,
      {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        cache: "no-store",
      }
    );
    if (authRes.ok) {
      const { users: authUsers } = await authRes.json() as {
        users: { user_metadata: Record<string, unknown> }[];
      };
      const names = authUsers
        .filter(
          (u) =>
            u.user_metadata?.role === "employee" &&
            typeof u.user_metadata?.display_name === "string" &&
            (u.user_metadata.display_name as string).trim() !== ""
        )
        .map((u) => u.user_metadata.display_name as string)
        .sort((a, b) => a.localeCompare(b, "he"));
      if (names.length > 0) employeeList = names;
    }
  }

  if (employeeList.length === 0) {
    const eRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?role=eq.employee&is_active=eq.true&select=name&order=name.asc`,
      { headers: dbHeaders(), cache: "no-store" }
    );
    if (eRes.ok) {
      const empRows = await eRes.json() as { name: string }[];
      if (empRows.length > 0) employeeList = empRows.map((r) => r.name);
    }
  }

  // Final fallback: static employee list
  if (employeeList.length === 0) {
    employeeList = [...EMPLOYEES];
  }

  // 1. Fetch constraints for the scheduling period — use service role to bypass RLS
  const constraintKey = SERVICE_KEY ?? SUPABASE_KEY;
  const cRes = await fetch(
    `${SUPABASE_URL}/rest/v1/employee_constraints` +
    `?date_iso=gte.${weekStart}&date_iso=lte.${weekEnd}` +
    `&select=employee_id,date_iso,constraint_type,note&order=date_iso.asc`,
    {
      headers: { apikey: constraintKey, Authorization: `Bearer ${constraintKey}`, Accept: "application/json" },
      cache: "no-store",
    }
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
