import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isNextInternalControlFlowError } from "@/lib/supabase/env";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { SidebarReopenButton } from "@/components/sidebar/SidebarReopenButton";

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

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar email={user.email ?? ""} />
      <SidebarReopenButton />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
