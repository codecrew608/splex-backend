import { LoadingScreen } from "@/components/ui/LoadingScreen";

// Root-level — Next.js shows this automatically while app/page.tsx's
// server-side auth check (createClient + getUser) resolves, before it
// redirects to /login or /chat. This is the first thing rendered on a
// fresh visit, ahead of the login page itself. (app)/loading.tsx is the
// separate, already-existing fallback for the authenticated section.
export default function Loading() {
  return <LoadingScreen />;
}
