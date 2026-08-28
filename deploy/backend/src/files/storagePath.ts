// Authorization for privileged Storage reads.
//
// THE VULNERABILITY THIS CLOSES
//
// files.storage_path was client-writable (authenticated held INSERT and
// UPDATE on it), and handlers/files.ts downloaded it with
// fastify.supabaseAdmin.storage — the SERVICE-ROLE client, which bypasses
// Storage RLS completely. The row's user_id was checked, but the PATH was
// not, so a user could point their own files row at another user's object
// and have the backend fetch it for them, extract its text, and store it
// where they could read it.
//
// Storage RLS itself is correct (uploads_owner_select requires
// foldername[1] = auth.uid(), bucket is private) — it simply never applies
// to a service-role call. This module is the check that does.
//
// Defence in depth: migration 0028 also stops the client writing
// storage_path at all (a trigger computes it). This validator stays
// regardless, because the download is privileged and must be able to prove
// its own authorization without trusting any upstream layer — including a
// future migration that loosens a grant, or any service-role code path
// that inserts a row itself.

export interface StoragePathCheck {
  ok: boolean;
  reason?: string;
}

// The canonical layout every upload must follow: <userId>/<fileId>/<name>.
// Anchored, and the segments are matched exactly — a prefix test alone
// would accept "<userId>-evil/..." or "<userId>/../<other>/x".
export function expectedPathPrefix(userId: string, fileId: string): string {
  return `${userId}/${fileId}/`;
}

// Rejects anything that is not provably inside the caller's own namespace.
//
// Order matters: traversal and encoding are checked BEFORE the prefix, so a
// path like "<userId>/<fileId>/../../victim/secret.pdf" — which does start
// with a legitimate prefix — is still refused.
export function validateOwnedStoragePath(userId: string, fileId: string, storagePath: string | null | undefined): StoragePathCheck {
  if (typeof storagePath !== "string" || storagePath.length === 0) {
    return { ok: false, reason: "empty storage path" };
  }

  // Percent-encoded traversal ("%2e%2e%2f", "%2E%2E/") would survive a naive
  // ".." check and can be normalized later by a storage layer or CDN.
  // Decode first; a malformed encoding is itself grounds to refuse.
  let decoded: string;
  try {
    decoded = decodeURIComponent(storagePath);
  } catch {
    return { ok: false, reason: "malformed percent-encoding" };
  }

  // Check BOTH the raw and decoded forms: a single decode pass cannot see
  // double-encoded input ("%252e%252e"), and the raw form is what actually
  // gets sent to Storage.
  for (const candidate of [storagePath, decoded]) {
    if (candidate.includes("..")) return { ok: false, reason: "path traversal" };
    if (candidate.includes("\\")) return { ok: false, reason: "backslash separator" };
    if (candidate.startsWith("/")) return { ok: false, reason: "absolute path" };
    // A NUL can truncate the path in a downstream C-backed consumer, making
    // the validated string and the used string differ.
    if (candidate.includes("\0")) return { ok: false, reason: "null byte" };
  }

  // Must sit exactly inside this user's folder for this file. Compared on
  // the DECODED form so "%2f" cannot smuggle a separator past the segment
  // check, and re-verified on the raw form so the two agree.
  const prefix = expectedPathPrefix(userId, fileId);
  if (!decoded.startsWith(prefix) || !storagePath.startsWith(prefix)) {
    return { ok: false, reason: "path outside the caller's namespace" };
  }

  // Nothing may live below the file's own folder — the object name is a
  // single trailing segment, never a nested path.
  const remainder = decoded.slice(prefix.length);
  if (remainder.length === 0) return { ok: false, reason: "missing object name" };
  if (remainder.includes("/")) return { ok: false, reason: "nested path below the file folder" };

  return { ok: true };
}

// Filename sanitiser used when CONSTRUCTING a canonical path (mirrors the
// SQL trigger in migration 0028 so both layers agree on the same value).
// Strips separators and traversal outright rather than escaping them —
// there is no legitimate reason for either in a stored object name.
export function sanitizeStoredFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/\0/g, "").replace(/\.\./g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "file";
}
