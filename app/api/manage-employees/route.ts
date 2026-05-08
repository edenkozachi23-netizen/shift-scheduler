import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPER_MANAGER_EMAIL = process.env.NEXT_PUBLIC_SUPER_MANAGER_EMAIL ?? "";

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
// Accepts flat body: { id, is_active?, role? }
// Cannot change own role or touch the super-manager's role/active status.
export async function PATCH(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (user.user_metadata?.role !== "manager") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await request.json()) as {
    id: string;
    is_active?: boolean;
    role?: string;
  };

  const { id, is_active, role } = body;

  if (!id) return NextResponse.json({ error: "Missing required field: id" }, { status: 400 });
  if (is_active === undefined && role === undefined) {
    return NextResponse.json({ error: "Must provide is_active or role" }, { status: 400 });
  }

  // Prevent manager from changing their own role
  if (role !== undefined && id === user.id) {
    return NextResponse.json({ error: "Cannot change your own role" }, { status: 403 });
  }

  // Protect super manager from role changes or deactivation
  if (SUPER_MANAGER_EMAIL) {
    // Fetch the target user's email from auth to compare
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceKey) {
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        cache: "no-store",
      });
      if (authRes.ok) {
        const authUser = await authRes.json() as { email?: string };
        if (authUser.email?.toLowerCase() === SUPER_MANAGER_EMAIL.toLowerCase()) {
          return NextResponse.json({ error: "לא ניתן לשנות הרשאות מנהל ראשי" }, { status: 403 });
        }
      }
    }
  }

  const updateFields: Record<string, unknown> = {};
  if (is_active !== undefined) updateFields.is_active = is_active;
  if (role !== undefined) updateFields.role = role;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/users?id=eq.${id}`,
    {
      method: "PATCH",
      headers: dbHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify(updateFields),
    }
  );

  if (!res.ok) {
    const resBody = await res.text();
    return NextResponse.json({ error: `Supabase error ${res.status}: ${resBody}` }, { status: res.status });
  }

  return NextResponse.json({ ok: true });
}
