import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// GET /api/employees
// Returns list of active employee display names.
// Requires authentication (any role).
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/users?role=eq.employee&is_active=eq.true&select=name&order=name.asc`,
    {
      headers: {
        apikey:         SUPABASE_KEY,
        Authorization:  `Bearer ${SUPABASE_KEY}`,
        Accept:         "application/json",
      },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    return NextResponse.json({ error: `Supabase error ${res.status}` }, { status: 500 });
  }

  const rows = await res.json() as { name: string }[];
  return NextResponse.json(rows.map((r) => r.name));
}
