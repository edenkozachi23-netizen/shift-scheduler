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

type PublishedWeekRow = {
  week_start: string;
  published_at: string | null;
};

// ─── GET /api/publish-schedule?week_start=YYYY-MM-DD ─────────────────────────
// Any authenticated user. Returns published status for the given week.
export async function GET(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const week_start = searchParams.get("week_start");

  if (!week_start) {
    return NextResponse.json({ error: "Missing query param: week_start" }, { status: 400 });
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/published_weeks?week_start=eq.${week_start}&select=week_start,published_at`,
    { headers: dbHeaders(), cache: "no-store" }
  );

  if (!res.ok) {
    const body = await res.text();
    return NextResponse.json({ error: `Supabase error ${res.status}: ${body}` }, { status: res.status });
  }

  const rows = (await res.json()) as PublishedWeekRow[];

  if (rows.length === 0) {
    return NextResponse.json({ published: false, published_at: null });
  }

  return NextResponse.json({ published: true, published_at: rows[0].published_at });
}

// ─── POST /api/publish-schedule ───────────────────────────────────────────────
// Manager only. Upserts a row into public.published_weeks and emails active employees.
//
// Required env vars for email:
//   SUPABASE_SERVICE_ROLE_KEY — to list auth user emails
//   RESEND_API_KEY            — Resend API key (https://resend.com)
//   RESEND_FROM_EMAIL         — verified sender, e.g. "shifts@yourdomain.com"
//   NEXT_PUBLIC_APP_URL       — public URL for the app link in the email
//
// If RESEND_API_KEY is absent, the schedule is published without sending emails.
export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (user.user_metadata?.role !== "manager") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await request.json()) as { week_start: string };
  const { week_start } = body;

  if (!week_start) {
    return NextResponse.json({ error: "Missing required field: week_start" }, { status: 400 });
  }

  // 1. Upsert into published_weeks (idempotent — re-publishing is fine)
  const pubRes = await fetch(`${SUPABASE_URL}/rest/v1/published_weeks`, {
    method: "POST",
    headers: dbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ week_start }),
  });

  if (!pubRes.ok) {
    const resBody = await pubRes.text();
    return NextResponse.json({ error: `Supabase error ${pubRes.status}: ${resBody}` }, { status: pubRes.status });
  }

  // 2. Send email notifications (optional — skipped if env vars are absent)
  const resendKey  = process.env.RESEND_API_KEY;
  const fromEmail  = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL ?? "";

  let emailsSent = 0;
  let emailError: string | null = null;

  if (resendKey && serviceKey) {
    try {
      // Fetch all auth users via admin API
      const usersRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        cache: "no-store",
      });

      if (usersRes.ok) {
        const { users: authUsers } = await usersRes.json() as {
          users: { id: string; email: string; user_metadata: Record<string, unknown> }[];
        };

        const activeEmployees = authUsers.filter(
          (u) => u.user_metadata?.role === "employee" && u.email
        );

        // Build week label (e.g. "11/5–17/5")
        const [y, m, d] = week_start.split("-").map(Number);
        const weekEndDate = new Date(y, m - 1, d + 6);
        const wEnd = `${weekEndDate.getFullYear()}-${String(weekEndDate.getMonth() + 1).padStart(2, "0")}-${String(weekEndDate.getDate()).padStart(2, "0")}`;
        const fmt  = (iso: string) => { const [, mo, dy] = iso.split("-"); return `${parseInt(dy)}/${parseInt(mo)}`; };
        const weekLabel = `${fmt(week_start)}–${fmt(wEnd)}`;

        const results = await Promise.allSettled(
          activeEmployees.map((emp) =>
            fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: fromEmail,
                to:   emp.email,
                subject: `סידור עבודה שבוע ${weekLabel} פורסם`,
                html: `
                  <div dir="rtl" style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
                    <h2 style="color:#1d4ed8;margin-bottom:8px">סידור עבודה — שבוע ${weekLabel}</h2>
                    <p>שלום ${(emp.user_metadata?.display_name as string) ?? ""},</p>
                    <p>הסידור לשבוע <strong>${weekLabel}</strong> פורסם ומוכן לצפייה.</p>
                    ${appUrl ? `<p><a href="${appUrl}/employee/dashboard" style="display:inline-block;background:#1d4ed8;color:white;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:bold;">צפה בסידור שלי</a></p>` : ""}
                    <p style="color:#9ca3af;font-size:0.85em;margin-top:24px">נשלח ממערכת ניהול סידורי עבודה</p>
                  </div>
                `,
              }),
            })
          )
        );

        emailsSent = results.filter((r) => r.status === "fulfilled").length;
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) emailError = `${failed} מיילים לא נשלחו`;
      }
    } catch (err) {
      emailError = err instanceof Error ? err.message : "שגיאה בשליחת מיילים";
    }
  }

  return NextResponse.json({ ok: true, emailsSent, emailError });
}
