import { BACKEND_URL } from "./backendUrl";

export interface MediaStatusResult {
  status: "queued" | "processing" | "completed" | "failed";
  url?: string;
  errorMessage?: string;
}

// Polled by useChatStream while an async media job (video) is in flight —
// see apps/backend/src/routes/media.ts for the server side of this same
// contract. Network/parse failures resolve to null rather than throwing,
// so a single flaky poll doesn't derail the whole polling loop; the caller
// just tries again on its next interval.
export async function fetchMediaStatus(mediaId: string, accessToken: string): Promise<MediaStatusResult | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/media/${mediaId}/status`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as MediaStatusResult;
  } catch {
    return null;
  }
}
