"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { withTimeout } from "@/lib/withTimeout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LogoMark } from "@/components/ui/Logo";
import { GoogleIcon } from "@/components/ui/GoogleIcon";
import { AuthShell } from "@/components/auth/AuthShell";

const SIGNUP_TIMEOUT_MS = 15_000;

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    // eslint-disable-next-line no-console
    console.log("[signup] submit: creating Supabase client");

    // Two distinct failure modes this guards against, neither of which a
    // bare try/catch alone fully covers:
    // 1. createClient()/signUp() throwing instead of resolving with
    //    {error} — a blocked/failed fetch (CORS, DNS, offline) surfaces as
    //    a thrown TypeError, not a clean Supabase error result. Caught
    //    below.
    // 2. The awaited call never settling at all (a hung connection, not a
    //    rejection) — try/catch/finally does nothing until a promise
    //    settles, so a truly stuck fetch would leave loading stuck
    //    forever regardless of the try/catch. withTimeout forces a
    //    rejection after SIGNUP_TIMEOUT_MS either way.
    // Without either fix, the button is stuck on "Creating account..."
    // forever with no visible error — exactly the reported symptom.
    try {
      const supabase = createClient();
      // eslint-disable-next-line no-console
      console.log("[signup] client created, calling auth.signUp()");
      const { error } = await withTimeout(
        supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        }),
        SIGNUP_TIMEOUT_MS,
      );
      // eslint-disable-next-line no-console
      console.log("[signup] auth.signUp() resolved", { hasError: !!error });

      if (error) {
        setError(error.message);
        return;
      }
      setSubmitted(true);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[signup] auth.signUp() threw or timed out:", err);
      setError(err instanceof Error ? err.message : "Couldn't reach SPLEX. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  if (submitted) {
    return (
      <AuthShell>
        <div className="flex flex-col items-center text-center">
          <LogoMark size={40} className="mb-4" />
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Check your inbox</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            We sent a confirmation link to {email}. Click it to finish setting up your SPLEX account.
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="mb-8 flex flex-col items-center text-center">
        <LogoMark size={40} className="mb-4" />
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Create your account</h1>
        <p className="mt-2 text-sm text-muted-foreground">Describe outcomes. SPLEX chooses the intelligence.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <Input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
        <Input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Creating account..." : "Create account"}
        </Button>
      </form>

      <div className="my-5 flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">or</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <Button variant="secondary" className="w-full" onClick={handleGoogleSignIn} type="button">
        <GoogleIcon size={18} />
        Continue with Google
      </Button>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
      <p className="mt-4 text-center text-xs text-muted-foreground">
        By creating an account, you agree to SPLEX&apos;s{" "}
        <Link href="/legal/terms" className="underline underline-offset-2 hover:text-foreground">
          Terms
        </Link>{" "}
        and{" "}
        <Link href="/legal/privacy" className="underline underline-offset-2 hover:text-foreground">
          Privacy Policy
        </Link>
        .
      </p>
    </AuthShell>
  );
}
