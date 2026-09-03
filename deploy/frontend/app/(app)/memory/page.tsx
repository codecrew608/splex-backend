import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MemoryEditor } from "@/components/memory/MemoryEditor";

export default async function MemoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: factRows }, { data: memoryRow }, { data: profileRow }] = await Promise.all([
    supabase.from("user_memories").select("id, fact").eq("user_id", user.id).order("created_at", { ascending: false }),
    supabase.from("user_memory").select("summary_text").eq("user_id", user.id).maybeSingle(),
    supabase.from("users").select("memory_enabled").eq("id", user.id).maybeSingle(),
  ]);

  return (
    <div className="mx-auto h-dvh max-w-2xl overflow-y-auto px-4 pb-10 pt-14 sm:px-6 sm:pt-10">
      <h1 className="text-xl font-semibold text-foreground">Memory</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        What SPLEX remembers about you across conversations — preferences, ongoing projects, how you like things
        done. It updates itself as you chat; you can review or delete anything below, or turn it off entirely.
      </p>

      <div className="mt-6">
        <MemoryEditor
          userId={user.id}
          initialFacts={factRows ?? []}
          initialLegacySummary={memoryRow?.summary_text ?? ""}
          initialMemoryEnabled={profileRow?.memory_enabled !== false}
        />
      </div>
    </div>
  );
}
