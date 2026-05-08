import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const dbHeaders = (extra?: Record<string, string>) => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
  ...extra,
});

async function requireManager() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  if (user.user_metadata?.role !== "manager") return null;
  return user;
}

// GET — any authenticated user
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ error: "Missing Supabase env vars" }, { status: 500 });
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/shift_types?select=id,name,period,start_time,end_time&order=period.asc,start_time.asc`,
    { headers: dbHeaders(), cache: "no-store" }
  );

  const body = await res.text();
  if (!res.ok) {
    return NextResponse.json({ error: `Supabase error ${res.status}: ${body}` }, { status: res.status });
  }

  return NextResponse.json(JSON.parse(body));
}

// POST — manager only. Body: { name, period, start_time, end_time }
export async function POST(request: Request) {
  const mgr = await requireManager();
  if (!mgr) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { name, period, start_time, end_time } = await request.json() as {
    name: string; period: string; start_time: string; end_time: string;
  };

  if (!name || !period || !start_time || !end_time) {
    return NextResponse.json({ error: "Missing required fields: name, period, start_time, end_time" }, { status: 400 });
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/shift_types`, {
    method: "POST",
    headers: dbHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({ name, period, start_time, end_time }),
  });

  const body = await res.text();
  if (!res.ok) return NextResponse.json({ error: `Supabase error ${res.status}: ${body}` }, { status: res.status });
  return NextResponse.json(JSON.parse(body)[0], { status: 201 });
}

// PATCH — manager only. Body: { id, ...fields }
export async function PATCH(request: Request) {
  const mgr = await requireManager();
  if (!mgr) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id, ...fields } = await request.json() as { id: number; name?: string; period?: string; start_time?: string; end_time?: string };
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const res = await fetch(`${SUPABASE_URL}/rest/v1/shift_types?id=eq.${id}`, {
    method: "PATCH",
    headers: dbHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(fields),
  });

  const body = await res.text();
  if (!res.ok) return NextResponse.json({ error: `Supabase error ${res.status}: ${body}` }, { status: res.status });
  return NextResponse.json(JSON.parse(body)[0]);
}

// DELETE — manager only. Query: ?id=xxx
export async function DELETE(request: Request) {
  const mgr = await requireManager();
  if (!mgr) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const res = await fetch(`${SUPABASE_URL}/rest/v1/shift_types?id=eq.${id}`, {
    method: "DELETE",
    headers: dbHeaders(),
  });

  if (!res.ok) {
    const body = await res.text();
    return NextResponse.json({ error: `Supabase error ${res.status}: ${body}` }, { status: res.status });
  }
  return new NextResponse(null, { status: 204 });
}
