// Generic, user-facing labels for each model_registry.category. This map —
// never openrouter_model_id — is what the Cortex panel is allowed to show.
const CATEGORY_LABELS: Record<string, string> = {
  coding: "Software Development",
  reasoning: "Advanced Reasoning",
  math: "Mathematics",
  writing: "Writing & Content",
  vision: "Visual Understanding",
  documents: "Document Analysis",
  general: "General Assistance",
};

export function categoryToLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? "General Assistance";
}
