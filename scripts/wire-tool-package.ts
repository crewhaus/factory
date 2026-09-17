/**
 * Wire a new `@crewhaus/tool-*` package into every place the runtime needs to
 * know about it.
 *
 * Adding a builtin tool touches five files that must agree, and a drifting
 * pair fails a test somewhere far from the edit. This script makes the five
 * edits from one declaration so they cannot drift:
 *
 *   1. packages/tool-categories/src/registry.ts  — the category it belongs to
 *   2. packages/target-cli/src/index.ts          — BUILTIN_TOOL_MAP, so a spec compiles
 *   3. apps/cli/src/index.ts                     — loadToolMap, so `crewhaus run` resolves it
 *   4. apps/cli/src/tools-cli.ts                 — CLI_RUNTIME_TOOL_KEYS and TOOL_KEYWORDS
 *   5. tsconfig.json + the two package.json files — build refs and deps
 *
 * Usage:
 *   bun run scripts/wire-tool-package.ts <manifest.json>
 *   bun run scripts/wire-tool-package.ts <manifest.json> --check
 *
 * The manifest:
 *   {
 *     "package": "tool-data",
 *     "category": { "name": "data", "title": "...", "rollUp": "content" },
 *     "tools": [ { "key": "jsonQuery", "keywords": ["query json", "jsonpath"] }, ... ]
 *   }
 *
 * `--check` reports what is missing without writing, which is what CI wants.
 *
 * Idempotent: running it twice makes no second set of edits.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ToolEntry = { readonly key: string; readonly keywords: ReadonlyArray<string> };
type Manifest = {
  readonly package: string;
  readonly category: { readonly name: string; readonly title: string; readonly rollUp?: string };
  readonly tools: ReadonlyArray<ToolEntry>;
};

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const manifestPath = args[0];
const checkOnly = args.includes("--check");

if (manifestPath === undefined) {
  console.error("usage: bun run scripts/wire-tool-package.ts <manifest.json> [--check]");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
const pkgDir = manifest.package.startsWith("tool-") ? manifest.package : `tool-${manifest.package}`;
const scope = `@crewhaus/${pkgDir}`;
const keys = manifest.tools.map((t) => t.key);

const edits: Array<{ file: string; applied: boolean; why: string }> = [];

function edit(rel: string, transform: (s: string) => string | undefined, why: string): void {
  const path = join(ROOT, rel);
  const before = readFileSync(path, "utf-8");
  const after = transform(before);
  if (after === undefined || after === before) {
    edits.push({ file: rel, applied: false, why: `${why} (already present)` });
    return;
  }
  if (!checkOnly) writeFileSync(path, after);
  edits.push({ file: rel, applied: true, why });
}

// 1 — the category registry ---------------------------------------------------
edit(
  "packages/tool-categories/src/registry.ts",
  (s) => {
    // Per-KEY, like the other guards: when the category already exists, the
    // new tools still have to be added to it. Keying on the category name
    // alone silently dropped every tool added to an existing category.
    const existing = new RegExp(`  ${manifest.category.name}: \\{[\\s\\S]*?\\n  \\},`).exec(s);
    if (existing !== null && existing[0].includes("includes:")) {
      // A category is a leaf OR a roll-up, never both. Silently doing nothing
      // here is how tool-code's twenty tools ended up registered nowhere.
      throw new Error(
        `category "${manifest.category.name}" already exists as a roll-up, which cannot own tools — pick a different leaf name`,
      );
    }
    if (existing !== null) {
      const missingHere = keys.filter((k) => !existing[0].includes(`"${k}"`));
      if (missingHere.length === 0) return undefined;
      const insert = missingHere.map((k) => `      ${JSON.stringify(k)},`).join("\n");
      // The tools array may be written on one line or across several; handle
      // both rather than silently matching neither.
      const multiline = /\n {4}\],/.test(existing[0]);
      const grown = multiline
        ? existing[0].replace(/(\n {4}\],)/, `\n${insert}$1`)
        : existing[0].replace(
            /tools: \[([^\]]*)\],/,
            (_m, body: string) =>
              `tools: [\n${body
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0)
                .map((t) => `      ${t},`)
                .join("\n")}\n${insert}\n    ],`,
          );
      return s.replace(existing[0], grown);
    }
    const toolLines = keys.map((k) => `      ${JSON.stringify(k)},`).join("\n");
    const block = [
      `  ${manifest.category.name}: {`,
      `    title: ${JSON.stringify(manifest.category.title)},`,
      "    tools: [",
      toolLines,
      "    ],",
      "  },",
      "",
    ].join("\n");
    let out = s.replace("  // ---- roll-ups ----", `${block}\n  // ---- roll-ups ----`);
    const rollUp = manifest.category.rollUp;
    if (rollUp !== undefined) {
      // Add this category to an existing roll-up's includes list.
      const re = new RegExp(`(  ${rollUp}: \\{[\\s\\S]*?includes: \\[)([^\\]]*)(\\])`);
      out = out.replace(re, (_m, head: string, body: string, tail: string) =>
        body.includes(`"${manifest.category.name}"`)
          ? `${head}${body}${tail}`
          : `${head}${body.trimEnd().replace(/,$/, "")}, "${manifest.category.name}"${tail}`,
      );
    }
    return out;
  },
  `category "${manifest.category.name}" with ${keys.length} tools`,
);

// 2 — the cli emitter's builtin map -------------------------------------------
edit(
  "packages/target-cli/src/index.ts",
  (s) => {
    // Per-KEY, not per-package: adding tools to a package that is already
    // wired must still insert the new keys.
    const absent = keys.filter((k) => !s.includes(`  ${k}: { package: "${scope}"`));
    if (absent.length === 0) return undefined;
    const anchor =
      '  codegraphSearch: { package: "@crewhaus/tool-codegraph", export: "codegraphSearch" },';
    if (!s.includes(anchor)) throw new Error("target-cli BUILTIN_TOOL_MAP anchor moved");
    const add = absent.map((k) => `  ${k}: { package: "${scope}", export: "${k}" },`).join("\n");
    return s.replace(anchor, `${add}\n${anchor}`);
  },
  "BUILTIN_TOOL_MAP entries",
);

// 3 — the CLI's runtime tool map ----------------------------------------------
edit(
  "apps/cli/src/index.ts",
  (s) => {
    const missing = keys.filter(
      (k) =>
        !s.includes(
          `    ${k}: ${pkgDir
            .replace(/^tool-/, "")
            .replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())}.${k},`,
        ),
    );
    if (missing.length === 0) return undefined;
    const alreadyImported = s.includes(`import("${scope}")`);
    const local = pkgDir
      .replace(/^tool-/, "")
      .replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    // The import goes LAST in the Promise.all array and the binding goes LAST
    // in the destructuring, so the two lists stay aligned. Inserting the
    // import near the top while appending the binding at the end silently
    // pairs every tool package with the wrong module.
    let out = s;
    if (!alreadyImported) {
      out = out.replace(
        /(\n(\s*)import\("@crewhaus\/tool-code-execution"\),[\s\S]*?)(\n\s*\]\);)/,
        (_m, body: string, indent: string, close: string) =>
          `${body}\n${indent}import("${scope}"),${close}`,
      );
      // Widen the destructuring that receives those imports, also at the end.
      out = out.replace(
        /(const \[[^\]]*?)(\s*\] =\s*await Promise\.all)/,
        (_m, head: string, tail: string) =>
          head.trimEnd().endsWith(",")
            ? `${head}\n    ${local},${tail}`
            : `${head},\n    ${local},${tail}`,
      );
    }
    const anchor = "    codegraphImpact: codegraph.codegraphImpact,";
    if (!out.includes(anchor)) throw new Error("loadToolMap anchor moved");
    const add = missing.map((k) => `    ${k}: ${local}.${k},`).join("\n");
    return out.replace(anchor, `${anchor}\n    // ${scope}\n${add}`);
  },
  "loadToolMap entries",
);

// 4 — the canonical key list and the suggest keyword table --------------------
edit(
  "apps/cli/src/tools-cli.ts",
  (s) => {
    const absentKeys = keys.filter((k) => !s.includes(`\n  "${k}",`));
    if (absentKeys.length === 0) return undefined;
    // Anchor on the array itself, not on whatever happens to be its last
    // entry: the previous version keyed off "codegraphImpact" and silently
    // did nothing once another package had appended below it.
    const listRe =
      /(export const CLI_RUNTIME_TOOL_KEYS: ReadonlyArray<string> = Object\.freeze\(\[)([\s\S]*?)(\n\]\);)/;
    if (!listRe.test(s)) throw new Error("CLI_RUNTIME_TOOL_KEYS declaration moved");
    const out = s.replace(
      listRe,
      (_m, head: string, body: string, close: string) =>
        `${head}${body}\n${absentKeys.map((k) => `  "${k}",`).join("\n")}${close}`,
    );
    if (out === s) throw new Error("CLI_RUNTIME_TOOL_KEYS was not updated");
    const anchor = '  todoWrite: ["todo", "task list", "track tasks", "checklist"],';
    if (!out.includes(anchor)) throw new Error("TOOL_KEYWORDS anchor moved");
    const add = manifest.tools
      .filter((t) => absentKeys.includes(t.key))
      .map((t) => `  ${t.key}: [${t.keywords.map((w) => JSON.stringify(w)).join(", ")}],`)
      .join("\n");
    return out.replace(anchor, `${anchor}\n${add}`);
  },
  "CLI_RUNTIME_TOOL_KEYS and TOOL_KEYWORDS entries",
);

// 5 — build references and dependencies ---------------------------------------
edit(
  "tsconfig.json",
  (s) =>
    s.includes(`"./packages/${pkgDir}"`)
      ? undefined
      : s.replace(
          '    { "path": "./packages/tool-consult" },',
          `    { "path": "./packages/tool-consult" },\n    { "path": "./packages/${pkgDir}" },`,
        ),
  "root build reference",
);

for (const [pj, tc, rel] of [
  ["apps/cli/package.json", "apps/cli/tsconfig.json", `../../packages/${pkgDir}`],
  ["packages/target-cli/package.json", "packages/target-cli/tsconfig.json", `../${pkgDir}`],
] as const) {
  edit(
    pj,
    (s) =>
      s.includes(scope)
        ? undefined
        : s.replace(
            '"@crewhaus/tool-builder": "workspace:*",',
            `"@crewhaus/tool-builder": "workspace:*",\n    "${scope}": "workspace:*",`,
          ),
    "dependency",
  );
  edit(
    tc,
    (s) =>
      s.includes(`"${rel}"`)
        ? undefined
        : s
            .replace(
              '{ "path": "../tool-builder" },',
              `{ "path": "../tool-builder" },\n    { "path": "${rel}" },`,
            )
            .replace(
              '{ "path": "../../packages/tool-builder" },',
              `{ "path": "../../packages/tool-builder" },\n    { "path": "${rel}" },`,
            ),
    "project reference",
  );
}

const changed = edits.filter((e) => e.applied);
for (const e of edits) {
  console.log(
    `${e.applied ? (checkOnly ? "WOULD EDIT" : "edited   ") : "unchanged"}  ${e.file}  — ${e.why}`,
  );
}
console.log(
  checkOnly
    ? `\n${changed.length} file(s) would change. Run without --check to apply, then \`bun install\`.`
    : `\n${changed.length} file(s) changed. Now run: bun install && bunx biome check --fix . && bunx tsc -b`,
);
if (checkOnly && changed.length > 0) process.exit(1);
