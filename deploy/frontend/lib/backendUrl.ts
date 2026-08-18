// NEXT_PUBLIC_BACKEND_URL is the canonical name every doc/example uses,
// but NEXT_PUBLIC_API_URL is a plausible enough alternate that a
// misconfigured deploy set it instead in production, silently turning
// every backend fetch() call into fetch("undefined/..."). Both env vars
// must be referenced as static `process.env.NEXT_PUBLIC_*` member
// expressions (not computed/dynamic access) for Next.js to inline them at
// build time — this is as far as that fallback can go without breaking
// that mechanism.
export const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || "") as string;

if (!BACKEND_URL && typeof window !== "undefined") {
  // eslint-disable-next-line no-console
  console.error(
    "[SPLEX] No backend URL configured. Set NEXT_PUBLIC_BACKEND_URL in this deployment's environment variables and redeploy — every request to the backend will fail until then.",
  );
}
