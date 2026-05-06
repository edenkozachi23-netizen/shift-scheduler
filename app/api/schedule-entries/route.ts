import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function headers(extra?: Record<string, string>) {
  return {
    apikey: SUPABASE_KEY!,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra,
  };
}

function missingEnv() {
  return NextResponse.json({ error: "Missing Supabase env vars" }, { status: 500 });
}

async function getUser() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// ─── GET /api/schedule-entries?from=YYYY-MM-DD&to=YYYY-MM-DD ─────────────────
// Requires authentication. Any role may read (employees need to see their shifts).
export async function GET(request: Request) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return missingEnv();

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to   = searchParams.get("to");
  if (!from || !to) {
    return NextResponse.json({ error: "Missing from/to params" }, { status: 400 });
  }

  const url =
    `${SUPABASE_URL}/rest/v1/saved_schedule_entries` +
    `?date=gte.${from}&date=lte.${to}` +
    `&select=date,period,employee_id,shift_template_id` +
    `&order=date.asc,period.asc`;

  const res = await fetch(url, { headers: headers(), cache: "no-store" });
  const body = await res.text();
  if (!res.ok) {
    return NextResponse.json({ error: `Supabase error ${res.status}: ${body}` }, { status: res.status });
  }
  return NextResponse.json(JSON.parse(body));
}

// ─── POST /api/schedule-entries ───────────────────────────────────────────────
// Requires manager role. Replaces all saved entries for the given week (Sun–Sat).
// Body: { weekStart: string, entries: { date, period, employeeId, shiftTemplateId }[] }
export async function POST(request: Request) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return missingEnv();

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const role = user.user_metadata?.role as string | undefined;
  if (role !== "manager") {
    return NextResponse.json({ error: "Forbidden — manager role required" }, { status: 403 });
  }

  const { weekStart, entries } = await request.json() as {
    weekStart: string;
    entries: { date: string; period: string; employeeId: string; shiftTemplateId: string }[];
  };

  if (!weekStart || !Array.isArray(entries)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Compute weekEnd (6 days after weekStart)
  const [y, m, d] = weekStart.split("-").map(Number);
  const end = new Date(y, m - 1, d + 6);
  const weekEnd = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;

  // 1. Delete all existing entries for this week
  const del = await fetch(
    `${SUPABASE_URL}/rest/v1/saved_schedule_entries?date=gte.${weekStart}&date=lte.${weekEnd}`,
    { method: "DELETE", headers: headers() }
  );
  if (!del.ok) {
    const body = await del.text();
    return NextResponse.json({ error: `Delete failed: ${body}` }, { status: del.status });
  }

  // 2. Insert new entries (skip empty slots)
  if (entries.length > 0) {
    const rows = entries.map((e) => ({
      date:              e.date,
      period:            e.period,
      employee_id:       e.employeeId,
      shift_template_id: e.shiftTemplateId,
      week_start:        weekStart,
    }));

    const ins = await fetch(`${SUPABASE_URL}/rest/v1/saved_schedule_entries`, {
      method: "POST",
      headers: headers({ Prefer: "return=minimal" }),
      body: JSON.stringify(rows),
    });
    if (!ins.ok) {
      const body = await ins.text();
      return NextResponse.json({ error: `Insert failed: ${body}` }, { status: ins.status });
    }
  }

  return NextResponse.json({ saved: entries.length });
}
