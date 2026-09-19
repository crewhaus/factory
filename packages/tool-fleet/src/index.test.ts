/**
 * The five tools, driven against real directories, a real registry file and a
 * real job ledger.
 *
 * Every test builds a throwaway workspace under the OS temp dir and chdir's
 * into it, because the containment root is `process.cwd()`. The machine-wide
 * roots are pointed at that same temp tree through `CREWHAUS_REGISTRY_ROOT`
 * and `CREWHAUS_HANGAR_ROOT`, which is how the real thing is configured — no
 * input field can move them. Nothing here writes into the repository, nothing
 * reaches a network address, and the only processes spawned are fixture
 * scripts these tests wrote themselves.
 *
 * What is asserted is WHAT HAPPENED ON DISK, not what the code looks like:
 * after a refused mutation the registry file is byte-for-byte what it was,
 * after a relocate the FILE holds exactly one row with that id, after a hook
 * write the operator's other settings blocks are still in the document, and
 * after a compile the bundle's stamp is re-read rather than inferred from an
 * exit code. A test that only checked the returned JSON would pass for a tool
 * that reported an edit it never made — and for one that made an edit it
 * never reported.
 *
 * The compile tests spawn a fixture CLI and are given an explicit budget: CI
 * is a loaded two-core box. None of them asserts on elapsed time.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { hashSpecSource } from "@crewhaus/harness-supervisor";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  cliVersionPin,
  compileBundle,
  harnessJobStatus,
  harnessRegister,
  hooksManage,
} from "./index";

const MUTATORS = [harnessRegister, compileBundle, hooksManage];
const READERS = [harnessJobStatus, cliVersionPin];
const ALL = [...MUTATORS, ...READERS];

const SPEC = "name: demo\ntarget: cli\nagent:\n  model: claude-sonnet-4-5\n  instructions: hi\n";

const originalCwd = process.cwd();
const originalEnv = { ...process.env };
let tmp: string;
let registryRoot: string;
let hangarRoot: string;
const outside: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-fleet-"));
  process.chdir(tmp);
  // `process.cwd()` resolves symlinks (on macOS the temp dir is under
  // /private), and the containment root is the resolved one.
  tmp = process.cwd();
  registryRoot = path.join(tmp, "machine-registry");
  hangarRoot = path.join(tmp, "machine-hangar");
  process.env["CREWHAUS_REGISTRY_ROOT"] = registryRoot;
  process.env["CREWHAUS_HANGAR_ROOT"] = hangarRoot;
  // `Reflect.deleteProperty`, never `process.env.X = undefined`: assigning
  // undefined to an env var stores the literal string "undefined", which the
  // registry would read as a truthy opt-out value.
  Reflect.deleteProperty(process.env, "CREWHAUS_NO_REGISTRY");
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of ["CREWHAUS_REGISTRY_ROOT", "CREWHAUS_HANGAR_ROOT", "CREWHAUS_NO_REGISTRY"]) {
    const was = originalEnv[key];
    if (was === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = was;
  }
  rmSync(tmp, { recursive: true, force: true });
  for (const dir of outside.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((acc, key) => (acc as Json | undefined)?.[key], value);

async function callRaw(tool: RegisteredTool, input: unknown): Promise<string> {
  return String(await tool.execute(input as never));
}

async function call(tool: RegisteredTool, input: unknown): Promise<Json> {
  const raw = await callRaw(tool, input);
  try {
    return JSON.parse(raw) as Json;
  } catch {
    throw new Error(`expected JSON, got: ${raw}`);
  }
}

function write(rel: string, content: string): string {
  const abs = path.join(tmp, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function outsideDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-fleet-outside-"));
  outside.push(dir);
  return dir;
}

const registryFile = (): string => path.join(registryRoot, "harnesses.json");
const ledgerFile = (): string => path.join(hangarRoot, "jobs.jsonl");

function readRegistry(): { harnesses: Array<Json> } {
  return JSON.parse(readFileSync(registryFile(), "utf8")) as { harnesses: Array<Json> };
}

/** A harness directory with a spec that really parses. */
function harness(rel: string, spec = SPEC): string {
  write(path.join(rel, "crewhaus.yaml"), spec);
  return rel;
}

