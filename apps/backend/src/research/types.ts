// Client-safe citation shape — url/title/snippet only. Never the raw
// OpenRouter annotation object (which also carries start_index/end_index,
// internal offsets into the model's own output that are meaningless once
// re-rendered as markdown and not worth exposing).
export interface Citation {
  url: string;
  title: string;
  snippet: string;
}

export interface WebSearchResult {
  text: string;
  citations: Citation[];
  costUsd: number;
  // False when the model answered from its own knowledge without actually
  // invoking the search tool (OpenRouter's tools are opt-in for the model,
  // not forced) — the caller uses this to decide whether "Searched the
  // web" framing is honest to show, rather than ever claiming a search
  // happened when citations is simply empty.
  searched: boolean;
}
