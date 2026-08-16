import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "./lib/supabase/env";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const env = getSupabaseEnv();
  if (!env) {
    // Middleware runs on every request with no page-level error boundary —
    // an uncaught exception here (e.g. createServerClient constructing a
    // URL from `undefined`) takes the entire site down as
    // MIDDLEWARE_INVOCATION_FAILED, not just one route. A missing/invalid
    // Supabase env var is a deploy misconfiguration, not a reason to 500
    // every page: log it clearly and pass the request through unauthenticated
    // — actual authorization still happens where it always has, in each
    // protected route's own server-side `redirect("/login")` check (see
    // app/(app)/layout.tsx). This only degrades session-refresh
    // convenience, never removes that enforcement.
    console.error(
      "[middleware] Supabase env vars missing/invalid — skipping session refresh. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your deployment platform and redeploy.",
    );
    return response;
  }

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // Refresh the session if expired — required for Server Components, which
  // can't set cookies themselves.
  try {
    await supabase.auth.getUser();
  } catch (err) {
    // Network/upstream Supabase failure — same reasoning as above, don't
    // take the whole site down over a session-refresh call failing.
    console.error("[middleware] supabase.auth.getUser() failed:", err);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
