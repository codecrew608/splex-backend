import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function RootPage() {
  // createClient() throws if Supabase env vars are missing/invalid — fail
  // closed to /login rather than 500 the entire site's landing route over
  // a config problem. Same reasoning as middleware.ts; see lib/supabase/env.ts.
  let user = null;
  try {
    const supabase = await createClient();
    ({
      data: { user },
    } = await supabase.auth.getUser());
  } catch (err) {
    console.error("[/] Supabase unavailable, treating as logged out:", err);
  }

  redirect(user ? "/chat" : "/login");
}
