/**
 * What this package may depend on, and what it exports. The compiled `crewhaus` binary
 * carries it, so it spawns nothing, opens no socket and reads no file of its own package.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import * as api from "./index";

const SRC = import.meta.dir;
const isTestSource = (name: string): boolean =>
  name.endsWith(".test.ts") || name === "test-helpers.ts";
const SOURCES = readdirSync(SRC)
  .filter((name) => name.endsWith(".ts") && !isTestSource(name))
  .map((name) => ({ name, text: readFileSync(join(SRC, name), "utf8") }));

const NAMED = new Set([
  "@crewhaus/control-contract",
  "@crewhaus/control-records",
  "@crewhaus/tool-safety/fs",
]);
const REFUSED_BUILTINS = new Set([
  "node:child_process",
  "node:worker_threads",
  "node:cluster",
  "node:net",
  "node:tls",
  "node:dgram",
  "node:dns",
  "node:http",
  "node:https",
  "node:http2",
]);
const BUILTINS = new Set(
  builtinModules.map((name) => (name.startsWith("node:") ? name : `node:${name}`)),
);

describe("what the sources import", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const imports = SOURCES.flatMap(({ name, text }) =>
    transpiler.scan(text).imports.map((found) => ({ from: name, ...found })),
  );

  test("the scan reads the sources", () => {
    expect(SOURCES.length).toBe(12);
    expect(imports.some((i) => i.path === "@crewhaus/control-records")).toBe(true);
  });

  test("only Node built-ins and the three named packages, no refused built-in", () => {
    const refused = imports
      .filter(({ path }) => !path.startsWith("./"))
      .filter(
        ({ path }) => !(NAMED.has(path) || (BUILTINS.has(path) && !REFUSED_BUILTINS.has(path))),
      )
      .map(({ from, path }) => `${from}: ${path}`);
    expect(refused).toEqual([]);
  });

  test("never the root of tool-safety, never zod or the schemas, never a dynamic import", () => {
    expect(imports.filter((i) => i.path === "@crewhaus/tool-safety")).toEqual([]);
    expect(imports.filter((i) => i.path.endsWith("/schemas") || i.path === "zod")).toEqual([]);
    expect(imports.filter((i) => i.kind === "dynamic-import")).toEqual([]);
    for (const { name, text } of SOURCES) {
      for (const banned of [
        "Bun.spawn",
        "new Worker",
        "import(",
        "require(",
        "process.env",
        "import.meta",
      ]) {
        if (text.includes(banned)) throw new Error(`${name} uses ${banned}`);
      }
    }
  });
});

describe("what the package exports", () => {
  test("exactly the named surface, and no test seam", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "INVITE_TTL_MS",
        "SERVICE_TOKEN_TTL_MS",
        "authorize",
        "effectiveRole",
        "ensureAccessSetUp",
        "listInvites",
        "listMembers",
        "listTokens",
        "loadAccessSnapshot",
        "localActorOf",
        "localPrincipalOf",
        "mintIssuedSecret",
        "openAccess",
        "redeemInvite",
      ].sort(),
    );
  });

  test("every export's docblock names its first consumer", () => {
    const text = SOURCES.map((s) => s.text).join("\n");
    const missing: string[] = [];
    for (const name of Object.keys(api)) {
      const declared = new RegExp(
        `/\\*\\*(?:(?!\\*/)[\\s\\S])*?\\*/\\s*export (?:async )?(?:function|const) ${name}\\b`,
      );
      const block = declared.exec(text)?.[0] ?? "";
      if (!/First consumers?:/.test(block)) missing.push(name);
    }
    expect(missing).toEqual([]);
  });
});
