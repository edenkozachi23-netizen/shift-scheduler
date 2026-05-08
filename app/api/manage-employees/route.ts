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

type UserRow = {
  id: string;
  name: string;
  role: string;
  is_active: boolean;
};

// ─── GET /api/manage-employees ────────────────────────────────────────────────
// Manager only. Returns all users from public.users.
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (user.user_metadata?.role !== "manager") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/users?select=id,name,role,is_active&order=name.asc`,
    { headers: dbHeaders(), cache: "no-store" }
  );

  if (!res.ok) {
    const body = await res.text();
    return NextResponse.json({ error: `Supabase error ${res.status}: ${body}` }, { status: res.status });
  }

  const rows = (await res.json()) as UserRow[];
  return NextResponse.json(rows);
}

// ─── PATCH /api/manage-employees ─────────────────────────────────────────────
// Manager only. Updates a single field (is_active or role) for the given user.
// Cannot change own role.
export async function PATCH(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (user.user_metadata?.role !== "manager") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await request.json()) as {
    id: string;
    field: "is_active" | "role";
    value: boolean | string;
  };

  const { id, field, value } = body;

  if (!id || !field || value === undefined) {
    return NextResponse.json({ error: "Missing required fields: id, field, value" }, { status: 400 });
  }

  if (field !== "is_active" && field !== "role") {
    return NextResponse.json({ error: "field must be 'is_active' or 'role'" }, { status: 400 });
  }

  // Prevent manager from changing their own role
  if (field === "role" && id === user.id) {
    return NextResponse.json({ error: "Cannot change your own role" }, { status: 403 });
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/users?id=eq.${id}`,
    {
      method: "PATCH",
      headers: dbHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({ [field]: value }),
    }
  );

  if (!res.ok) {
    const resBody = await res.text();
    return NextResponse.json({ error: `Supabase error ${res.status}: ${resBody}` }, { status: res.status });
  }

  return NextResponse.json({ ok: true });
}
