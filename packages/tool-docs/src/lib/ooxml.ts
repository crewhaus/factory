/**
 * The bits every OOXML format shares: opening the container safely,
 * following relationship parts, and reading core document properties.
 *
 * An OOXML package (.docx, .xlsx, .pptx) is a ZIP whose members are named
 * parts. Two package-level facts matter here:
 *
 *   1. A part name is a security input. `[Content_Types].xml` and the parts
 *      it describes are addressed by name, and a malicious package can name
 *      a member `../../../etc/passwd`. Nothing in this package writes an
 *      extracted member to disk, but the check is done at OPEN time anyway,
 *      so a package that contains such a name is refused before any of it is
 *      read — the same posture as archive extraction.
 *   2. Parts reference each other through `.rels` parts rather than directly,
 *      so the slide order in a .pptx and the sheet order in a .xlsx are only
 *      correct if the relationships are followed. They are, here.
 */
import { archiveEntryEscapes } from "../paths";
import { childrenNamed, isElement, parseXml, rootElement, textOf } from "./xml";
import { type ZipArchive, ZipError } from "./zip";

/** A relationship from a `.rels` part: id to resolved part name. */
export type Relationship = {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  /** True when the target is outside the package (a hyperlink, say). */
  readonly external: boolean;
};

/**
 * Check every member name before anything is read. A package with an
 * escaping name is refused whole: a producer never writes one, so its
 * presence says the file is hostile or corrupt, and reading "the good parts"
 * of a hostile file is not a service to the caller.
 */
export function assertSafePartNames(zip: ZipArchive): void {
  for (const entry of zip.entries) {
    if (archiveEntryEscapes(entry.name)) {
      throw new ZipError(
        `package member "${entry.name}" would escape its container; refusing the whole package`,
      );
    }
  }
}

/** The `.rels` part that describes relationships for `partName`. */
export function relsPathFor(partName: string): string {
  const slash = partName.lastIndexOf("/");
  const dir = slash < 0 ? "" : partName.slice(0, slash + 1);
  const base = slash < 0 ? partName : partName.slice(slash + 1);
  return `${dir}_rels/${base}.rels`;
}

/** Resolve a relationship target against the part that declared it. */
export function resolvePartPath(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const slash = fromPart.lastIndexOf("/");
  const dir = slash < 0 ? "" : fromPart.slice(0, slash + 1);
  const segments: string[] = [];
  for (const segment of `${dir}${target}`.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** Read the relationships declared for a part. Missing `.rels` ⇒ none. */
export function readRelationships(zip: ZipArchive, partName: string): Relationship[] {
  const relsPath = relsPathFor(partName);
  if (!zip.has(relsPath)) return [];
  const root = rootElement(parseXml(zip.readText(relsPath)));
  const out: Relationship[] = [];
  for (const rel of childrenNamed(root, "Relationship")) {
    const id = rel.attributes["Id"];
    const target = rel.attributes["Target"];
    if (id === undefined || target === undefined) continue;
    const external = rel.attributes["TargetMode"] === "External";
    out.push({
      id,
      type: rel.attributes["Type"] ?? "",
      target: external ? target : resolvePartPath(partName, target),
      external,
    });
  }
  return out;
}

/** Relationship id to resolved target, for the common lookup. */
export function relationshipMap(zip: ZipArchive, partName: string): Map<string, Relationship> {
  return new Map(readRelationships(zip, partName).map((r) => [r.id, r]));
}

/**
 * The document's core properties (`docProps/core.xml`, Dublin Core) plus the
 * handful of `docProps/app.xml` fields that are worth the bytes. Absent
 * fields are omitted rather than reported as empty strings.
 */
export type CoreProperties = Record<string, string>;

const CORE_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["dc:title", "title"],
  ["dc:subject", "subject"],
  ["dc:creator", "creator"],
  ["cp:keywords", "keywords"],
  ["dc:description", "description"],
  ["cp:lastModifiedBy", "lastModifiedBy"],
  ["cp:revision", "revision"],
  ["dcterms:created", "created"],
  ["dcterms:modified", "modified"],
  ["cp:category", "category"],
  ["cp:contentStatus", "contentStatus"],
  ["dc:language", "language"],
];

const APP_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["Application", "application"],
  ["AppVersion", "appVersion"],
  ["Company", "company"],
  ["Pages", "pages"],
  ["Words", "words"],
  ["Characters", "characters"],
  ["Paragraphs", "paragraphs"],
  ["Slides", "slides"],
  ["Template", "template"],
];

export function readCoreProperties(zip: ZipArchive): CoreProperties {
  const out: CoreProperties = {};
  if (zip.has("docProps/core.xml")) {
    const root = rootElement(parseXml(zip.readText("docProps/core.xml")));
    for (const child of root.children) {
      if (!isElement(child)) continue;
      for (const [tag, key] of CORE_FIELDS) {
        if (child.name === tag) {
          const value = textOf(child).trim();
          if (value !== "") out[key] = value;
        }
      }
    }
  }
  if (zip.has("docProps/app.xml")) {
    const root = rootElement(parseXml(zip.readText("docProps/app.xml")));
    for (const child of root.children) {
      if (!isElement(child)) continue;
      for (const [tag, key] of APP_FIELDS) {
        if (child.name === tag) {
          const value = textOf(child).trim();
          if (value !== "") out[key] = value;
        }
      }
    }
  }
  return out;
}

/** The XML declaration every part this package writes starts with. */
export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
