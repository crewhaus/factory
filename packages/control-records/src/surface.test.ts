/**
 * What this package may depend on and what its shapes may be called. It must stay safe
 * to import into a compiled daemon: no process, no socket, no package-relative read.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { isCredentialKey } from "@crewhaus/spec-patch";
import { ensureDigestKey, readDigestKey } from "./digest";
import * as api from "./index";
import { acquireMutatingLease } from "./lease";
import { appendClaim, publishClaim } from "./ledger";
import { dropSegmentsBefore } from "./retention";
import { _setRollBytesForTest } from "./segments";
import { controlFile, jsonLine, plant, removeTempDirs, runsLedger, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const SRC = import.meta.dir;
const isTestSource = (name: string): boolean =>
  name.endsWith(".test.ts") || name === "test-helpers.ts";
const SOURCES = readdirSync(SRC)
  .filter((name) => name.endsWith(".ts") && !isTestSource(name))
  .map((name) => ({ name, text: readFileSync(join(SRC, name), "utf8") }));

const NAMED_PACKAGES = new Set([
  "@crewhaus/control-contract",
  "@crewhaus/infra-utils",
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

  test("the scan really reads the sources", () => {
    expect(SOURCES.length).toBe(19);
    expect(imports.length).toBeGreaterThan(40);
    expect(imports.some((i) => i.path === "node:fs")).toBe(true);
    expect(imports.some((i) => i.path === "@crewhaus/tool-safety/fs")).toBe(true);
  });

  test("only Node built-ins and the three named packages, and no refused built-in", () => {
    const refused: string[] = [];
    for (const { from, path } of imports) {
      if (path.startsWith("./")) continue;
      const allowed =
        NAMED_PACKAGES.has(path) || (BUILTINS.has(path) && !REFUSED_BUILTINS.has(path));
      if (!allowed) refused.push(`${from}: ${path}`);
    }
    expect(refused).toEqual([]);
  });

  test("the root of tool-safety, which re-exports a spawner, is never imported", () => {
    expect(imports.filter((i) => i.path === "@crewhaus/tool-safety")).toEqual([]);
  });

  test("control-contract's schemas, and with them zod, are never imported", () => {
    expect(imports.filter((i) => i.path.endsWith("/schemas") || i.path === "zod")).toEqual([]);
  });

  test("no dynamic import, no spawn, no worker", () => {
    expect(imports.filter((i) => i.kind === "dynamic-import")).toEqual([]);
    for (const { name, text } of SOURCES) {
      for (const banned of ["Bun.spawn", "new Worker", "import(", "require("]) {
        if (text.includes(banned)) throw new Error(`${name} uses ${banned}`);
      }
    }
  });

  test("no record path is made with a recursive mkdir", () => {
    for (const { name, text } of SOURCES) {
      if (/mkdirSync|recursive: true/.test(text))
        throw new Error(`${name} makes a directory itself`);
    }
  });

  test("no environment variable can reach a reader, the verdict or assertRunnable", () => {
    const hits = SOURCES.filter(({ text }) => text.includes("process.env")).map((s) => s.name);
    expect(hits).toEqual([]);
  });
});

describe("what the package exports", () => {
  test("no test seam leaves through the entry point", () => {
    const names = Object.keys(api);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name) => name.startsWith("_"))).toEqual([]);
  });

  test("composition stays internal", () => {
    expect(Object.keys(api)).not.toContain("composeIntake");
  });

  test("exactly the named surface", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "acquireMutatingLease",
        "append",
        "appendClaim",
        "assertRunnable",
        "casAppend",
        "casAppendLocked",
        "controlPaths",
        "createApproverReader",
        "createOperatorReader",
        "createStandingRuleReader",
        "decisionsLedger",
        "deploymentsLedger",
        "dropSegmentsBefore",
        "ensureDigestKey",
        "expireClaim",
        "foldStates",
        "harnessLedger",
        "holderProvablyDead",
        "intakeVerdict",
        "LOCAL_ACTOR_LABEL",
        "PROPOSAL_TTL_MS",
        "keyedDigest",
        "operatorVerdict",
        "proposalOf",
        "proposalState",
        "publishClaim",
        "readApproverProjection",
        "readClaim",
        "readDeployments",
        "readDigestKey",
        "readHarnessIdentity",
        "readMutatingLease",
        "readOperatorRecord",
        "readPage",
        "readProposals",
        "readStandingRules",
        "readTail",
        "resume",
        "ruleIsLive",
        "snapshotAt",
        "standingRuleOf",
        "standingRulesLedger",
        "storedLocalActor",
        "withLedgerLock",
        "withMutatingLease",
        "writeHarnessIdentity",
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

describe("no field name is one the masker would redact", () => {
  function fieldNames(value: unknown, into: Set<string>): void {
    if (Array.isArray(value)) {
      for (const item of value) fieldNames(item, into);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        into.add(key);
        fieldNames(inner, into);
      }
    }
  }

  test("every shape this package writes or answers", async () => {
    _setRollBytesForTest(1);
    try {
      const root = tempDir();
      const ledger = runsLedger(root);
      const names = new Set<string>();
      const read = (rel: string): unknown =>
        JSON.parse(readFileSync(controlFile(root, rel), "utf8"));
      const claim = publishClaim(ledger, "idem/one", { id: "x" });
      fieldNames(claim, names);
      fieldNames(read("claims/idem/one.json"), names);
      fieldNames(await appendClaim(ledger, { claim: "idem/two", record: { id: "y" } }), names);
      fieldNames(await appendClaim(ledger, { claim: "idem/two", record: { id: "y" } }), names);
      fieldNames(await api.casAppend(ledger, "z", null, { state: "a" }), names);
      fieldNames(await api.casAppend(ledger, "z", "wrong", { state: "a" }), names);
      fieldNames(api.foldStates(ledger), names);
      await dropSegmentsBefore(ledger, 2);
      fieldNames(read("runs/watermark.json"), names);
      fieldNames(api.controlPaths(root), names);
      fieldNames(ledger, names);
      fieldNames(api.readPage(ledger, { limit: 1 }), names);
      const resumed = api.resume(
        { runs: ledger },
        { runs: [{ seg: 1, off: 0, tail: "" }] },
        {
          maxLines: 100,
          maxBytes: 4096,
        },
      );
      fieldNames(resumed, names);
      fieldNames(api.snapshotAt({ runs: ledger }), names);
      fieldNames(api.readTail(root, "missing", { maxLines: 1, maxBytes: 1 }), names);

      const held = await acquireMutatingLease(
        root,
        { head: "cli", kind: "eval" },
        {
          probe: { isAlive: () => true, startTimeMs: () => 1 },
        },
      );
      fieldNames(read("leases/mutating.json"), names);
      fieldNames(held, names);
      fieldNames(
        await acquireMutatingLease(root, { head: "cli", kind: "eval" }, { waitMs: 0 }),
        names,
      );
      fieldNames(api.readMutatingLease(root), names);

      await ensureDigestKey(root);
      fieldNames(await readDigestKey(root), names);

      plant(
        controlFile(root, "operator.json"),
        jsonLine({
          v: 1,
          rev: 1,
          desired: "running",
          intake: { paused: true, since: "s", by: "b", reason: "r", notice: "n", cmd: "c" },
          deployment: { disabled: true, since: "s", by: "b", reason: "r", cmd: "c" },
        }),
      );
      const operator = api.createOperatorReader()(root);
      fieldNames(operator, names);
      fieldNames(api.operatorVerdict(operator), names);
      const closed = api.intakeVerdict(root, { read: api.createOperatorReader() });
      fieldNames(closed, names);
      fieldNames(
        api.assertRunnable(root, { mode: "run", read: api.createOperatorReader() }),
        names,
      );

      plant(controlFile(root, "approvers.json"), "not a projection");
      fieldNames(api.createApproverReader()(root), names);

      plant(controlFile(root, "operator.json"), "torn");
      fieldNames(api.intakeVerdict(root, { read: api.createOperatorReader() }), names);

      // Each expected name is really in the walk, so the assertion below can fail.
      for (const name of [
        "digestKeyFile",
        "hmac",
        "leaseRef",
        "startedAt",
        "notice",
        "detail",
        "reasons",
        "snapshotAt",
        "tail",
        "lock",
        "claims",
      ]) {
        expect(names.has(name)).toBe(true);
      }
      expect(names.size).toBeGreaterThan(40);
      expect([...names].filter((name) => isCredentialKey(name))).toEqual([]);
    } finally {
      _setRollBytesForTest(undefined);
    }
  });

  test("the check itself recognises the names it must refuse", () => {
    expect(isCredentialKey("digestKey")).toBe(true);
    expect(isCredentialKey("leaseToken")).toBe(true);
  });
});
