/**
 * The structured editor's writes over the spec corpus: every fixture the repo
 * keeps and the hand-edited specs vendored from crewhaus/demos. For every
 * control the form shows for a setting a file declares, an unchanged control
 * sends nothing, a changed one changes bytes only inside that setting's own
 * lines, and writing the old value back gives the file back byte for byte. A
 * setting whose value comes back redacted never becomes an edit.
 *
 * The form is the console's own module (`schema-form.js`), loaded by URL; the
 * edits go through the same writer every spec write uses.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSpec, specJsonSchema } from "@crewhaus/spec";
import { parseYamlOnly } from "@crewhaus/spec-patch/commit";
import { Glob } from "bun";
import { effectiveConfig, narrowSchema, previewSpecEdits } from "./spec-edit";
import { keyLineParts } from "./spec-lines";

const REPO = resolve(import.meta.dir, "../../..");
/** Repo-relative paths with `/`, whatever the platform's separator. */
const scan = (pattern: string): string[] =>
  [...new Glob(pattern).scanSync(REPO)].map((rel) => rel.replace(/\\/g, "/")).sort();

/** A spec as it is in git: a Windows checkout may have turned its line ends into CRLF. */
const readSpec = (rel: string): string =>
  readFileSync(join(REPO, rel), "utf8").replace(/\r\n/g, "\n");

const CLI_FIXTURES = scan("apps/cli/test-fixtures/**/crewhaus.yaml");
const COMPILER_FIXTURES = scan("packages/compiler/src/__fixtures__/**/*.spec.yaml");
const HAND_EDITED = scan("packages/spec-patch/src/__corpus__/*.yaml");
const CORPUS = [...CLI_FIXTURES, ...COMPILER_FIXTURES, ...HAND_EDITED];

type FormNode = {
  segments: string[];
  kind: string;
  seed?: unknown;
  source: string | null;
  options?: unknown[];
  writeOnly: boolean;
};
type SchemaForm = {
  CONTROL_KINDS: readonly string[];
  formModel(schema: unknown, effective: unknown, trust: unknown): { groups: FormNode[] };
  flatten(groups: FormNode[]): FormNode[];
  fieldEdit(node: FormNode, input: unknown): { path: string[]; value?: unknown } | null;
  carriesMasked(value: unknown): boolean;
};

const loadForm = async (): Promise<SchemaForm> =>
  (await import(
    new URL("../../hangar-ui/assets/js/ui/schema-form.js", import.meta.url).href
  )) as SchemaForm;

/**
 * Where a key's lines are in `text`: from the start of its key line to the next
 * line at its indent or less. Sequence items are skipped, as `declaredPaths`
 * skips them; a key not found by lines (one inside a flow map) answers the
 * deepest ancestor found, which is still a sound bound. `exact` says which.
 */
function spanOf(
  text: string,
  segments: readonly string[],
): { start: number; end: number; exact: boolean; line: string } {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const stack: Array<{ indent: number; key: string }> = [];
  let best: { index: number; indent: number; depth: number } | null = null;
  let seqIndent: number | null = null;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (seqIndent !== null) {
      if (indent > seqIndent) continue;
      seqIndent = null;
    }
    if (line.trimStart().startsWith("- ") || line.trim() === "-") {
      seqIndent = indent;
      continue;
    }
    const parts = keyLineParts(line);
    if (parts === null) continue;
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) {
      stack.pop();
    }
    stack.push({ indent, key: parts[1] });
    const path = stack.map((s) => s.key);
    const depth = path.length;
    const prefixes = depth <= segments.length && path.every((k, i) => k === segments[i]);
    if (prefixes && (best === null || depth > best.depth)) best = { index, indent, depth };
  }
  if (best === null) return { start: 0, end: text.length, exact: false, line: "" };
  let next = best.index + 1;
  while (next < lines.length) {
    const line = lines[next] as string;
    if (line.trim() !== "" && line.length - line.trimStart().length <= best.indent) break;
    next += 1;
  }
  return {
    start: offsets[best.index] as number,
    end: next < lines.length ? (offsets[next] as number) : text.length,
    exact: best.depth === segments.length,
    line: lines[best.index] as string,
  };
}

