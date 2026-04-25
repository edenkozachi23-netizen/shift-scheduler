"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Display names that exist in the scheduling system.
// Employees must choose one of these so their constraints and shifts match.
const KNOWN_DISPLAY_NAMES = [
  "עדן", "נועה", "שחר", "מאיה", "רון", "דניאל", "יובל", "עמית",
];

type Mode = "login" | "register";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [mode, setMode]               = useState<Mode>("login");
  const [email, setEmail]             = useState("");
  const [password, setPassword]       = useState("");
  const [confirmPwd, setConfirmPwd]   = useState("");
  const [fullName, setFullName]       = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole]               = useState<"employee" | "manager">("employee");

  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [info, setInfo]               = useState<string | null>(null);

  // Show error from callback (e.g. confirmation failure)
  useEffect(() => {
    if (searchParams.get("error")) setError("שגיאה בכניסה — נסה שוב");
  }, [searchParams]);

  function reset() {
    setError(null);
    setInfo(null);
  }

  // ── Login ────────────────────────────────────────────────────────────────────
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    reset();
    if (!email || !password) { setError("יש למלא אימייל וסיסמה"); return; }
    setLoading(true);
    try {
      const supabase = createClient();
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email, password,
      });
      if (authError) { setError(authError.message); return; }

      const role = data.user?.user_metadata?.role as string | undefined;
      router.replace(role === "manager" ? "/manager/dashboard" : "/employee/dashboard");
    } catch {
      setError("שגיאה בהתחברות — נסה שוב");
    } finally {
      setLoading(false);
    }
  }

  // ── Register ─────────────────────────────────────────────────────────────────
  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    reset();
    if (!email || !password || !fullName || !displayName) {
      setError("יש למלא את כל השדות");
      return;
    }
    if (password !== confirmPwd) {
      setError("הסיסמאות אינן תואמות");
      return;
    }
    if (password.length < 6) {
      setError("הסיסמה חייבת להכיל לפחות 6 תווים");
      return;
    }

    setLoading(true);
    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name:    fullName,
            display_name: displayName,
            role,
          },
          emailRedirectTo: `${window.location.origin}/api/auth/callback`,
        },
      });
      if (authError) { setError(authError.message); return; }
      setInfo("נשלח אימייל אימות — בדוק את תיבת הדואר שלך ולחץ על הקישור להשלמת ההרשמה.");
      setMode("login");
    } catch {
      setError("שגיאה ברישום — נסה שוב");
    } finally {
      setLoading(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-br from-blue-50 to-gray-100 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">

        {/* Logo / title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 mb-4">
            <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-800">מערכת סידור עבודה</h1>
          <p className="text-gray-500 text-sm mt-1">
            {mode === "login" ? "כניסה למערכת" : "הרשמה למערכת"}
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-md p-8 space-y-5">

          {/* Mode toggle */}
          <div className="flex rounded-xl overflow-hidden border border-gray-200">
            {(["login", "register"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); reset(); }}
                className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${
                  mode === m
                    ? "bg-blue-600 text-white"
                    : "bg-white text-gray-500 hover:bg-gray-50"
                }`}
              >
                {m === "login" ? "כניסה" : "הרשמה"}
              </button>
            ))}
          </div>

          {/* Error / info banners */}
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              {error}
            </div>
          )}
          {info && (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
              {info}
            </div>
          )}

          {/* ── LOGIN FORM ───────────────────────────────────────────────────── */}
          {mode === "login" && (
            <form onSubmit={handleLogin} className="space-y-4">
              <Field label="אימייל">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  autoComplete="email"
                  className={INPUT}
                />
              </Field>

              <Field label="סיסמה">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className={INPUT}
                />
              </Field>

              <button type="submit" disabled={loading} className={BTN_PRIMARY}>
                {loading ? "מתחבר..." : "כניסה"}
              </button>
            </form>
          )}

          {/* ── REGISTER FORM ────────────────────────────────────────────────── */}
          {mode === "register" && (
            <form onSubmit={handleRegister} className="space-y-4">
              <Field label="שם מלא">
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="ישראל ישראלי"
                  autoComplete="name"
                  className={INPUT}
                />
              </Field>

              <Field
                label="שם בסידור"
                hint="חייב להתאים לשם שלך ברשימת העובדים"
              >
                <select
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className={INPUT}
                >
                  <option value="">— בחר שם —</option>
                  {KNOWN_DISPLAY_NAMES.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </Field>

              <Field label="תפקיד">
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as "employee" | "manager")}
                  className={INPUT}
                >
                  <option value="employee">עובד</option>
                  <option value="manager">מנהל</option>
                </select>
                <p className="text-xs text-amber-600 mt-1">
                  בסביבת ייצור, תפקיד מנהל מוענק על-ידי מנהל המערכת בלבד.
                </p>
              </Field>

              <Field label="אימייל">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  autoComplete="email"
                  className={INPUT}
                />
              </Field>

              <Field label="סיסמה">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="לפחות 6 תווים"
                  autoComplete="new-password"
                  className={INPUT}
                />
              </Field>

              <Field label="אימות סיסמה">
                <input
                  type="password"
                  value={confirmPwd}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  className={INPUT}
                />
              </Field>

              <button type="submit" disabled={loading} className={BTN_PRIMARY}>
                {loading ? "נרשם..." : "הרשמה"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────────────

const INPUT = "w-full border border-gray-300 rounded-xl px-3 py-2 text-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400";
const BTN_PRIMARY = "w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-2.5 text-sm transition-colors";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-gray-700">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400">{hint}</p>}
    </div>
  );
}
