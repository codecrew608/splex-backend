"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function SecuritySection() {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });

    setLoading(false);
    if (error) {
      setMessage({ type: "error", text: error.message });
      return;
    }
    setPassword("");
    setMessage({ type: "success", text: "Password updated." });
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-border bg-surface p-5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">Security</p>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
          className="max-w-xs"
        />
        <Button type="submit" variant="secondary" disabled={loading || password.length < 8}>
          {loading ? "Updating..." : "Change password"}
        </Button>
      </form>
      {message && (
        <p className={`text-sm ${message.type === "error" ? "text-danger" : "text-muted-foreground"}`}>{message.text}</p>
      )}
    </div>
  );
}
