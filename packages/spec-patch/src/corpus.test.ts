/**
 * The corpus gate: every spec the repo keeps as a fixture, and the
 * hand-edited specs in `__corpus__/`, round-trip through the commit helper
 * and the minimal-diff writer with every untouched byte kept.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { isMap, parseDocument } from "yaml";
import { commitSpec, parseYamlOnly, specRev } from "./commit";
import { renderMinimal } from "./minimal-diff";

const REPO = resolve(import.meta.dir, "../../..");

function scan(pattern: string): string[] {
  return [...new Glob(pattern).scanSync(REPO)].sort();
}

const CLI_FIXTURES = scan("apps/cli/test-fixtures/**/crewhaus.yaml");
const COMPILER_FIXTURES = scan("packages/compiler/src/__fixtures__/**/*.spec.yaml");
const HAND_EDITED = scan("packages/spec-patch/src/__corpus__/*.yaml");
const CORPUS = [...CLI_FIXTURES, ...COMPILER_FIXTURES, ...HAND_EDITED];

const scratch = mkdtempSync(join(tmpdir(), "spec-corpus-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The text before `start` and after `end` is the source's. */
function keepsOutside(source: string, out: string, start: number, end: number): void {
  expect(out.slice(0, start)).toBe(source.slice(0, start));
  expect(out.slice(out.length - (source.length - end))).toBe(source.slice(end));
}

describe("the spec corpus", () => {
  test("finds every fixture it gates", () => {
    expect(CLI_FIXTURES.length).toBe(10);
    expect(COMPILER_FIXTURES.length).toBe(27);
    expect(HAND_EDITED.length).toBe(4);
  });

  for (const [i, rel] of CORPUS.entries()) {
    describe(rel, () => {
      const source = readFileSync(join(REPO, rel), "utf8");

      test("a commit that changes nothing leaves the file byte-identical", async () => {
        const path = join(scratch, `zero-${i}.yaml`);
        writeFileSync(path, source);
        const result = await commitSpec(
          { specPath: path },
          { kind: "edits", edits: [] },
          {
            expectedRev: specRev(source),
            writer: "cli.lint",
            actor: { kind: "process" },
            parse: parseYamlOnly,
          },
        );
        expect(result.ok && result.wrote).toBe(false);
        expect(readFileSync(path, "utf8")).toBe(source);
      });

      test("a scalar edit changes only that scalar", () => {
        const doc = parseDocument(source);
        const node = isMap(doc.contents) ? doc.contents.get("name", true) : undefined;
        const range = (node as { range?: [number, number, number] } | undefined)?.range;
        expect(range).toBeDefined();
        const [start, end] = range as [number, number, number];
        doc.setIn(["name"], `${String(doc.get("name"))}-renamed`);
        const out = renderMinimal(source, doc, [["name"]]);
        expect(out?.formatting).toBe("kept");
        keepsOutside(source, out?.yaml ?? "", start, end);
      });

      test("an added key changes nothing else", () => {
        const doc = parseDocument(source);
        doc.setIn(["zz_added"], "value");
        const out = renderMinimal(source, doc, [["zz_added"]]);
        expect(out?.formatting).toBe("kept");
        const yaml = out?.yaml ?? "";
        const at = yaml.indexOf("zz_added: value\n");
        expect(at).toBeGreaterThan(-1);
        keepsOutside(source, yaml, at, at);
        expect(yaml.length).toBe(
          source.length + "zz_added: value\n".length + (source.endsWith("\n") ? 0 : 1),
        );
      });
    });
  }
});
