"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();

  // "loading" = exchanging the code, "ready" = show form, "error" = bad/missing code
  const [stage, setStage]           = useState<"loading" | "ready" | "error">("loading");
  const [password, setPassword]     = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [saving, setSaving]         = useState(false);
  const [formError, setFormError]   = useState<string | null>(null);
  const [done, setDone]             = useState(false);

  // Exchange the one-time code that Supabase appended to the URL.
  // The Supabase browser client may auto-exchange the code on init, making a
  // second call fail with "code already used". So we fall back to checking
  // whether a session was established anyway.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("code");
    if (!code) { setStage("error"); return; }

    const supabase = createClient();
    supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
      if (!error) { setStage("ready"); return; }
      // Exchange failed — check if the client already established a session
      supabase.auth.getSession().then(({ data: { session } }) => {
        setStage(session ? "ready" : "error");
      });
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!password || !confirmPwd) { setFormError("יש למלא את שני השדות"); return; }
    if (password !== confirmPwd)  { setFormError("הסיסמאות אינן תואמות"); return; }
    if (password.length < 6)      { setFormError("הסיסמה חייבת להכיל לפחות 6 תווים"); return; }

    setSaving(true);
    try {
      const { error } = await createClient().auth.updateUser({ password });
      if (error) { setFormError(error.message); return; }
      setDone(true);
      setTimeout(() => router.replace("/login"), 2500);
    } catch {
      setFormError("שגיאה באיפוס הסיסמה — נסה שוב");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-br from-blue-50 to-gray-100 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">

        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 mb-4">
            <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-800">איפוס סיסמה</h1>
        </div>

        <div className="bg-white rounded-2xl shadow-md p-8">
          {stage === "loading" && (
            <p className="text-sm text-gray-500 text-center">מאמת קישור...</p>
          )}

          {stage === "error" && (
            <div className="space-y-4">
              <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-center">
                הקישור אינו תקף או פג תוקפו. יש לבקש קישור חדש.
              </p>
              <button
                onClick={() => router.replace("/login")}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl py-2.5 text-sm transition-colors"
              >
                חזרה לכניסה
              </button>
            </div>
          )}

          {stage === "ready" && !done && (
            <form onSubmit={handleSubmit} className="space-y-4">
              {formError && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                  {formError}
                </div>
              )}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">סיסמה חדשה</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="לפחות 6 תווים"
                  autoComplete="new-password"
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">אימות סיסמה</label>
                <input
                  type="password"
                  value={confirmPwd}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
              <button
                type="submit"
                disabled={saving}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-2.5 text-sm transition-colors"
              >
                {saving ? "מעדכן..." : "עדכן סיסמה"}
              </button>
            </form>
          )}

          {done && (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-center">
              הסיסמה עודכנה בהצלחה! מועבר לדף הכניסה...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
