"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { withTimeout } from "@/lib/withTimeout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LogoMark } from "@/components/ui/Logo";
import { GoogleIcon } from "@/components/ui/GoogleIcon";
import { AuthShell } from "@/components/auth/AuthShell";

const LOGIN_TIMEOUT_MS = 15_000;

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // eslint-disable-next-line no-console
    console.log("[login] submit: creating Supabase client");

    // Two distinct failure modes, neither fully covered by try/catch
    // alone: createClient()/signInWithPassword() throwing instead of
    // resolving with {error} (a blocked/failed fetch — CORS, DNS, offline
    // — surfaces as a thrown TypeError), and the awaited call never
    // settling at all (a hung connection, which try/catch/finally can't
    // help with since it only runs once a promise settles). Without both,
    // the button is stuck on "Signing in..." forever with no visible error.
    try {
      const supabase = createClient();
      // eslint-disable-next-line no-console
      console.log("[login] client created, calling auth.signInWithPassword()");
      const { error } = await withTimeout(supabase.auth.signInWithPassword({ email, password }), LOGIN_TIMEOUT_MS);
      // eslint-disable-next-line no-console
      console.log("[login] signInWithPassword() resolved", { hasError: !!error });

      if (error) {
        setError(error.message);
        return;
      }
      router.push("/chat");
      router.refresh();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[login] signInWithPassword() threw or timed out:", err);
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

  return (
    <AuthShell>
      <div className="mb-8 flex flex-col items-center text-center">
        <LogoMark size={40} className="mb-4" />
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Welcome back</h1>
        <p className="mt-2 text-sm text-muted-foreground">Sign in to continue to SPLEX.</p>
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
          autoComplete="current-password"
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Signing in..." : "Sign in"}
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
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-medium text-accent hover:underline">
          Sign up
        </Link>
      </p>
      <p className="mt-4 text-center text-xs text-muted-foreground">
        By continuing, you agree to SPLEX&apos;s{" "}
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
