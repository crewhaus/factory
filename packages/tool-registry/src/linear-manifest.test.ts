/**
 * A manifest's dependencies are located in one pass over the file.
 *
 * RegistryOutdated and ManifestDependencySet read a package.json, Cargo.toml
 * or pyproject.toml of up to 4 MiB from the workspace. Each dependency of a
 * package.json was located with `locateJsonMember`, which read the whole
 * top-level object and the whole section again for every one, and every
 * dependency's line came from `lineAt`, which counted line breaks from the
 * top of the file: both quadratic in the file, and a repository chooses its
 * own manifest. Now each object is read once (`JsonMembers`) and the line
 * breaks are found once (`LineIndex`).
 *
 * The rewrites are checked against the code they replaced, restated here,
 * on generated documents, well-formed and not: duplicate and escaped keys,
 * truncation, a byte-order mark, offsets no caller passes. The work is
 * counted, never timed. tool-code's __test__/js-work.ts counts the string
 * copies a scan makes (each key it decodes is a copy), and `LineIndex`
 * counts the characters it scans and the probes it makes in `steps`. A loop
 * that counts line breaks by indexing the text is property reads, which no
 * meter sees, so the line numbers are also held to coming from one index.
 *
 * A test that walks many generated inputs declares a budget, as the house
 * does for a test that is slow by construction.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { jsWork, jsWorkAsync } from "../../tool-code/src/__test__/js-work";
import { manifestDependencySet } from "./index";
import { type JsonLocate, JsonMembers, locateJsonMember } from "./lib/jsonspan";
import { type ManifestKind, collectSites } from "./lib/manifest";
import { LineIndex, lineAt } from "./lib/toml";

/** String copies and searches, array visits and iterators, per character of manifest. */
const WORK_PER_CHARACTER = 4;

const space = { cwd: process.cwd(), dir: "" };

beforeEach(() => {
  space.dir = mkdtempSync(join(tmpdir(), "crewhaus-registry-linear-"));
  process.chdir(space.dir);
});

afterEach(() => {
  process.chdir(space.cwd);
  rmSync(space.dir, { recursive: true, force: true });
});

/** Seeded, so a failure names the same input every run. */
function rng(start: number): () => number {
  const state = { seed: start };
  return () => {
    state.seed = (state.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every `LineIndex` that answered a line while `body` ran, how many lines
 * they answered, and the steps they took, building included; and the
 * characters every `JsonMembers` that located something scanned. `body` may
 * be asynchronous; the count runs until it settles.
 */
async function scanWork<T>(body: () => T | Promise<T>): Promise<{
  value: T;
  indexes: number;
  lines: number;
  steps: number;
  jsonSteps: number;
}> {
  const lineProto = LineIndex.prototype;
  const realLineAt = lineProto.lineAt;
  const jsonProto = JsonMembers.prototype;
  const realLocate = jsonProto.locate;
  const indexes = new Set<LineIndex>();
  const readers = new Set<JsonMembers>();
  const tally = { lines: 0 };
  lineProto.lineAt = function (this: LineIndex, at: number) {
    indexes.add(this);
    tally.lines += 1;
    return realLineAt.call(this, at);
  };
  jsonProto.locate = function (this: JsonMembers, path: readonly string[]) {
    readers.add(this);
    return realLocate.call(this, path);
  };
  try {
    const value = await body();
    let steps = 0;
    for (const index of indexes) steps += index.steps;
    let jsonSteps = 0;
    for (const reader of readers) jsonSteps += reader.steps;
    return { value, indexes: indexes.size, lines: tally.lines, steps, jsonSteps };
  } finally {
    lineProto.lineAt = realLineAt;
    jsonProto.locate = realLocate;
  }
}

// ---------------------------------------------------------------------------
// The code as it was.

function oldLineAt(text: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at && i < text.length; i++) if (text[i] === "\n") line += 1;
  return line;
}

function oldSkipWs(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\ufeff") i += 1;
    else break;
  }
  return i;
}

function oldReadString(text: string, from: number): { end: number } | null {
  if (text[from] !== '"') return null;
  let i = from + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return { end: i + 1 };
    i += 1;
  }
  return null;
}

function oldDecode(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function oldReadValue(text: string, from: number): { end: number } | null {
  const c = text[from];
  if (c === undefined) return null;
  if (c === '"') return oldReadString(text, from);
  if (c === "{" || c === "[") {
    const close = c === "{" ? "}" : "]";
    let depth = 0;
    let i = from;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        const str = oldReadString(text, i);
        if (str === null) return null;
        i = str.end;
        continue;
      }
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return ch === close ? { end: i + 1 } : null;
      }
      i += 1;
    }
    return null;
  }
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "," || ch === "}" || ch === "]") break;
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") break;
    i += 1;
  }
  return i === from ? null : { end: i };
}

