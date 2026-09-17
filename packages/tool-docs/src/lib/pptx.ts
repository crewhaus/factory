/**
 * PresentationML (.pptx) — slide titles and text, in presentation order.
 *
 * ## Supported
 *
 * - Slide ORDER from `ppt/presentation.xml`'s `p:sldIdLst`, resolved through
 *   the presentation's relationships. This matters: the numeric suffix of
 *   `slide7.xml` is a part name, not a position, and a deck that has had
 *   slides reordered or deleted will not agree with it.
 * - Per shape, the text of its `a:p` paragraphs, with `a:t` runs joined and
 *   `a:br` treated as a line break. Text inside a table (`a:tbl`) and inside
 *   a group shape is included.
 * - The title: the shape whose placeholder type (`p:ph/@type`) is `title`,
 *   `ctrTitle`, or index 0 when a deck omits the type, which PowerPoint
 *   does for the default layout.
 * - Speaker notes from the slide's notes-slide relationship, when asked for.
 *
 * ## Not supported — stated rather than faked
 *
 * - Text that lives in the LAYOUT or MASTER rather than the slide (a running
 *   footer, a slide-number placeholder) is not inherited into the slide's
 *   text. What is reported is what the slide itself carries.
 * - SmartArt (`dgm:` diagram parts), charts, and text baked into images.
 * - Animation, transitions, positioning and formatting.
 */
import { assertSafePartNames, relationshipMap } from "./ooxml";
import {
  type XmlElement,
  childNamed,
  descendants,
  isElement,
  parseXml,
  rootElement,
  textOf,
} from "./xml";
import { type ZipArchive, ZipError } from "./zip";

export type SlideShape = {
  /** `title`, `body`, `subTitle`, … from the placeholder type, or `shape`. */
  readonly role: string;
  readonly text: string;
};

export type Slide = {
  readonly index: number;
  readonly part: string;
  readonly title: string | null;
  readonly shapes: ReadonlyArray<SlideShape>;
  readonly notes?: string;
};

const PRESENTATION_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const NOTES_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

/** The text of one `a:p`, with `a:br` as a newline and `a:t` runs joined. */
function paragraphText(paragraph: XmlElement): string {
  let out = "";
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (!isElement(child)) continue;
      if (child.name === "a:t") out += textOf(child);
      else if (child.name === "a:br") out += "\n";
      else walk(child);
    }
  };
  walk(paragraph);
  return out;
}

/** Every `a:p` under a shape, joined with newlines. */
function shapeText(shape: XmlElement): string {
  return descendants(shape, "a:p")
    .map(paragraphText)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function placeholderRole(shape: XmlElement): string {
  const nv = childNamed(shape, "p:nvSpPr");
  if (nv === undefined) return "shape";
  const nvPr = childNamed(nv, "p:nvPr");
  if (nvPr === undefined) return "shape";
  const ph = childNamed(nvPr, "p:ph");
  if (ph === undefined) return "shape";
  const type = ph.attributes["type"];
  if (type !== undefined) return type;
  // PowerPoint omits @type for the default title/body pair and distinguishes
  // them by index: 0 is the title, everything else is body.
  return ph.attributes["idx"] === undefined ? "title" : "body";
}

function collectShapes(tree: XmlElement): SlideShape[] {
  const out: SlideShape[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (!isElement(child)) continue;
      if (child.name === "p:sp") {
        const text = shapeText(child);
        if (text !== "") out.push({ role: placeholderRole(child), text });
      } else if (child.name === "p:graphicFrame") {
        // A table or embedded object: take whatever text it carries.
        const text = shapeText(child);
        if (text !== "") out.push({ role: "graphic", text });
      } else if (child.name === "p:grpSp" || child.name === "p:spTree") {
        walk(child);
      }
    }
  };
  walk(tree);
  return out;
}

export function readPptx(zip: ZipArchive, includeNotes: boolean): Slide[] {
  assertSafePartNames(zip);
  let presentationPart: string | undefined;
  for (const rel of relationshipMap(zip, "").values()) {
    if (rel.type === PRESENTATION_REL && !rel.external) presentationPart = rel.target;
  }
  if (presentationPart === undefined && zip.has("ppt/presentation.xml")) {
    presentationPart = "ppt/presentation.xml";
  }
  if (presentationPart === undefined) {
    throw new ZipError("this package declares no presentation part (is it really a .pptx?)");
  }
  const root = rootElement(parseXml(zip.readText(presentationPart)));
  const rels = relationshipMap(zip, presentationPart);
  const parts: string[] = [];
  const list = childNamed(root, "p:sldIdLst");
  if (list !== undefined) {
    for (const sldId of descendants(list, "p:sldId")) {
      const relId = sldId.attributes["r:id"];
      const target = relId === undefined ? undefined : rels.get(relId)?.target;
      if (target !== undefined && zip.has(target)) parts.push(target);
    }
  }
  const slides: Slide[] = [];
  for (const [i, part] of parts.entries()) {
    const slideRoot = rootElement(parseXml(zip.readText(part)));
    const shapes = collectShapes(slideRoot);
    const titleShape = shapes.find((s) => s.role === "title" || s.role === "ctrTitle");
    const slide: {
      index: number;
      part: string;
      title: string | null;
      shapes: SlideShape[];
      notes?: string;
    } = {
      index: i + 1,
      part,
      title: titleShape === undefined ? null : titleShape.text,
      shapes,
    };
    if (includeNotes) {
      for (const rel of relationshipMap(zip, part).values()) {
        if (rel.type !== NOTES_REL || rel.external || !zip.has(rel.target)) continue;
        const notesRoot = rootElement(parseXml(zip.readText(rel.target)));
        const text = collectShapes(notesRoot)
          .map((s) => s.text)
          .join("\n")
          .trim();
        if (text !== "") slide.notes = text;
      }
    }
    slides.push(slide);
  }
  return slides;
}

/** Plain text of a deck: a title line per slide, then its other shapes. */
export function pptxPlainText(slides: ReadonlyArray<Slide>): string {
  const out: string[] = [];
  for (const slide of slides) {
    out.push(`# Slide ${slide.index}${slide.title === null ? "" : `: ${slide.title}`}`);
    for (const shape of slide.shapes) {
      if (shape.text === slide.title) continue;
      out.push(shape.text);
    }
    if (slide.notes !== undefined) out.push(`[notes] ${slide.notes}`);
  }
  return out.join("\n");
}
