"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X, Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { BACKEND_URL } from "@/lib/backendUrl";

interface FakeCheckoutModalProps {
  onClose: () => void;
}

// SPLEX has no real payment gateway integration — this is a test-mode
// stand-in that always succeeds. Deliberately, visibly fake throughout
// (the "TEST MODE" badge, the placeholder card number, the copy) so
// there's no chance of it being mistaken for a real charge.
export function FakeCheckoutModal({ onClose }: FakeCheckoutModalProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePay() {
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

      const res = await fetch(`${BACKEND_URL}/billing/fake-checkout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (!res.ok) {
        setLoading(false);
        setError("Couldn't complete checkout. Please try again.");
        return;
      }

      router.refresh();
      onClose();
    } catch {
      setLoading(false);
      setError("Couldn't reach SPLEX. Check your connection and try again.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-sm rounded-xl border border-border-strong bg-surface-raised p-6" style={{ boxShadow: "var(--shadow-card)" }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="inline-block rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-accent">
              Test mode
            </span>
            <h2 className="mt-2 text-lg font-medium text-foreground">Upgrade to Starter</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <X size={16} strokeWidth={1.6} />
          </button>
        </div>

        <p className="mt-1 text-[13px] text-muted-foreground">
          No payment gateway is connected yet — this is a placeholder checkout. Confirming below activates Starter
          instantly, no real charge.
        </p>

        <div className="mt-5 flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3">
          <span className="text-sm text-foreground">SPLEX Starter</span>
          <span className="text-sm font-medium text-foreground">₹299/mo</span>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <label className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">Card number</label>
          <div className="rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm text-muted-foreground">
            4242 4242 4242 4242 <span className="text-xs">(placeholder — not a real field)</span>
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}

        <Button onClick={handlePay} disabled={loading} className="mt-5 w-full">
          <Lock size={13} strokeWidth={1.8} />
          {loading ? "Processing..." : "Confirm test payment — ₹299"}
        </Button>
      </div>
    </div>
  );
}