/** The changed region of `out` against `source`: the bytes outside it are the source's. */
function changedRegion(source: string, out: string): { start: number; end: number } {
  let start = 0;
  while (start < source.length && start < out.length && source[start] === out[start]) start += 1;
  let tail = 0;
  while (
    tail < source.length - start &&
    tail < out.length - start &&
    source[source.length - 1 - tail] === out[out.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { start, end: source.length - tail };
}

/** A value of the node's kind that differs from its seed, or undefined when there is none. */
function changedInput(node: FormNode): unknown {
  const seed = node.seed;
  switch (node.kind) {
    case "text":
      return `${String(seed)}-edited`;
    case "number":
    case "integer":
      return String(Number(seed) + 1);
    case "boolean":
      return !seed;
    case "select":
      return (node.options ?? []).find((option) => option !== seed);
    default:
      return undefined;
  }
}

/** The input a control starts with for its seed. */
const seedInput = (node: FormNode): unknown =>
  node.kind === "text" || node.kind === "number" || node.kind === "integer"
    ? String(node.seed)
    : node.seed;

/**
 * The writer folds a plain scalar longer than its line width when it rewrites
 * one, so such a value cannot come back on its one line. Counted, so a second
 * case is seen.
 */
const WRITER_LINE_WIDTH = 80;

describe("the settings form over the spec corpus", () => {
  test("finds every file the corpus gate finds, and each parses", () => {
    expect(CLI_FIXTURES.length).toBe(10);
    expect(COMPILER_FIXTURES.length).toBe(27);
    expect(HAND_EDITED.length).toBe(4);
    for (const rel of CORPUS) expect(() => parseSpec(readSpec(rel))).not.toThrow();
  });

  test("every declared control round-trips its bytes, and a hidden value never becomes an edit", async () => {
    const form = await loadForm();
    const whole = specJsonSchema() as Record<string, unknown>;
    let checked = 0;
    let located = 0;
    let hidden = 0;
    const folded: string[] = [];
    const problems: string[] = [];
    for (const rel of CORPUS) {
      const source = readSpec(rel);
      const spec = parseSpec(source) as { target: string };
      const schema = narrowSchema(whole, spec.target).schema;
      const model = form.formModel(schema, effectiveConfig(spec, source), []);
      for (const node of form.flatten(model.groups)) {
        if (!form.CONTROL_KINDS.includes(node.kind) || node.source !== "declared") continue;
        const seed = node.seed;
        if (seed === undefined || seed === null || typeof seed === "object") continue;
        const where = `${rel} ${node.segments.join(".")}`;
        if (form.carriesMasked(seed)) {
          hidden += 1;
          // An empty control sends nothing, and the placeholder itself is never sent.
          if (form.fieldEdit(node, "") !== null)
            problems.push(`${where}: empty hidden control wrote`);
          if (form.fieldEdit(node, seed) !== null) problems.push(`${where}: placeholder wrote`);
          continue;
        }
        if (form.fieldEdit(node, seedInput(node)) !== null) {
          problems.push(`${where}: an unchanged control made an edit`);
        }
        const input = changedInput(node);
        if (input === undefined) continue;
        const edit = form.fieldEdit(node, input);
        if (edit === null) {
          problems.push(`${where}: a changed control made no edit`);
          continue;
        }
        if (form.carriesMasked(edit)) problems.push(`${where}: an edit carries the placeholder`);
        const out = previewSpecEdits(source, [edit], { parse: parseYamlOnly });
        if (!out.ok || out.yaml === null) {
          problems.push(`${where}: does not apply: ${out.error}`);
          continue;
        }
        checked += 1;
        const span = spanOf(source, node.segments);
        if (span.exact) located += 1;
        const region = changedRegion(source, out.yaml);
        if (region.start < span.start || region.end > span.end) {
          problems.push(
            `${where}: changed [${region.start}, ${region.end}) outside [${span.start}, ${span.end})`,
          );
        }
        const back = previewSpecEdits(out.yaml, [{ path: edit.path, value: seed }], {
          parse: parseYamlOnly,
        });
        if (back.yaml === source) continue;
        if (
          span.exact &&
          span.line.length > WRITER_LINE_WIDTH &&
          !span.line.trimEnd().endsWith("|")
        ) {
          // Folded by the writer: the value is still the same, and the rest of the file is kept.
          folded.push(where);
          const read = parseYamlOnly(back.yaml ?? "") as unknown;
          let at: unknown = read;
          for (const seg of node.segments) at = (at as Record<string, unknown>)?.[seg];
          if (at !== seed) problems.push(`${where}: the value did not come back`);
          const kept = changedRegion(source, back.yaml ?? "");
          if (kept.start < span.start || kept.end > span.end)
            problems.push(`${where}: folding moved other bytes`);
          continue;
        }
        problems.push(`${where}: writing the old value back did not give the file back`);
      }
    }
    expect(problems).toEqual([]);
    // Counts measured on this corpus, so a change that silently skips settings fails here.
    expect(checked).toBe(196);
    // The rest sit inside a flow map (`exam: { dataset: …, graders: … }`), bounded by its lines.
    expect(located).toBe(182);
    expect(hidden).toBe(15);
    expect(folded).toEqual([
      "packages/spec-patch/src/__corpus__/trader.crewhaus.yaml learning.domain",
    ]);
  }, 60_000); // slow by construction: 41 specs, each edited and written back once per control
});
