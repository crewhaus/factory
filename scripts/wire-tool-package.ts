/**
 * Wire a new `@crewhaus/tool-*` package into every place the runtime needs to
 * know about it.
 *
 * Adding a builtin tool touches a handful of files that must agree, and a
 * drifting pair fails a test somewhere far from the edit. This script makes
 * the edits from one declaration so they cannot drift:
 *
 *   1. packages/tool-categories/src/registry.ts  — the category it belongs to
 *   2. packages/tool-categories/src/builtins.ts  — the builtin table row every
 *      shape, `crewhaus run`, eval and lint read (package, export, the
 *      registered name, and the io / sandbox facts, read off the tool itself)
 *   3. apps/cli/src/tool-packages.ts             — a literal loader for a NEW
 *      package, so the single-binary CLI embeds it
 *   4. apps/cli/src/tools-cli.ts                 — the `tools suggest` keyword table
 *   5. tsconfig.json + apps/cli's package.json/tsconfig — build refs and deps
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

type ToolEntry = {
  /** The camelCase key a spec writes in `tools:`. */
  readonly key: string;
  /**
   * The name the package actually exports, when it differs from the key —
   * a tool whose natural name collides with a library function in its own
   * module ends up exported with a suffix. The spec should still read
   * `documentText`, not `documentTextTool`.
   */
  readonly export?: string;
  readonly keywords: ReadonlyArray<string>;
};
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

/**
 * A tool key must be unique across the whole monorepo.
 *
 * Every integration point is an object literal keyed by the tool name, so a
 * duplicate silently shadows the earlier entry and the tool count comes out
 * one short. `tsc` does catch it — as TS1117, in two generated files, with
 * no hint of which package caused it — so the failure lands far from the
 * edit. `unitConvert` reached that point once: tool-math converts metres,
 * tool-onchain converts token decimals, and the second one won.
 */
const BUILTINS_FILE = "packages/tool-categories/src/builtins.ts";
{
  const registry = readFileSync(join(ROOT, BUILTINS_FILE), "utf-8");
  // A row is `  key: { package: "…", … }` — on one line, or wrapped by biome
  // with the package on a later line — so take the text up to the row's end.
  const rowOf = (key: string): string | undefined =>
    new RegExp(`^  ${key}: \\{[\\s\\S]*?\\},?$`, "m").exec(registry)?.[0];
  const taken = keys.filter((key) => {
    const row = rowOf(key);
    return row !== undefined && !row.includes(`package: "${scope}"`);
  });
  if (taken.length > 0) {
    const owners = taken.map((key) => {
      const owner = /@crewhaus\/[a-z0-9-]+/.exec(rowOf(key) ?? "")?.[0] ?? "another package";
      return `  ${key} — already registered by ${owner}`;
    });
    throw new Error(
      `these tool keys are already taken, and a key must be unique across the monorepo:\n${owners.join("\n")}\nRename yours to something that says what it does differently, and say so in its description.`,
    );
  }
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new Error(`the manifest lists "${key}" twice`);
    seen.add(key);
  }
}

const edits: Array<{ file: string; applied: boolean; why: string }> = [];

/**
 * Apply one edit.
 *
 * The transform returns `undefined` to mean "already wired, nothing to do".
 * Returning the input unchanged means something else: the anchor it looked
 * for was not found, so the edit silently did nothing. Those two were once
 * the same branch here, and an anchor that had moved was reported as
 * "already present" — which is how a whole package shipped registered
 * nowhere. They are now distinguished, and a missing anchor is fatal.
 */
