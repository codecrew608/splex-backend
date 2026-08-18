"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { getSupabaseEnv } from "@/lib/supabase/env";

// Checked proactively on mount, not just discovered when someone clicks
// submit and createClient() throws deep inside a try/catch. A missing/
// invalid NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY on
// this build otherwise looks indistinguishable from "the button doesn't
// do anything" — this makes that specific failure mode impossible to
// mistake for a network/CORS issue, both for real users and for
// debugging in production. Renders nothing at all when config is fine —
// this is not a decorative element that always shows.
export function SupabaseConfigWarning() {
  const [misconfigured, setMisconfigured] = useState(false);

  useEffect(() => {
    if (!getSupabaseEnv()) {
      setMisconfigured(true);
      // eslint-disable-next-line no-console
      console.error(
        "[SPLEX] NEXT_PUBLIC_SUPABASE_URL and/or NEXT_PUBLIC_SUPABASE_ANON_KEY are missing or invalid on this build. Sign-in/sign-up cannot work until these are set in the deployment platform's environment variables and the app is rebuilt — NEXT_PUBLIC_* values are baked in at build time, not read at runtime.",
      );
    }
  }, []);

  if (!misconfigured) return null;

  return (
    <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/10 px-3.5 py-3 text-left text-[13px] text-danger">
      <AlertTriangle size={15} strokeWidth={1.8} className="mt-0.5 shrink-0" />
      <span>
        This deployment is missing its Supabase configuration, so sign-in and sign-up can&apos;t work right now.
        (Developer: set <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> /{" "}
        <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> and redeploy.)
      </span>
    </div>
  );
}
