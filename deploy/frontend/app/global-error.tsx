"use client";

import { useEffect } from "react";

// Last-resort boundary: catches errors thrown by the root layout itself,
// which app/error.tsx cannot — at that point no layout has rendered, so this
// component must supply its own <html>/<body>.
//
// Styling is inline rather than Tailwind because a root-layout failure may
// well mean globals.css never loaded. Colours are hardcoded to the light
// palette for the same reason: the theme-init script may not have run, so
// no CSS variable can be relied on here.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[splex] root layout error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "1.5rem",
          textAlign: "center",
          background: "#ede9e2",
          color: "#0b0c10",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>SPLEX couldn&apos;t start</h1>
        <p style={{ maxWidth: "28rem", fontSize: "0.875rem", color: "#5b6270", margin: 0 }}>
          Something failed while loading the app. Your account and data are unaffected.
        </p>
        {error.digest && (
          <p style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.7rem", color: "#5b6270", margin: 0 }}>
            Reference: {error.digest}
          </p>
        )}
        <button
          type="button"
          onClick={reset}
          style={{
            cursor: "pointer",
            borderRadius: "0.5rem",
            border: "none",
            background: "#7a5308",
            color: "#ffffff",
            padding: "0.5rem 1rem",
            fontSize: "0.875rem",
            fontWeight: 600,
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
