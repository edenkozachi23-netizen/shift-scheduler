import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

/**
 * Handles the OAuth / email-confirmation redirect from Supabase.
 * Supabase sends the user back to /api/auth/callback?code=xxx after they
 * click the confirmation link in their email.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Exchange failed — send back to login with an error flag
  return NextResponse.redirect(`${origin}/login?error=confirmation_failed`);
}
