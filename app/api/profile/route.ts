import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

/**
 * GET /api/profile
 * Returns the current user's profile derived from their auth session.
 * No extra DB query needed — all fields are stored in user_metadata at signup.
 */
export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const meta = user.user_metadata ?? {};

  return NextResponse.json({
    id:          user.id,
    email:       user.email ?? "",
    fullName:    (meta.full_name    as string | undefined) ?? "",
    displayName: (meta.display_name as string | undefined) ?? "",
    role:        (meta.role         as string | undefined) ?? "employee",
  });
}
