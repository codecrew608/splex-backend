"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { withTimeout } from "@/lib/withTimeout";
import { BACKEND_URL } from "@/lib/backendUrl";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LogoMark } from "@/components/ui/Logo";

const SUBMIT_TIMEOUT_MS = 15_000;
const TODAY = new Date().toISOString().slice(0, 10);

// Shown once, gated in app/(app)/layout.tsx on users.full_name being null
// — the DB-level signal that this step has never been completed, so it
// naturally never reappears once saved. No skip button by design (the
// request was for this to actually collect the two fields, not offer a
// way around it) — "Sign out instead" is the one deliberate escape hatch,
// for someone who opened the wrong account rather than someone who just
// doesn't want to answer.
export function OnboardingModal() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setError("Your session expired. Please sign in again.");
        return;
      }

      const res = await withTimeout(
        fetch(`${BACKEND_URL}/account/profile`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({
            fullName: fullName.trim(),
            dateOfBirth,
            // Best-effort: an unrecognized/unavailable value is just
            // dropped server-side (see handlers/account.ts's
            // isValidIanaTimezone) — never something worth failing this
            // step over.
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        }),
        SUBMIT_TIMEOUT_MS,
      );

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.message ?? "Couldn't save your details. Please try again.");
        return;
      }

      // full_name is now set server-side — re-running app/(app)/layout.tsx
      // (a server component) is what actually stops this modal from
      // rendering again, not local state here.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach SPLEX. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div
        className="w-full max-w-sm rounded-xl border border-border-strong bg-surface-raised p-6"
        style={{ boxShadow: "var(--shadow-card)" }}
      >
        <div className="flex flex-col items-center text-center">
          <LogoMark size={36} className="mb-3" />
          <h2 className="text-lg font-medium text-foreground">Welcome to SPLEX</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">A couple of details before you get started.</p>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="onboarding-name" className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
              Full name
            </label>
            <Input
              id="onboarding-name"
              type="text"
              placeholder="Your name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              maxLength={200}
              autoComplete="name"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="onboarding-dob" className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
              Date of birth
            </label>
            <Input
              id="onboarding-dob"
              type="date"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
              required
              max={TODAY}
              autoComplete="bday"
            />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Saving..." : "Continue"}
          </Button>
        </form>

        <button
          type="button"
          onClick={handleSignOut}
          className="mt-4 w-full text-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Wrong account? Sign out
        </button>
      </div>
    </div>
  );
}
