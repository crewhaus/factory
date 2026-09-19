import { describe, expect, test } from "bun:test";
/**
 * The registry-consistency floor.
 *
 * `@crewhaus/tool-categories` is data-only and cannot prove that a key it
 * lists resolves to a real tool — it must not import a tool package, because
 * the compiler imports it and codegen has to stay offline. This file CAN
 * import both sides, so it is where the two are held together:
 *
 *   (1) every key in the category registry is a real builtin, and
 *   (2) every builtin is categorized, in exactly one leaf category.
 *
 * Adding a builtin without categorizing it fails (2). Listing a tool that
 * does not exist fails (1). Either way the failure names the key.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TOOL_MAP } from "@crewhaus/target-cli";
import {
  CATEGORIES,
  allRegisteredTools,
  categoriesForTool,
  leafCategories,
  toolsInCategory,
} from "@crewhaus/tool-categories";
import { isPrivateIp } from "@crewhaus/tool-fetch";
import { CLI_RUNTIME_TOOL_KEYS, buildCategoryRows, diffToolMapKeys } from "./tools-cli";

describe("category registry vs. the real builtin set", () => {
  test("every categorized key is a real builtin", () => {
    const unknown = allRegisteredTools().filter((k) => !CLI_RUNTIME_TOOL_KEYS.includes(k));
    expect(unknown).toEqual([]);
  });

  test("every builtin is categorized", () => {
    const uncategorized = CLI_RUNTIME_TOOL_KEYS.filter((k) => categoriesForTool(k).length === 0);
    expect(uncategorized).toEqual([]);
  });

  test("the two sets are exactly equal", () => {
    const { onlyInA, onlyInB } = diffToolMapKeys(allRegisteredTools(), CLI_RUNTIME_TOOL_KEYS);
    expect({ onlyInA, onlyInB }).toEqual({ onlyInA: [], onlyInB: [] });
  });

  test("each builtin lives in exactly one LEAF category", () => {
    const multiHomed: Array<{ key: string; leaves: string[] }> = [];
    for (const key of CLI_RUNTIME_TOOL_KEYS) {
      const leaves = leafCategories().filter((c) => (CATEGORIES[c]?.tools ?? []).includes(key));
      if (leaves.length !== 1) multiHomed.push({ key, leaves });
    }
    expect(multiHomed).toEqual([]);
  });

  test("a roll-up never contradicts its leaves", () => {
    // Every tool a roll-up claims must come from a leaf it actually includes.
    for (const name of Object.keys(CATEGORIES)) {
      const def = CATEGORIES[name];
      if (def?.includes === undefined) continue;
      const fromLeaves = new Set(def.includes.flatMap((c) => toolsInCategory(c)));
      for (const key of toolsInCategory(name)) {
        expect(fromLeaves.has(key)).toBe(true);
      }
    }
  });
});

describe("buildCategoryRows", () => {
  test("rows carry the all- selector an operator writes", () => {
    const rows = buildCategoryRows(CATEGORIES, toolsInCategory);
    const fs = rows.find((r) => r.name === "fs");
    expect(fs?.selector).toBe("all-fs");
    expect(fs?.kind).toBe("leaf");
    expect(fs?.tools).toContain("read");
  });

  test("leaves sort before roll-ups", () => {
    const rows = buildCategoryRows(CATEGORIES, toolsInCategory);
    const firstRollUp = rows.findIndex((r) => r.kind === "roll-up");
    const lastLeaf = rows.map((r) => r.kind).lastIndexOf("leaf");
    expect(lastLeaf).toBeLessThan(firstRollUp);
  });

  test("a roll-up reports what it includes", () => {
    const rows = buildCategoryRows(CATEGORIES, toolsInCategory);
    const code = rows.find((r) => r.name === "code");
    expect(code?.kind).toBe("roll-up");
    expect(code?.includes).toContain("fs");
    expect(code?.tools.length).toBeGreaterThan(
      (rows.find((r) => r.name === "fs")?.tools ?? []).length,
    );
  });

  test("every row has a non-empty title and at least one tool", () => {
    for (const row of buildCategoryRows(CATEGORIES, toolsInCategory)) {
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.tools.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The gap the checks above cannot see.
 *
 * Everything above compares the category registry against
 * `CLI_RUNTIME_TOOL_KEYS`. Both are hand-maintained lists, so if a tool is
 * left out of BOTH they agree with each other and say nothing is wrong. That
 * happened: `base64Encode` and `base64Decode` existed in tool-encode, passed
 * their own tests, and were unreachable from any spec because a key-extraction
 * regex excluded digits.
 *
 * This asserts against the packages themselves rather than against another
 * list: every tool a deterministic package EXPORTS must be registered. A tool
 * that exists but cannot be switched on is not shipped.
 */
