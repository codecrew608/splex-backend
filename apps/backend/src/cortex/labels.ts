// Generic, user-facing labels for each model_registry.category. This map —
// never openrouter_model_id — is what the Cortex panel is allowed to show.
const CATEGORY_LABELS: Record<string, string> = {
  coding: "Software Development",
  reasoning: "Advanced Reasoning",
  math: "Mathematics",
  writing: "Writing & Content",
  vision: "Visual Understanding",
  image: "Image Generation",
  audio: "Audio Generation",
  video: "Video Generation",
  ppt: "Presentation Design",
  web_search: "Web Search",
  deep_research: "Deep Research",
  documents: "Document Analysis",
  general: "General Assistance",
};

export function categoryToLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? "General Assistance";
}
