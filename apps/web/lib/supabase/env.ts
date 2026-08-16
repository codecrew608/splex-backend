// Centralized validation for the two env vars every Supabase client
// constructor in this app depends on. NEXT_PUBLIC_* vars are inlined at
// Next.js build time, so a missing/malformed value here means the deploy
// target's build ran without them configured, not a transient runtime
// fluke. Every call site gets one specific, actionable error/log instead
// of createServerClient's own cryptic low-level exception when handed
// `undefined` (e.g. attempting `new URL(undefined)`) — that exception,
// uncaught inside middleware specifically, is what surfaces on Vercel as
// MIDDLEWARE_INVOCATION_FAILED, since middleware runs on every request and
// has no page-level error boundary to catch it.
export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Non-throwing — for call sites (middleware) where a config problem must
// degrade gracefully rather than take the whole site down.
export function getSupabaseEnv(): SupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey || !isValidHttpUrl(url)) {
    return null;
  }
  return { url, anonKey };
}

// Throwing — for call sites (Server/Client Component Supabase client
// creation) where a single broken page failing loudly and specifically is
// preferable to a cryptic downstream stack trace, and where failing that
// one page doesn't bring down the rest of the site the way a middleware
// crash does.
export function requireSupabaseEnv(): SupabaseEnv {
  const env = getSupabaseEnv();
  if (!env) {
    throw new Error(
      "Supabase is not configured: NEXT_PUBLIC_SUPABASE_URL and/or NEXT_PUBLIC_SUPABASE_ANON_KEY are missing or invalid for this build. Set both in your deployment platform's environment variables and redeploy.",
    );
  }
  return env;
}
