import { describe, it, expect } from "vitest";
import { applyDeterministicOptimization } from "../src/optimizer/deterministic.js";
import { extractProtectedContent, restoreProtectedContent, protectedPlaceholdersIn } from "../src/optimizer/protect.js";

describe("applyDeterministicOptimization — Layer A (spec item 2): zero AI cost, unconditionally safe", () => {
  it("collapses runs of whitespace and excess blank lines", () => {
    const result = applyDeterministicOptimization("Hello,    please   help.\n\n\n\nThanks.");
    expect(result.text).toBe("Hello, please help.\n\nThanks.");
    expect(result.changed).toBe(true);
  });

  it("removes an exact duplicate line (long enough to matter)", () => {
    const line = "Please review this code carefully for bugs and security issues.";
    const result = applyDeterministicOptimization(`${line}\nSome other content here.\n${line}`);
    expect(result.duplicateLinesRemoved).toBe(1);
    expect(result.text.match(new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
  });

  it("does NOT dedupe short lines — list markers and short repeats are structure, not redundancy", () => {
    const result = applyDeterministicOptimization("- item\n- item\n- item");
    expect(result.duplicateLinesRemoved).toBe(0);
    expect(result.text).toBe("- item\n- item\n- item");
  });

  it("removes a whole sentence restated verbatim (case-insensitively) elsewhere in the paragraph", () => {
    const sentence = "Please check for bugs carefully before merging this branch.";
    const result = applyDeterministicOptimization(`I need help with this PR. ${sentence} Thanks a lot! ${sentence.toUpperCase()}`);
    expect(result.duplicateSentencesRemoved).toBe(1);
  });

  it("does NOT attempt to catch a phrase repeated inside a differently-worded sentence — that needs phrase-level matching, out of scope for an unconditionally-safe layer", () => {
    const sentence = "Please check for bugs carefully before merging this branch.";
    const result = applyDeterministicOptimization(`I need help with this PR. ${sentence} As I said, ${sentence.toLowerCase()}`);
    // "As I said, please check..." is a DIFFERENT whole sentence from
    // "Please check...", even though it contains the same clause — not a
    // false negative, a deliberate scope boundary.
    expect(result.duplicateSentencesRemoved).toBe(0);
  });

  it("a duplicate sentence removal drops exactly its own trailing separator, never a neighbor's — no stray double-space or lost paragraph break", () => {
    const sentence = "Please check for bugs carefully before merging this branch.";
    const result = applyDeterministicOptimization(`${sentence}\n\n${sentence}\n\nA final unrelated closing remark here.`);
    expect(result.text).toBe(`${sentence}\n\nA final unrelated closing remark here.`);
  });

  it("a clean, non-redundant message is reported as unchanged", () => {
    const text = "Write a haiku about autumn leaves falling in the wind.";
    const result = applyDeterministicOptimization(text);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(text);
  });

  it("never drops or reorders real content — only whitespace/duplication is removed", () => {
    const text = "First point about the API design. Second point about database schema. Third point about testing strategy.";
    const result = applyDeterministicOptimization(text);
    expect(result.text).toContain("First point about the API design");
    expect(result.text).toContain("Second point about database schema");
    expect(result.text).toContain("Third point about testing strategy");
  });
});

describe("extractProtectedContent / restoreProtectedContent — spec item 6", () => {
  it("protects a fenced code block and restores it byte-for-byte", () => {
    const code = "```js\nfunction add(a, b) {\n  return a + b;\n}\n```";
    const { text, spans } = extractProtectedContent(`Please review this:\n${code}\nThanks.`);
    expect(text).not.toContain("function add");
    expect(restoreProtectedContent(text, spans)).toBe(`Please review this:\n${code}\nThanks.`);
  });

  it("protects inline code without touching surrounding prose", () => {
    const { text, spans } = extractProtectedContent("Run `npm install --save-dev` before building.");
    expect(text).not.toContain("npm install");
    expect(restoreProtectedContent(text, spans)).toBe("Run `npm install --save-dev` before building.");
  });

  it("protects a URL exactly, including query string", () => {
    const url = "https://api.example.com/v2/users?id=42&active=true";
    const { text, spans } = extractProtectedContent(`Fetch data from ${url} please.`);
    expect(text).not.toContain(url);
    expect(restoreProtectedContent(text, spans)).toContain(url);
  });

  it("protects a valid JSON block via balanced-bracket detection", () => {
    const json = '{"name": "test", "values": [1, 2, 3], "nested": {"ok": true}}';
    const { text, spans } = extractProtectedContent(`Use this config: ${json} when starting.`);
    expect(text).not.toContain('"nested"');
    expect(restoreProtectedContent(text, spans)).toContain(json);
  });

  it("does NOT protect malformed/unbalanced JSON-looking text — falls through safely", () => {
    const { text, spans } = extractProtectedContent("The object {a: 1, b: is incomplete here.");
    // Not valid JSON (unquoted key, trailing "is"), so it stays as plain text.
    expect(spans.length).toBe(0);
    expect(text).toContain("is incomplete here");
  });

  it("protects an API-key-shaped token", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz1234567890ABCD";
    const { text, spans } = extractProtectedContent(`My key is ${key}, keep it safe.`);
    expect(text).not.toContain(key);
    expect(restoreProtectedContent(text, spans)).toContain(key);
  });

  it("protects a Groq-shaped secret token", () => {
    // Fake, not a real credential — matches the gsk_ shape only.
    const key = "gsk_FAKEKEYFORTESTINGPURPOSESONLYxxxxxxxxxxxxxxxxxxxx";
    const { spans } = extractProtectedContent(`Use ${key} as the token.`);
    expect(spans).toContain(key);
  });

  it("multiple protected spans each get a distinct placeholder and restore independently", () => {
    const code = "`const x = 1;`";
    const url = "https://example.com/docs";
    const { text, spans } = extractProtectedContent(`See ${code} and ${url} for reference.`);
    const placeholders = protectedPlaceholdersIn(text);
    expect(placeholders.length).toBe(2);
    expect(new Set(placeholders).size).toBe(2); // distinct, not the same placeholder twice
    expect(restoreProtectedContent(text, spans)).toBe(`See ${code} and ${url} for reference.`);
  });

  it("placeholder marker does not collide with ordinary technical text like 'P0 bug'", () => {
    const { text, spans } = extractProtectedContent("This is a P0 bug affecting the P1 checkout flow.");
    // Nothing should be protected here at all — no code/URL/JSON/secret shape —
    // and critically, "P0"/"P1" must survive completely untouched.
    expect(spans.length).toBe(0);
    expect(text).toBe("This is a P0 bug affecting the P1 checkout flow.");
  });

  it("text with no protectable content round-trips unchanged", () => {
    const text = "Just an ordinary sentence with nothing special in it.";
    const { text: extracted, spans } = extractProtectedContent(text);
    expect(extracted).toBe(text);
    expect(spans).toEqual([]);
    expect(restoreProtectedContent(extracted, spans)).toBe(text);
  });

  it("restoreProtectedContent leaves an out-of-range placeholder untouched rather than crashing", () => {
    expect(restoreProtectedContent("see ⟦SPLEXPROTECT5⟧ here", [])).toBe("see ⟦SPLEXPROTECT5⟧ here");
  });
});
