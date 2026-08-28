"use client";

import { useEffect } from "react";

// Route-level error boundary.
//
// Without one, any uncaught render error in a client component unmounts the
// whole segment and the user is left staring at a blank page with no way
// forward — no message, no retry, no navigation. Next.js renders this
// instead, keeping the app usable.
//
// Deliberately does NOT surface `error.message`: a React error string can
// contain internal details (query shapes, ids) and is meaningless to a user.
// The digest is shown because it's the one token that lets someone matching
// a report to a server log find the right entry.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Goes to the browser console (and any client-side collector) rather than
    // being swallowed — this is the only place the real error is visible.
    console.error("[splex] unhandled render error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="font-display text-xl font-semibold text-foreground">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        This part of SPLEX failed to load. Your conversations and files are unaffected.
      </p>
      {error.digest && <p className="font-mono text-[11px] text-muted-foreground">Reference: {error.digest}</p>}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
        >
          Try again
        </button>
        <a
          href="/chat"
          className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent"
        >
          Back to chat
        </a>
      </div>
    </div>
  );
}
