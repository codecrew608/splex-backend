import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isNextInternalControlFlowError } from "@/lib/supabase/env";

// The auth check below is usually fast enough that app/loading.tsx (the
// branded splash) would flash by unnoticed or not render at all — this
// floor makes sure it's actually seen for a beat before handing off to
// /login or /chat, rather than being a fallback that mostly never shows.
// Deliberate, bounded cost paid once per fresh visit, not on every
// navigation within the app.
const MIN_SPLASH_MS = 500;

export default async function RootPage() {
  // createClient() throws if Supabase env vars are missing/invalid — fail
  // closed to /login rather than 500 the entire site's landing route over
  // a config problem. Same reasoning as middleware.ts; see lib/supabase/env.ts.
  let user = null;
  const started = Date.now();
  try {
    const supabase = await createClient();
    ({
      data: { user },
    } = await supabase.auth.getUser());
  } catch (err) {
    if (isNextInternalControlFlowError(err)) throw err;
    console.error("[/] Supabase unavailable, treating as logged out:", err);
  }

  const elapsed = Date.now() - started;
  if (elapsed < MIN_SPLASH_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_SPLASH_MS - elapsed));
  }

  redirect(user ? "/chat" : "/login");
}
