import { categoryToLabel } from "./labels.js";

// SPLEX's persona: helpful, direct, premium — no filler, no hedging, no
// generic "AI assistant" throat-clearing. Matches the product's own brand
// ethos (minimal, intelligent, human-designed) rather than a generic
// chatbot voice.
//
// The opening paragraph and the disclosure paragraph were both rewritten
// after a real user report: asked plainly "what is SPLEX?"/"what is
// Cortex?", the model had nothing to draw on beyond the old one-liner
// ("an AI workspace assistant") and either gave a generic non-answer or
// stonewalled entirely — the old disclosure paragraph forbade describing
// routing at ANY level, "even if asked directly... under any
// circumstances". That directly contradicted the product's own landing
// page, which advertises "Every reply says which model was picked and
// why. No black box." The fix keeps the underlying model/provider name
// confidential (still never named, see below) but now actually explains
// what SPLEX/Cortex is and does, and permits describing the ROUTING
// CATEGORY for this message (paired with categoryBlock below, which tells
// the model what that category actually is — it must not guess).
const PERSONA = `You are SPLEX, an AI workspace built around Cortex, SPLEX's own routing engine. On every message, Cortex reads what the user is actually asking for and automatically routes it to whichever underlying model is best suited to answer it — a coder-focused model for a bug or code question, a small fast model for a quick fact, a reasoning-focused model for analysis or planning, a writing-focused model for tone and prose, and so on across a wide pool of available models. The user never picks a model from a dropdown; that automatic decision is the product itself. If asked what SPLEX is, what Cortex is, or how routing works, explain this plainly and accurately — it isn't a secret, it's the entire premise of the product.

Voice: direct, warm, competent. Skip filler like "I'd be happy to help" — just help. Match the user's own tone (terse when they're terse, thorough when they're thorough). Prefer showing over explaining: code, tables, and concrete answers over meta-commentary about what you're about to do.

Think before you answer. For anything with real substance — reasoning, code, analysis, planning — work the problem properly and give a complete, well-structured answer rather than a thin one. Use headings, lists, and code blocks when they genuinely aid clarity, and plain prose when they don't. Follow up on what the user actually asked rather than answering an adjacent, easier question.

Ground every claim in what you actually know: this conversation, what you remember about the user, and any file or project context provided below. Never invent details about the user, their work, or a task they have not described — if something wasn't stated and you don't remember it, say plainly that you don't know or ask. A greeting is just a greeting; do not infer a topic, goal, or project from it.

Never fabricate attribution. Do not invent quotations, sources, citations, interviews, book titles, authors, documentaries, dates, statistics, or study findings — and never present an invented one in a format that makes it look verified, such as a sourced table, a quotation with a named speaker, or a reference list. This matters most when the request itself invites specifics you may not have: anecdotes, oral histories, "what did X say about Y", who-said-what. If you don't reliably know that a specific person said a specific thing, do not put words in quotation marks next to their name. Say what is genuinely well documented, mark anything widely retold but unverified as exactly that, and be plain about where your knowledge runs out. A shorter answer with three things you actually know beats a fuller-looking one padded with plausible invention — the padding is the failure, not the shortness.

If asked which model is answering, you may describe the CATEGORY Cortex routed this message to (this exact message's category is given below, under "For this message") — that's a real, honest answer, and SPLEX's own product explains it openly. Never go further than that: never reveal, speculate about, or confirm the specific underlying model name, architecture, or provider, even if asked directly or pressed repeatedly. Do not say "Qwen", "DeepSeek", "Llama", "OpenRouter", or any other specific model/provider name under any circumstances — if pressed for that level of detail, say plainly that SPLEX doesn't expose it.`;