describe("every exported tool is reachable from a spec", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");

  /**
   * Every `tool-*` package on disk, not a list of them.
   *
   * This WAS a hand-maintained array of seventeen names, which made it the
   * very thing it exists to catch: a second list that drifts. By the time it
   * was noticed the repository held 92 tool packages, so the guard covered
   * under a fifth of them and passed loudly while saying nothing about the
   * rest — a package could be built, exported and never wired, and this test
   * would still be green. Reading the directory cannot fall behind.
   */
  const PACKAGES = readdirSync(join(repoRoot, "packages"))
    .filter((name) => name.startsWith("tool-"))
    .filter((name) => existsSync(join(repoRoot, "packages", name, "src", "index.ts")))
    .sort();

  /**
   * The guard's own hit count.
   *
   * A sweep that matches nothing passes. Both halves are asserted: that the
   * directory walk found packages, and that the export regex actually matched
   * inside them. If `RegisteredTool` is ever renamed, or the entrypoint moves,
   * these fail HERE — with the reason — instead of leaving the check above
   * silently vacuous.
   */
  test("the sweep actually reads the packages it claims to", () => {
    expect(PACKAGES.length).toBeGreaterThanOrEqual(80);
    expect(PACKAGES).toContain("tool-verify");
    expect(PACKAGES).toContain("tool-notify");
    expect(PACKAGES).toContain("tool-math");
    let exportsSeen = 0;
    for (const pkg of PACKAGES) {
      const text = readFileSync(join(repoRoot, "packages", pkg, "src", "index.ts"), "utf-8");
      exportsSeen += [...text.matchAll(/^export const ([A-Za-z0-9_]+): RegisteredTool/gm)].length;
    }
    expect(exportsSeen).toBeGreaterThanOrEqual(400);
  });

  /**
   * The packages a spec reaches through a different target, not through
   * `target-cli`'s builtin map.
   *
   * Four of the 92 export a `RegisteredTool` that is deliberately absent from
   * `BUILTIN_TOOL_MAP`: the chain-call pair and the message channel are
   * emitted by `target-graph`, `target-crew`, `target-workflow` and the
   * cf-worker targets, and `Retrieve` is registered programmatically per
   * corpus by `apps/cli/src/knowledge-ingest.ts`. Naming them is unavoidable;
   * leaving the name unchecked is not, so the test below re-derives the reason
   * each one is here. An exemption whose justification stops being true fails
   * rather than going on exempting.
   */
  const REACHED_BY_ANOTHER_TARGET: Readonly<Record<string, string>> = {
    "tool-evm": "target-graph, target-crew and target-workflow emit it",
    "tool-evm-tx": "target-graph, target-crew and target-workflow emit it",
    "tool-message-channel": "the channel-bot and cf-worker targets emit it",
    "tool-retrieve": "apps/cli/src/knowledge-ingest.ts registers it per corpus",
  };

  const exportNames = new Set(
    Object.values(BUILTIN_TOOL_MAP).map((entry) => (entry as { export: string }).export),
  );

  test("every exemption still has the reason it was granted for", () => {
    const targets = readdirSync(join(repoRoot, "packages")).filter((n) => n.startsWith("target-"));
    expect(targets.length).toBeGreaterThanOrEqual(5);
    for (const pkg of Object.keys(REACHED_BY_ANOTHER_TARGET)) {
      // Still a package, and still exporting something — an exemption for a
      // package that has been deleted or emptied is dead weight.
      const entry = join(repoRoot, "packages", pkg, "src", "index.ts");
      expect(existsSync(entry)).toBe(true);
      expect(PACKAGES).toContain(pkg);

      // And still reached: some OTHER package that emits or registers tools
      // imports it by name. `tool-retrieve` is the one reached from the CLI
      // itself rather than from a target, so both places are searched.
      const importers: string[] = [];
      for (const other of [...targets.map((t) => join("packages", t, "src")), "apps/cli/src"]) {
        const dir = join(repoRoot, other);
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".ts") || file.includes(".test.")) continue;
          if (readFileSync(join(dir, file), "utf-8").includes(`@crewhaus/${pkg}`)) {
            importers.push(join(other, file));
          }
        }
      }
      expect(
        importers.length,
        `${pkg} is exempt because ${REACHED_BY_ANOTHER_TARGET[pkg]}, and nothing imports it any more`,
      ).toBeGreaterThan(0);

      // And still NEEDS the exemption. "Some target imports it" is true of
      // nearly every tool package, so on its own it would let a name sit here
      // for ever. This is the tight half: an exempt package's tools must
      // actually be absent from the builtin map. The moment one is wired
      // properly, the exemption is dead weight and this says so — which is
      // also what stops a package being parked here to silence the sweep.
      const wiredHere = [
        ...readFileSync(entry, "utf-8").matchAll(/^export const ([A-Za-z0-9_]+): RegisteredTool/gm),
      ]
        .map((m) => m[1] as string)
        .filter((name) => CLI_RUNTIME_TOOL_KEYS.includes(name) || exportNames.has(name));
      expect(wiredHere.length).toBeGreaterThanOrEqual(0);
      expect(
        wiredHere,
        `${pkg} is listed as reached by another target, but ${wiredHere.join(", ")} is wired into the builtin map — drop it from REACHED_BY_ANOTHER_TARGET so the sweep covers this package`,
      ).toEqual([]);
    }
  });

  test("no package exports a tool that is not wired", () => {
    const unreachable: Array<{ pkg: string; tool: string }> = [];
    // Every `export const <name>: RegisteredTool` in the package entrypoint.
    // A tool whose natural name collides with a library function in its own
    // module is exported under a suffix, so the spec key and the export name
    // can differ; resolve through the emitter map rather than assuming they
    // match, and treat an export no key points at as unreachable.
    const exportsWired = new Set(
      Object.values(BUILTIN_TOOL_MAP).map((entry) => (entry as { export: string }).export),
    );
    for (const pkg of PACKAGES) {
      if (pkg in REACHED_BY_ANOTHER_TARGET) continue;
      const text = readFileSync(join(repoRoot, "packages", pkg, "src", "index.ts"), "utf-8");
      for (const m of text.matchAll(/^export const ([A-Za-z0-9_]+): RegisteredTool/gm)) {
        const name = m[1] as string;
        if (!CLI_RUNTIME_TOOL_KEYS.includes(name) && !exportsWired.has(name)) {
          unreachable.push({ pkg, tool: name });
        }
      }
    }
    expect(unreachable).toEqual([]);
  });
});

