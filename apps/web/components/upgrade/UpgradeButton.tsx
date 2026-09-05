"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { createClient } from "@/lib/supabase/client";
import { BACKEND_URL } from "@/lib/backendUrl";

// Razorpay's Checkout.js attaches itself to window.Razorpay once loaded —
// no npm package, this is how Razorpay's own docs say to integrate it.
declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => { open: () => void };
  }
}

interface RazorpayCheckoutOptions {
  key: string;
  subscription_id: string;
  name: string;
  description?: string;
  handler: () => void;
  modal?: { ondismiss?: () => void };
}

const CHECKOUT_SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function loadRazorpayCheckout(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT_SRC;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

// Razorpay's own success callback fires the instant the browser sees an
// authorization go through — it is NOT proof the subscription is active.
// Only SPLEX's webhook (POST /webhooks/razorpay, triggered server-to-
// server by Razorpay once it has actually confirmed the charge) flips
// plan_tier, and that happens asynchronously, seconds after this callback.
// So the callback only starts polling for the real, server-authoritative
// state change — it never grants anything on its own.
const POLL_INTERVAL_MS = 2000;
const POLL_ATTEMPTS = 15;

type CheckoutPhase = "idle" | "starting" | "awaiting-activation" | "timed-out" | "error";

export function UpgradeButton() {
  const router = useRouter();
  const [phase, setPhase] = useState<CheckoutPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const pollForActivation = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    for (let attempt = 0; user && attempt < POLL_ATTEMPTS; attempt++) {
      const { data: profile } = await supabase.from("users").select("plan_tier").eq("id", user.id).single();
      if (profile?.plan_tier === "pro") {
        setPhase("idle");
        router.refresh();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    setPhase("timed-out");
  }, [router]);

  async function handleUpgrade() {
    setPhase("starting");
    setError(null);

    const checkoutReady = await loadRazorpayCheckout();
    if (!checkoutReady || !window.Razorpay) {
      setPhase("error");
      setError("Couldn't load the payment provider. Check your connection and try again.");
      return;
    }

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setPhase("error");
        setError("Your session expired. Please sign in again.");
        return;
      }

      const res = await fetch(`${BACKEND_URL}/billing/create-subscription`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setPhase("error");
        setError(body?.message || "Couldn't start checkout. Please try again.");
        return;
      }

      const { subscriptionId, keyId } = body as { subscriptionId: string; keyId: string };

      const razorpay = new window.Razorpay({
        key: keyId,
        subscription_id: subscriptionId,
        name: "SPLEX",
        description: "SPLEX Starter — ₹299/month",
        handler: () => {
          setPhase("awaiting-activation");
          void pollForActivation();
        },
        modal: {
          // The user closed the widget without completing payment — a
          // normal, silent cancellation, not an error.
          ondismiss: () => setPhase((current) => (current === "starting" ? "idle" : current)),
        },
      });
      razorpay.open();
    } catch {
      setPhase("error");
      setError("Couldn't reach SPLEX. Check your connection and try again.");
    }
  }

  if (phase === "awaiting-activation") {
    return <p className="text-sm text-muted-foreground">Payment received — activating your plan…</p>;
  }

  if (phase === "timed-out") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          Still activating — this can take a minute. Refresh to check again.
        </p>
        <Button onClick={() => router.refresh()} className="w-full">
          Refresh
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Button onClick={handleUpgrade} disabled={phase === "starting"} className="w-full">
        {phase === "starting" ? "Starting checkout…" : "Upgrade to Starter"}
      </Button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