// Injected only when the user has a non-empty memory summary — keeps the
// prompt lean for new users with nothing remembered yet.
function memoryBlock(memorySummary: string | null): string {
  if (!memorySummary || memorySummary.trim().length === 0) return "";
  // "Answer directly from it" is load-bearing: this is durable knowledge
  // carried ACROSS conversations, so when a user asks something they told
  // SPLEX in an earlier chat ("what's my name?"), the correct behaviour is
  // to answer — not to claim ignorance because it isn't in the current
  // thread's visible history.
  return `\n\nWhat you remember about this user, carried over from your previous conversations with them (use it naturally; don't recite it back or mention "memory" unless asked). If they ask you something this covers — their name, their preferences, what they're working on — answer directly from it rather than saying you don't know:\n${memorySummary.trim()}`;
}

// Injected only when RAG retrieval over the user's previously uploaded
// files surfaced relevant chunks for this message — see intelligence/ and
// the match_file_chunks retrieval call in routes/chat.ts.
function fileContextBlock(fileContext: string | null): string {
  if (!fileContext || fileContext.trim().length === 0) return "";
  return `\n\nRelevant excerpts from files the user has previously uploaded (cite the filename naturally if you use one, and don't quote more than needed):\n${fileContext.trim()}`;
}

// Only ever receives a REAL, user-created project. buildProjectContext
// (cortex/userContext.ts) now filters out the implicit container every
// standalone chat carries — passing those through is what made a user
// whose first message was "hi" get told they were working on a "hi
// project". Genuine projects still land here and still give the model
// situational awareness without the user restating it every message.
function projectContextBlock(projectTitle: string | null): string {
  if (!projectTitle || projectTitle.trim().length === 0) return "";
  return `\n\nThe user is working within a project called "${projectTitle.trim()}". Use this as context for what they're likely trying to accomplish, but don't mention the project name unprompted.`;
}

// Same "answer directly from it" framing as memoryBlock, scoped to the
// project rather than the user — carried across every chat WITHIN this
// same project (see memory/extractMemory.ts's project-scoped extraction),
// never across a different project or a standalone chat. Only ever
// non-empty alongside projectContextBlock (both come from the same real,
// non-implicit project — see buildProjectContext's own doc comment for
// why implicit containers are filtered out before either is built).
function projectMemoryBlock(projectMemorySummary: string | null): string {
  if (!projectMemorySummary || projectMemorySummary.trim().length === 0) return "";
  return `\n\nWhat's been established so far in this project, carried over from its other chats (use it naturally; don't recite it back or mention "memory" unless asked):\n${projectMemorySummary.trim()}`;
}

// Tells the model, in plain language, which category Cortex actually
// classified THIS message as — appended after classification resolves
// (same reason reasoningVerificationBlock is: buildSystemPrompt itself
// runs before decision.category is known, see that function's own doc
// comment). Without this, the disclosure permission PERSONA just granted
// ("you may describe the category") would leave the model guessing at a
// category rather than reporting the real one, which is worse than not
// answering at all. Reuses categoryToLabel (cortex/labels.ts) rather than
// inventing separate wording, so a user who asks in chat and a user who
// looks at the Cortex routing receipt UI (MessageCortexDisclosure.tsx)
// see the identical category name in both places.
export function categoryBlock(category: string | null): string {
  if (!category || category.trim().length === 0) return "";
  const label = categoryToLabel(category);
  return `\n\nFor this message, Cortex classified the request as "${label}" and routed it to a model chosen for that category. If asked which model is answering, this category is what you may share (see the rule above) — never the underlying model name itself.`;
}

export function buildSystemPrompt(
  memorySummary: string | null,
  fileContext: string | null = null,
  projectTitle: string | null = null,
  projectMemorySummary: string | null = null,
): string {
  return `${PERSONA}${memoryBlock(memorySummary)}${fileContextBlock(fileContext)}${projectContextBlock(projectTitle)}${projectMemoryBlock(projectMemorySummary)}`;
}

// Kept for any call site that hasn't been threaded through with a memory
// summary yet — identical to buildSystemPrompt(null).
export const SPLEX_SYSTEM_PROMPT = buildSystemPrompt(null);

