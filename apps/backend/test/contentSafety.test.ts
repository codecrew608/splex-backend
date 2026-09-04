import { describe, it, expect } from "vitest";
import {
  sniffFileType,
  validateDeclaredFileType,
  looksBinary,
  scanZipSafety,
  DOCX_MIME,
} from "../src/files/contentSafety.js";

// FIX (file-type / zip-safety hardening — production completion pass):
// mime_type is 100% client-declared (Composer.tsx sets it straight from
// the browser's File.type) and was never checked against the bytes
// actually downloaded — these are real behavioral tests against the
// exported pure functions, not source-text pins, since all of this logic
// is deterministic and has no I/O.

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF87_BYTES = Buffer.from("GIF87a" + "\0\0\0\0", "latin1");
const GIF89_BYTES = Buffer.from("GIF89a" + "\0\0\0\0", "latin1");
const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "latin1")]);
const PDF_BYTES = Buffer.from("%PDF-1.7\n%...", "latin1");
const ZIP_LOCAL_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
const RANDOM_BYTES = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);

describe("sniffFileType — magic-byte detection", () => {
  it("recognizes PNG, JPEG, GIF87a, GIF89a, WEBP, PDF, and ZIP signatures", () => {
    expect(sniffFileType(PNG_BYTES)).toBe("png");
    expect(sniffFileType(JPEG_BYTES)).toBe("jpeg");
    expect(sniffFileType(GIF87_BYTES)).toBe("gif");
    expect(sniffFileType(GIF89_BYTES)).toBe("gif");
    expect(sniffFileType(WEBP_BYTES)).toBe("webp");
    expect(sniffFileType(PDF_BYTES)).toBe("pdf");
    expect(sniffFileType(ZIP_LOCAL_BYTES)).toBe("zip");
  });

  it("returns 'unknown' for content matching none of the known signatures, including short/empty buffers", () => {
    expect(sniffFileType(RANDOM_BYTES)).toBe("unknown");
    expect(sniffFileType(Buffer.from("<svg xmlns='...'><script>evil()</script></svg>", "utf-8"))).toBe("unknown");
    expect(sniffFileType(Buffer.alloc(0))).toBe("unknown");
    expect(sniffFileType(Buffer.from([0x89, 0x50]))).toBe("unknown"); // truncated PNG signature
  });
});

describe("looksBinary — conservative text/binary heuristic", () => {
  it("flags content with a NUL byte as binary", () => {
    expect(looksBinary(Buffer.from([0x68, 0x69, 0x00, 0x21]))).toBe(true);
  });

  it("does not flag ordinary text (including UTF-8 multi-byte content) as binary", () => {
    expect(looksBinary(Buffer.from("function hello() { return 'world — café'; }", "utf-8"))).toBe(false);
  });

  it("only inspects a bounded leading sample, not the whole buffer", () => {
    const huge = Buffer.alloc(20_000, 0x61); // all 'a'
    expect(looksBinary(huge)).toBe(false);
  });
});

describe("validateDeclaredFileType — declared type vs. sniffed content", () => {
  it("accepts a genuine PNG declared as an image", () => {
    expect(validateDeclaredFileType({ buffer: PNG_BYTES, mimeType: "image/png", looksLikeTextClaim: false })).toEqual({ ok: true });
  });

  it("rejects PDF bytes relabeled as an image", () => {
    const result = validateDeclaredFileType({ buffer: PDF_BYTES, mimeType: "image/png", looksLikeTextClaim: false });
    expect(result.ok).toBe(false);
  });

  it("rejects SVG (no safe raster signature) even though its mime type starts with image/ — fails closed rather than sanitizing", () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "utf-8");
    const result = validateDeclaredFileType({ buffer: svg, mimeType: "image/svg+xml", looksLikeTextClaim: false });
    expect(result.ok).toBe(false);
  });

  it("accepts a genuine PDF declared as application/pdf, rejects a relabeled non-PDF", () => {
    expect(validateDeclaredFileType({ buffer: PDF_BYTES, mimeType: "application/pdf", looksLikeTextClaim: false })).toEqual({ ok: true });
    expect(validateDeclaredFileType({ buffer: PNG_BYTES, mimeType: "application/pdf", looksLikeTextClaim: false }).ok).toBe(false);
  });

  it("accepts a genuine zip declared as .docx, rejects a relabeled non-zip", () => {
    expect(validateDeclaredFileType({ buffer: ZIP_LOCAL_BYTES, mimeType: DOCX_MIME, looksLikeTextClaim: false })).toEqual({ ok: true });
    expect(validateDeclaredFileType({ buffer: PDF_BYTES, mimeType: DOCX_MIME, looksLikeTextClaim: false }).ok).toBe(false);
  });

  it("applies the binary heuristic only to files claiming to be text/code", () => {
    const text = Buffer.from("console.log('hello');", "utf-8");
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(validateDeclaredFileType({ buffer: text, mimeType: "text/plain", looksLikeTextClaim: true })).toEqual({ ok: true });
    expect(validateDeclaredFileType({ buffer: binary, mimeType: null, looksLikeTextClaim: true }).ok).toBe(false);
  });

  it("rejects an empty file outright", () => {
    expect(validateDeclaredFileType({ buffer: Buffer.alloc(0), mimeType: "image/png", looksLikeTextClaim: false }).ok).toBe(false);
  });

  it("falls through unchanged for a type this app doesn't actively sniff — processFile's own unsupported-type check owns that rejection", () => {
    expect(validateDeclaredFileType({ buffer: RANDOM_BYTES, mimeType: "application/x-msdownload", looksLikeTextClaim: false })).toEqual({ ok: true });
  });
});

