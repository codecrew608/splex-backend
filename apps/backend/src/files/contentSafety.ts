// Server-side content validation for uploaded files (production completion
// pass, item 2/3). Two concerns, kept in one module since both exist for
// the same reason — never trust what the client SAYS a file is:
//
//  1. sniffFileType/validateDeclaredFileType: mime_type is 100% client-
//     declared (apps/web/components/chat/Composer.tsx sets it straight from
//     the browser's File.type before any server involvement — see
//     handlers/files.ts's own doc comment on the storage_path bypass for
//     the same class of "client metadata isn't truth" issue). Nothing
//     previously checked it against the bytes actually downloaded, so a
//     client could relabel arbitrary content to route it through whichever
//     extraction path it liked — e.g. claim application/pdf and have
//     anything fed straight into the PDF parser, or claim image/png and
//     have arbitrary bytes OCR'd as an "image".
//
//  2. scanZipSafety: DOCX (and any other ZIP-container format this app
//     might accept later) is parsed by a real zip-decompression library
//     (transitively, via mammoth) — a crafted archive with an extreme
//     compression ratio can exhaust memory/CPU before that library ever
//     returns a result ("zip bomb"). This reads ONLY the zip's central
//     directory (file names + compressed/uncompressed sizes) — no
//     decompression happens here — so it's cheap enough to run before the
//     real parser touches the file at all.
export type SniffedKind = "png" | "jpeg" | "gif" | "webp" | "pdf" | "zip" | "unknown";

const IMAGE_KINDS: ReadonlySet<SniffedKind> = new Set(["png", "jpeg", "gif", "webp"]);

// Every check here reads fixed magic-byte offsets only — no parsing of the
// rest of the file, so this is safe to run on arbitrary/hostile input.
export function sniffFileType(buffer: Buffer): SniffedKind {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61
  ) {
    return "gif";
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "webp";
  }
  if (
    buffer.length >= 5 &&
    buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46 && buffer[4] === 0x2d
  ) {
    return "pdf";
  }
  // Local-file-header (0x04034b50), empty-archive (0x06054b50), and
  // spanned-archive (0x08074b50) signatures — DOCX/XLSX/PPTX and every
  // other OOXML format are all just zip containers, always starting with
  // one of these.
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 && buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
  ) {
    return "zip";
  }
  return "unknown";
}

// Conservative binary-content heuristic for formats with no reliable magic
// bytes at all (plain text / source code) — the same approach git and many
// other tools use: a NUL byte anywhere in a leading sample is a strong
// signal the content is not text, regardless of what extension or
// mime-type it was uploaded with. Deliberately simple and cheap; it isn't
// meant to catch everything, only to reject an obviously-mislabeled binary
// masquerading as source/text.
const BINARY_SNIFF_SAMPLE_BYTES = 8000;
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_SAMPLE_BYTES));
  return sample.includes(0);
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type FileTypeValidation = { ok: true } | { ok: false; reason: string };

// Called once, up front, right after the real bytes are known — every
// extraction branch downstream keys off file.mime_type, so this is the one
// place a mismatch has to be caught to protect all of them at once.
// `looksLikeTextClaim` is passed in rather than recomputed here so the
// extension/CODE_EXTENSIONS list stays owned by handlers/files.ts, not
// duplicated.
export function validateDeclaredFileType(params: {
  buffer: Buffer;
  mimeType: string | null;
  looksLikeTextClaim: boolean;
}): FileTypeValidation {
  const { buffer, mimeType, looksLikeTextClaim } = params;

  if (buffer.length === 0) {
    return { ok: false, reason: "empty file" };
  }

  const sniffed = sniffFileType(buffer);

  if (mimeType?.startsWith("image/")) {
    // Only a fixed allowlist of raster formats is ever accepted as an
    // "image" attachment. Deliberately excludes SVG and anything else that
    // merely CLAIMS an image/* content-type but has no safe binary
    // signature to verify — SVG is XML text that can carry an embedded
    // <script>, so there's no sniff that makes trusting it safe here. Fail
    // closed rather than attempt SVG sanitization.
    if (!IMAGE_KINDS.has(sniffed)) {
      return { ok: false, reason: `declared an image type but content sniffed as '${sniffed}'` };
    }
    return { ok: true };
  }

  if (mimeType === "application/pdf") {
    if (sniffed !== "pdf") {
      return { ok: false, reason: `declared application/pdf but content sniffed as '${sniffed}'` };
    }
    return { ok: true };
  }

  if (mimeType === DOCX_MIME) {
    if (sniffed !== "zip") {
      return { ok: false, reason: `declared a .docx but content sniffed as '${sniffed}'` };
    }
    return { ok: true };
  }

  if (looksLikeTextClaim) {
    if (looksBinary(buffer)) {
      return { ok: false, reason: "declared a text/code file but content looks binary" };
    }
    return { ok: true };
  }

  // Anything else falls through unchanged — processFile's own
  // "unsupported file type" branch already rejects types this app doesn't
  // attempt to extract at all; this function's job is only to catch a
  // mismatch for the types it DOES actively parse.
  return { ok: true };
}

// ---- ZIP central-directory safety scan (decompression-bomb guard) ----

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
// EOCD is fixed-size (22 bytes) plus up to a 64KB comment — search window
// has to cover the worst case.
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 65535;

