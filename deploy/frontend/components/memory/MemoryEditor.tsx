"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export interface MemoryFactRow {
  id: string;
  fact: string;
}

interface MemoryEditorProps {
  userId: string;
  initialFacts: MemoryFactRow[];
  // The old free-text blob (user_memory.summary_text) — see migration
  // 0037's own comment for why it still exists: real, already-accumulated
  // memory for users who had it before this structured model shipped.
  // Shown, and clearable, separately — never silently dropped.
  initialLegacySummary: string;
  initialMemoryEnabled: boolean;
}

// Individual, deletable memories — not a single free-text blob. "Delete
// one fact" has no honest implementation against a paragraph an LLM
// wrote; this is why user_memories (migration 0037) exists as separate
// rows. Every write here is a DELETE against a table the client only has
// SELECT/DELETE grants on (see that migration) — the client can remove a
// memory, never invent or edit one; only the server's extraction pipeline
// (service role) ever adds or changes a fact's text.
export function MemoryEditor({ userId, initialFacts, initialLegacySummary, initialMemoryEnabled }: MemoryEditorProps) {
  const [facts, setFacts] = useState(initialFacts);
  const [legacySummary, setLegacySummary] = useState(initialLegacySummary);
  const [memoryEnabled, setMemoryEnabled] = useState(initialMemoryEnabled);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);

  async function handleDeleteOne(id: string) {
    setBusyId(id);
    const supabase = createClient();
    const { error } = await supabase.from("user_memories").delete().eq("id", id).eq("user_id", userId);
    setBusyId(null);
    if (!error) setFacts((prev) => prev.filter((f) => f.id !== id));
  }

  async function handleClearAll() {
    if (facts.length === 0 && !legacySummary) return;
    if (!window.confirm("Clear everything SPLEX remembers about you? This can't be undone.")) return;
    setClearingAll(true);
    const supabase = createClient();
    const [{ error: factsError }] = await Promise.all([
      supabase.from("user_memories").delete().eq("user_id", userId),
      legacySummary ? supabase.from("user_memory").update({ summary_text: "" }).eq("user_id", userId) : Promise.resolve({ error: null }),
    ]);
    setClearingAll(false);
    if (!factsError) {
      setFacts([]);
      setLegacySummary("");
    }
  }

  async function handleClearLegacy() {
    setClearingAll(true);
    const supabase = createClient();
    const { error } = await supabase.from("user_memory").update({ summary_text: "" }).eq("user_id", userId);
    setClearingAll(false);
    if (!error) setLegacySummary("");
  }

  async function handleToggleEnabled() {
    const next = !memoryEnabled;
    setTogglingEnabled(true);
    const supabase = createClient();
    const { error } = await supabase.from("users").update({ memory_enabled: next }).eq("id", userId);
    setTogglingEnabled(false);
    if (!error) setMemoryEnabled(next);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-surface p-3">
        <div>
          <p className="text-sm font-medium text-foreground">Remember things about me</p>
          <p className="text-xs text-muted-foreground">
            {memoryEnabled
              ? "SPLEX can save durable facts you share (like your name or preferences) and use them in future conversations."
              : "SPLEX will not save new memories or use existing ones — your saved memories below are kept, just unused, until you turn this back on."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={memoryEnabled}
          onClick={handleToggleEnabled}
          disabled={togglingEnabled}
          className={cn(
            "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50",
            memoryEnabled ? "bg-accent" : "bg-border-strong",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform",
              memoryEnabled ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      {facts.length === 0 && !legacySummary ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          Nothing remembered yet — SPLEX picks up durable facts (your name, preferences, ongoing projects) as you
          chat, or tell it directly: &quot;Remember that I…&quot;
        </p>
      ) : (
        <div className="space-y-2">
          {facts.map((f) => (
            <div key={f.id} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
              <p className="text-sm text-foreground">{f.fact}</p>
              <button
                type="button"
                onClick={() => handleDeleteOne(f.id)}
                disabled={busyId === f.id}
                title="Forget this"
                aria-label="Forget this"
                className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-hover hover:text-danger disabled:opacity-50"
              >
                <X size={14} />
              </button>
            </div>
          ))}

          {legacySummary && (
            <div className="space-y-2 rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Imported from your earlier memory</p>
                <Button variant="secondary" onClick={handleClearLegacy} disabled={clearingAll}>
                  Clear
                </Button>
              </div>
              <p className="whitespace-pre-wrap text-sm text-foreground">{legacySummary}</p>
            </div>
          )}
        </div>
      )}

      {(facts.length > 0 || legacySummary) && (
        <Button variant="secondary" onClick={handleClearAll} disabled={clearingAll}>
          {clearingAll ? "Clearing..." : "Clear all memory"}
        </Button>
      )}
    </div>
  );
}
