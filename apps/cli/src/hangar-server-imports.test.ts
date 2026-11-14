/**
 * The CLI may START Hangar's server, and take nothing else from it.
 *
 * `@crewhaus/hangar-server` is an HTTP server. The helpers the CLI used to
 * borrow from its internals — the control.v1 client, run detail, the env
 * merge, the log scrubbers — now live in the packages that own them
 * (`@crewhaus/gateway-protocol/control-client`, `@crewhaus/harness-supervisor`
 * and its `./run-detail` subpath), because everything that comes after the
 * server (a resident service, other heads) needs the same helpers and must
 * not depend on the server to get them (crewhaus/factory#507, step 03).
 *
 * So this guard reads every non-test source under `src/` with the statement
 * grammar `manifest.test.ts` uses (an `import`/`export … from "…"` whose
 * specifier list may span lines, and a bare `import "…"`), extended to step
 * over a comment in that list whole, whatever the comment holds, and to leave
 * an `export` that declares something alone. It allows exactly:
 *   - from `.`: what `crewhaus hangar` needs to start the server — the
 *     function, its two types, the default port, and the token file name;
 *   - from `./scaffolded-workflows`: the workflow file names the flywheel
 *     and CI scaffolds share with the server's flywheel route;
 *   - from `./plugin-grants`: Home's plugin grants ledger, which
 *     `crewhaus plugins grants|grant|revoke` reads and writes as Home does.
 * `daemon-cmd.ts` may not import the server at all. A namespace, default,
 * side-effect or dynamic import of the server is a violation wherever it is,
 * because none of them can be held to a list of names.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = import.meta.dir;

/** Allowed names, per specifier. Anything not listed is refused. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "@crewhaus/hangar-server": [
    "startHangarServer",
    "HangarServer",
    "HangarServerOptions",
    "DEFAULT_HANGAR_PORT",
    "TOKEN_FILENAME",
  ],
  "@crewhaus/hangar-server/scaffolded-workflows": [
    "SCAFFOLDED_WORKFLOWS",
    "WORKFLOWS_DIR_SEGMENTS",
  ],
  // Home's plugin grants ledger: `crewhaus plugins grants|grant|revoke` reads and
  // writes the same rows Home's `plugins.*` operations do, through the same code.
  "@crewhaus/hangar-server/plugin-grants": [
    "GrantOutcome",
    "PluginGrantInput",
    "PluginRow",
    "expectHolds",
    "grantPlugin",
    "grantProblem",
    "liveGrantOf",
    "pluginReviewOf",
    "readPluginGrants",
    "readPluginInventory",
    "revokePlugin",
    "standingFrom",
  ],
};

/** Sources that may not import the server in any form. */
const NO_SERVER_AT_ALL: readonly string[] = ["daemon-cmd.ts"];

const SERVER_PACKAGE = "@crewhaus/hangar-server";

