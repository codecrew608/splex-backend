"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { BACKEND_URL } from "@/lib/backendUrl";

// The full-page create flow (/projects/new). Replaces the inline
// name-only form that used to expand in place on the Projects list:
// a project now carries a description too, which needs more room than a
// single row of header controls, and a dedicated page gives the "New
// project" button in the sidebar somewhere real to land.
export function NewProjectForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || loading) return;

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
        body: JSON.stringify({
          title: trimmedTitle,
          // Omitted entirely rather than sent as "" — the backend schema
          // treats description as optional, and an empty string would
          // store a meaningless non-null value.
          ...(description.trim() ? { description: description.trim() } : {}),
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setLoading(false);
        setError(body?.message ?? "Failed to create project. Please try again.");
        return;
      }

      const data = (await res.json()) as { id: string };
      // Deliberately no setLoading(false) on the success path — the button
      // stays disabled through the navigation, so a double-click during
      // the route transition can't fire a second create.
      router.push(`/projects/${data.id}`);
      router.refresh();
    } catch {
      setLoading(false);
      setError("Couldn't reach SPLEX. Check your connection and try again.");
    }
  }

  return (
    <form onSubmit={handleCreate} className="mt-6 flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label htmlFor="project-title" className="text-[13px] font-medium text-foreground">
          Project name
        </label>
        <Input
          id="project-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Q3 marketing site"
          maxLength={200}
          autoFocus
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="project-description" className="text-[13px] font-medium text-foreground">
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <textarea
          id="project-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this project is for. Every chat you start inside it shares this context."
          rows={4}
          maxLength={2000}
          className="w-full resize-y rounded-lg border border-border-strong bg-surface-raised px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
        />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={loading || !title.trim()}>
          {loading ? "Creating…" : "Create project"}
        </Button>
        <Link href="/projects">
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </Link>
      </div>
    </form>
  );
}
