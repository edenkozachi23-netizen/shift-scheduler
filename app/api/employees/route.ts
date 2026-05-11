import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { EMPLOYEES as STATIC_EMPLOYEES } from "@/lib/employees";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // ── Source 1 (best): auth.users admin API via service role key ────────────
  // Bypasses RLS, always up-to-date, no public.users dependency.
  if (SERVICE_KEY) {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?per_page=200`,
      {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        cache: "no-store",
      }
    );
    if (res.ok) {
      const { users: authUsers } = await res.json() as {
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
      if (names.length > 0) return NextResponse.json(names);
    }
  }

  // ── Source 2: public.users table via authenticated Supabase client ────────
  const { data: usersData } = await supabase
    .from("users")
    .select("name")
    .eq("role", "employee")
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (usersData && usersData.length > 0) {
    return NextResponse.json(usersData.map((r) => (r as { name: string }).name));
  }

  // ── Source 3 (fallback): distinct employee_ids from constraints table ─────
  // Works even if public.users is empty, as long as someone submitted constraints.
  // Use service role key to bypass RLS.
  const fallbackKey = SERVICE_KEY ?? SUPABASE_KEY;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/employee_constraints?select=employee_id&order=employee_id.asc`,
    {
      headers: {
        apikey: fallbackKey,
        Authorization: `Bearer ${fallbackKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
    }
  );
  if (res.ok) {
    const rows = (await res.json()) as { employee_id: string }[];
    const names = Array.from(new Set(rows.map((r) => r.employee_id))).sort((a, b) =>
      a.localeCompare(b, "he")
    );
    if (names.length > 0) return NextResponse.json(names);
  }

  // ── Source 4 (final fallback): static employee list from lib/employees.ts ──
  return NextResponse.json([...STATIC_EMPLOYEES].sort((a, b) => a.localeCompare(b, "he")));
}