// Builds a minimal, valid ZIP structure containing only what scanZipSafety
// actually reads: the central directory entries followed by the
// end-of-central-directory record. No local file headers or entry payload
// bytes — scanZipSafety never looks at either, by design (it reads
// declared metadata only, never decompresses).
function buildZipCentralDirectory(entries: Array<{ name: string; compressedSize: number; uncompressedSize: number }>): Buffer {
  const entryBuffers = entries.map(({ name, compressedSize, uncompressedSize }) => {
    const nameBytes = Buffer.from(name, "utf-8");
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // versionMadeBy
    header.writeUInt16LE(20, 6); // versionNeeded
    header.writeUInt16LE(0, 8); // flags
    header.writeUInt16LE(0, 10); // compressionMethod
    header.writeUInt16LE(0, 12); // lastModTime
    header.writeUInt16LE(0, 14); // lastModDate
    header.writeUInt32LE(0, 16); // crc32
    header.writeUInt32LE(compressedSize, 20);
    header.writeUInt32LE(uncompressedSize, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extraLength
    header.writeUInt16LE(0, 32); // commentLength
    header.writeUInt16LE(0, 34); // diskNumberStart
    header.writeUInt16LE(0, 36); // internalAttrs
    header.writeUInt32LE(0, 38); // externalAttrs
    header.writeUInt32LE(0, 42); // localHeaderOffset
    return Buffer.concat([header, nameBytes]);
  });

  const centralDirectory = Buffer.concat(entryBuffers);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // diskNumber
  eocd.writeUInt16LE(0, 6); // diskWithCD
  eocd.writeUInt16LE(entries.length, 8); // numEntriesThisDisk
  eocd.writeUInt16LE(entries.length, 10); // numEntriesTotal
  eocd.writeUInt32LE(centralDirectory.length, 12); // sizeOfCD
  eocd.writeUInt32LE(0, 16); // offsetOfCD -- central directory starts at byte 0 of this buffer
  eocd.writeUInt16LE(0, 20); // commentLength

  return Buffer.concat([centralDirectory, eocd]);
}

describe("scanZipSafety — pre-extraction decompression-bomb guard (metadata only, no decompression)", () => {
  it("accepts a well-formed archive with ordinary, non-suspicious entries", () => {
    const zip = buildZipCentralDirectory([
      { name: "word/document.xml", compressedSize: 2000, uncompressedSize: 10_000 },
      { name: "word/styles.xml", compressedSize: 500, uncompressedSize: 3000 },
    ]);
    expect(scanZipSafety(zip)).toEqual({ ok: true });
  });

  it("rejects content with no end-of-central-directory record at all", () => {
    const result = scanZipSafety(Buffer.from("not a zip file, just some bytes that go on a while", "utf-8"));
    expect(result.ok).toBe(false);
  });

  it("rejects an archive claiming more entries than the entry-count ceiling, without ever walking them", () => {
    // A fabricated EOCD claiming 6000 entries against an otherwise-empty
    // central directory -- the entry-count check runs BEFORE iterating
    // entries, so this rejects cleanly rather than reading past the buffer.
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(6000, 8);
    eocd.writeUInt16LE(6000, 10);
    eocd.writeUInt32LE(0, 12);
    eocd.writeUInt32LE(0, 16);
    const result = scanZipSafety(eocd);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too many entries/);
  });

  it("rejects an entry whose declared compression ratio is bomb-like (huge uncompressed size, tiny compressed size)", () => {
    const zip = buildZipCentralDirectory([
      // 50MB uncompressed from 100 declared compressed bytes: a ~500,000x
      // ratio, comfortably over the threshold, while the 50MB total stays
      // well under the separate total-uncompressed-size cap -- isolating
      // the ratio check from the total-size check below.
      { name: "word/document.xml", compressedSize: 100, uncompressedSize: 50 * 1024 * 1024 },
    ]);
    const result = scanZipSafety(zip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/compression ratio/);
  });

  it("rejects an archive whose total declared uncompressed size is too large, even at an innocuous per-entry ratio", () => {
    const zip = buildZipCentralDirectory([
      { name: "media/image1.png", compressedSize: 200 * 1024 * 1024, uncompressedSize: 200 * 1024 * 1024 },
      { name: "media/image2.png", compressedSize: 200 * 1024 * 1024, uncompressedSize: 200 * 1024 * 1024 },
    ]);
    const result = scanZipSafety(zip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/total uncompressed size/);
  });

  it("rejects a path-traversal entry name", () => {
    const zip = buildZipCentralDirectory([{ name: "../../etc/passwd", compressedSize: 10, uncompressedSize: 10 }]);
    const result = scanZipSafety(zip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/suspicious path/);
  });

  it("rejects an absolute-path entry name", () => {
    const zip = buildZipCentralDirectory([{ name: "/etc/passwd", compressedSize: 10, uncompressedSize: 10 }]);
    const result = scanZipSafety(zip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/suspicious path/);
  });

  it("does not reject a small, ordinary entry with a modest compression ratio below the threshold", () => {
    // Plain XML text compresses well (10x here) but nowhere near bomb
    // territory, and is well under the ratio-check's minimum size anyway.
    const zip = buildZipCentralDirectory([{ name: "word/document.xml", compressedSize: 1000, uncompressedSize: 10_000 }]);
    expect(scanZipSafety(zip)).toEqual({ ok: true });
  });
});