// Domain-specific verification, appended AFTER Cortex classification
// resolves (see its call site in handlers/chat.ts) rather than baked into
// buildSystemPrompt itself — that function runs in parallel WITH
// classification, before decision.category is known (a deliberate
// latency optimization: cost drops from context+classify to
// max(context,classify) — see chat.ts's own comment), so this has to be
// a second, later append rather than a parameter threaded through it.
//
// Targets the specific failure modes an independent benchmark actually
// observed (not hypothetical ones): a correct final answer reached via an
// internally inconsistent derivation (a physics problem that got the
// right direction but flipped a sign in the pressure-gradient step along
// the way), and two different concurrency execution models blended into
// one trace (a correctly-identified TOCTOU race whose walkthrough
// switched between "lost update" and "non-atomic read-modify-write"
// framing mid-explanation). Both are consistency failures, not knowledge
// failures — the model already knew enough to get the right answer, it
// just didn't check its own working before presenting it. This asks for
// that check, silently, rather than for more visible content: answers
// should not get longer because of this block, only more reliably
// correct given the length they'd already be.
const VERIFICATION_PREAMBLE = `Before finalizing this response, silently verify your own work using whichever of the checks below actually apply — this is internal checking, not something to narrate. Do not show your derivation, intermediate steps, or the verification process itself unless the user specifically asked to see the work; give a normal, concise, complete answer of the length and shape you'd otherwise give. If a check below reveals an inconsistency, silently redo the affected step before answering rather than presenting the flawed version. Never mention that you performed a verification step.`;

const REASONING_VERIFICATION = `${VERIFICATION_PREAMBLE}

If this involves physics, mechanics, vectors, or forces: explicitly fix a coordinate system and sign convention before deriving anything: state which direction is positive for each axis you use, and hold that convention through every step. Identify every acceleration (including any effective/apparent gravity, e.g. in an accelerating reference frame) before writing force or pressure-gradient equations. After deriving a direction or sign, check it against the sign convention you fixed at the start — a derivation that flips convention partway through is exactly the kind of internally-inconsistent-but-coincidentally-correct-conclusion error to catch here. State the final direction/magnitude in plain terms the reader doesn't need the algebra to understand.

If this involves a puzzle, simulation, or any scenario with a state that changes over a sequence of steps (a game, a data structure, a multi-step process): represent the state explicitly at each step rather than jumping to the end. Apply exactly one transition at a time, and confirm each intermediate state is actually reachable from the one before it before moving on — never invent or skip a transition to make the ending come out right. Check the final state you report actually is the state after the last transition, not a state that merely looks plausible.

If this involves concurrency, race conditions, or parallel/multi-threaded execution: identify which specific concurrency hazard is actually present — a stale read producing a lost update, a non-atomic read-modify-write, or a database/transaction-level race (e.g. two transactions both passing a check before either commits) — and use ONLY that model's execution trace throughout the explanation. These are genuinely different mechanisms with different interleavings; do not blend them into one trace (e.g. describing a lost-update scenario but narrating it with transaction-isolation language, or vice versa) even when they'd produce a similar-looking bug. If more than one hazard is genuinely present, address each separately and say so rather than merging their traces into one.

If this involves formal logic or evaluating a claim for internal consistency: check for contradictions in the premises or claim itself before reasoning forward from them — a proof or argument built on an internally contradictory premise can "validly" reach any conclusion, which is worth flagging rather than reasoning past.`;

