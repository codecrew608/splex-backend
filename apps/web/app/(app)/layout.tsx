import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar/Sidebar";

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
    console.error("[(app)/layout] Supabase unavailable, treating as logged out:", err);
  }

  if (!user) {
    redirect("/login");
  }

  return (
    // No bg-background here, deliberately — the gradient canvas wash lives
    // on <body> (globals.css) and would otherwise be covered by this
    // wrapper across every page in the app (chat, projects, settings,
    // memory, upgrade). The sidebar is glass/translucent specifically so
    // it reads as chrome floating over that same canvas rather than a
    // flat opaque panel.
    <div className="flex h-screen overflow-hidden">
      <Sidebar email={user.email ?? ""} />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
