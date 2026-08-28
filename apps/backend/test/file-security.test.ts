import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateOwnedStoragePath, expectedPathPrefix, sanitizeStoredFilename } from "../src/files/storagePath.js";

const SRC = join(import.meta.dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const FILE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const FILE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const ok = (p: string) => validateOwnedStoragePath(USER_A, FILE_A, p);

describe("1. User A cannot make their file row reference User B's object", () => {
  it("rejects a path in another user's namespace", () => {
    const r = ok(`${USER_B}/${FILE_B}/secret.pdf`);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("path outside the caller's namespace");
  });

  it("rejects another user's namespace even with a matching file id", () => {
    expect(ok(`${USER_B}/${FILE_A}/secret.pdf`).ok).toBe(false);
  });

  it("rejects the caller's own namespace but a DIFFERENT file id", () => {
    // Still someone else's object if that file row belongs to another user's
    // upload flow; the path must match this exact file.
    expect(ok(`${USER_A}/${FILE_B}/other.pdf`).ok).toBe(false);
  });

  it("rejects a namespace that merely starts with the user id", () => {
    // A naive startsWith(userId) check would accept this.
    expect(ok(`${USER_A}-evil/${FILE_A}/x.pdf`).ok).toBe(false);
    expect(ok(`${USER_A}extra/${FILE_A}/x.pdf`).ok).toBe(false);
  });
});

describe("2. Path traversal is rejected", () => {
  it("rejects plain ../ traversal", () => {
    expect(ok(`${USER_A}/${FILE_A}/../../${USER_B}/secret.pdf`).reason).toBe("path traversal");
    expect(ok("../../../etc/passwd").reason).toBe("path traversal");
  });

  it("rejects traversal that begins with a LEGITIMATE prefix", () => {
    // The dangerous case: prefix check alone would pass this.
    const r = ok(`${USER_A}/${FILE_A}/../${FILE_B}/secret.pdf`);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("path traversal");
  });

  it("rejects percent-encoded traversal", () => {
    expect(ok(`${USER_A}/${FILE_A}/%2e%2e%2f${USER_B}/x.pdf`).ok).toBe(false);
    expect(ok(`${USER_A}/${FILE_A}/%2E%2E/${USER_B}/x.pdf`).ok).toBe(false);
  });

  it("rejects double-encoded traversal", () => {
    // One decode pass yields "%2e%2e", which still is not ".." — the raw
    // form is checked too so this cannot slip through.
    expect(ok(`${USER_A}/${FILE_A}/%252e%252e/x.pdf`).ok).toBe(false);
  });

  it("rejects malformed percent-encoding rather than guessing", () => {
    expect(ok(`${USER_A}/${FILE_A}/%zz.pdf`).reason).toBe("malformed percent-encoding");
  });

  it("rejects backslashes, absolute paths and NUL bytes", () => {
    expect(ok(`${USER_A}\\${FILE_A}\\x.pdf`).reason).toBe("backslash separator");
    expect(ok(`/${USER_A}/${FILE_A}/x.pdf`).reason).toBe("absolute path");
    expect(ok(`${USER_A}/${FILE_A}/x\0.pdf`).reason).toBe("null byte");
  });

  it("rejects an encoded separator smuggling a nested path", () => {
    expect(ok(`${USER_A}/${FILE_A}/sub%2Fdir%2Fx.pdf`).reason).toBe("nested path below the file folder");
  });

  it("rejects nesting below the file folder", () => {
    expect(ok(`${USER_A}/${FILE_A}/sub/x.pdf`).reason).toBe("nested path below the file folder");
  });

  it("rejects empty and missing object names", () => {
    expect(ok("").ok).toBe(false);
    expect(ok(`${USER_A}/${FILE_A}/`).reason).toBe("missing object name");
    expect(validateOwnedStoragePath(USER_A, FILE_A, null).ok).toBe(false);
    expect(validateOwnedStoragePath(USER_A, FILE_A, undefined).ok).toBe(false);
  });
});

describe("3/4. storage_path and user_id are database-owned (migration 0028)", () => {
  const mig = readFileSync(join(SRC, "..", "..", "..", "db", "migrations", "0028_lock_down_files_client_writes.sql"), "utf8");

  it("revokes blanket INSERT/UPDATE from the client", () => {
    expect(mig).toMatch(/revoke insert, update on public\.files from authenticated, anon;/);
  });

  it("re-grants ONLY non-security-relevant columns", () => {
    expect(mig).toMatch(/grant insert \(filename, file_type, mime_type, project_id, processing_status\)/);
    expect(mig).toMatch(/grant update \(filename, project_id\)/);
    for (const col of ["storage_path", "size_bytes", "extracted_text", "user_id"]) {
      expect(mig).not.toMatch(new RegExp(`grant (insert|update) \\([^)]*\\b${col}\\b`));
    }
  });

  it("pins storage_path, user_id and id on UPDATE so a row cannot be re-pointed", () => {
    expect(mig).toContain("new.storage_path := old.storage_path;");
    expect(mig).toContain("new.user_id := old.user_id;");
    expect(mig).toContain("new.id := old.id;");
  });

  it("computes the canonical path server-side and strips traversal", () => {
    expect(mig).toContain("new.user_id::text || '/' || new.id::text || '/' || v_name");
    expect(mig).toMatch(/regexp_replace\(coalesce\(new\.filename, ''\), '\^\.\*\[\/\\\\\]', ''\)/);
    expect(mig).toContain("replace(replace(v_name, '..', ''), chr(0), '')");
  });

  it("supplies defaults so the NOT NULL columns still populate", () => {
    expect(mig).toContain("alter column user_id set default auth.uid()");
    expect(mig).toContain("alter column size_bytes set default 0");
  });
});

describe("5. size_bytes cannot bypass the storage quota", () => {
  it("the server records the MEASURED size, not the claimed one", () => {
    const src = read("handlers/files.ts");
    expect(src).toContain("if (file.size_bytes !== buffer.byteLength)");
    expect(src).toContain("update({ size_bytes: buffer.byteLength })");
  });

  it("the storage quota is re-checked on real bytes after download", () => {
    const src = read("handlers/files.ts");
    expect(src).toContain("checkStorageQuota(fastify, userId, planTier, file.id)");
    // and the size correction happens BEFORE the quota check, so the check
    // sees truth for this file too
    expect(src.indexOf("update({ size_bytes: buffer.byteLength })")).toBeLessThan(
      src.indexOf("checkStorageQuota(fastify, userId, planTier, file.id)"),
    );
  });

  it("the per-file cap is measured, never claimed", () => {
    expect(read("handlers/files.ts")).toContain("buffer.byteLength > sizeLimit");
  });
});

describe("6. extracted_text cannot be forged through the client", () => {
  it("no client write grant exists for it", () => {
    const mig = readFileSync(join(SRC, "..", "..", "..", "db", "migrations", "0028_lock_down_files_client_writes.sql"), "utf8");
    expect(mig).not.toMatch(/grant (insert|update) \([^)]*extracted_text/);
  });

  it("the frontend no longer sends database-owned columns", () => {
    const composer = readFileSync(join(SRC, "..", "..", "web", "components", "chat", "Composer.tsx"), "utf8");
    const insertBlock = composer.slice(composer.indexOf('.from("files")'), composer.indexOf(".select(\"id, storage_path\")"));
    for (const col of ["user_id", "size_bytes", "storage_path", "extracted_text"]) {
      expect(insertBlock, `client must not insert ${col}`).not.toMatch(new RegExp(`\\b${col}:`));
    }
  });
});

describe("7. Legitimate upload/process still works", () => {
  it("accepts the canonical path the trigger produces", () => {
    expect(ok(`${USER_A}/${FILE_A}/report.pdf`).ok).toBe(true);
    expect(ok(`${USER_A}/${FILE_A}/My Report (final) v2.docx`).ok).toBe(true);
    expect(ok(`${USER_A}/${FILE_A}/notes.md`).ok).toBe(true);
  });

  it("expectedPathPrefix matches the shape the SQL trigger builds", () => {
    expect(expectedPathPrefix(USER_A, FILE_A)).toBe(`${USER_A}/${FILE_A}/`);
  });

  it("the TS sanitiser agrees with the SQL trigger's rules", () => {
    expect(sanitizeStoredFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeStoredFilename("C:\\Users\\me\\x.pdf")).toBe("x.pdf");
    expect(sanitizeStoredFilename("")).toBe("file");
    expect(sanitizeStoredFilename("..")).toBe("file");
    expect(sanitizeStoredFilename("a".repeat(400)).length).toBe(200);
    expect(sanitizeStoredFilename("normal file.pdf")).toBe("normal file.pdf");
  });

  it("the frontend uploads to the SERVER-COMPUTED path", () => {
    const composer = readFileSync(join(SRC, "..", "..", "web", "components", "chat", "Composer.tsx"), "utf8");
    expect(composer).toContain("const storagePath = fileRow.storage_path as string;");
    // and no longer builds one itself
    expect(composer).not.toMatch(/const storagePath = `\$\{user\.id\}/);
  });
});

describe("8. Failed authorization never reaches service-role Storage", () => {
  it("the path check runs BEFORE the download and before any status write", () => {
    const src = read("handlers/files.ts");
    const check = src.indexOf("validateOwnedStoragePath(userId, file.id, file.storage_path)");
    const statusWrite = src.indexOf('update({ processing_status: "extracting" })');
    const download = src.indexOf(".storage\n    .from(\"uploads\")\n    .download(");
    expect(check).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(-1);
    expect(check).toBeLessThan(statusWrite);
    expect(check).toBeLessThan(download);
  });

  it("returns 404 on a rejected path, leaking nothing about the target", () => {
    const src = read("handlers/files.ts");
    const seg = src.slice(src.indexOf("const pathCheck ="), src.indexOf('processing_status: "extracting"'));
    expect(seg).toContain('return fail("File not found.", 404);');
  });

  it("logs the refusal as an error so an attempt is visible", () => {
    expect(read("handlers/files.ts")).toContain("refused privileged storage read");
  });
});
