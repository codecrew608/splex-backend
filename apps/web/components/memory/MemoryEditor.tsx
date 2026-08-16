"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";

export function MemoryEditor({ userId, initialSummary }: { userId: string; initialSummary: string }) {
  const [value, setValue] = useState(initialSummary);
  const [saved, setSaved] = useState(true);
  const [loading, setLoading] = useState(false);

  async function handleSave() {
    setLoading(true);
    const supabase = createClient();
    await supabase.from("user_memory").update({ summary_text: value }).eq("user_id", userId);
    setLoading(false);
    setSaved(true);
  }

  async function handleClear() {
    if (!window.confirm("Clear everything SPLEX remembers about you? This can't be undone.")) return;
    setLoading(true);
    const supabase = createClient();
    await supabase.from("user_memory").update({ summary_text: "" }).eq("user_id", userId);
    setValue("");
    setLoading(false);
    setSaved(true);
  }

  return (
    <div className="space-y-3">
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        rows={12}
        placeholder="Nothing remembered yet — SPLEX picks up durable facts (preferences, ongoing projects, how you like to work) as you chat, or you can write your own here."
        className="w-full resize-y rounded-2xl border border-border bg-surface p-4 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:shadow-[0_0_0_3px_var(--accent-soft)]"
      />
      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={loading || saved}>
          {loading ? "Saving..." : saved ? "Saved" : "Save changes"}
        </Button>
        <Button variant="secondary" onClick={handleClear} disabled={loading || !value}>
          Clear memory
        </Button>
      </div>
    </div>
  );
}
