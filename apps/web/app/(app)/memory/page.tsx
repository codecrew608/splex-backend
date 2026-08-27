import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MemoryEditor } from "@/components/memory/MemoryEditor";

export default async function MemoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: memoryRow } = await supabase.from("user_memory").select("summary_text").eq("user_id", user.id).single();

  return (
    <div className="mx-auto h-dvh max-w-2xl overflow-y-auto px-4 pb-10 pt-14 sm:px-6 sm:pt-10">
      <h1 className="text-xl font-semibold text-foreground">Memory</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        What SPLEX remembers about you across conversations — preferences, ongoing projects, how you like things
        done. It updates itself as you chat; you can edit or clear it any time.
      </p>

      <div className="mt-6">
        <MemoryEditor userId={user.id} initialSummary={memoryRow?.summary_text ?? ""} />
      </div>
    </div>
  );
}
