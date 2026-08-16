// Intent taxonomy for the regex pre-filter. This is intent classification,
// not model routing — model_registry.category is the only thing that must
// stay DB-driven; the taxonomy of *what counts as* a category is allowed to
// live in code, and is explicitly meant to be extended over time by adding
// entries here.
//
// `category` must exactly match a value used in public.model_registry.category
// ('coding' | 'reasoning' | 'math' | 'writing' | 'vision' | 'documents' | 'general').

export interface IntentDefinition {
  id: string;
  category: string;
  capabilities: string[];
  strongKeywords: RegExp[];
  weakKeywords: RegExp[];
}

export const INTENTS: IntentDefinition[] = [
  {
    id: "code_generation",
    category: "coding",
    capabilities: ["code_generation", "technical_context"],
    strongKeywords: [
      /\bwrite (a|an|some) (function|script|program|class|component|api|endpoint)\b/i,
      /\bimplement\b/i,
      /\bbuild (a|an) (function|app|api|component|script)\b/i,
      /```[a-z]*\n/,
    ],
    weakKeywords: [/\bcode\b/i, /\bfunction\b/i, /\bscript\b/i],
  },
  {
    id: "debugging",
    category: "coding",
    capabilities: ["debugging", "reasoning", "technical_context"],
    strongKeywords: [
      /\bfix (this|my|the) (bug|error|code|issue)\b/i,
      /\bwhy (is|does) (this|my) .*(error|fail|break|crash)/i,
      /\bstack trace\b/i,
      /\btraceback\b/i,
    ],
    weakKeywords: [/\bbug\b/i, /\berror\b/i, /\bexception\b/i, /\bcrash(es|ing)?\b/i],
  },
  {
    id: "math_reasoning",
    category: "math",
    capabilities: ["math_reasoning", "reasoning"],
    strongKeywords: [
      /\bsolve for\b/i,
      /\bcalculate\b/i,
      /\bwhat is the (derivative|integral|probability)\b/i,
      /\bprove that\b/i,
      /\bequation\b/i,
    ],
    weakKeywords: [/\bmath\b/i, /\bnumber\b/i, /\bsum\b/i],
  },
  {
    id: "creative_writing",
    category: "writing",
    capabilities: ["creative_writing", "long_form_generation"],
    strongKeywords: [
      /\bwrite (a|an) (story|poem|essay|blog post|script|song)\b/i,
      /\bcompose (a|an)\b/i,
      /\bcreative writing\b/i,
    ],
    weakKeywords: [/\bstory\b/i, /\bpoem\b/i, /\bessay\b/i],
  },
  {
    id: "summarization",
    category: "documents",
    capabilities: ["summarization", "long_context"],
    strongKeywords: [
      /\bsummari[sz]e\b/i,
      /\btl;?dr\b/i,
      /\bgive me (a|the) (summary|gist)\b/i,
      /\bkey (points|takeaways)\b/i,
    ],
    weakKeywords: [/\bsummary\b/i, /\bshorten\b/i],
  },
  {
    id: "translation",
    category: "writing",
    capabilities: ["translation"],
    strongKeywords: [
      /\btranslate\b.*\bto\b/i,
      /\bhow do (you|i) say\b/i,
      /\bin (spanish|french|german|hindi|japanese|chinese|tamil|telugu)\b/i,
    ],
    weakKeywords: [/\btranslate\b/i, /\blanguage\b/i],
  },
  {
    id: "data_analysis",
    category: "reasoning",
    capabilities: ["analysis", "reasoning", "technical_context"],
    strongKeywords: [
      /\banaly[sz]e (this|my) data\b/i,
      /\bfind (patterns|trends|insights)\b/i,
      /\bcsv\b/i,
      /\bdataset\b/i,
    ],
    weakKeywords: [/\bdata\b/i, /\banalysis\b/i, /\btrend\b/i],
  },
  {
    id: "image_understanding",
    category: "vision",
    capabilities: ["vision", "image_understanding"],
    strongKeywords: [
      /\bwhat('| i)?s in this image\b/i,
      /\bdescribe this (image|photo|picture)\b/i,
      /\bread the text in (this|the) image\b/i,
    ],
    weakKeywords: [/\bimage\b/i, /\bphoto\b/i, /\bpicture\b/i, /\bscreenshot\b/i],
  },
  {
    id: "general_qa",
    category: "general",
    capabilities: ["general_knowledge"],
    strongKeywords: [/\bwhat is\b/i, /\bwho (is|was)\b/i, /\bexplain\b/i, /\bhow does .* work\b/i],
    weakKeywords: [/\bwhy\b/i, /\bhow\b/i, /\bwhat\b/i],
  },
];

export const GENERAL_FALLBACK_INTENT: IntentDefinition = {
  id: "general_qa",
  category: "general",
  capabilities: ["general_knowledge"],
  strongKeywords: [],
  weakKeywords: [],
};
