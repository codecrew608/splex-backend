"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SignOutButton } from "./SignOutButton";
import { BACKEND_URL } from "@/lib/backendUrl";
const CONFIRM_TEXT = "DELETE";

export function DangerZoneSection() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
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

      const res = await fetch(`${BACKEND_URL}/account`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (!res.ok) {
        setLoading(false);
        setError("Failed to delete account. Please try again.");
        return;
      }

      await supabase.auth.signOut();
      router.push("/login");
      router.refresh();
    } catch {
      // Network-level failure (fetch threw rather than resolving) — surface
      // it instead of leaving the button stuck on "Deleting..." forever.
      setLoading(false);
      setError("Couldn't reach SPLEX. Check your connection and try again.");
    }
  }

  return (
    <div className="mt-4 space-y-4 rounded-[22px] border border-danger/30 bg-surface p-5">
      <p className="text-xs uppercase tracking-wide text-danger">Danger zone</p>

      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-foreground">Sign out</p>
          <p className="text-xs text-muted-foreground">End your session on this device.</p>
        </div>
        <SignOutButton />
      </div>

      <div className="border-t border-border pt-4">
        <p className="text-sm text-foreground">Delete account</p>
        <p className="text-xs text-muted-foreground">
          Permanently deletes your account and everything in it — conversations, projects, files, and usage history.
          This cannot be undone.
        </p>

        {!confirming ? (
          <Button variant="danger" className="mt-3" onClick={() => setConfirming(true)}>
            Delete account
          </Button>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              Type <span className="font-mono font-medium text-foreground">{CONFIRM_TEXT}</span> to confirm.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="max-w-[160px]"
                autoFocus
              />
              <Button
                variant="danger"
                disabled={confirmText !== CONFIRM_TEXT || loading}
                onClick={handleDelete}
              >
                {loading ? "Deleting..." : "Permanently delete"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
