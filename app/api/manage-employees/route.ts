import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPER_MANAGER_EMAIL = process.env.NEXT_PUBLIC_SUPER_MANAGER_EMAIL ?? "";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (user.user_metadata?.role !== "manager") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("users")
    .select("id, name, role, is_active")
    .order("name", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function PATCH(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (user.user_metadata?.role !== "manager") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await request.json()) as { id: string; is_active?: boolean; role?: string };
  const { id, is_active, role } = body;

  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  if (is_active === undefined && role === undefined) {
    return NextResponse.json({ error: "Must provide is_active or role" }, { status: 400 });
  }

  if (role !== undefined && id === user.id) {
    return NextResponse.json({ error: "Cannot change your own role" }, { status: 403 });
  }

  // Protect super manager
  if (SUPER_MANAGER_EMAIL) {
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

  const { error } = await supabase.from("users").update(updateFields).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
