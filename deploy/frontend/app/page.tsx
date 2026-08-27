import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isNextInternalControlFlowError } from "@/lib/supabase/env";
import { LandingPage } from "@/components/landing/LandingPage";

export default async function RootPage() {
  // createClient() throws if Supabase env vars are missing/invalid — fail
  // OPEN to the landing page rather than 500 the site's front door over a
  // config problem. A logged-out visitor and a visitor we can't identify
  // should see the same thing, so there's nothing to leak here. Same
  // reasoning as middleware.ts; see lib/supabase/env.ts.
  let user = null;
  try {
    const supabase = await createClient();
    ({
      data: { user },
    } = await supabase.auth.getUser());
  } catch (err) {
    if (isNextInternalControlFlowError(err)) throw err;
    console.error("[/] Supabase unavailable, treating as logged out:", err);
  }

  // Signed-in users skip the marketing page entirely and land in the
  // product — being made to click past a pitch you've already accepted is
  // exactly the friction that makes a returning user bounce. Signed-out
  // visitors get the landing page itself, NOT a redirect to /login: the
  // whole point of having one is that the front door explains the product
  // before asking for credentials.
  if (user) redirect("/chat");

  // The 500ms splash floor that used to live here is gone with the
  // redirect it existed to justify — app/loading.tsx still covers the
  // genuine wait, and deliberately delaying a page that now renders real
  // content would just be a slower first paint.
  return <LandingPage />;
}
