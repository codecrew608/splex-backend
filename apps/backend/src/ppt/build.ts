import PptxGenJS from "pptxgenjs";
import type { DeckPlan } from "./plan.js";

// SPLEX's dark deck palette, kept in sync by eye with the app's own
// surface/accent tokens rather than imported from the frontend — these are
// PPTX hex literals with no alpha/CSS-variable equivalent, and the deck is
// a standalone artifact that must look right outside the app entirely.
const BG = "0B0D0F";
const SURFACE = "14171A";
const TEXT = "F2F4F6";
const MUTED = "9AA3AB";
const ACCENT = "5B8DEF";

const FONT = "Segoe UI"; // Present on Windows/Office by default; PowerPoint substitutes gracefully elsewhere.

// Builds a real .pptx from a planned deck. Pure/local — no network, no
// model call — so this can never be the slow or flaky part of PPT
// generation, and its output is fully deterministic for a given plan.
export async function buildPptx(plan: DeckPlan): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.title = plan.title;

  // Title slide
  const title = pptx.addSlide();
  title.background = { color: BG };
  title.addText(plan.title, {
    x: 0.6, y: 2.1, w: 8.8, h: 1.2,
    fontSize: 40, bold: true, color: TEXT, fontFace: FONT, valign: "middle",
  });
  if (plan.subtitle) {
    title.addText(plan.subtitle, {
      x: 0.6, y: 3.3, w: 8.8, h: 0.7,
      fontSize: 18, color: MUTED, fontFace: FONT, valign: "middle",
    });
  }
  // Accent rule under the title — the one piece of visual identity that
  // survives being opened in any PowerPoint theme.
  title.addShape(pptx.ShapeType.rect, { x: 0.6, y: 3.15, w: 1.4, h: 0.06, fill: { color: ACCENT } });

  for (const slide of plan.slides) {
    const s = pptx.addSlide();
    s.background = { color: BG };

    s.addText(slide.title, {
      x: 0.6, y: 0.5, w: 8.8, h: 0.9,
      fontSize: 26, bold: true, color: TEXT, fontFace: FONT, valign: "middle",
    });
    s.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.32, w: 0.9, h: 0.05, fill: { color: ACCENT } });

    s.addText(
      slide.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
      {
        x: 0.75, y: 1.75, w: 8.5, h: 3.2,
        fontSize: 16, color: TEXT, fontFace: FONT, lineSpacingMultiple: 1.4, valign: "top",
      },
    );

    if (slide.notes) s.addNotes(slide.notes);
  }

  // pptxgenjs types `write` loosely across its output targets; "nodebuffer"
  // genuinely returns a Buffer in Node, so this narrows rather than lies.
  const out = (await pptx.write({ outputType: "nodebuffer" })) as unknown as Buffer;
  if (!Buffer.isBuffer(out) || out.length === 0) {
    throw new Error("PPTX generation produced no output");
  }
  return out;
}
