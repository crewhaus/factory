/**
 * Structured edits to a graders file that keep the author's file: comments,
 * key order and keys this version does not know all survive, because each
 * edit is applied to the YAML document itself (`parseDocument`), never to a
 * re-serialized copy.
 *
 * The edited text is parsed again with {@link parseGradersConfig} before it
 * is returned, so an edit that would leave an invalid file throws and
 * returns nothing for a caller to write.
 */
import { type Document, isMap, isSeq, parseDocument } from "yaml";
import { z } from "zod";
import {
  CRITERION_MODES,
  CRITERION_SEVERITIES,
  type CriterionSpec,
  CriterionSpecSchema,
  boundSpecsOf,
  criterionDigest,
} from "./criteria";
import { GraderError } from "./errors";
import { type GradersConfig, parseGradersConfig } from "./graders-config";
import { gradersConfigHash } from "./graders-hash";

const ExampleKind = z.enum(["acceptable", "unacceptable"]);
const Id = z.string().min(1);

/** One edit. A closed vocabulary: an unknown op or key is refused. */
export const GradersEditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addCriterion"), criterion: CriterionSpecSchema }).strict(),
  z.object({ op: z.literal("removeCriterion"), id: Id }).strict(),
  z
    .object({
      op: z.literal("setText"),
      id: Id,
      field: z.enum(["title", "description"]),
      value: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal("addExample"),
      id: Id,
      kind: ExampleKind,
      example: z.object({ text: z.string().min(1), case: z.string().min(1).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("removeExample"),
      id: Id,
      kind: ExampleKind,
      index: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      op: z.literal("setSeverity"),
      id: Id,
      value: z.enum(CRITERION_SEVERITIES).nullable(),
    })
    .strict(),
  z.object({ op: z.literal("setOwner"), id: Id, value: z.string().min(1).nullable() }).strict(),
  z.object({ op: z.literal("setMode"), id: Id, value: z.enum(CRITERION_MODES) }).strict(),
  z
    .object({
      op: z.literal("setScope"),
      id: Id,
      value: z
        .object({ metadata: z.record(z.array(z.string().min(1)).min(1)) })
        .strict()
        .nullable(),
    })
    .strict(),
  z.object({ op: z.literal("setProtected"), id: Id, value: z.boolean() }).strict(),
  z.object({ op: z.literal("bind"), id: Id, grader: Id }).strict(),
  z.object({ op: z.literal("unbind"), id: Id, grader: Id }).strict(),
  z
    .object({
      op: z.literal("editRubricCriterion"),
      grader: Id,
      criterion: Id,
      description: z.string().min(1).optional(),
      anchors: z
        .object({
          "1": z.string(),
          "2": z.string(),
          "3": z.string(),
          "4": z.string(),
          "5": z.string(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("setPassingScore"),
      grader: Id,
      value: z.number().min(1).max(5),
    })
    .strict(),
]);

export type GradersEdit = z.infer<typeof GradersEditSchema>;

/** A list of edits, as `crewhaus criteria apply` reads it from a file. */
export const GradersEditsSchema = z.array(GradersEditSchema);

/** One criterion an edit batch changed, by digest (absent: it did not exist on that side). */
export type CriterionChange = {
  readonly criterion: string;
  readonly before?: string;
  readonly after?: string;
};

export type GradersEditResult = {
  readonly yaml: string;
  readonly config: GradersConfig;
  /** The edited file's `gradersHash` ({@link gradersConfigHash}). */
  readonly gradersHash: string;
  readonly changed: ReadonlyArray<CriterionChange>;
};

/**
 * Apply `edits` to a graders file, in order. Throws {@link GraderError} when
 * the file does not parse, an edit names something the file does not have,
 * or the edited file is not a valid graders config.
 */
export function applyGradersEdits(
  yamlText: string,
  edits: ReadonlyArray<GradersEdit>,
): GradersEditResult {
  const before = parseGradersConfig(yamlText).config;
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new GraderError(`malformed YAML: ${doc.errors[0]?.message ?? "parse error"}`);
  }
  edits.forEach((raw, i) => {
    const parsed = GradersEditSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GraderError(`edit #${i} is not a graders edit: ${parsed.error.message}`);
    }
    applyOne(doc, parsed.data, `edit #${i} (${parsed.data.op})`);
  });
  const yaml = doc.toString();
  const { config } = parseGradersConfig(yaml);
  return {
    yaml,
    config,
    gradersHash: gradersConfigHash(config),
    changed: criteriaChanged(before, config),
  };
}

/** The criteria whose digest differs between two configs, added and removed ones included. */
export function criteriaChanged(before: GradersConfig, after: GradersConfig): CriterionChange[] {
  const digests = (config: GradersConfig): Map<string, string> =>
    new Map(
      (config.criteria ?? []).map((c) => [c.id, criterionDigest(c, boundSpecsOf(config, c))]),
    );
  const a = digests(before);
  const b = digests(after);
  const out: CriterionChange[] = [];
  for (const [id, digest] of a) {
    const now = b.get(id);
    if (now !== digest)
      out.push({ criterion: id, before: digest, ...(now !== undefined ? { after: now } : {}) });
  }
  for (const [id, digest] of b) if (!a.has(id)) out.push({ criterion: id, after: digest });
  return out;
}

function criterionIndex(doc: Document, id: string, label: string): number {
  const seq = doc.get("criteria");
  if (isSeq(seq)) {
    const i = seq.items.findIndex((item) => isMap(item) && item.get("id") === id);
    if (i >= 0) return i;
  }
  throw new GraderError(`${label}: no criterion "${id}" in this file`);
}

function graderIndex(doc: Document, name: string, label: string): number {
  const seq = doc.get("graders");
  if (isSeq(seq)) {
    const i = seq.items.findIndex((item) => isMap(item) && item.get("name") === name);
    if (i >= 0) return i;
  }
  throw new GraderError(`${label}: no grader "${name}" in this file`);
}

/** Set a leaf, or delete it for `null`. */
function setOrDelete(doc: Document, path: ReadonlyArray<string | number>, value: unknown): void {
  if (value === null) {
    if (doc.hasIn(path)) doc.deleteIn(path);
    return;
  }
  doc.setIn(path, value);
}

/** Drop an empty list or map at `path`, then its parent when that empties too. */
function pruneEmpty(doc: Document, path: ReadonlyArray<string | number>): void {
  for (let len = path.length; len > 2; len--) {
    const at = path.slice(0, len);
    const node = doc.getIn(at, true);
    if ((isSeq(node) || isMap(node)) && node.items.length === 0) doc.deleteIn(at);
    else return;
  }
}

function applyOne(doc: Document, edit: GradersEdit, label: string): void {
  switch (edit.op) {
    case "addCriterion": {
      const seq = doc.get("criteria");
      if (isSeq(seq)) {
        if (seq.items.some((item) => isMap(item) && item.get("id") === edit.criterion.id)) {
          throw new GraderError(`${label}: criterion "${edit.criterion.id}" already exists`);
        }
        seq.add(doc.createNode(edit.criterion as CriterionSpec));
      } else {
        doc.set("criteria", doc.createNode([edit.criterion]));
      }
      return;
    }
    case "removeCriterion": {
      const i = criterionIndex(doc, edit.id, label);
      doc.deleteIn(["criteria", i]);
      pruneEmptyRoot(doc, "criteria");
      return;
    }
    case "setText":
      setOrDelete(doc, ["criteria", criterionIndex(doc, edit.id, label), edit.field], edit.value);
      return;
    case "addExample": {
      const i = criterionIndex(doc, edit.id, label);
      const path = ["criteria", i, "examples", edit.kind];
      const list = doc.getIn(path, true);
      if (isSeq(list)) list.add(doc.createNode(edit.example));
      else doc.setIn(path, doc.createNode([edit.example]));
      return;
    }
    case "removeExample": {
      const i = criterionIndex(doc, edit.id, label);
      const path = ["criteria", i, "examples", edit.kind];
      const list = doc.getIn(path, true);
      if (!isSeq(list) || edit.index >= list.items.length) {
        throw new GraderError(
          `${label}: criterion "${edit.id}" has no ${edit.kind} example #${edit.index}`,
        );
      }
      doc.deleteIn([...path, edit.index]);
      pruneEmpty(doc, path);
      return;
    }
    case "setSeverity":
      setOrDelete(doc, ["criteria", criterionIndex(doc, edit.id, label), "severity"], edit.value);
      return;
    case "setOwner":
      setOrDelete(doc, ["criteria", criterionIndex(doc, edit.id, label), "owner"], edit.value);
      return;
    case "setMode":
      doc.setIn(["criteria", criterionIndex(doc, edit.id, label), "mode"], edit.value);
      return;
    case "setScope":
      setOrDelete(
        doc,
        ["criteria", criterionIndex(doc, edit.id, label), "scope"],
        edit.value === null ? null : doc.createNode(edit.value),
      );
      return;
    case "setProtected":
      setOrDelete(
        doc,
        ["criteria", criterionIndex(doc, edit.id, label), "protected"],
        edit.value ? true : null,
      );
      return;
    case "bind": {
      const i = criterionIndex(doc, edit.id, label);
      graderIndex(doc, edit.grader, label);
      const list = doc.getIn(["criteria", i, "measured_by"], true);
      if (isSeq(list)) {
        if (list.items.some((item) => scalarOf(item) === edit.grader)) {
          throw new GraderError(`${label}: "${edit.grader}" already measures "${edit.id}"`);
        }
        list.add(edit.grader);
      } else {
        doc.setIn(["criteria", i, "measured_by"], doc.createNode([edit.grader]));
      }
      return;
    }
    case "unbind": {
      const i = criterionIndex(doc, edit.id, label);
      const list = doc.getIn(["criteria", i, "measured_by"], true);
      const at = isSeq(list) ? list.items.findIndex((item) => scalarOf(item) === edit.grader) : -1;
      if (at < 0) {
        throw new GraderError(`${label}: "${edit.grader}" does not measure "${edit.id}"`);
      }
      doc.deleteIn(["criteria", i, "measured_by", at]);
      return;
    }
    case "editRubricCriterion": {
      const g = graderIndex(doc, edit.grader, label);
      if (doc.getIn(["graders", g, "type"]) !== "llm_judge") {
        throw new GraderError(`${label}: grader "${edit.grader}" is not an llm_judge`);
      }
      const list = doc.getIn(["graders", g, "rubric", "criteria"], true);
      const at = isSeq(list)
        ? list.items.findIndex((item) => isMap(item) && item.get("name") === edit.criterion)
        : -1;
      if (at < 0) {
        throw new GraderError(
          `${label}: judge "${edit.grader}" has no rubric criterion "${edit.criterion}"`,
        );
      }
      const path = ["graders", g, "rubric", "criteria", at];
      if (edit.description !== undefined) doc.setIn([...path, "description"], edit.description);
      if (edit.anchors !== undefined) doc.setIn([...path, "anchors"], doc.createNode(edit.anchors));
      return;
    }
    case "setPassingScore": {
      const g = graderIndex(doc, edit.grader, label);
      if (doc.getIn(["graders", g, "type"]) !== "llm_judge") {
        throw new GraderError(`${label}: grader "${edit.grader}" is not an llm_judge`);
      }
      if (doc.getIn(["graders", g, "rubric", "kind"]) === "categorical") {
        throw new GraderError(
          `${label}: judge "${edit.grader}" has a categorical rubric, which passes by label, not by score`,
        );
      }
      doc.setIn(["graders", g, "rubric", "passing_score"], edit.value);
      return;
    }
  }
}

/** Drop a top-level list key once it is empty. */
function pruneEmptyRoot(doc: Document, key: string): void {
  const node = doc.get(key, true);
  if (isSeq(node) && node.items.length === 0) doc.delete(key);
}

function scalarOf(item: unknown): unknown {
  return typeof item === "object" && item !== null && "value" in item
    ? (item as { value: unknown }).value
    : item;
}