// Generous headroom over anything a legitimate document plausibly needs
// (a real-world DOCX/PPTX with dozens of embedded images still lands in
// the low hundreds of entries) while still bounding a pathological archive
// with millions of tiny entries.
const MAX_ZIP_ENTRIES = 5000;
// Total uncompressed content across all entries. Office documents' actual
// content (XML text + embedded media) rarely approaches this even with
// many high-resolution images, since those are already near-incompressible
// and so contribute roughly 1:1 to both this cap and the file's own
// (already-enforced) on-disk size limit.
const MAX_TOTAL_UNCOMPRESSED_BYTES = 300 * 1024 * 1024;
// Per-entry compression ratio. Legitimate XML/text streams (document.xml,
// styles.xml, ...) typically compress 5-20x; classic zip-bomb constructions
// reach ratios in the thousands. 300x sits comfortably above real documents
// and comfortably below a bomb. Only checked once an entry's uncompressed
// size is large enough for the ratio to matter (see MIN_RATIO_CHECK_BYTES)
// — a tiny stored/near-empty entry can have a huge nominal ratio (e.g. 0
// compressed bytes) without being any kind of threat.
const MAX_COMPRESSION_RATIO = 300;
const MIN_RATIO_CHECK_BYTES = 1024 * 1024;

export type ZipSafetyResult = { ok: true } | { ok: false; reason: string };

function isSuspiciousEntryName(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\")) return true;
  if (/^[a-zA-Z]:/.test(name)) return true; // Windows drive-letter absolute path
  return name.split(/[/\\]/).some((segment) => segment === "..");
}

// Manual little-endian reads instead of Buffer's readUInt32LE/readUInt16LE
// — deliberately, not a style preference: @cloudflare/workers-types'
// ambient Buffer type (this module is compiled under both the Node and
// Worker tsconfigs) doesn't declare those methods, only plain numeric
// indexing and .subarray, which every Buffer implementation supports
// identically. Same reasoning for decoding entry names via TextDecoder
// below instead of buffer.toString(encoding).
function readU32LE(buffer: Buffer, offset: number): number {
  return (buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) >>> 0;
}
function readU16LE(buffer: Buffer, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8);
}
const utf8Decoder = new TextDecoder("utf-8");

// Reads ONLY the central directory's per-entry metadata (name + declared
// compressed/uncompressed sizes) — never decompresses a single byte of
// actual entry content. Safe to run on hostile input specifically because
// of that: even a maximally hostile archive can't make this function do
// more work than "read a few thousand small, fixed-format records".
//
// Anything this parser can't confidently make sense of (malformed
// structure, ZIP64 extensions — vanishingly rare for a real Office
// document) is rejected rather than guessed at: "reject suspicious archive
// structures" applies as much to "structure I can't verify" as to
// "structure I can verify is bad".
export function scanZipSafety(buffer: Buffer): ZipSafetyResult {
  if (buffer.length < EOCD_MIN_SIZE) return { ok: false, reason: "too small to be a valid archive" };

  const searchStart = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  let eocdOffset = -1;
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (readU32LE(buffer, i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return { ok: false, reason: "no end-of-central-directory record found" };

  const totalEntries = readU16LE(buffer, eocdOffset + 10);
  const centralDirSize = readU32LE(buffer, eocdOffset + 12);
  const centralDirOffset = readU32LE(buffer, eocdOffset + 16);

  // ZIP64 sentinel values — this app never expects a genuinely ZIP64-sized
  // Office document; treat the (extremely rare, for this app's use case)
  // presence of one as unsupported rather than parse the ZIP64 locator.
  if (totalEntries === 0xffff || centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
    return { ok: false, reason: "ZIP64 archives are not supported" };
  }
  if (totalEntries > MAX_ZIP_ENTRIES) {
    return { ok: false, reason: `archive has too many entries (${totalEntries} > ${MAX_ZIP_ENTRIES})` };
  }
  if (centralDirOffset + centralDirSize > eocdOffset) {
    return { ok: false, reason: "central directory extends past end-of-central-directory record" };
  }

  let cursor = centralDirOffset;
  let totalUncompressed = 0;

  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex++) {
    if (cursor + 46 > buffer.length) return { ok: false, reason: "truncated central directory entry" };
    if (readU32LE(buffer, cursor) !== CENTRAL_DIR_SIGNATURE) {
      return { ok: false, reason: "malformed central directory entry" };
    }

    const compressedSize = readU32LE(buffer, cursor + 20);
    const uncompressedSize = readU32LE(buffer, cursor + 24);
    const filenameLength = readU16LE(buffer, cursor + 28);
    const extraLength = readU16LE(buffer, cursor + 30);
    const commentLength = readU16LE(buffer, cursor + 32);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      return { ok: false, reason: "ZIP64 archives are not supported" };
    }

    const nameStart = cursor + 46;
    const nameEnd = nameStart + filenameLength;
    if (nameEnd > buffer.length) return { ok: false, reason: "truncated central directory entry name" };
    const name = utf8Decoder.decode(buffer.subarray(nameStart, nameEnd));
    if (isSuspiciousEntryName(name)) {
      return { ok: false, reason: `archive entry has a suspicious path: ${name}` };
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      return { ok: false, reason: "archive's total uncompressed size is too large" };
    }
    if (
      uncompressedSize > MIN_RATIO_CHECK_BYTES &&
      uncompressedSize / Math.max(compressedSize, 1) > MAX_COMPRESSION_RATIO
    ) {
      return { ok: false, reason: `archive entry has a suspicious compression ratio: ${name}` };
    }

    cursor = nameEnd + extraLength + commentLength;
  }

  return { ok: true };
}