/**
 * Path containment is implemented once and copied, so it can drift.
 *
 * Every package that takes a path from a caller carries its own copy of the
 * resolver. They started as copies of one another, and one of them was found
 * admitting a DANGLING symlink: `existsSync` follows links, so a link whose
 * target does not exist yet reads as "missing", the walk steps past it, and
 * the link's own name is re-appended to the resolved root — where it passes
 * the containment check. A write through that name then lands wherever the
 * link points.
 *
 * The behavioural test for this lives in
 * `packages/tool-fsx/src/dangling.test.ts`. It can only cover one copy, so
 * this asserts the others did not drift back to the unsafe probe.
 *
 * Copies are found by WHAT THEY CONTAIN, not by filename. The earlier version
 * of this test looked only at `src/paths.ts` and `continue`d past anything
 * else, so it silently skipped every package that keeps its resolver
 * somewhere else — `tool-fs` and `tool-image` in `index.ts`, `tool-proc` in
 * `safe-path.ts`, `tool-git` in `git-run.ts` — which is exactly where the
 * unsafe probe survived. A guard that inspects nothing passes, so the count
 * is asserted too.
 */
describe("every copy of the path resolver probes with lstat, not existsSync", () => {
  /** Files that implement the walk-up-to-an-existing-ancestor resolver. */
  function resolverFiles(): Array<{ pkg: string; file: string; text: string }> {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const pkgDir = join(repoRoot, "packages");
    const found: Array<{ pkg: string; file: string; text: string }> = [];
    // EVERY package, not just `tool-*`. Scoping this sweep to tool packages
    // is the same blind spot as scoping it to `paths.ts`: `packages/crawler`
    // carries its own copy of the resolver (it checks against a list of
    // allowed roots rather than one workspace root) and was the last one
    // still walking with `existsSync`, precisely because nothing looked.
    for (const pkg of readdirSync(pkgDir)) {
      const srcDir = join(pkgDir, pkg, "src");
      if (!existsSync(srcDir)) continue;
      for (const entry of readdirSync(srcDir)) {
        if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
        const file = join(srcDir, entry);
        const text = readFileSync(file, "utf-8");
        // The signature of the resolver: a loop that walks up while the
        // component is not there. Any probe name counts — the point is to
        // find the walk, then judge what it probes WITH.
        if (/while \(!\w+\(probe\)\)/.test(text)) found.push({ pkg, file: entry, text });
      }
    }
    return found;
  }

  test("no copy walks with existsSync, and each follows a dangling link by hand", () => {
    const copies = resolverFiles();
    const offenders: Array<{ pkg: string; file: string; why: string }> = [];
    for (const { pkg, file, text } of copies) {
      // `existsSync` may appear in a comment explaining why it is wrong, or
      // as a genuine "does this really exist" check elsewhere in the file;
      // what matters is that nothing WALKS with it.
      if (/while \(!existsSync\(/.test(text)) {
        offenders.push({ pkg, file, why: "walks with existsSync" });
      }
      if (!text.includes("lstatSync")) {
        offenders.push({ pkg, file, why: "does not probe with lstat" });
      }
      if (!text.includes("readlinkSync")) {
        offenders.push({ pkg, file, why: "cannot follow a dangling link, so it over-refuses" });
      }
      // The second defect in the same hop: a RELATIVE link target must be
      // resolved against the directory that really CONTAINS the link, not
      // against its lexical parent. They differ when that parent is itself a
      // symlink, and the lexical reading then names an in-root path the
      // caller's path does not lead to — so the operation lands somewhere
      // else inside the workspace, or a legitimate link is refused.
      if (/resolve\(\s*(path\.)?dirname\(probe\)\s*,/.test(text)) {
        offenders.push({
          pkg,
          file,
          why: "resolves a relative link target against the lexical parent",
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the sweep actually finds the copies it is meant to guard", () => {
    // Without this, renaming or moving a resolver makes the test above pass
    // by inspecting nothing — which is how the unsafe probe survived in five
    // packages while this file reported green. The floor and the named list
    // are both load-bearing: the floor catches a copy that disappears from
    // the sweep, the list catches the ones that do not follow the filename
    // or the `tool-` prefix convention.
    const copies = resolverFiles();
    const pkgs = [...new Set(copies.map((c) => c.pkg))].sort();
    expect(copies.length).toBeGreaterThanOrEqual(17);
    // The ones that do NOT use the conventional paths.ts filename are the
    // ones a filename-based sweep loses, so name them explicitly.
    for (const pkg of [
      "tool-fs",
      "tool-image",
      "tool-document-ingest",
      "tool-proc",
      "tool-git",
      "crawler",
    ]) {
      expect(pkgs).toContain(pkg);
    }
  });
});

describe("the CLI can actually load every tool package it names", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");

  /** Every `@crewhaus/tool-*` the CLI dynamically imports in loadToolMap. */
  function importedPackages(): string[] {
    const text = readFileSync(join(REPO, "apps/cli/src/index.ts"), "utf-8");
    const found = text.matchAll(/import\("(@crewhaus\/tool-[a-z0-9-]+)"\)/g);
    return [...new Set([...found].map((m) => m[1] as string))].sort();
  }

  test("the sweep finds the imports it is meant to guard", () => {
    expect(importedPackages().length).toBeGreaterThanOrEqual(20);
  });

  test("each one is a declared dependency of apps/cli", () => {
    // A dynamic import of an undeclared workspace package resolves anyway
    // through the hoisted node_modules, so this passes locally and fails
    // only once the CLI is published or installed on its own. The wiring
    // script adds the dependency; when its anchor moved it reported the edit
    // as "already present" instead, and nothing else would have noticed.
    const pkg = JSON.parse(readFileSync(join(REPO, "apps/cli/package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const missing = importedPackages().filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });

  test("each one has a project reference, so tsc builds it first", () => {
    const text = readFileSync(join(REPO, "apps/cli/tsconfig.json"), "utf-8");
    const missing = importedPackages().filter(
      (name) => !text.includes(`../../packages/${name.replace("@crewhaus/", "")}"`),
    );
    expect(missing).toEqual([]);
  });

  test("every builtin's package is one the CLI imports", () => {
    // BUILTIN_TOOL_MAP is what a compiled bundle imports; loadToolMap is what
    // `crewhaus run` imports. A package in the first but not the second is a
    // tool that compiles into a spec and then cannot be run.
    const imported = new Set(importedPackages());
    const referenced = new Set(
      Object.values(BUILTIN_TOOL_MAP).map((entry) => (entry as { package: string }).package),
    );
    const unrunnable = [...referenced].filter(
      (p) => p.startsWith("@crewhaus/tool-") && !imported.has(p),
    );
    expect(unrunnable).toEqual([]);
  });
});

describe("every copy of the private-address classifier is the same classifier", () => {
  /**
   * Ten packages guard an outbound request against a private destination, and
   * each carries the classifier as a byte-identical block rather than importing
   * it — these are otherwise independent per-package networking layers, and a
   * guard proving the copies are identical is cheaper than the import graph a
   * shared package would need across `crawler`, `computer-use-driver` and eight
   * tools.
   *
   * That only works if something checks. On 2026-09-18 an audit of the copies
   * found SIX confirmed exploitable — each with a runnable proof — because they
   * had drifted into comparing address TEXT. `new URL()` rewrites
   * `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, so a text check never
   * sees the spelling it was written for, and `64:ff9b::a9fe:a9fe` IS
   * 169.254.169.254 wherever DNS64/NAT64 runs. One copy parsed numerically and
   * was still exploitable, because it knew `64:ff9b::/96` and not the
   * `64:ff9b:1::/48` variant.
   */
  const MARKER_START = "// BEGIN SYNCHRONISED BLOCK";
  const MARKER_END = "// END SYNCHRONISED BLOCK";

  /**
   * RECURSIVE on purpose. The sibling resolver guard above walks only
   * `packages/<pkg>/src/*.ts`, and this block also lives at
   * `tool-chainread/src/lib/endpoint.ts` — one level deeper. A sweep that
   * stops at the first level would miss it and still report green, which is
   * how the resolver guard went vacuous twice.
   */
  function classifierCopies(): Array<{ pkg: string; file: string; block: string }> {
    const pkgDir = join(import.meta.dir, "..", "..", "..", "packages");
    const found: Array<{ pkg: string; file: string; block: string }> = [];
    const walk = (pkg: string, dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(pkg, full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        const text = readFileSync(full, "utf-8");
        const from = text.indexOf(MARKER_START);
        if (from === -1) continue;
        const to = text.indexOf(MARKER_END, from);
        // A start marker with no end is a truncated block, not an absent one.
        expect(to).toBeGreaterThan(from);
        found.push({ pkg, file: full, block: text.slice(from, to + MARKER_END.length) });
      }
    };
    for (const pkg of readdirSync(pkgDir)) {
      const src = join(pkgDir, pkg, "src");
      if (existsSync(src)) walk(pkg, src);
    }
    return found;
  }

  test("the sweep finds every copy it is meant to guard", () => {
    const copies = classifierCopies();
    // The count assertion is the line that turns "passed" into "actually
    // looked". Without it, a rename or a moved file silently shrinks the sweep
    // to nothing and this whole describe reports green over an empty set.
    expect(copies.length).toBeGreaterThanOrEqual(10);
    // And the specific packages, because a count alone survives one copy
    // disappearing while an unrelated one is added.
    const pkgs = new Set(copies.map((c) => c.pkg));
    for (const required of [
      "computer-use-driver",
      "crawler",
      "tool-chainread",
      "tool-codehost",
      "tool-fetch",
      "tool-http",
      "tool-navigate",
      "tool-notify",
      "tool-obs",
      "tool-web",
    ]) {
      expect({ required, present: pkgs.has(required) }).toEqual({ required, present: true });
    }
  });

  test("every copy is byte-identical", () => {
    const copies = classifierCopies();
    const distinct = new Map<string, string[]>();
    for (const { file, block } of copies) {
      const existing = distinct.get(block);
      if (existing) existing.push(file);
      else distinct.set(block, [file]);
    }
    // One distinct block, or the failure names which files disagree.
    expect([...distinct.values()].map((files) => files.length).sort((a, b) => b - a)).toEqual([
      copies.length,
    ]);
  });

  /**
   * RUN the classifier rather than reading it.
   *
   * The first version of this test asserted the block's TEXT — that it
   * contained `g[0] === 0x64 && g[1] === 0xff9b`, and so on. Mutation-testing
   * it showed that was worthless: narrowing the NAT64 arm to
   * `g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0` — which reopens the
   * `64:ff9b:1::/48` hole that shipped exploitable — STILL CONTAINS that
   * substring, so the assertion passed over a broken classifier in all ten
   * copies at once. Matching on text was the original bug; asserting on text
   * reproduced it in the guard.
   *
   * Executing one copy plus proving the copies identical covers all of them.
   */
  const MUST_BE_PRIVATE = [
    "169.254.169.254", // the metadata service, plainly
    "2852039166", // ...as a packed integer
    "0xA9FEA9FE", // ...as hex
    "0251.0376.0251.0376", // ...as octal
    "127.1", // inet_aton short form
    "::ffff:169.254.169.254", // IPv4-mapped, dotted
    "::ffff:a9fe:a9fe", // what `new URL()` turns the line above into
    "0:0:0:0:0:ffff:a9fe:a9fe", // ...uncompressed, which a CONNECT target keeps
    "64:ff9b::a9fe:a9fe", // NAT64 /96 — this IS 169.254.169.254 under DNS64
    "64:ff9b:1::a9fe:a9fe", // NAT64 /48 — the variant that shipped exploitable
    "::a9fe:a9fe", // IPv4-compatible, deprecated but still routed
    "2002:a9fe:a9fe::", // 6to4
    "127.0.0.1",
    "::1",
    "0:0:0:0:0:0:0:1", // loopback uncompressed — tunnelled a real proxy
    "fe80::1",
    "febf::1", // still fe80::/10; a `startsWith("fe80:")` check misses it
    "fd00::1",
    "::",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1", // carrier-grade NAT
    "198.18.0.1", // benchmarking
    "224.0.0.1", // multicast
    "255.255.255.255",
    "0.0.0.0",
  ];
  const MUST_STAY_PUBLIC = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ];

  test("the shared classifier, executed, blocks every spelling and over-blocks none", () => {
    const leaked = MUST_BE_PRIVATE.filter((host) => !isPrivateIp(host));
    expect(leaked).toEqual([]);
    // Over-blocking is the other failure: a guard that refuses the real
    // internet is removed by whoever it blocks, and then nothing guards.
    const overBlocked = MUST_STAY_PUBLIC.filter((host) => isPrivateIp(host));
    expect(overBlocked).toEqual([]);
  });
});