type OldHit = { valueStart: number; valueEnd: number };

function oldMemberOf(text: string, from: number, key: string): JsonLocate | OldHit {
  if (text[from] !== "{") {
    return { ok: false, kind: "notAnObject", reason: `expected an object at offset ${from}` };
  }
  let i = oldSkipWs(text, from + 1);
  let hit: OldHit | undefined;
  if (text[i] === "}") return { ok: false, kind: "missing", reason: `"${key}" is not declared` };
  while (i < text.length) {
    const keyRead = oldReadString(text, i);
    if (keyRead === null) {
      return { ok: false, kind: "malformed", reason: `unreadable key at offset ${i}` };
    }
    const name = oldDecode(text.slice(i, keyRead.end));
    if (name === null) {
      return { ok: false, kind: "malformed", reason: `unreadable key at offset ${i}` };
    }
    const colon = oldSkipWs(text, keyRead.end);
    if (text[colon] !== ":") {
      return { ok: false, kind: "malformed", reason: `expected ":" at offset ${colon}` };
    }
    const valueStart = oldSkipWs(text, colon + 1);
    const value = oldReadValue(text, valueStart);
    if (value === null) {
      return { ok: false, kind: "malformed", reason: `unreadable value at offset ${valueStart}` };
    }
    if (name === key) {
      if (hit !== undefined) {
        return {
          ok: false,
          kind: "duplicate",
          reason: `"${key}" is declared more than once in the same object`,
        };
      }
      hit = { valueStart, valueEnd: value.end };
    }
    const next = oldSkipWs(text, value.end);
    if (text[next] === ",") {
      i = oldSkipWs(text, next + 1);
      continue;
    }
    if (text[next] === "}") break;
    return { ok: false, kind: "malformed", reason: `expected "," or "}" at offset ${next}` };
  }
  if (hit === undefined) return { ok: false, kind: "missing", reason: `"${key}" is not declared` };
  return hit;
}

function oldLocate(text: string, path: readonly string[]): JsonLocate {
  if (path.length === 0)
    return { ok: false, kind: "malformed", reason: "no member path was given" };
  let at = oldSkipWs(text, 0);
  for (let depth = 0; depth < path.length; depth++) {
    const result = oldMemberOf(text, at, path[depth] as string);
    if ("ok" in result) {
      if (result.ok) return result;
      return depth === path.length - 1
        ? result
        : { ok: false, kind: result.kind, reason: `${result.reason} (at "${path[depth]}")` };
    }
    at = result.valueStart;
    if (depth === path.length - 1) {
      const isString = text[result.valueStart] === '"';
      return {
        ok: true,
        valueSpan: { start: result.valueStart, end: result.valueEnd },
        isString,
        ...(isString ? { inner: { start: result.valueStart + 1, end: result.valueEnd - 1 } } : {}),
      };
    }
  }
  return { ok: false, kind: "missing", reason: "not found" };
}

// ---------------------------------------------------------------------------
// Manifests.

function packageJson(count: number): string {
  const half = Math.floor(count / 2);
  const deps = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => `    "p${from + i}": "^1.${from + i}.0"`).join(
      ",\n",
    );
  return `{\n  "name": "x",\n  "dependencies": {\n${deps(0, half)}\n  },\n  "devDependencies": {\n${deps(half, count)}\n  }\n}\n`;
}

function cargoToml(count: number): string {
  const half = Math.floor(count / 2);
  const plain = Array.from({ length: half }, (_, i) => `p${i} = "1.${i}"`).join("\n");
  const inline = Array.from(
    { length: count - half },
    (_, i) => `q${i} = { version = "0.${i}", features = ["a"] }`,
  ).join("\n");
  return `[package]\nname = "x"\n\n[dependencies]\n${plain}\n\n[dev-dependencies]\n${inline}\n`;
}

function pyprojectToml(count: number): string {
  const half = Math.floor(count / 2);
  const listed = Array.from({ length: half }, (_, i) => `  "p${i}>=1.${i}",`).join("\n");
  const poetry = Array.from({ length: count - half }, (_, i) => `q${i} = "^2.${i}"`).join("\n");
  return `[project]\nname = "x"\ndependencies = [\n${listed}\n]\n\n[tool.poetry.dependencies]\n${poetry}\n`;
}

const MAKERS: ReadonlyArray<readonly [ManifestKind, (count: number) => string]> = [
  ["package.json", packageJson],
  ["Cargo.toml", cargoToml],
  ["pyproject.toml", pyprojectToml],
];

