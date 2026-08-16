import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar/Sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

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