/** A compiled bundle for `rel`, stamped with `specHash` and `compiledWith`. */
function bundle(rel: string, specHash: string, compiledWith?: string): void {
  write(path.join(rel, "dist", "agent.ts"), "console.log('agent');\n");
  write(
    path.join(rel, "dist", "package.json"),
    `${JSON.stringify(
      {
        name: "crewhaus-compiled-bundle",
        version: "0.0.0",
        crewhaus: {
          specHash,
          ...(compiledWith !== undefined ? { compiledWith } : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * A fixture `crewhaus` at `<rel>/node_modules/.bin/crewhaus`.
 *
 * Inside the workspace on purpose: that is the only place these tools will
 * execute a binary from without `allowExternalCli`, and the fleet's own
 * harness-local CLI is exactly what the supervisor's resolver prefers.
 */
function fakeCli(rel: string, body: string): string {
  const abs = write(path.join(rel, "node_modules", ".bin", "crewhaus"), body);
  chmodSync(abs, 0o755);
  return abs;
}

/** A fixture CLI whose `compile` writes a bundle stamped with `hash`. */
function compilingCli(rel: string, hash: string, version = "9.9.9"): string {
  return fakeCli(
    rel,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "crewhaus ${version}"; exit 0; fi`,
      'out="$4"',
      'mkdir -p "$out"',
      'printf "console.log(1);\\n" > "$out/agent.ts"',
      'cat > "$out/package.json" <<JSON',
      '{ "name": "crewhaus-compiled-bundle", "version": "0.0.0",',
      `  "crewhaus": { "specHash": "${hash}", "compiledWith": "${version}" } }`,
      "JSON",
      "exit 0",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// package-wide claims
// ---------------------------------------------------------------------------

/**
 * The schema's own field names. `JSON.stringify` on a zod object yields `{}`
 * — a guard built on it asserts nothing at all — so the shape is read
 * directly and the field list is asserted non-empty before anything is
 * concluded from it.
 */
function schemaFields(tool: RegisteredTool): string[] {
  const shape = (tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  const fields = Object.keys(shape ?? {}).sort();
  expect({ tool: tool.name, fields: fields.length > 0 }).toEqual({ tool: tool.name, fields: true });
  return fields;
}

test("every mutating tool is destructive, takes a dryRun, and says the default", () => {
  for (const tool of MUTATORS) {
    const fields = schemaFields(tool);
    console.log(`SCHEMA ${tool.name} ${fields.join(",")}`);
    expect({
      name: tool.name,
      destructive: tool.destructive,
      dryRun: fields.includes("dryRun"),
      readOnly: tool.readOnly,
    }).toEqual({ name: tool.name, destructive: true, dryRun: true, readOnly: false });
    expect(tool.description).toContain("dryRun defaults to true");
  }
  for (const tool of READERS) {
    expect({ name: tool.name, readOnly: tool.readOnly, destructive: tool.destructive }).toEqual({
      name: tool.name,
      readOnly: true,
      destructive: false,
    });
  }
});

test("the two tools that spawn a process declare it, and the other three do not", () => {
  const declared = ALL.map((tool) => ({
    name: tool.name,
    scope: tool.scope,
    io: tool.ioCapability,
  })).sort((a, b) => (a.name < b.name ? -1 : 1));
  console.log(`SCOPES ${JSON.stringify(declared)}`);
  // CompileBundle runs `crewhaus compile`; CliVersionPin can run
  // `<bin> --version`. Both cross a process boundary, so the audit in
  // @crewhaus/tool-builder requires scope "external" on them — and the three
  // that only touch files must NOT claim it.
  expect(declared).toEqual([
    { name: "CliVersionPin", scope: "external", io: "process" },
    { name: "CompileBundle", scope: "external", io: "process" },
    { name: "HarnessJobStatus", scope: "internal", io: undefined },
    { name: "HarnessRegister", scope: "internal", io: undefined },
    { name: "HooksManage", scope: "internal", io: undefined },
  ]);
});

test("no schema offers a way around the containment root or the machine roots", () => {
  for (const tool of ALL) {
    const fields = schemaFields(tool);
    for (const field of [
      "cwd",
      "workspaceRoot",
      "registryRoot",
      "hangarRoot",
      "ledgerPath",
      "absolute",
      "followSymlinks",
      "force",
    ]) {
      expect({ tool: tool.name, field, present: fields.includes(field) }).toEqual({
        tool: tool.name,
        field,
        present: false,
      });
    }
  }
});

test("every tool that takes a path refuses one that escapes the workspace, and says why", async () => {
  const escapes: Array<[RegisteredTool, Json]> = [
    [harnessRegister, { action: "register", dir: "../escape", dryRun: false }],
    [compileBundle, { dir: "../escape" }],
    [hooksManage, { action: "list", dir: "../escape" }],
    [harnessJobStatus, { dir: "../escape" }],
    [cliVersionPin, { dirs: ["../escape"] }],
  ];
  for (const [tool, input] of escapes) {
    const r = await call(tool, input);
    const text = JSON.stringify(r);
    console.log(`ESCAPE ${tool.name} -> ${text.slice(0, 120)}`);
    // The REASON, not just a failure: a missing-directory error would also
    // stop the call without proving the boundary held.
    expect(text).toContain("escapes the workspace root");
  }
});

test("a path carrying a NUL byte is refused at the gate, not left to fail as unreadable", async () => {
  harness("h1");
  // A NUL truncates a path at the syscall boundary, so the string the
  // containment check measures and the one `open` acts on can differ.
  const r = await call(hooksManage, { action: "list", dir: "h1\u0000/../../etc" });
  console.log(`NUL ${String(r["reason"]).slice(0, 120)}`);
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("NUL byte");
  // The path is echoed back with the control character neutralised.
  expect(String(r["reason"])).not.toContain("\u0000");
});

// ---------------------------------------------------------------------------
// HarnessRegister
// ---------------------------------------------------------------------------

test("HarnessRegister previews a registration and writes no registry file at all", async () => {
  harness("h1");
  const r = await call(harnessRegister, { action: "register", dir: "h1" });
  console.log(`REGISTER_PREVIEW ${JSON.stringify(r)}`);
  expect(r["status"]).toBe("preview");
  expect(r["dryRun"]).toBe(true);
  expect(r["specName"]).toBe("demo");
  expect(r["target"]).toBe("cli");
  expect(r["nothingWasTouched"]).toBe(true);
  // A preview must not even create the file: the registry is created lazily
  // on the first write, and creating it here would be a write.
  expect(existsSync(registryFile())).toBe(false);
});

test("HarnessRegister registers with the spec's own name and target, and the row lands 0600", async () => {
  harness("h1");
  const r = await call(harnessRegister, { action: "register", dir: "h1", dryRun: false });
  console.log(`REGISTER_APPLIED ${JSON.stringify(r)}`);
  expect(r["status"]).toBe("applied");
  expect(r["created"]).toBe(true);
  expect(r["persisted"]).toBe(true);
  expect(at(r, "entry", "specName")).toBe("demo");
  expect(at(r, "entry", "target")).toBe("cli");
  expect(String(at(r, "entry", "id"))).toMatch(/^hrn_[0-9a-f]{16}$/);

  // On disk, in the file the library owns — with the library's own mode.
  const doc = readRegistry();
  expect(doc.harnesses.length).toBe(1);
  expect(doc.harnesses[0]?.["dir"]).toBe(path.join(tmp, "h1"));
  expect(statSync(registryFile()).mode & 0o777).toBe(0o600);
});

test("HarnessRegister refuses a harness whose spec does not parse, then accepts explicit identity", async () => {
  harness("bad", "name: demo\ntarget: cli\n");
  const refused = await call(harnessRegister, { action: "register", dir: "bad", dryRun: false });
  console.log(`REGISTER_BADSPEC ${String(refused["reason"]).slice(0, 140)}`);
  expect(refused["status"]).toBe("refused");
  expect(String(refused["reason"])).toContain("does not parse");
  // The parser's own first issue, not a generic "invalid spec".
  expect(String(refused["reason"])).toContain("agent");
  expect(existsSync(registryFile())).toBe(false);

  const ok = await call(harnessRegister, {
    action: "register",
    dir: "bad",
    specName: "manual",
    target: "cli",
    dryRun: false,
  });
  expect(ok["status"]).toBe("applied");
  expect(at(ok, "entry", "specName")).toBe("manual");
});

test("HarnessRegister relocates by id: one entry, same id, new directory", async () => {
  harness("old");
  harness("new");
  const created = await call(harnessRegister, { action: "register", dir: "old", dryRun: false });
  const id = String(at(created, "entry", "id"));
  await call(harnessRegister, {
    action: "update",
    id,
    groups: ["fleet"],
    tags: ["keep"],
    notes: "survives a move",
    dryRun: false,
  });

  const preview = await call(harnessRegister, { action: "relocate", id, dir: "new" });
  expect(preview["status"]).toBe("preview");
  expect(readRegistry().harnesses[0]?.["dir"]).toBe(path.join(tmp, "old"));

  const r = await call(harnessRegister, { action: "relocate", id, dir: "new", dryRun: false });
  console.log(`RELOCATE ${JSON.stringify(r)}`);
  expect(r["status"]).toBe("applied");
  expect(r["idPreserved"]).toBe(true);
  // The claim that matters: a registry keyed by PATH answers a relocate by
  // adding a second row, and the count is the only thing that catches it.
  expect(r["entriesWithId"]).toBe(1);
  expect(r["entriesLeftAtOldDir"]).toBe(0);

  const doc = readRegistry();
  expect(doc.harnesses.length).toBe(1);
  expect(doc.harnesses[0]?.["id"]).toBe(id);
  expect(doc.harnesses[0]?.["dir"]).toBe(path.join(tmp, "new"));
  // The user-managed fields travel with the id, not with the path.
  expect(doc.harnesses[0]?.["groups"]).toEqual(["fleet"]);
  expect(doc.harnesses[0]?.["tags"]).toEqual(["keep"]);
  expect(doc.harnesses[0]?.["notes"]).toBe("survives a move");
});

test("HarnessRegister refuses to relocate onto a directory another entry already holds", async () => {
  harness("a");
  harness("b");
  const first = await call(harnessRegister, { action: "register", dir: "a", dryRun: false });
  await call(harnessRegister, { action: "register", dir: "b", dryRun: false });
  const id = String(at(first, "entry", "id"));
  const r = await call(harnessRegister, { action: "relocate", id, dir: "b", dryRun: false });
  console.log(`RELOCATE_CONFLICT ${String(r["reason"]).slice(0, 120)}`);
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("conflict");
  const doc = readRegistry();
  expect(doc.harnesses.length).toBe(2);
  expect(doc.harnesses.find((h) => h["id"] === id)?.["dir"]).toBe(path.join(tmp, "a"));
});

test("HarnessRegister registers a symlinked directory as ONE row, not a second one", async () => {
  harness("real");
  symlinkSync(path.join(tmp, "real"), path.join(tmp, "link"));
  const first = await call(harnessRegister, { action: "register", dir: "real", dryRun: false });
  const second = await call(harnessRegister, { action: "register", dir: "link", dryRun: false });
  console.log(`SYMLINK_REGISTER ${JSON.stringify(second)}`);
  expect(second["status"]).toBe("applied");
  expect(second["created"]).toBe(false);
  expect(at(second, "entry", "id")).toBe(at(first, "entry", "id"));
  expect(readRegistry().harnesses.length).toBe(1);
});

test("HarnessRegister refuses an id that is not an hrn_ id rather than treating it as a path", async () => {
  harness("h1");
  await call(harnessRegister, { action: "register", dir: "h1", dryRun: false });
  const r = await call(harnessRegister, { action: "remove", id: "h1", dryRun: false });
  console.log(`BAD_ID ${String(r["reason"]).slice(0, 140)}`);
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("bad-input");
  expect(String(r["reason"])).toContain("DIRECTORY");
  expect(readRegistry().harnesses.length).toBe(1);
});

test("HarnessRegister removes only the row, and only with dryRun:false", async () => {
  harness("h1");
  const created = await call(harnessRegister, { action: "register", dir: "h1", dryRun: false });
  const id = String(at(created, "entry", "id"));

  const preview = await call(harnessRegister, { action: "remove", id });
  expect(preview["status"]).toBe("preview");
  expect(readRegistry().harnesses.length).toBe(1);

  const r = await call(harnessRegister, { action: "remove", id, dryRun: false });
  console.log(`REMOVE ${JSON.stringify(r)}`);
  expect(r["status"]).toBe("applied");
  expect(r["removed"]).toBe(true);
  expect(r["stillPresent"]).toBe(false);
  expect(readRegistry().harnesses.length).toBe(0);
  // The row went; the harness did not.
  expect(existsSync(path.join(tmp, "h1", "crewhaus.yaml"))).toBe(true);
});

test("HarnessRegister refuses to mutate an unparseable registry, and leaves it byte-for-byte", async () => {
  harness("h1");
  mkdirSync(registryRoot, { recursive: true });
  // Half-written by a crash, or hand-edited. @crewhaus/harness-registry reads
  // it as an EMPTY registry and the next write replaces it wholesale.
  const corrupt = '{ "v": 2, "harnesses": [ { "id": "hrn_00000000000000aa",';
  writeFileSync(registryFile(), corrupt);

  const r = await call(harnessRegister, { action: "register", dir: "h1", dryRun: false });
  console.log(`CORRUPT_REGISTRY ${r["code"]} ${String(r["reason"]).slice(0, 160)}`);
  expect(r["status"]).toBe("refused");
  expect(r["registryFileState"]).toBe("unparseable");
  expect(String(r["reason"])).toContain("not valid JSON");
  expect(String(r["reason"])).toContain("not an empty registry");
  // The whole point: the operator's half-recoverable file is still there.
  expect(readFileSync(registryFile(), "utf8")).toBe(corrupt);
});

test("HarnessRegister lists an unparseable registry as unreadable, never as zero harnesses", async () => {
  mkdirSync(registryRoot, { recursive: true });
  writeFileSync(registryFile(), "not json at all");
  const r = await call(harnessRegister, { action: "list" });
  console.log(`CORRUPT_LIST ${JSON.stringify(r).slice(0, 200)}`);
  expect(r["status"]).toBe("unreadable");
  expect(r["registryFileState"]).toBe("unparseable");
  expect(String(r["reason"])).toContain("NOT an empty registry");
  expect(r["count"]).toBe(0);
  // `count: 0` with `status: "ok"` would be the lie; the status is what a
  // caller has to read, so it says the count means nothing here.
  expect(r["status"]).not.toBe("ok");
});

test("HarnessRegister refuses a write while CREWHAUS_NO_REGISTRY makes writes silent no-ops", async () => {
  harness("h1");
  process.env["CREWHAUS_NO_REGISTRY"] = "1";
  const r = await call(harnessRegister, { action: "register", dir: "h1", dryRun: false });
  console.log(`NO_REGISTRY ${r["code"]} ${String(r["reason"]).slice(0, 120)}`);
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("unavailable");
  expect(r["writesDisabled"]).toBe(true);
  expect(String(r["reason"])).toContain("never persisted");
  expect(existsSync(registryFile())).toBe(false);
});

test("HarnessRegister lists groups, tags and the entries outside the workspace", async () => {
  harness("h1");
  const created = await call(harnessRegister, { action: "register", dir: "h1", dryRun: false });
  const id = String(at(created, "entry", "id"));
  await call(harnessRegister, {
    action: "update",
    id,
    groups: ["core"],
    tags: ["nightly"],
    pinned: true,
    group: "core",
    order: 2,
    dryRun: false,
  });
  // A row for a directory this workspace cannot contain — the normal case
  // for a MACHINE registry, and a path this tool must report without
  // opening.
  const elsewhere = outsideDir();
  const doc = readRegistry();
  doc.harnesses.push({
    ...(doc.harnesses[0] as Json),
    id: "hrn_00000000000000ff",
    dir: elsewhere,
    groups: [],
    tags: [],
    pinned: false,
  });
  writeFileSync(registryFile(), JSON.stringify(doc));

  const r = await call(harnessRegister, { action: "list" });
  console.log(`LIST ${JSON.stringify(r).slice(0, 260)}`);
  expect(r["status"]).toBe("ok");
  expect(r["count"]).toBe(2);
  expect(r["outsideWorkspace"]).toBe(1);
  const mine = (r["entries"] as Json[]).find((e) => e["id"] === id);
  expect(mine?.["groups"]).toEqual(["core"]);
  expect(mine?.["tags"]).toEqual(["nightly"]);
  expect(mine?.["pinned"]).toBe(true);
  expect(mine?.["groupOrder"]).toEqual({ core: 2 });
  expect(mine?.["inWorkspace"]).toBe(true);
  expect((r["entries"] as Json[]).find((e) => e["dir"] === elsewhere)?.["inWorkspace"]).toBe(false);

  const filtered = await call(harnessRegister, { action: "list", filterGroup: "core" });
  expect(filtered["count"]).toBe(1);
});

// ---------------------------------------------------------------------------
// HarnessJobStatus
// ---------------------------------------------------------------------------

function job(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`;
}

function ledger(...lines: string[]): void {
  mkdirSync(hangarRoot, { recursive: true });
  writeFileSync(ledgerFile(), lines.join(""));
}

test("HarnessJobStatus reports an absent ledger as absent, with no jobs and no pretence", async () => {
  const r = await call(harnessJobStatus, {});
  console.log(`JOBS_ABSENT ${JSON.stringify(r)}`);
  expect(r["status"]).toBe("ok");
  expect(r["ledgerState"]).toBe("absent");
  expect(r["recordsInLedger"]).toBe(0);
  expect(r["jobs"]).toEqual([]);
});

test("HarnessJobStatus folds the ledger, counts by state, and keeps a torn last line out", async () => {
  const dir = path.join(tmp, "h1");
  mkdirSync(dir, { recursive: true });
  ledger(
    job({
      jobId: "job_a",
      harnessDir: dir,
      kind: "eval",
      argv: ["crewhaus", "eval"],
      mutating: true,
      state: "pending",
      enqueuedAt: "2026-09-01T10:00:00.000Z",
    }),
    // The same job, later: the fold is last-write-wins per jobId.
    job({ jobId: "job_a", state: "running", startedAt: "2026-09-01T10:00:01.000Z" }),
    job({ jobId: "job_a", state: "done", endedAt: "2026-09-01T10:00:09.000Z", exitCode: 0 }),
    job({
      jobId: "job_b",
      harnessDir: dir,
      kind: "compile",
      argv: ["crewhaus", "compile"],
      mutating: true,
      state: "interrupted",
      enqueuedAt: "2026-09-02T10:00:00.000Z",
    }),
    // A manager appending while we read: the trailing record is half a line.
    '{"jobId":"job_c","harnessDir":"',
  );

  const r = await call(harnessJobStatus, {});
  console.log(`JOBS ${JSON.stringify(r).slice(0, 260)}`);
  expect(r["ledgerState"]).toBe("ok");
  expect(r["recordsInLedger"]).toBe(2);
  expect(r["countsByState"]).toEqual({ done: 1, interrupted: 1 });
  // Newest first.
  expect((r["jobs"] as Json[])[0]?.["jobId"]).toBe("job_b");
  const done = (r["jobs"] as Json[]).find((j) => j["jobId"] === "job_a");
  expect(done?.["state"]).toBe("done");
  expect(done?.["exitCode"]).toBe(0);
  expect(done?.["kind"]).toBe("eval");

  const filtered = await call(harnessJobStatus, { dir: "h1", state: "interrupted" });
  expect(filtered["matched"]).toBe(1);
  expect((filtered["jobs"] as Json[])[0]?.["jobId"]).toBe("job_b");

  const since = await call(harnessJobStatus, { since: "2026-09-02T00:00:00Z" });
  expect(since["matched"]).toBe(1);
});

test("HarnessJobStatus refuses a ledger it cannot open instead of reporting no jobs", async () => {
  // A directory where the ledger should be: the store's reader catches the
  // EISDIR and returns [], which is indistinguishable from an idle fleet.
  mkdirSync(ledgerFile(), { recursive: true });
  const r = await call(harnessJobStatus, {});
  console.log(`JOBS_UNREADABLE ${r["code"]} ${String(r["reason"]).slice(0, 140)}`);
  expect(r["status"]).toBe("refused");
  expect(r["ledgerState"]).toBe("not-a-file");
  expect(String(r["reason"])).toContain("empty list");
});

test("HarnessJobStatus refuses a `since` that is not a timestamp rather than ignoring it", async () => {
  ledger();
  const r = await call(harnessJobStatus, { since: "yesterday" });
  console.log(`JOBS_BADSINCE ${String(r["reason"]).slice(0, 120)}`);
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("ISO 8601");
});

test("HarnessJobStatus keeps a record whose timestamp does not parse, and flags it", async () => {
  const dir = path.join(tmp, "h1");
  ledger(
    job({
      jobId: "job_x",
      harnessDir: dir,
      kind: "eval",
      argv: [],
      mutating: true,
      state: "running",
      enqueuedAt: "not-a-date",
    }),
  );
  const r = await call(harnessJobStatus, { since: "2020-01-01T00:00:00Z" });
  console.log(`JOBS_BADSTAMP ${JSON.stringify(r).slice(0, 200)}`);
  expect(r["matched"]).toBe(1);
  expect(at(r, "unparsedTimestamps", "total")).toBe(1);
});

// ---------------------------------------------------------------------------
// CompileBundle
// ---------------------------------------------------------------------------

test("CompileBundle calls a bundle it cannot judge UNDETERMINED, and refuses to call that success", async () => {
  harness("h1"); // a spec, and no bundle at all
  const preview = await call(compileBundle, { dir: "h1" });
  console.log(`COMPILE_PREVIEW ${JSON.stringify(preview)}`);
  expect(preview["status"]).toBe("preview");
  expect(preview["verdict"]).toBe("undetermined");
  expect(preview["freshness"]).toBe("unknown");
  expect(preview["wouldRecompile"]).toBe(false);
  expect(String(preview["wouldRefuse"])).toContain("compiled nothing");

  const real = await call(compileBundle, { dir: "h1", dryRun: false });
  console.log(`COMPILE_UNDETERMINED ${String(real["reason"]).slice(0, 200)}`);
  expect(real["status"]).toBe("refused");
  expect(String(real["reason"])).toContain("not a fresh one");
  // The remedy names the command and the directory, because compileIfStale
  // will never perform a FIRST compile: it only acts on a stale verdict.
  expect(String(real["reason"])).toContain("crewhaus compile");
  expect(String(real["reason"])).toContain("-o dist");
});

test("CompileBundle reports an unparseable spec as undetermined, not as a missing bundle", async () => {
  harness("h1", "name: demo\ntarget: cli\n");
  const r = await call(compileBundle, { dir: "h1" });
  console.log(`COMPILE_BADSPEC ${JSON.stringify(r)}`);
  expect(r["status"]).toBe("undetermined");
  expect(r["verdict"]).toBe("undetermined");
  expect(String(r["reason"])).toContain("does not parse");
});

test("CompileBundle leaves a stamped, matching bundle alone and says the stamp proved it", async () => {
  harness("h1");
  bundle("h1", hashSpecSource(SPEC), "0.6.0");
  const r = await call(compileBundle, { dir: "h1", dryRun: false });
  console.log(`COMPILE_FRESH ${JSON.stringify(r)}`);
  expect(r["status"]).toBe("unchanged");
  expect(r["verdict"]).toBe("fresh");
  expect(r["exact"]).toBe(true);
  expect(r["compiledWith"]).toBe("0.6.0");
  expect(r["compiled"]).toBe(false);
});

test("CompileBundle recompiles a stale bundle and re-reads the stamp afterwards", async () => {
  harness("h1");
  bundle("h1", "sha256:0000000000000000000000000000000000000000000000000000000000000000", "0.5.2");
  compilingCli("h1", hashSpecSource(SPEC));

  const preview = await call(compileBundle, { dir: "h1" });
  expect(preview["verdict"]).toBe("stale");
  expect(preview["wouldRecompile"]).toBe(true);
  expect(at(preview, "cli", "where")).toBe("harness-local");
  expect(at(preview, "cli", "inWorkspace")).toBe(true);
  // The preview changed nothing: the old stamp is still on disk.
  expect(readFileSync(path.join(tmp, "h1", "dist", "package.json"), "utf8")).toContain("0.5.2");

  const r = await call(compileBundle, { dir: "h1", dryRun: false });
  console.log(`COMPILE_APPLIED ${JSON.stringify(r)}`);
  expect(r["status"]).toBe("applied");
  expect(r["compiled"]).toBe(true);
  // The verdict AFTER the compile, read from the bundle the compile wrote —
  // an exit code of 0 is not evidence that the bundle now matches the spec.
  expect(at(r, "after", "verdict")).toBe("fresh");
  expect(at(r, "after", "exact")).toBe(true);
  expect(at(r, "after", "compiledWith")).toBe("9.9.9");
  expect(readFileSync(path.join(tmp, "h1", "dist", "package.json"), "utf8")).toContain("9.9.9");
}, 30_000);

test("CompileBundle reports a failed compile with its output and leaves the stale bundle in place", async () => {
  harness("h1");
  const oldStamp = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  bundle("h1", oldStamp, "0.5.2");
  fakeCli("h1", ["#!/bin/sh", 'echo "emitter exploded" >&2', "exit 3", ""].join("\n"));
  const r = await call(compileBundle, { dir: "h1", dryRun: false });
  console.log(`COMPILE_FAILED ${JSON.stringify(r)}`);
  expect(r["status"]).toBe("failed");
  expect(r["compiled"]).toBe(false);
  expect(r["stage"]).toBe("compile");
  expect(r["exitCode"]).toBe(3);
  expect(JSON.stringify(r["output"])).toContain("emitter exploded");
  // The bundle that was there is the bundle that is there.
  expect(readFileSync(path.join(tmp, "h1", "dist", "package.json"), "utf8")).toContain(oldStamp);
  expect(at(r, "after", "verdict")).toBe("stale");
}, 30_000);

test("CompileBundle hands the compile a minimal environment, forwarding only what it was asked to", async () => {
  harness("h1");
  bundle("h1", "sha256:2222222222222222222222222222222222222222222222222222222222222222");
  // The fixture CLI prints the environment it received into the bundle it
  // writes, so the assertion is about the child's real env, not about ours.
  fakeCli(
    "h1",
    [
      "#!/bin/sh",
      'out="$4"',
      'mkdir -p "$out"',
      'printf "console.log(1);\\n" > "$out/agent.ts"',
      'env | sort > "$out/env.txt"',
      "exit 0",
      "",
    ].join("\n"),
  );
  process.env["FLEET_SECRET"] = "s3cret";
  process.env["FLEET_WANTED"] = "yes";
  try {
    const r = await call(compileBundle, {
      dir: "h1",
      dryRun: false,
      forwardEnv: ["FLEET_WANTED", "FLEET_ABSENT"],
    });
    console.log(`COMPILE_ENV ${JSON.stringify(r["envForwarded"])}`);
    // Only the names that actually had a value are reported as forwarded.
    expect(r["envForwarded"]).toEqual(["FLEET_WANTED"]);
    const env = readFileSync(path.join(tmp, "h1", "dist", "env.txt"), "utf8");
    expect(env).toContain("FLEET_WANTED=yes");
    expect(env).not.toContain("FLEET_SECRET");
    expect(env).toContain("PATH=");
  } finally {
    Reflect.deleteProperty(process.env, "FLEET_SECRET");
    Reflect.deleteProperty(process.env, "FLEET_WANTED");
  }
}, 30_000);

// ---------------------------------------------------------------------------
// CliVersionPin
// ---------------------------------------------------------------------------

test("CliVersionPin rolls the fleet up by compiledWith and shows the mixed versions", async () => {
  harness("old-one");
  bundle("old-one", hashSpecSource(SPEC), "0.5.2");
  harness("old-two");
  bundle("old-two", hashSpecSource(SPEC), "0.5.2");
  harness("current");
  bundle("current", hashSpecSource(SPEC), "0.6.0");
  harness("never-compiled");

  const r = await call(cliVersionPin, {
    dirs: ["old-one", "old-two", "current", "never-compiled"],
  });
  console.log(`VERSIONS ${JSON.stringify(r).slice(0, 320)}`);
  expect(r["status"]).toBe("ok");
  expect(r["source"]).toBe("input");
  expect(r["count"]).toBe(4);
  expect(r["compiledWith"]).toEqual({
    "0.5.2": 2,
    "0.6.0": 1,
    "unstamped-or-undetermined": 1,
  });
  expect(r["distinctCompiledWith"]).toBe(2);
  expect(r["mixedFleet"]).toBe(true);
  // The harness with no bundle is UNDETERMINED — it is not quietly counted
  // as agreeing with whatever the others are on.
  expect(r["undetermined"]).toBe(1);
  // And the tool says plainly what it cannot do rather than half-doing it.
  expect(JSON.stringify(r["cannotDo"])).toContain("chvm");
});

test("CliVersionPin takes the fleet from the registry and skips rows it cannot contain", async () => {
  harness("mine");
  bundle("mine", hashSpecSource(SPEC), "0.6.0");
  await call(harnessRegister, { action: "register", dir: "mine", dryRun: false });
  const elsewhere = outsideDir();
  writeFileSync(path.join(elsewhere, "crewhaus.yaml"), SPEC);
  const doc = readRegistry();
  doc.harnesses.push({
    ...(doc.harnesses[0] as Json),
    id: "hrn_00000000000000fe",
    dir: elsewhere,
  });
  writeFileSync(registryFile(), JSON.stringify(doc));

  const r = await call(cliVersionPin, {});
  console.log(`VERSIONS_REGISTRY ${JSON.stringify(r).slice(0, 300)}`);
  expect(r["source"]).toBe("registry");
  expect(r["count"]).toBe(1);
  // A path a STORE handed back still has to pass containment before this
  // tool opens a spec or a bundle underneath it.
  expect(JSON.stringify(r["skipped"])).toContain("outside the workspace root");
  expect((r["harnesses"] as Json[])[0]?.["dir"]).toBe("mine");
});

test("CliVersionPin refuses to enumerate a fleet from a registry it could not read", async () => {
  mkdirSync(registryRoot, { recursive: true });
  writeFileSync(registryFile(), "{oops");
  const r = await call(cliVersionPin, {});
  console.log(`VERSIONS_CORRUPT ${String(r["reason"]).slice(0, 140)}`);
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("not an empty one");
});

test("CliVersionPin probes each distinct binary once and reports the PARSED version", async () => {
  harness("a");
  harness("b");
  compilingCli("a", "sha256:unused", "1.2.3");
  const r = await call(cliVersionPin, { dirs: ["a", "b"], probe: true });
  console.log(`PROBE ${JSON.stringify(r["probes"])}`);
  const probes = r["probes"] as Record<string, Json>;
  const binA = path.join(tmp, "a", "node_modules", ".bin", "crewhaus");
  expect(probes[binA]).toEqual({ state: "known", version: "1.2.3" });
  // `b` has no CLI of its own, so the resolver falls through to PATH. On a
  // machine that HAS a crewhaus installed that is a second distinct binary —
  // and it is one this tool refuses to execute, because it sits outside the
  // workspace. Asserted as a property rather than as a count, so the test
  // says the same thing on a machine with no crewhaus on PATH.
  for (const [bin, probe] of Object.entries(probes)) {
    if (bin === binA) continue;
    expect(probe["state"]).toBe("not-probed");
    expect(String(probe["reason"])).toContain("outside the workspace root");
  }
}, 30_000);

test("CliVersionPin reports a version it could not parse as unparsed, not as a version", async () => {
  harness("a");
  fakeCli("a", ["#!/bin/sh", 'echo "crewhaus (development build)"', "exit 0", ""].join("\n"));
  const r = await call(cliVersionPin, { dirs: ["a"], probe: true });
  console.log(`PROBE_UNPARSED ${JSON.stringify(r["probes"])}`);
  const probe = Object.values(r["probes"] as Record<string, Json>)[0];
  expect(probe?.["state"]).toBe("unparsed");
  expect(JSON.stringify(probe?.["output"])).toContain("development build");
}, 30_000);

test("CliVersionPin reports a binary that fails as unknown, with the exit code", async () => {
  harness("a");
  fakeCli("a", ["#!/bin/sh", 'echo "boom" >&2', "exit 7", ""].join("\n"));
  const r = await call(cliVersionPin, { dirs: ["a"], probe: true });
  console.log(`PROBE_FAILED ${JSON.stringify(r["probes"])}`);
  const probe = Object.values(r["probes"] as Record<string, Json>)[0];
  expect(probe?.["state"]).toBe("unknown");
  expect(String(probe?.["reason"])).toContain("7");
}, 30_000);

// ---------------------------------------------------------------------------
// HooksManage
// ---------------------------------------------------------------------------

function hookScript(rel: string, name = "prep.sh"): string {
  const abs = write(path.join(rel, name), "#!/bin/sh\nexit 0\n");
  chmodSync(abs, 0o755);
  return abs;
}

test("HooksManage lists a harness with no settings file without inventing hooks", async () => {
  harness("h1");
  const r = await call(hooksManage, { action: "list", dir: "h1" });
  console.log(`HOOKS_LIST_EMPTY ${JSON.stringify(r)}`);
  expect(r["status"]).toBe("ok");
  expect(r["settingsState"]).toBe("absent");
  expect((r["hooks"] as Json[]).map((h) => h["declared"])).toEqual([false, false]);
  expect(at(r, "timeout", "isDefault")).toBe(true);
  expect(r["autoCompile"]).toBe(false);
});

test("HooksManage refuses a string declaration with whitespace and spells out the array form", async () => {
  harness("h1");
  const r = await call(hooksManage, {
    action: "set",
    dir: "h1",
    hook: "preSpawn",
    command: "bun run prep.ts",
    dryRun: false,
  });
  console.log(`HOOKS_SPLIT ${String(r["reason"]).slice(0, 220)}`);
  expect(r["status"]).toBe("refused");
  // The point is not that it looks odd — it is that the supervisor will
  // spawn a FILE with that name and refuse every start.
  expect(String(r["reason"])).toContain("never word-splits");
  expect(String(r["reason"])).toContain('["bun", "run", "prep.ts"]');
  expect(existsSync(path.join(tmp, "h1", ".crewhaus", "settings.json"))).toBe(false);
});

test("HooksManage refuses a hook whose command is not there, and takes it with the flag", async () => {
  harness("h1");
  const refused = await call(hooksManage, {
    action: "set",
    dir: "h1",
    hook: "preSpawn",
    command: ["./missing.sh"],
    dryRun: false,
  });
  console.log(`HOOKS_MISSING ${String(refused["reason"]).slice(0, 180)}`);
  expect(refused["status"]).toBe("refused");
  expect(String(refused["reason"])).toContain("absent");
  expect(String(refused["reason"])).toContain("REFUSES every start");

  const forced = await call(hooksManage, {
    action: "set",
    dir: "h1",
    hook: "preSpawn",
    command: ["./missing.sh"],
    allowMissingCommand: true,
    dryRun: false,
  });
  expect(forced["status"]).toBe("applied");
  expect(at(forced, "now", "commandState")).toBe("absent");
});

test("HooksManage writes one hook and preserves every other block in the file", async () => {
  harness("h1");
  hookScript("h1");
  // The file is shared: the runtime's own hooks and permissions live here,
  // and a rewrite that knew only about `manager` would drop them.
  write(
    "h1/.crewhaus/settings.json",
    `${JSON.stringify(
      {
        permissions: { allow: ["Read(*)"] },
        hooks: [{ event: "pre-tool", command: "./audit.sh" }],
        manager: { autoCompile: true, envFiles: ["../.env"] },
        somethingNewerWrote: { keep: "me" },
      },
      null,
      2,
    )}\n`,
  );

  const preview = await call(hooksManage, {
    action: "set",
    dir: "h1",
    hook: "postCompile",
    command: ["./prep.sh", "--fast"],
  });
  console.log(`HOOKS_PREVIEW ${JSON.stringify(preview)}`);
  expect(preview["status"]).toBe("preview");
  expect(at(preview, "hook", "argv")).toEqual(["./prep.sh", "--fast"]);
  expect(at(preview, "hook", "commandState")).toBe("executable");
  expect(readFileSync(path.join(tmp, "h1", ".crewhaus", "settings.json"), "utf8")).not.toContain(
    "postCompile",
  );

  const r = await call(hooksManage, {
    action: "set",
    dir: "h1",
    hook: "postCompile",
    command: ["./prep.sh", "--fast"],
    timeoutMs: 5000,
    dryRun: false,
  });
  console.log(`HOOKS_SET ${JSON.stringify(r)}`);
  expect(r["status"]).toBe("applied");
  expect(r["verified"]).toBe(true);
  expect(at(r, "timeout", "ms")).toBe(5000);
  expect(at(r, "timeout", "isDefault")).toBe(false);

  const doc = JSON.parse(
    readFileSync(path.join(tmp, "h1", ".crewhaus", "settings.json"), "utf8"),
  ) as Json;
  expect(at(doc, "permissions", "allow")).toEqual(["Read(*)"]);
  expect(doc["hooks"]).toEqual([{ event: "pre-tool", command: "./audit.sh" }]);
  expect(at(doc, "somethingNewerWrote", "keep")).toBe("me");
  expect(at(doc, "manager", "autoCompile")).toBe(true);
  expect(at(doc, "manager", "envFiles")).toEqual(["../.env"]);
  expect(at(doc, "manager", "hooks", "postCompile")).toEqual(["./prep.sh", "--fast"]);
});

test("HooksManage removes a hook, only with dryRun:false, and leaves the rest alone", async () => {
  harness("h1");
  hookScript("h1");
  write(
    "h1/.crewhaus/settings.json",
    JSON.stringify({
      manager: { hooks: { preSpawn: ["./prep.sh"], postCompile: "./prep.sh", timeoutMs: 1000 } },
    }),
  );

  const preview = await call(hooksManage, { action: "remove", dir: "h1", hook: "preSpawn" });
  expect(preview["status"]).toBe("preview");
  expect(at(preview, "removing", "argv")).toEqual(["./prep.sh"]);

  const r = await call(hooksManage, {
    action: "remove",
    dir: "h1",
    hook: "preSpawn",
    dryRun: false,
  });
  console.log(`HOOKS_REMOVE ${JSON.stringify(r)}`);
  expect(r["status"]).toBe("applied");
  expect(r["verified"]).toBe(true);
  expect(at(r, "now", "declared")).toBe(false);
  const doc = JSON.parse(
    readFileSync(path.join(tmp, "h1", ".crewhaus", "settings.json"), "utf8"),
  ) as Json;
  expect(at(doc, "manager", "hooks", "preSpawn")).toBeUndefined();
  expect(at(doc, "manager", "hooks", "postCompile")).toBe("./prep.sh");
  expect(at(doc, "manager", "hooks", "timeoutMs")).toBe(1000);
});

test("HooksManage refuses to rewrite a settings file that does not parse, and keeps every byte", async () => {
  harness("h1");
  hookScript("h1");
  const corrupt = '{ "permissions": { "allow": ["Read(*)"] },,, }';
  write("h1/.crewhaus/settings.json", corrupt);
  const r = await call(hooksManage, {
    action: "set",
    dir: "h1",
    hook: "preSpawn",
    command: ["./prep.sh"],
    dryRun: false,
  });
  console.log(`HOOKS_CORRUPT ${String(r["reason"]).slice(0, 200)}`);
  expect(r["status"]).toBe("refused");
  expect(r["settingsState"]).toBe("unparseable");
  expect(String(r["reason"])).toContain("hooks and permissions blocks");
  expect(readFileSync(path.join(tmp, "h1", ".crewhaus", "settings.json"), "utf8")).toBe(corrupt);

  const listed = await call(hooksManage, { action: "list", dir: "h1" });
  // The tolerant reader would have answered "no hooks"; the state says why
  // that answer means nothing.
  expect(listed["status"]).toBe("unreadable");
  expect(String(listed["reason"])).toContain("DEFAULTS");
});

test("HooksManage keeps the settings file's mode when it rewrites it", async () => {
  harness("h1");
  hookScript("h1");
  const abs = write("h1/.crewhaus/settings.json", JSON.stringify({ manager: {} }));
  chmodSync(abs, 0o640);
  const r = await call(hooksManage, {
    action: "set",
    dir: "h1",
    hook: "preSpawn",
    command: ["./prep.sh"],
    dryRun: false,
  });
  expect(r["status"]).toBe("applied");
  console.log(`HOOKS_MODE ${(statSync(abs).mode & 0o777).toString(8)}`);
  expect(statSync(abs).mode & 0o777).toBe(0o640);
});

test("HooksManage refuses to write through a symlinked settings file, and the target is untouched", async () => {
  harness("h1");
  hookScript("h1");
  const elsewhere = outsideDir();
  const target = path.join(elsewhere, "settings.json");
  // Real content, so the read half of this test can assert that none of it
  // came back reported as h1's own configuration.
  const targetText = '{"manager":{"hooks":{"preSpawn":["/bin/echo","LEAKED"]}}}';
  writeFileSync(target, targetText);
  mkdirSync(path.join(tmp, "h1", ".crewhaus"), { recursive: true });
  symlinkSync(target, path.join(tmp, "h1", ".crewhaus", "settings.json"));

  const r = await call(hooksManage, {
    action: "set",
    dir: "h1",
    hook: "preSpawn",
    command: ["./prep.sh"],
    dryRun: false,
  });
  console.log(`HOOKS_SYMLINK ${String(r["reason"]).slice(0, 200)}`);
  expect(r["status"]).toBe("refused");
  expect(String(r["reason"])).toContain("resolves outside the workspace root");
  expect(String(r["reason"])).toContain("no flag for following it");
  // The write ends in a RENAME, which would have replaced the link's target.
  expect(readFileSync(target, "utf8")).toBe(targetText);

  // And the refusal is not only a write gate: READING through the link is
  // the same escape, so `list` — which writes nothing — is refused too,
  // rather than reporting another file's hooks as this harness's.
  const listed = await call(hooksManage, { action: "list", dir: "h1" });
  expect(listed["status"]).toBe("refused");
  expect(String(listed["reason"])).toContain("resolves outside the workspace root");
  expect(JSON.stringify(listed)).not.toContain("LEAKED");
});

// ---------------------------------------------------------------------------
// the shared file
// ---------------------------------------------------------------------------

test("a row another writer added between two calls survives them both", async () => {
  harness("mine");
  harness("theirs");
  const created = await call(harnessRegister, { action: "register", dir: "mine", dryRun: false });
  const id = String(at(created, "entry", "id"));

  // A running manager, writing the same file through the library between our
  // calls. Every tool here opens a fresh registry handle and mutates through
  // @crewhaus/harness-registry's read-merge-write, so this row is merged
  // rather than clobbered — a tool that cached the document it probed and
  // wrote its own copy back would delete it here.
  const theirs = openHangarRegistry({ root: registryRoot });
  theirs.upsert({ dir: path.join(tmp, "theirs"), specName: "manager", target: "cli" });

  await call(harnessRegister, {
    action: "update",
    id,
    tags: ["after"],
    notes: "still here",
    dryRun: false,
  });
  const doc = readRegistry();
  console.log(`MERGE ${JSON.stringify(doc.harnesses.map((h) => h["specName"]))}`);
  expect(doc.harnesses.length).toBe(2);
  expect(doc.harnesses.find((h) => h["specName"] === "manager")).toBeDefined();
  expect(doc.harnesses.find((h) => h["id"] === id)?.["tags"]).toEqual(["after"]);

  // And the document is still the library's own: format v2, its indentation,
  // its trailing newline, its mode.
  const text = readFileSync(registryFile(), "utf8");
  expect((JSON.parse(text) as Json)["v"]).toBe(2);
  expect(text.endsWith("}\n")).toBe(true);
  expect(text).toContain('\n  "harnesses": [');
  expect(statSync(registryFile()).mode & 0o777).toBe(0o600);

  // The removal is a merge too: the other writer's row is untouched.
  await call(harnessRegister, { action: "remove", id, dryRun: false });
  const after = readRegistry();
  expect(after.harnesses.map((h) => h["specName"])).toEqual(["manager"]);
});

test("CliVersionPin counts one harness once, however many spellings it is given", async () => {
  harness("h1");
  bundle("h1", hashSpecSource(SPEC), "0.6.0");
  symlinkSync(path.join(tmp, "h1"), path.join(tmp, "alias"));
  const r = await call(cliVersionPin, { dirs: ["h1", "h1", "alias", "./h1"] });
  console.log(`VERSIONS_DEDUPE ${JSON.stringify(r["compiledWith"])}`);
  expect(r["count"]).toBe(1);
  // A duplicate would have doubled the version roll-up, which is the number
  // an operator reads to decide whether the fleet is on one CLI.
  expect(r["compiledWith"]).toEqual({ "0.6.0": 1 });
});

test("HarnessRegister says when a group membership names a group nobody defined", async () => {
  harness("h1");
  const created = await call(harnessRegister, { action: "register", dir: "h1", dryRun: false });
  const id = String(at(created, "entry", "id"));
  const r = await call(harnessRegister, {
    action: "update",
    id,
    groups: ["nightly"],
    dryRun: false,
  });
  console.log(`GROUPS_UNDEFINED ${JSON.stringify(r["groupsNotDefined"])}`);
  expect(r["status"]).toBe("applied");
  // The membership IS written — this is a report, not a refusal.
  expect(at(r, "entry", "groups")).toEqual(["nightly"]);
  expect(r["groupsNotDefined"]).toEqual(["nightly"]);
  expect(String(r["groupsNote"])).toContain("not defined in the registry's group list");
});
