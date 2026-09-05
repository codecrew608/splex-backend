// Pulls substantial fenced code blocks out of a streamed assistant
// message's raw markdown so they can render as a separate "file" artifact
// instead of a long inline code block the user has to scroll through.
// Deliberately NOT implemented via a custom tag threaded through
// react-markdown (e.g. rehype-raw) — that means trusting model-generated
// text as raw HTML, which is exactly the kind of thing worth avoiding when
// a plain string-replace accomplishes the same thing more simply and
// without that risk. The stripped placeholder is ordinary markdown text.

export interface ExtractedArtifact {
  id: string;
  language: string;
  code: string;
  title: string;
}

// Small, short, or untagged blocks stay inline as a normal CodeBlock — the
// artifact treatment is for something worth treating as a "file", not a
// two-line shell command quoted in passing.
const MIN_LINES = 5;
const MIN_CHARS = 200;

const LANGUAGE_FILENAMES: Record<string, string> = {
  python: "script.py",
  py: "script.py",
  javascript: "script.js",
  js: "script.js",
  typescript: "script.ts",
  ts: "script.ts",
  tsx: "App.tsx",
  jsx: "App.jsx",
  html: "index.html",
  css: "styles.css",
  json: "data.json",
  sql: "query.sql",
  bash: "script.sh",
  sh: "script.sh",
  shell: "script.sh",
  java: "Main.java",
  cpp: "main.cpp",
  "c++": "main.cpp",
  c: "main.c",
  go: "main.go",
  rust: "main.rs",
  rs: "main.rs",
  ruby: "script.rb",
  rb: "script.rb",
  php: "script.php",
  yaml: "config.yaml",
  yml: "config.yaml",
  markdown: "README.md",
  md: "README.md",
};

function titleForLanguage(language: string, usedTitles: Set<string>): string {
  const base = LANGUAGE_FILENAMES[language.toLowerCase()] ?? (language ? `snippet.${language}` : "snippet.txt");
  if (!usedTitles.has(base)) return base;
  const [name, ext] = [base.slice(0, base.lastIndexOf(".")), base.slice(base.lastIndexOf("."))];
  let n = 2;
  while (usedTitles.has(`${name} (${n})${ext}`)) n++;
  return `${name} (${n})${ext}`;
}

// Matches a closed fence (```lang\ncode\n```) OR one still streaming in
// with no closing fence yet ($ instead) — the latter is what makes the
// panel fill in live as tokens arrive, rather than only appearing once the
// whole block is done.
const FENCE_RE = /```(\w*)\n([\s\S]*?)(?:```|$)/g;

export function extractArtifacts(content: string, messageId: string): { strippedContent: string; artifacts: ExtractedArtifact[] } {
  const artifacts: ExtractedArtifact[] = [];
  const usedTitles = new Set<string>();
  let index = 0;

  const strippedContent = content.replace(FENCE_RE, (match, language: string, code: string) => {
    const lineCount = code.split("\n").length;
    if (!language || (lineCount < MIN_LINES && code.length < MIN_CHARS)) return match;

    const title = titleForLanguage(language, usedTitles);
    usedTitles.add(title);
    const id = `${messageId}:${index++}`;
    // Trailing newline before the fence's own closing marker is cosmetic,
    // not part of the code — same trim CodeBlock's own caller already does.
    artifacts.push({ id, language, code: code.replace(/\n$/, ""), title });
    return `*[See \`${title}\` in the panel →]*`;
  });

  return { strippedContent, artifacts };
}
