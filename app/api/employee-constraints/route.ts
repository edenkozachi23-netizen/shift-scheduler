import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

function anonHeaders(extra?: Record<string, string>) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra,
  };
}

async function getUser() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// GET /api/employee-constraints
//
// Manager (?from=YYYY-MM-DD&to=YYYY-MM-DD):
//   Returns ALL employees' constraints in the date range using service role key
//   so it bypasses RLS and always returns the full dataset.
//
// Employee (no params):
//   Returns the logged-in employee's own constraints.
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to   = searchParams.get("to");
  const role = user.user_metadata?.role as string | undefined;

  if (role === "manager" && from && to) {
    // Use service role key to bypass RLS — managers can see all constraints
    const key = SERVICE_KEY ?? SUPABASE_KEY;
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/employee_constraints` +
        `?date_iso=gte.${from}&date_iso=lte.${to}` +
        `&select=id,employee_id,date_iso,constraint_type,note` +
        `&order=date_iso.asc`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
        cache: "no-store",
      }
    );
    const body = await res.text();
    if (!res.ok) return NextResponse.json({ error: `Supabase ${res.status}: ${body}` }, { status: res.status });
    return NextResponse.json(JSON.parse(body));
  }

  // Employee: only their own constraints via anon key (table allows anon reads)
  const employeeId = user.user_metadata?.display_name as string | undefined;
  if (!employeeId) {
    return NextResponse.json({ error: "Profile has no display_name" }, { status: 400 });
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/employee_constraints` +
      `?employee_id=eq.${encodeURIComponent(employeeId)}` +
      `&select=id,date_iso,constraint_type,note` +
      `&order=date_iso.asc`,
    { headers: anonHeaders(), cache: "no-store" }
  );
  const body = await res.text();
  if (!res.ok) return NextResponse.json({ error: `Supabase ${res.status}: ${body}` }, { status: res.status });
  return NextResponse.json(JSON.parse(body));
}

// POST /api/employee-constraints
// Body: { dateISO, constraintType, note }
// The employeeId is derived from the session — not accepted from the body.
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const employeeId = user.user_metadata?.display_name as string | undefined;
  if (!employeeId) {
    return NextResponse.json({ error: "Profile has no display_name" }, { status: 400 });
  }

  const { dateISO, constraintType, note } = await request.json();

  // Enforce submission deadline (10th of current or next month)
  const now = new Date();
  const ty = now.getFullYear(), tm = now.getMonth() + 1, td = now.getDate();
  const todayStr = `${ty}-${String(tm).padStart(2,"0")}-${String(td).padStart(2,"0")}`;
  const deadlineISO = td >= 20
    ? `${tm === 12 ? ty + 1 : ty}-${String(tm === 12 ? 1 : tm + 1).padStart(2,"0")}-10`
    : `${ty}-${String(tm).padStart(2,"0")}-10`;
  if (todayStr > deadlineISO) {
    return NextResponse.json({ error: "פג המועד להגשת אילוצים לתקופה הנוכחית" }, { status: 403 });
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/employee_constraints`, {
    method: "POST",
    headers: anonHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({
      employee_id:     employeeId,
      employee_name:   employeeId,
      date_iso:        dateISO,
      constraint_type: constraintType,
      note:            note ?? "",
    }),
  });

  const body = await res.text();
  if (!res.ok) return NextResponse.json({ error: `Supabase ${res.status}: ${body}` }, { status: res.status });
  return NextResponse.json(JSON.parse(body));
}

// DELETE /api/employee-constraints?id=xxx
// Only deletes the record if it belongs to the currently authenticated employee.
export async function DELETE(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const employeeId = user.user_metadata?.display_name as string | undefined;
  if (!employeeId) {
    return NextResponse.json({ error: "Profile has no display_name" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // Ownership check
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/employee_constraints?id=eq.${encodeURIComponent(id)}&select=employee_id`,
    { headers: anonHeaders(), cache: "no-store" }
  );
  if (!checkRes.ok) return NextResponse.json({ error: "Failed to verify ownership" }, { status: 500 });
  const rows = (await checkRes.json()) as { employee_id: string }[];
  if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (rows[0].employee_id !== employeeId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/employee_constraints?id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE", headers: anonHeaders() }
  );

  if (!res.ok) {
    const body = await res.text();
    return NextResponse.json({ error: `Supabase ${res.status}: ${body}` }, { status: res.status });
  }
  return new NextResponse(null, { status: 204 });
}
