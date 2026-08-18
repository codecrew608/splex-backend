"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { BACKEND_URL } from "@/lib/backendUrl";

export function CreateProjectForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setLoading(false);
        setError("Your session expired. Please sign in again.");
        return;
      }

      const res = await fetch(`${BACKEND_URL}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ title: trimmed }),
      });

      setLoading(false);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "Failed to create project. Please try again.");
        return;
      }

      const data = (await res.json()) as { id: string };
      router.push(`/projects/${data.id}`);
      router.refresh();
    } catch {
      setLoading(false);
      setError("Couldn't reach SPLEX. Check your connection and try again.");
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} className="gap-2">
        <Plus size={15} />
        New Project
      </Button>
    );
  }

  return (
    <form onSubmit={handleCreate} className="flex items-center gap-2">
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Project name"
        autoFocus
        className="max-w-xs"
      />
      <Button type="submit" disabled={loading || !title.trim()}>
        {loading ? "Creating..." : "Create"}
      </Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error && <span className="text-sm text-danger">{error}</span>}
    </form>
  );
}
