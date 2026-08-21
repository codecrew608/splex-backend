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
    id: "deep_research",
    category: "deep_research",
    capabilities: ["deep_research", "web_search", "citation_synthesis"],
    strongKeywords: [
      /\bdeep research\b/i,
      /\b(do|write|conduct) a (deep|thorough|comprehensive) (dive|research|report)\b/i,
      /\bcomprehensive research (report )?(on|into)\b/i,
      /\bwrite (me )?a research report\b/i,
      /\bresearch .*(thoroughly|in depth|in-depth)\b/i,
    ],
    weakKeywords: [/\bresearch report\b/i, /\bin-?depth research\b/i],
  },
  {
    id: "news_search",
    category: "web_search",
    capabilities: ["web_search", "news"],
    strongKeywords: [
      /\b(latest|breaking|today'?s|recent) news\b/i,
      /\bnews (about|on|regarding)\b/i,
      /\bwhat'?s (in|happening in) the news\b/i,
      /\bcurrent events\b/i,
    ],
    weakKeywords: [/\bnews\b/i, /\bheadlines\b/i],
  },
  {
    id: "web_search",
    category: "web_search",
    capabilities: ["web_search"],
    strongKeywords: [
      /\bsearch (the web|online|the internet)( for)?\b/i,
      /\b(google|look up) (that|this|it|\w[\w\s]{2,40})\b/i,
      /\bwhat('| i)?s the (current|latest) (price|version|status|score)\b/i,
      /\b(as of|right now|currently)\b.*\?/i,
      /\bwhat'?s happening (with|to)\b/i,
      // Live testing caught "what is the price of btc now" being answered
      // confidently from stale training data instead of triggering a
      // search — general_qa's broad /\bwhat is\b/i matched as the ONLY
      // strong hit, so classifyIntent's single-strong-match branch never
      // even reached the LLM fallback that would have caught this. Doesn't
      // require a trailing "?" (casual chat messages routinely omit one)
      // or the word "current"/"latest" before the noun (the existing
      // pattern above already covers that phrasing) — this catches the
      // "...price of X now/today" shape specifically, since price/value/
      // rate/cost questions are inherently time-sensitive in a way most
      // other "now"-suffixed questions aren't.
      /\b(price|value|cost|rate|worth)\b[\s\S]*\b(now|today|currently|right now|at the moment)\b/i,
    ],
    weakKeywords: [/\blatest\b/i, /\bcurrent(ly)?\b/i, /\bright now\b/i],
  },
  {
    id: "presentation_generation",
    category: "ppt",
    capabilities: ["presentation_generation", "long_form_generation"],
    strongKeywords: [
      /\b(make|create|build|generate|design) (me |us )?(a|an) (\w+ )?(presentation|slide ?deck|powerpoint|pptx?|deck)\b/i,
      /\b(presentation|slide ?deck|powerpoint) (about|on|for)\b/i,
      /\bslides? (about|on|for)\b/i,
    ],
    weakKeywords: [/\bpresentation\b/i, /\bslide ?deck\b/i, /\bpowerpoint\b/i, /\bslides\b/i],
  },
  {
    id: "video_generation",
    category: "video",
    capabilities: ["video_generation"],
    strongKeywords: [
      /\b(generate|create|make) (me |us )?(a|an) (short )?video( of| clip| showing)?\b/i,
      /\bvideo of\b/i,
      /\banimate (this|that|it)\b/i,
      /\btext[- ]to[- ]video\b/i,
    ],
    weakKeywords: [/\bvideo\b/i, /\banimation\b/i, /\bclip\b/i],
  },
  {
    id: "audio_generation",
    category: "audio",
    capabilities: ["audio_generation", "text_to_speech"],
    strongKeywords: [
      /\b(read|say) (this|that|it) (aloud|out loud)\b/i,
      /\btext[- ]to[- ]speech\b/i,
      /\bconvert (this|that|it) to (speech|audio|voice)\b/i,
      /\b(generate|create|make) (an? )?(audio|voiceover|narration)\b/i,
      /\bnarrate (this|that|it)\b/i,
    ],
    weakKeywords: [/\bspeech\b/i, /\bvoiceover\b/i, /\bnarration\b/i, /\btts\b/i],
  },
  {
    id: "image_generation",
    category: "image",
    capabilities: ["image_generation"],
    strongKeywords: [
      /\b(generate|create|draw|design|make|paint) (me |us )?(a|an) (image|picture|photo|illustration|drawing|painting|logo|icon|graphic|artwork)\b/i,
      /\b(image|picture|photo|illustration) of\b/i,
      /\btext[- ]to[- ]image\b/i,
    ],
    weakKeywords: [/\bdraw\b/i, /\billustrat/i, /\bartwork\b/i],
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