function edit(rel: string, transform: (s: string) => string | undefined, why: string): void {
  const path = join(ROOT, rel);
  const before = readFileSync(path, "utf-8");
  const after = transform(before);
  if (after === undefined) {
    edits.push({ file: rel, applied: false, why: `${why} (already present)` });
    return;
  }
  if (after === before) {
    throw new Error(
      `${rel}: the anchor for "${why}" was not found, so nothing was written. The file's shape changed — update this script rather than editing the file by hand, or the next package hits the same hole.`,
    );
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
    if (existing?.[0].includes("includes:")) {
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

// 2 — the builtin table -----------------------------------------------------
{
  // The registered name and the io / sandbox / justification facts are read off the tools
  // themselves, so the row cannot claim something the tool does not do.
  // (apps/cli/src/tool-registry.test.ts re-reads them on every run.)
  const mod = (await import(join(ROOT, "packages", pkgDir, "src", "index.ts"))) as Record<
    string,
    unknown
  >;
  // A package whose every existing row names one boot registrar configures
  // the whole package through it (tool_config.http), so a new tool in it
  // names it too — otherwise the package's block would not reach it.
  const siblings = Object.values(
    (
      (await import(join(ROOT, BUILTINS_FILE))) as {
        BUILTIN_TOOLS: Record<
          string,
          { package: string; initSymbol?: string; chainSymbol?: string }
        >;
      }
    ).BUILTIN_TOOLS,
  ).filter((e) => e.package === scope);
  const shared = (field: "initSymbol" | "chainSymbol"): string | undefined => {
    const values = new Set(siblings.map((e) => e[field]));
    const only = [...values][0];
    return siblings.length >= 2 && values.size === 1 ? only : undefined;
  };
  const initSymbol = shared("initSymbol");
  const chainSymbol = shared("chainSymbol");
  const rowFor = (key: string): string => {
    const exp = manifest.tools.find((t) => t.key === key)?.export ?? key;
    const tool = mod[exp] as
      | {
          name?: unknown;
          ioCapability?: unknown;
          requiresSandbox?: unknown;
          requireJustification?: unknown;
        }
      | undefined;
    if (tool === undefined || typeof tool.name !== "string") {
      throw new Error(
        `${scope} does not export a RegisteredTool named "${exp}" (for key "${key}")`,
      );
    }
    const parts = [
      `package: "${scope}"`,
      `export: "${exp}"`,
      `name: ${JSON.stringify(tool.name)}`,
      ...(initSymbol !== undefined ? [`initSymbol: "${initSymbol}"`] : []),
      ...(chainSymbol !== undefined ? [`chainSymbol: "${chainSymbol}"`] : []),
      ...(tool.ioCapability === "process" || tool.ioCapability === "network"
        ? [`io: "${tool.ioCapability}"`]
        : []),
      ...(tool.requiresSandbox === true ? ["sandbox: true"] : []),
      ...(tool.requireJustification === true ? ["justify: true"] : []),
    ];
    return `  ${key}: { ${parts.join(", ")} },`;
  };
  edit(
    BUILTINS_FILE,
    (s) => {
      const absent = keys.filter((k) => !new RegExp(`^  ${k}: \\{`, "m").test(s));
      if (absent.length === 0) return undefined;
      const anchor =
        "  // ---- scripts/wire-tool-package.ts inserts new builtins above this line ----";
      if (!s.includes(anchor)) throw new Error("builtins.ts insertion anchor moved");
      return s.replace(anchor, `${absent.map(rowFor).join("\n")}\n${anchor}`);
    },
    "builtin table rows",
  );
}

// 3 — the CLI's literal package loader ----------------------------------------
edit(
  "apps/cli/src/tool-packages.ts",
  (s) => {
    if (s.includes(`"${scope}": () => import("${scope}"),`)) return undefined;
    const tableRe =
      /(export const TOOL_PACKAGE_LOADERS: Readonly<Record<string, \(\) => Promise<ToolModule>>> = \{)([\s\S]*?)(\n\};)/;
    if (!tableRe.test(s)) throw new Error("TOOL_PACKAGE_LOADERS declaration moved");
    return s.replace(
      tableRe,
      (_m, head: string, body: string, close: string) =>
        `${head}${body}\n  "${scope}": () => import("${scope}"),${close}`,
    );
  },
  "package loader",
);

// 4 — the suggest keyword table -----------------------------------------------
edit(
  "apps/cli/src/tools-cli.ts",
  (s) => {
    const absentKeys = keys.filter((k) => !new RegExp(`^  ${k}: \\[`, "m").test(s));
    if (absentKeys.length === 0) return undefined;
    const anchor = '  todoWrite: ["todo", "task list", "track tasks", "checklist"],';
    if (!s.includes(anchor)) throw new Error("TOOL_KEYWORDS anchor moved");
    const add = manifest.tools
      .filter((t) => absentKeys.includes(t.key))
      .map((t) => `  ${t.key}: [${t.keywords.map((w) => JSON.stringify(w)).join(", ")}],`)
      .join("\n");
    return s.replace(anchor, `${anchor}\n${add}`);
  },
  "TOOL_KEYWORDS entries",
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

/**
 * Only `apps/cli` needs the package as a dependency. The builtin table names
 * it too, but as a *string* — data an emitter writes into a generated
 * bundle's imports, never something `tool-categories` itself resolves. No
 * emitter imports a tool package, so adding a dependency and a project
 * reference there would be cargo cult.
 */
for (const [pj, tc, rel] of [
  ["apps/cli/package.json", "apps/cli/tsconfig.json", `../../packages/${pkgDir}`],
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
