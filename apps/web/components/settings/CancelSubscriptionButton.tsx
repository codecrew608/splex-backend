"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { BACKEND_URL } from "@/lib/backendUrl";

export function CancelSubscriptionButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleCancel() {
    if (!window.confirm("Cancel your Pro plan? You'll move back to the Free plan immediately.")) return;
    setLoading(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setLoading(false);
      return;
    }

    await fetch(`${BACKEND_URL}/billing/fake-cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });

    router.refresh();
    setLoading(false);
  }

  return (
    <button
      type="button"
      onClick={handleCancel}
      disabled={loading}
      className="rounded-full border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
    >
      {loading ? "Cancelling..." : "Cancel plan"}
    </button>
  );
}
