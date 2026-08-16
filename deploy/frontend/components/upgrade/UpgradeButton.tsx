"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL as string;

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open: () => void };
  }
}

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export function UpgradeButton() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "activating" | "error">("idle");

  async function handleUpgrade() {
    setLoading(true);
    setStatus("idle");

    try {
      const supabase = createClient();
      const {
        data: { session, user },
      } = await (async () => {
        const [{ data: sessionData }, { data: userData }] = await Promise.all([
          supabase.auth.getSession(),
          supabase.auth.getUser(),
        ]);
        return { data: { session: sessionData.session, user: userData.user } };
      })();
      if (!session || !user) {
        setLoading(false);
        setStatus("error");
        return;
      }

      const [scriptLoaded, createRes] = await Promise.all([
        loadRazorpayScript(),
        fetch(`${BACKEND_URL}/billing/create-subscription`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
      ]);

      if (!scriptLoaded || !createRes.ok) {
        setLoading(false);
        setStatus("error");
        return;
      }

      const { subscriptionId, keyId } = (await createRes.json()) as { subscriptionId: string; keyId: string };

      const razorpay = new window.Razorpay({
        key: keyId,
        subscription_id: subscriptionId,
        name: "SPLEX",
        description: "Pro plan — ₹299/month",
        prefill: { email: user.email },
        // The actual plan_tier flip happens asynchronously via the Razorpay
        // webhook, not here — this just tells the user checkout succeeded
        // and to expect activation shortly.
        handler: () => setStatus("activating"),
        modal: { ondismiss: () => setLoading(false) },
      });

      razorpay.open();
      setLoading(false);
    } catch {
      // Network-level failure (fetch threw rather than resolving) — surface
      // it instead of leaving the button stuck on "Loading checkout...".
      setLoading(false);
      setStatus("error");
    }
  }

  if (status === "activating") {
    return <p className="text-sm text-accent">Activating your plan — this can take a moment. Refresh shortly.</p>;
  }

  return (
    <div className="space-y-2">
      <Button onClick={handleUpgrade} disabled={loading} className="w-full">
        {loading ? "Loading checkout..." : "Upgrade to Pro"}
      </Button>
      {status === "error" && (
        <p className="text-sm text-danger">Couldn&apos;t start checkout. Please try again.</p>
      )}
    </div>
  );
}
