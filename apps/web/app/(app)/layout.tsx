import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isNextInternalControlFlowError } from "@/lib/supabase/env";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { SidebarReopenButton } from "@/components/sidebar/SidebarReopenButton";
import { OnboardingModal } from "@/components/onboarding/OnboardingModal";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // createClient() throws if Supabase env vars are missing/invalid — fail
  // closed to /login (same as an unauthenticated user) rather than 500
  // every protected route nested under this layout. See lib/supabase/env.ts.
  let user = null;
  try {
    const supabase = await createClient();
    ({
      data: { user },
    } = await supabase.auth.getUser());
  } catch (err) {
    if (isNextInternalControlFlowError(err)) throw err;
    console.error("[(app)/layout] Supabase unavailable, treating as logged out:", err);
  }

  if (!user) {
    redirect("/login");
  }

  // full_name IS NULL is the onboarding-needed signal (set once, by
  // POST /account/profile) — covers both email/password and Google OAuth
  // signups uniformly, since both land here regardless of which auth path
  // they came through.
  //
  // FAILS OPEN, and the `error` check is what actually makes that true.
  // supabase-js resolves with { data: null, error } instead of throwing,
  // so the try/catch below never fires on a query error — which meant a
  // failed lookup produced `!null?.full_name` === true and showed the
  // modal to EVERY signed-in user. OnboardingModal has no dismiss control
  // and its save would fail for the same underlying reason, so that
  // combination locked the whole app behind an uncompletable dialog
  // (observed live when the columns were missing from the database).
  // Only a lookup that genuinely succeeds and genuinely has no name may
  // gate the app.
  let needsOnboarding = false;
  let avatarUrl: string | null = null;
  try {
    const supabase = await createClient();
    const { data: profile, error } = await supabase
      .from("users")
      .select("full_name, avatar_path")
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      console.error("[(app)/layout] full_name lookup failed, skipping onboarding gate for this request:", error);
    } else {
      needsOnboarding = !profile?.full_name;
      if (profile?.avatar_path) avatarUrl = supabase.storage.from("avatars").getPublicUrl(profile.avatar_path).data.publicUrl;
    }
  } catch (err) {
    if (isNextInternalControlFlowError(err)) throw err;
    console.error("[(app)/layout] full_name lookup threw, skipping onboarding gate for this request:", err);
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar email={user.email ?? ""} avatarUrl={avatarUrl} />
      <SidebarReopenButton />
      <main className="min-w-0 flex-1">{children}</main>
      {needsOnboarding && <OnboardingModal />}
    </div>
  );
}
