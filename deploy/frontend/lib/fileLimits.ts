import type { PlanTier } from "@/shared-types";

// Hardcoded per-tier caps, matching the original product spec — no
// plan_file_limits table (three static numbers don't warrant one).
export const FILE_SIZE_LIMITS: Record<PlanTier, number> = {
  free: 5 * 1024 * 1024,
  starter: 20 * 1024 * 1024,
  pro: 50 * 1024 * 1024,
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