// ---------------------------------------------------------------------------
// Counted.

describe("a manifest is read in one pass", () => {
  for (const [kind, make] of MAKERS) {
    test(`collectSites over a ${kind} of thousands of dependencies`, async () => {
      const measured: number[] = [];
      for (const count of [4_000, 8_000]) {
        const text = make(count);
        const limit = WORK_PER_CHARACTER * text.length;
        const lines = await scanWork(() => jsWork(limit, () => collectSites(kind, text)));
        const run = lines.value;
        expect(run.work).toBeLessThanOrEqual(limit);
        const out = run.value;
        expect(out?.ok && out.sites.length).toBe(count);
        // One index for the file; a line for every site, from it.
        expect({ indexes: lines.indexes, lines: lines.lines }).toEqual({
          indexes: 1,
          lines: count,
        });
        const probes = Math.ceil(Math.log2(text.length)) + 1;
        expect(lines.steps).toBeLessThanOrEqual(text.length + count * probes);
        // The JSON scanner reads the file once for the top-level object and
        // once more for the sections inside it, however many it locates.
        expect(lines.jsonSteps).toBeLessThanOrEqual(2 * text.length);
        measured.push(run.work + lines.steps + lines.jsonSteps);
      }
      expect((measured[1] as number) / (measured[0] as number)).toBeLessThan(2.4);
    }, 20_000);
  }

  test("ManifestDependencySet's dry run of one edit in a manifest of thousands", async () => {
    const measured: number[] = [];
    for (const count of [4_000, 8_000]) {
      const text = packageJson(count);
      writeFileSync("package.json", text);
      const tool = manifestDependencySet as RegisteredTool;
      const input = tool.inputSchema.parse({
        manifest: "package.json",
        edits: [{ name: `p${count - 1}`, spec: "2.0.0" }],
        dryRun: true,
      });
      // The manifest as read, and as it would be after the edit.
      const limit = WORK_PER_CHARACTER * 2 * text.length;
      const lines = await scanWork(() =>
        jsWorkAsync(limit, () => tool.execute(input, {} as never)),
      );
      const run = lines.value;
      expect(run.work).toBeLessThanOrEqual(limit);
      const out = JSON.parse(String(run.value));
      expect(out).toMatchObject({ applied: false, dryRun: true, changed: 1 });
      // The last dependency is on the line before the two closing braces.
      expect(out.edits[0]).toMatchObject({
        line: count + 5,
        from: `^1.${count - 1}.0`,
        to: "^2.0.0",
      });
      // One line index for each of the two texts.
      expect(lines.indexes).toBe(2);
      expect(lines.steps).toBeLessThanOrEqual(limit);
      expect(lines.jsonSteps).toBeLessThanOrEqual(2 * 2 * text.length);
      measured.push(run.work + lines.steps + lines.jsonSteps);
    }
    expect((measured[1] as number) / (measured[0] as number)).toBeLessThan(2.4);
  }, 20_000);

  test("a package.json that opens with a long run of whitespace", async () => {
    const measured: number[] = [];
    for (const count of [4_000, 8_000]) {
      // As much blank space before the object as there is object.
      const body = packageJson(count);
      const text = `${" \n".repeat(body.length / 2)}${body}`;
      const run = await scanWork(() => collectSites("package.json", text));
      expect(run.value.ok && run.value.sites.length).toBe(count);
      // The blank space is skipped once, not once per dependency.
      expect(run.jsonSteps).toBeLessThanOrEqual(2 * text.length);
      measured.push(run.jsonSteps);
    }
    expect((measured[1] as number) / (measured[0] as number)).toBeLessThan(2.4);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// The same answers as before.

describe("the one-pass readers answer what the scans answered", () => {
  test("LineIndex places every offset on the line lineAt counted to", () => {
    const next = rng(0x5eed2001);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const odd = [-1, -0, 0.5, 2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    const differ: string[] = [];
    for (let n = 0; n < 4_000; n++) {
      const text = Array.from({ length: Math.floor(next() * 30) }, () =>
        pick(["a", "\n", "\r", "\r\n", " ", "\u2028", "é"]),
      ).join("");
      const index = new LineIndex(text);
      for (let k = 0; k < 8; k++) {
        const at = next() < 0.2 ? pick(odd) : Math.floor(next() * (text.length + 3));
        const want = oldLineAt(text, at);
        if (index.lineAt(at) !== want || lineAt(text, at) !== want) {
          differ.push(`${JSON.stringify(text)} @ ${at}`);
        }
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
  }, 20_000);

  test("JsonMembers locates what locateJsonMember's scan located, through one reading", () => {
    const next = rng(0x5eed2002);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const keys = ["a", "b", "dependencies"];
    const ws = () => pick(["", "", " ", "\n  ", "\t"]);
    const spelled = (key: string) =>
      next() < 0.85 ? JSON.stringify(key) : JSON.stringify(key).replace(/[ab]/, "\\u0061");
    const value = (depth: number): string =>
      depth > 0 && next() < 0.45
        ? object(depth - 1)
        : pick(['"1.0"', '"^2"', "3", "-1.5e3", "true", "null", "[1,{}]", '"a\\"b"', '"}"']);
    const object = (depth: number): string =>
      `{${ws()}${Array.from(
        { length: Math.floor(next() * 4) },
        () => `${spelled(pick(keys))}${ws()}:${ws()}${value(depth)}${ws()}`,
      ).join(`,${ws()}`)}}`;
    /** Well-formed most of the time; otherwise cut short, or one character changed. */
    const document = (): string => {
      const text = `${pick(["", "", "\ufeff", " \n"])}${next() < 0.1 ? "[1]" : object(2)}${pick(["", "\n"])}`;
      const at = Math.floor(next() * text.length);
      const roll = next();
      if (roll < 0.15) return text.slice(0, at);
      if (roll < 0.35)
        return `${text.slice(0, at)}${pick([":", ",", "}", "]", '"', "x", " "])}${text.slice(at + 1)}`;
      return text;
    };
    const differ: string[] = [];
    const seen = { found: 0, duplicate: 0, malformed: 0, missing: 0, notAnObject: 0 };
    for (let n = 0; n < 4_000; n++) {
      const text = document();
      const members = new JsonMembers(text);
      for (let k = 0; k < 6; k++) {
        const path = Array.from({ length: Math.floor(next() * 3) + (k === 0 ? 0 : 1) }, () =>
          pick(keys),
        );
        const want = oldLocate(text, path);
        if (want.ok) seen.found++;
        else seen[want.kind]++;
        const shared = JSON.stringify(members.locate(path));
        const fresh = JSON.stringify(locateJsonMember(text, path));
        if (shared !== JSON.stringify(want) || fresh !== JSON.stringify(want)) {
          differ.push(`${JSON.stringify(text)} ${JSON.stringify(path)}`);
        }
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(Math.min(...Object.values(seen))).toBeGreaterThan(200);
  }, 20_000);

  test("collectSites puts every site on the line, and every npm spec at the span, it did", () => {
    const next = rng(0x5eed2003);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const differ: string[] = [];
    const seen = { sites: 0, skipped: 0 };
    for (let n = 0; n < 600; n++) {
      const [kind, make] = pick(MAKERS);
      // Blank lines and comments move the lines; a repeated name is skipped
      // with the lines of each declaration.
      let text = make(1 + Math.floor(next() * 12));
      text = text.replace(/\n/g, () => pick(["\n", "\n", "\n\n", "\r\n"]));
      if (next() < 0.4) {
        text =
          kind === "package.json"
            ? text.replace('"p0":', '"p0": "1", "p0":')
            : text.replace("\np0 =", '\np0 = "1"\np0 =');
      }
      const out = collectSites(kind, text);
      if (!out.ok) {
        differ.push(`${kind} did not read: ${out.reason}`);
        continue;
      }
      seen.sites += out.sites.length;
      seen.skipped += out.skipped.length;
      const members = new JsonMembers(text);
      for (const site of out.sites) {
        if (site.line !== oldLineAt(text, site.specSpan.start)) {
          differ.push(`${kind} ${site.name} line ${site.line} ${JSON.stringify(text)}`);
        }
        if (kind === "package.json") {
          const was = oldLocate(text, [site.section, site.name]);
          if (!was.ok || JSON.stringify(was.inner) !== JSON.stringify(site.specSpan)) {
            differ.push(
              `${site.name} span ${JSON.stringify(site.specSpan)} ${JSON.stringify(text)}`,
            );
          }
          if (JSON.stringify(members.locate([site.section, site.name])) !== JSON.stringify(was)) {
            differ.push(`${site.name} located differently ${JSON.stringify(text)}`);
          }
        }
      }
      for (const skip of out.skipped) {
        const listed = skip.reason.match(/\(lines ([\d, ]+)\)/)?.[1];
        if (listed === undefined) continue;
        // Each listed line holds a declaration of the name.
        for (const line of listed.split(", ").map(Number)) {
          const held = text.split("\n")[line - 1] ?? "";
          if (!held.includes(skip.name)) differ.push(`${skip.name} not on line ${line}`);
        }
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(seen.sites).toBeGreaterThan(2_000);
    expect(seen.skipped).toBeGreaterThan(100);
  }, 20_000);
});