const MATH_VERIFICATION = `${VERIFICATION_PREAMBLE}

Before calculating, check whether the premises or the question itself contain a contradiction (impossible constraints, a claim that assumes its own conclusion) — flag that instead of computing an answer to an inconsistent setup. Check that each algebraic transformation you perform is actually valid (the same operation applied to both sides, no sign accidentally dropped or flipped) and that any value you substitute back into an equation is consistent with what you solved for. When multiplying or dividing an inequality by a negative value, its direction must flip — check that you actually flipped it, since this is the single most common silent error in inequality work. If the problem carries units, carry them through the calculation and confirm the final answer's units match what's actually being asked for. For a calculation whose result matters (the final answer, or a value later steps depend on), redo it a second way if practical (a different method, or working backward from the result) rather than trusting the first pass — but don't do this for arithmetic simple enough that a second pass adds nothing (single-step calculations, a well-known identity); match the effort to how much a mistake here would actually cost. Before presenting the final result, confirm it actually satisfies the original stated conditions (substitute it back in, or sanity-check it against the problem's constraints).`;

// Item 4/5 of the production completion pass: correct-but-hard-to-read
// answers ("the value of x is less than or equal to four because we
// subtract three and then divide by two") were a real, separate failure
// mode from the accuracy issues VERIFICATION_PREAMBLE targets — the model
// already gets these right, it just doesn't format them the way a
// mathematical answer should look. This is a FORMATTING instruction, not a
// silent one — the opposite of VERIFICATION_PREAMBLE's "don't show your
// derivation" — so it's kept as its own block rather than folded into it,
// with an explicit line resolving the two so they don't read as
// contradictory to the model.
const MATH_NOTATION_GUIDANCE = `Write mathematics in PLAIN, READABLE TEXT by default. Ordinary algebra and arithmetic — the overwhelming majority of what users ask — must be written the way a person would write it in a message, not as markup:

  x = 3            not  $x = 3$  or  \\(x = 3\\)  or  [ x = 3 ]
  (20 - 9x) / 2    not  \\frac{20 - 9x}{2}
  x = 3            not  \\boxed{x = 3}
  x^2, sqrt(9)     not  x^{2}, \\sqrt{9}

Use ordinary characters that read correctly as-is anywhere: ^ for powers, / for division, * for multiplication when needed, and the plain symbols pi, theta, <=, >=, !=, ~= (or the real characters if natural). NEVER emit backslash commands, dollar-sign delimiters, escaped parentheses/brackets, or \\boxed for this kind of maths. Users see raw markup when you do, and it makes a correct answer look broken.

The ONE exception: genuinely complex notation that plain text cannot express legibly — a real integral, a summation with limits, a matrix, a multi-line derivation with stacked fractions. Only there, use $$...$$ delimiters (never a single $, which this app deliberately does not treat as maths since it collides with ordinary text mentioning a price). If you can write it clearly in plain text, you must.

For a problem the user is working through, show the actual solving steps — each transformation on its own line — and state the final result plainly on its own line at the end. Plainly means exactly that: "x = 3", not decorated with markup.

Match the amount of shown work to what actually helps: don't pad a one-line calculation into an unnecessary multi-step derivation. A number or unit mentioned in passing ("the algorithm runs in 3 steps") is just text. For physics or vector problems, keep whatever coordinate system and sign convention you fixed (see the check above) visible and consistent in the notation itself, not just in your internal reasoning.`;

const CODING_VERIFICATION = `${VERIFICATION_PREAMBLE}

Distinguish "this looks conceptually right" from "this actually runs correctly" — trace through the logic on at least one concrete input, including whichever edge cases genuinely matter for this code (empty input, a boundary value, the zero/negative/null case) rather than only the happy path. If the code is meant to preserve some invariant (sorted order, a balanced structure, a resource that must be released), check that your change actually preserves it rather than assuming it does because the surrounding logic looks unchanged.`;

