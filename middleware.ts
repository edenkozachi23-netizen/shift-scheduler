import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  // We must build a fresh response and thread cookies through it so that
  // Supabase can refresh the session token when it's about to expire.
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: object }[]) {
          // Forward cookies to both the mutated request and the response so
          // that Server Components downstream can read the refreshed session.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as Parameters<typeof supabaseResponse.cookies.set>[2])
          );
        },
      },
    }
  );

  // IMPORTANT: always call getUser() — this refreshes the session and must
  // not be removed or the session will silently expire.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // ── Auth callback (email confirmation) — always allow ──────────────────────
  if (pathname.startsWith("/api/auth")) {
    return supabaseResponse;
  }

  // ── Reset password — user arrives with a one-time code, not yet authenticated
  if (pathname === "/reset-password") {
    return supabaseResponse;
  }

  // ── Other API routes — skip redirect, they return JSON ─────────────────────
  if (pathname.startsWith("/api/")) {
    return supabaseResponse;
  }

  // ── /login — redirect logged-in users to their dashboard ───────────────────
  if (pathname === "/login") {
    if (user) {
      const role = user.user_metadata?.role as string | undefined;
      return NextResponse.redirect(
        new URL(
          role === "manager" ? "/manager/dashboard" : "/employee/dashboard",
          request.url
        )
      );
    }
    return supabaseResponse;
  }

  // ── Root — redirect to dashboard or login ──────────────────────────────────
  if (pathname === "/") {
    if (!user) return NextResponse.redirect(new URL("/login", request.url));
    const role = user.user_metadata?.role as string | undefined;
    return NextResponse.redirect(
      new URL(
        role === "manager" ? "/manager/dashboard" : "/employee/dashboard",
        request.url
      )
    );
  }

  // ── All other routes: must be authenticated ───────────────────────────────
  if (!user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // ── Manager routes: require manager role ──────────────────────────────────
  if (pathname.startsWith("/manager")) {
    const role = user.user_metadata?.role as string | undefined;
    if (role !== "manager") {
      return NextResponse.redirect(new URL("/employee/dashboard", request.url));
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    // Match everything except Next.js internals and static files
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