/** Non-test sources: `*.test.ts` and anything under `__test__/` skipped. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__test__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

// `manifest.test.ts`'s grammar, extended twice. It captures the keyword
// (group 1), the clause (2), the specifier (5) and a bare `import "…"`'s
// specifier (6). The clause runs to `from "…"` across newlines, but never
// across a quote, a backtick or a `;` outside a comment, so it cannot run from
// one statement into the next.
//
// First, a comment is taken whole, so nothing in it (an apostrophe, a quote, a
// `;`, a `from "…"`) ends the clause early or is read as code. Each comment is
// atomic as well: a lookahead captures it (3, 4) and a backreference consumes
// it, and JavaScript never backtracks into a lookahead. Without that, a
// statement that fails to match goes back into its comments to try other
// readings of them: it can then take a `from "…"` inside one as its own, and a
// run of block comments costs time exponential in their number.
//
// Second, an `export` starts a clause only where a re-export can: before `{`,
// `*`, `type {`, `type *` or a comment. An `export` that declares something
// (`export const …`, `export function …`) never does. Its body may hold a regex
// literal, and a `//` or `/*` in one would read as a comment and carry the
// clause on into the statements after it.
const STATEMENT_RE =
  /^(import|export(?=\s+(?:type\s+)?[{*/]))\s((?:[^;"'`/]|\/(?![/*])|(?=(\/\/[^\n]*))\3|(?=(\/\*[\s\S]*?\*\/))\4)*?)\bfrom\s+"([^"]+)"|^import\s+"([^"]+)"/gm;
// A dynamic `import("…")` or `require("…")` of the server: never allowed.
const DYNAMIC_RE =
  /\b(?:import|require)\s*\(\s*["'`](@crewhaus\/hangar-server(?:\/[^"'`]*)?)["'`]/g;

const isServerSpecifier = (specifier: string): boolean =>
  specifier === SERVER_PACKAGE || specifier.startsWith(`${SERVER_PACKAGE}/`);

type Hit = { readonly file: string; readonly specifier: string; readonly names: string[] };

/** A clause with each comment replaced by a space. Outside a comment a clause
 *  holds no quote (the grammar refuses one), so a single left-to-right pass
 *  reads the comments the way the grammar does: a `/*` inside a `//` comment
 *  belongs to that comment, and a `//` inside a block comment to the block. */
const withoutComments = (clause: string): string =>
  clause.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, " ");

/** The names a `{ … }` clause binds (its comments already gone), with `type `
 *  prefixes and `as` aliases off. */
function namedBindings(inner: string): string[] {
  return inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map(
      (part) =>
        part
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          ?.trim() ?? "",
    );
}

/** Every server import in one source, and what is wrong with each. */
function scan(file: string, text: string): { hits: Hit[]; violations: string[] } {
  const hits: Hit[] = [];
  const violations: string[] = [];
  const banned = NO_SERVER_AT_ALL.includes(file);
  for (const match of text.matchAll(STATEMENT_RE)) {
    // Groups 3 and 4 only hold a comment while it is consumed.
    const [, keywordGroup, clauseGroup, , , specifierGroup, sideEffect] = match;
    if (sideEffect !== undefined) {
      if (isServerSpecifier(sideEffect)) {
        violations.push(`${file}: side-effect import of ${sideEffect}`);
      }
      continue;
    }
    const keyword = keywordGroup as string;
    const specifier = specifierGroup as string;
    if (!isServerSpecifier(specifier)) continue;
    const clause = withoutComments(clauseGroup as string)
      .trim()
      .replace(/^type\s+/, "");
    const braces = clause.match(/^([^{]*)\{([^}]*)\}\s*$/);
    if (braces === null) {
      // `* as h`, `*` (an `export *`), or a bare default binding.
      violations.push(
        `${file}: ${clause.startsWith("*") ? "namespace" : "default"} ${keyword} of ${specifier}`,
      );
      continue;
    }
    if ((braces[1] as string).trim() !== "") {
      violations.push(`${file}: default ${keyword} of ${specifier} beside named ones`);
      continue;
    }
    const names = namedBindings(braces[2] as string);
    hits.push({ file, specifier, names });
    if (banned) {
      violations.push(`${file}: imports ${specifier} (${names.join(", ")}) — it may not at all`);
      continue;
    }
    const allowed = ALLOWED[specifier];
    if (allowed === undefined) {
      violations.push(`${file}: imports ${specifier}, which no exemption names`);
      continue;
    }
    for (const name of names) {
      if (!allowed.includes(name)) violations.push(`${file}: imports ${name} from ${specifier}`);
    }
  }
  for (const match of text.matchAll(DYNAMIC_RE)) {
    violations.push(`${file}: dynamic import of ${match[1]}`);
  }
  return { hits, violations };
}

describe("what the CLI takes from @crewhaus/hangar-server", () => {
  const files = sourceFiles(SRC);
  const results = files.map((path) => scan(relative(SRC, path), readFileSync(path, "utf8")));
  const hits = results.flatMap((r) => r.hits);
  const violations = results.flatMap((r) => r.violations);

  test("the sweep reads the sources it is meant to guard", () => {
    // Well over a hundred non-test sources; a sweep that found a handful
    // would be reading the wrong directory.
    expect(files.length).toBeGreaterThan(100);
    const scanned = files.map((path) => relative(SRC, path));
    expect(scanned).toContain("daemon-cmd.ts");
    expect(scanned).toContain("hangar-cmd.ts");
    expect(scanned.some((name) => name.endsWith(".test.ts"))).toBe(false);
  });

  test("it finds exactly the four statements that may import the server", () => {
    // Its own hit count: a grammar that silently stopped matching would
    // otherwise pass every test below by finding nothing.
    expect(hits.map((hit) => `${hit.file} ← ${hit.specifier}`).sort()).toEqual([
      "ci-scaffold.ts ← @crewhaus/hangar-server/scaffolded-workflows",
      "flywheel.ts ← @crewhaus/hangar-server/scaffolded-workflows",
      "hangar-cmd.ts ← @crewhaus/hangar-server",
      "plugins-grant-cmd.ts ← @crewhaus/hangar-server/plugin-grants",
    ]);
  });

  test("no source imports anything else from the server, and daemon-cmd.ts imports none of it", () => {
    expect(violations).toEqual([]);
  });

  test("every exemption is still used", () => {
    // An allow-list entry nothing imports is a hole waiting for a new caller.
    const used = new Set(
      hits.flatMap((hit) => hit.names.map((name) => `${hit.specifier}:${name}`)),
    );
    for (const [specifier, names] of Object.entries(ALLOWED)) {
      for (const name of names) {
        expect(`${specifier}:${name}:${used.has(`${specifier}:${name}`)}`).toBe(
          `${specifier}:${name}:true`,
        );
      }
    }
  });

  test("the guard reports the imports it exists to refuse", () => {
    // Planted in memory, never on disk: the scanner's own failure modes.
    const helper = scan(
      "planted.ts",
      'import {\n  runDetail,\n  startHangarServer,\n} from "@crewhaus/hangar-server";\n',
    );
    expect(helper.violations).toEqual([
      "planted.ts: imports runDetail from @crewhaus/hangar-server",
    ]);
    const namespace = scan("planted.ts", 'import * as h from "@crewhaus/hangar-server";\n');
    expect(namespace.violations).toEqual([
      "planted.ts: namespace import of @crewhaus/hangar-server",
    ]);
    expect(scan("planted.ts", 'import h from "@crewhaus/hangar-server";\n').violations).toEqual([
      "planted.ts: default import of @crewhaus/hangar-server",
    ]);
    expect(scan("planted.ts", 'import "@crewhaus/hangar-server";\n').violations).toEqual([
      "planted.ts: side-effect import of @crewhaus/hangar-server",
    ]);
    expect(
      scan("planted.ts", 'export { runsView } from "@crewhaus/hangar-server";\n').violations,
    ).toEqual(["planted.ts: imports runsView from @crewhaus/hangar-server"]);
    expect(
      scan("planted.ts", 'const h = await import("@crewhaus/hangar-server");\n').violations,
    ).toEqual(["planted.ts: dynamic import of @crewhaus/hangar-server"]);
    expect(
      scan("planted.ts", 'import { HttpError } from "@crewhaus/hangar-server/http";\n').violations,
    ).toEqual(["planted.ts: imports @crewhaus/hangar-server/http, which no exemption names"]);
    // A comment in the list hides nothing, whatever it holds: an apostrophe, a
    // quote or a `;` (a grammar that read it as code would stop there and never
    // see the statement), a `from "…"` (it would be taken as the statement's
    // specifier), a `/*` inside a `//` comment, or a `}`.
    for (const list of [
      "  runDetail, // the server's wrapper\n",
      '  /* "x"; */ runDetail,\n',
      '  startHangarServer, // from "./boot"\n  runDetail,\n',
      "  // reads logs/*.log\n  runDetail,\n  /* boots it */ startHangarServer,\n",
      "  // see {@link runsView}\n  runDetail,\n",
    ]) {
      const { violations: found } = scan(
        "planted.ts",
        `import {\n${list}} from "@crewhaus/hangar-server";\n`,
      );
      expect({ list, found }).toEqual({
        list,
        found: ["planted.ts: imports runDetail from @crewhaus/hangar-server"],
      });
    }
    // A comment is never read as code, even in a statement that fails to
    // match: a local `export { … };` whose comment names the server re-exports
    // nothing, and no statement stretches a block comment past its `;`.
    expect(
      scan("planted.ts", 'export {\n  limits, // from "@crewhaus/hangar-server"\n};\n'),
    ).toEqual({ hits: [], violations: [] });
    expect(
      scan(
        "planted.ts",
        'export { limits /* one */ };\n/* two */\nimport { runDetail } from "@crewhaus/hangar-server";\n',
      ).violations,
    ).toEqual(["planted.ts: imports runDetail from @crewhaus/hangar-server"]);
    // An `export` that declares something is no statement of this grammar, so
    // a `//` or `/*` in its regex literal cannot carry it into the import that
    // follows: that import is read on its own, allowed or refused.
    expect(
      scan(
        "planted.ts",
        'export const URL_RE = /^https?:\\/\\//;\nimport { startHangarServer } from "@crewhaus/hangar-server";\n',
      ),
    ).toEqual({
      hits: [
        { file: "planted.ts", specifier: "@crewhaus/hangar-server", names: ["startHangarServer"] },
      ],
      violations: [],
    });
    expect(
      scan(
        "planted.ts",
        'export const SLASHES = /\\/*$/;\nimport { runDetail } from "@crewhaus/hangar-server";\n/** docs */\nimport { z } from "zod";\n',
      ).violations,
    ).toEqual(["planted.ts: imports runDetail from @crewhaus/hangar-server"]);
    // daemon-cmd.ts may not take even an allowed name…
    expect(
      scan("daemon-cmd.ts", 'import { startHangarServer } from "@crewhaus/hangar-server";\n')
        .violations,
    ).toEqual([
      "daemon-cmd.ts: imports @crewhaus/hangar-server (startHangarServer) — it may not at all",
    ]);
    // …nor hide one behind a comment.
    expect(
      scan(
        "daemon-cmd.ts",
        'import {\n  // the server\'s run detail, borrowed again\n  runDetail as serverRunDetail,\n} from "@crewhaus/hangar-server";\n',
      ).violations,
    ).toEqual(["daemon-cmd.ts: imports @crewhaus/hangar-server (runDetail) — it may not at all"]);
    // …and an allowed import, a `type` one or a commented one included, passes.
    expect(
      scan(
        "planted.ts",
        'import {\n  type HangarServer,\n  // boots the console\n  startHangarServer,\n} from "@crewhaus/hangar-server";\n',
      ).violations,
    ).toEqual([]);
    expect(
      scan("planted.ts", 'import type { HangarServerOptions } from "@crewhaus/hangar-server";\n')
        .violations,
    ).toEqual([]);
  });
});