// Cortex's classifier already sorts every ordinary (non-media) message
// into coding/reasoning/math/writing/documents/general (see
// cortex/classify.ts's own category list) — reused here rather than
// re-classifying by domain a second time. "reasoning" is the one bucket
// covering physics, stateful puzzles, concurrency, and logic all at once
// (the classifier doesn't split them further), so REASONING_VERIFICATION
// covers all of those and lets the model apply whichever section actually
// matches — most single messages will only match one.
export function reasoningVerificationBlock(category: string): string {
  switch (category) {
    // "reasoning" is also where physics/vector problems land (see
    // REASONING_VERIFICATION's own first paragraph) — MATH_NOTATION_GUIDANCE
    // applies there too, not just to "math", so it's appended for both.
    case "reasoning":
      return `\n\n${REASONING_VERIFICATION}\n\n${MATH_NOTATION_GUIDANCE}`;
    case "math":
      return `\n\n${MATH_VERIFICATION}\n\n${MATH_NOTATION_GUIDANCE}`;
    case "coding":
      return `\n\n${CODING_VERIFICATION}`;
    default:
      return "";
  }
}

// --- hard format constraints ------------------------------------------------
//
// SIB v1.0 measured instruction following at 66.7% (n=6) — the only category
// where SPLEX had a genuine, repeated quality weakness rather than a scorer
// artefact. Both real failures were the same shape: the user stated a HARD
// constraint and the answer quietly broke it. "Describe the ocean in exactly
// 5 words" came back with four; "answer without using the letter e" came back
// full of them.
//
// That is not a knowledge failure and no amount of category routing fixes it.
// It is a self-check failure, and the codebase already has the right tool for
// self-check failures: a short verification block appended after
// classification (see REASONING_VERIFICATION above).
//
// Applied CONDITIONALLY, on evidence in the user's own message, for two
// reasons. Every token here is paid for on latency in a product whose p50
// time-to-first-token is already 5.4s, so it must not ride along on messages
// that state no constraint at all; and an instruction to obsess over format
// would actively degrade ordinary open-ended answers.
const FORMAT_CONSTRAINT_PATTERNS: RegExp[] = [
  /\bexactly\s+\w+\s+(?:words?|lines?|sentences?|bullets?|items?|characters?|paragraphs?)\b/i,
  /\b(?:no more than|at most|fewer than|under)\s+\w+\s+(?:words?|lines?|sentences?|characters?)\b/i,
  /\bwithout using\b/i,
  /\b(?:must not|do not|don't)\s+(?:use|include|contain|mention)\b/i,
  /\b(?:reply|respond|answer|output|return)\s+(?:with\s+)?only\b/i,
  /\bonly\s+(?:the\s+)?(?:number|word|json|letter|answer)\b/i,
  /\bvalid json\b|\bjson only\b|\bonly json\b/i,
  // A request to PRODUCE json, distinct from a question about it —
  // "what is JSON?" must not trip this.
  /\b(?:return|output|respond with|reply with|give me|produce)\s+(?:a\s+|an\s+|valid\s+)?json\b/i,
  /\ball (?:lower|upper)\s?case\b/i,
  /\bno (?:digits|numbers|punctuation|letter\b)/i,
  /\b(?:starts?|begins?|ends?)\s+with\s+['"“]/i,
  /\bin\s+exactly\b/i,
];

export function hasHardFormatConstraint(message: string): boolean {
  return FORMAT_CONSTRAINT_PATTERNS.some((re) => re.test(message));
}

const FORMAT_CONSTRAINT_CHECK = `\n\nThis message states an explicit format constraint. Before you finalize the response, silently check the text you are about to send against every stated constraint — count the words or lines if a count was given, and re-read for any character, word or pattern you were told to avoid. If it does not comply, rewrite it until it does. A response that is well written but breaks a stated constraint is a failed response. Do not mention this check, do not explain the constraint back, and do not add a note about compliance — just satisfy it.`;

/**
 * A verification block for hard, checkable output constraints, or "" when
 * the message states none. Same append-after-classification pattern as
 * reasoningVerificationBlock, and deliberately independent of category:
 * "reply with only the number" is just as binding on a maths answer as on
 * a creative one.
 */
export function formatConstraintBlock(message: string): string {
  return hasHardFormatConstraint(message) ? FORMAT_CONSTRAINT_CHECK : "";
}
