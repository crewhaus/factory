import { afterEach, beforeEach, describe, expect, it } from "bun:test";
/**
 * What the four tools actually DO, asserted against the filesystem and the
 * returned document rather than against the shape of the code.
 *
 * Three claims get the most attention here, because each is a class of bug
 * this repository has shipped before:
 *
 *   - A DRY RUN THAT IS NOT THE REAL RUN. Both writing tools are asserted by
 *     running the dry run, capturing the bytes it reported, running the real
 *     one, and comparing the bytes on disk to those - not by reading the code
 *     and believing it.
 *   - A REFUSAL THAT IS INDISTINGUISHABLE FROM A CRASH. Every refusal test
 *     asserts the REASON, because "it did not write" is also satisfied by a
 *     thrown error, a missing file, or a timeout.
 *   - AN UNREADABLE THING COUNTED AS AN EMPTY THING. `SpecAdvise` is driven
 *     against a missing directory, an unreadable file and a corrupt log, and
 *     asserted to report each one rather than to return a clean bill of health.
 *
 * Every test runs in its own temporary working directory, because the
 * containment boundary is `process.cwd()`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpec } from "@crewhaus/spec";
import * as fx from "./fixtures";
import { doctorFix, specAdvise, specPatchApply, specUpgrade } from "./index";

/** CI is a loaded two-core box; these do real file I/O. */
const BUDGET_MS = 30_000;

let previousCwd = process.cwd();
let workspace = "";

beforeEach(() => {
  previousCwd = process.cwd();
  // realpath: on macOS the temp dir is reached through a symlink, and the
  // containment check compares real paths.
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "specops-")));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workspace, { recursive: true, force: true });
});

async function run(
  tool: { execute: (input: unknown) => Promise<unknown> },
  input: unknown,
): Promise<Record<string, unknown>> {
  const out = String(await tool.execute(input));
  try {
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    // A plain-string refusal is a legitimate result shape in this repository;
    // tests that expect one read `raw`.
    return { raw: out };
  }
}

// ---------------------------------------------------------------------------
// SpecPatchApply
// ---------------------------------------------------------------------------

describe("SpecPatchApply", () => {
  it("applies a tunable field and leaves the author's comments and key order alone", async () => {
    const out = await run(specPatchApply, {
      spec: fx.CLI_SPEC_YAML,
      patches: [{ path: ["agent", "max_tokens"], value: 16384 }],
    });
    const yaml = String(out["yaml"]);
    console.log(`PATCHED\n${yaml}`);
    expect({ ok: out["ok"], applied: out["applied"], changed: out["changed"] }).toEqual({
      ok: true,
      applied: 1,
      changed: true,
    });
    expect(yaml).toContain("# a spec a human maintains");
    expect(yaml).toContain("# the roster is human-owned");
    expect(yaml).toContain("max_tokens: 16384");
    // Key order preserved: the CST edit touches one value, not the document.
    expect(yaml.indexOf("name: hello")).toBeLessThan(yaml.indexOf("target: cli"));
    expect(yaml.indexOf("model: claude-sonnet-4-6")).toBeLessThan(yaml.indexOf("instructions:"));
    expect(out["diff"]).toEqual([{ kind: "added", path: "agent.max_tokens", after: "16384" }]);
  });

  it("chooses add or replace from the FILE, not from the defaulted parsed spec", async () => {
    const absent = await run(specPatchApply, {
      spec: fx.CLI_SPEC_YAML,
      patches: [{ path: ["agent", "max_tokens"], value: 16384 }],
    });
    const present = await run(specPatchApply, {
      spec: fx.CLI_SPEC_TUNED_YAML,
      patches: [{ path: ["agent", "max_tokens"], value: 16384 }],
    });
    console.log(`OPS ${JSON.stringify(absent["patches"])} ${JSON.stringify(present["patches"])}`);
    expect((absent["patches"] as Array<Record<string, unknown>>)[0]?.["op"]).toBe("add");
    expect((present["patches"] as Array<Record<string, unknown>>)[0]?.["op"]).toBe("replace");
  });

  it("recomputes the op against the running document inside one batch", async () => {
    // The second patch addresses a key the FIRST one created. Deciding both
    // ops up front against the original text would make this an "add" onto an
    // existing key, which the CST refuses.
    const out = await run(specPatchApply, {
      spec: fx.CLI_SPEC_YAML,
      patches: [
        { path: ["compaction", "curate"], value: true },
        { path: ["compaction", "curate"], value: false },
      ],
    });
    console.log(`BATCH_OPS ${JSON.stringify(out["patches"])}`);
    expect(out["ok"]).toBe(true);
    expect((out["patches"] as Array<Record<string, unknown>>).map((p) => p["op"])).toEqual([
      "add",
      "replace",
    ]);
    expect(String(out["yaml"])).toContain("curate: false");
  });

  it("refuses every bad path in one answer, and applies none of the batch", async () => {
    const out = await run(specPatchApply, {
      spec: fx.CLI_SPEC_YAML,
      patches: [
        { path: ["agent", "max_tokens"], value: 16384 },
        { path: ["agent", "model"], value: "claude-opus-4-1" },
        { path: ["permissions", "mode"], value: "bypass" },
      ],
    });
    const refused = out["refused"] as Array<Record<string, unknown>>;
    console.log(`REFUSED ${refused.length} ${refused.map((r) => r["path"]).join(",")}`);
    // Both refusals come back together: one per round trip is how a caller
    // ends up in a retry loop.
    expect({ ok: out["ok"], applied: out["applied"], refusals: refused.length }).toEqual({
      ok: false,
      applied: 0,
      refusals: 2,
    });
    expect(String(refused[0]?.["humanOwned"])).toMatch(/roster/i);
  });

  it("refuses a patch that would break the schema, in memory, before any write", async () => {
    const specPath = join(workspace, "crewhaus.yaml");
    writeFileSync(specPath, fx.CLI_SPEC_YAML);
    const out = await run(specPatchApply, {
      path: "crewhaus.yaml",
      dryRun: false,
      patches: [{ path: ["agent", "max_tokens"], value: "banana" }],
    });
    console.log(`SCHEMA_GATE ${JSON.stringify(out["failedAt"])}`);
    expect({ ok: out["ok"], wrote: out["wrote"] }).toEqual({ ok: false, wrote: false });
    // The reason, not just the failure: a timeout or a crash would also leave
    // the file untouched.
    expect(String((out["failedAt"] as Record<string, unknown>)["reason"])).toMatch(
      /failed spec validation/i,
    );
    expect(readFileSync(specPath, "utf8")).toBe(fx.CLI_SPEC_YAML);
  });

  it(
    "writes nothing by default, and dryRun: false writes exactly the bytes the dry run showed",
    async () => {
      const specPath = join(workspace, "crewhaus.yaml");
      writeFileSync(specPath, fx.CLI_SPEC_YAML);
      const patches = [{ path: ["agent", "max_tokens"], value: 16384 }];

      const dry = await run(specPatchApply, { path: "crewhaus.yaml", patches });
      expect(dry["wrote"]).toBe(false);
      expect(String(dry["wroteReason"])).toMatch(/dryRun/);
      // Default is a dry run: the file is untouched.
      expect(readFileSync(specPath, "utf8")).toBe(fx.CLI_SPEC_YAML);

      const real = await run(specPatchApply, { path: "crewhaus.yaml", dryRun: false, patches });
      const onDisk = readFileSync(specPath, "utf8");
      console.log(`WROTE ${JSON.stringify(real["wrote"])} bytes_on_disk=${onDisk.length}`);
      expect(real["ok"]).toBe(true);
      // The preview IS the write. A dry run rendered by a parallel code path
      // is how tool-hostfs predicted a destination the real call never used.
      expect(onDisk).toBe(String(dry["yaml"]));
      expect((real["wrote"] as Record<string, unknown>)["bytes"]).toBe(
        Buffer.byteLength(onDisk, "utf8"),
      );
    },
    BUDGET_MS,
  );

  it("removes a key when asked, and says so in the diff", async () => {
    const out = await run(specPatchApply, {
      spec: fx.CLI_SPEC_TUNED_YAML,
      patches: [{ path: ["compaction", "curate"], op: "remove" }],
    });
    console.log(`REMOVE ${JSON.stringify(out["diff"])}`);
    expect(out["ok"]).toBe(true);
    expect(String(out["yaml"])).not.toContain("curate:");
  });

  it("does not rewrite a file when the patch changes nothing", async () => {
    const specPath = join(workspace, "crewhaus.yaml");
    writeFileSync(specPath, fx.CLI_SPEC_TUNED_YAML);
    const before = statSync(specPath).mtimeMs;
    const out = await run(specPatchApply, {
      path: "crewhaus.yaml",
      dryRun: false,
      patches: [{ path: ["agent", "max_tokens"], op: "replace", value: 8192 }],
    });
    console.log(`NOOP ${JSON.stringify(out["wroteReason"])}`);
    expect({ ok: out["ok"], changed: out["changed"], wrote: out["wrote"] }).toEqual({
      ok: true,
      changed: false,
      wrote: false,
    });
    // Not merely "the content is the same": the file was not touched at all.
    // A bumped mtime is what makes every compiled bundle in a fleet look
    // stale to the freshness check.
    expect(statSync(specPath).mtimeMs).toBe(before);
    expect(String(out["wroteReason"])).toMatch(/byte-identical/);
  });

  it("refuses a spec path that escapes the workspace", async () => {
    const out = await run(specPatchApply, {
      path: "../outside.yaml",
      patches: [{ path: ["agent", "max_tokens"], value: 16384 }],
    });
    console.log(`ESCAPE ${JSON.stringify(out)}`);
    expect(String(out["raw"])).toMatch(/escapes the workspace/);
  });

  it("says an unparseable spec is unparseable rather than reporting nothing to patch", async () => {
    const out = await run(specPatchApply, {
      spec: "name: [unclosed\ntarget: cli\n",
      patches: [{ path: ["agent", "max_tokens"], value: 16384 }],
    });
    console.log(`UNPARSEABLE ${JSON.stringify(out)}`);
    expect(out["ok"]).toBe(false);
    expect(String(out["error"])).toMatch(/not parseable YAML/);
  });

  it("refuses add and replace without a value instead of writing a null", async () => {
    const out = await run(specPatchApply, {
      spec: fx.CLI_SPEC_YAML,
      patches: [{ path: ["agent", "max_tokens"], op: "replace" }],
    });
    const refused = out["refused"] as Array<Record<string, unknown>>;
    expect(String(refused[0]?.["reason"])).toMatch(/needs a value/);
  });
});

// ---------------------------------------------------------------------------
// SpecUpgrade
// ---------------------------------------------------------------------------

describe("SpecUpgrade", () => {
  it("surfaces only the notes whose detectors fire, and names the releases it checked", async () => {
    const out = await run(specUpgrade, { spec: fx.CLI_SPEC_YAML });
    const ids = (out["notes"] as Array<Record<string, unknown>>).map((n) => n["id"]);
    console.log(`NOTES ${ids.join(",")} releases=${JSON.stringify(out["releasesChecked"])}`);
    expect(ids).toContain("continuity-default-on");
    // An empty note list has to be distinguishable from an unchecked spec.
    expect((out["releasesChecked"] as string[]).length).toBeGreaterThanOrEqual(2);
    expect(out["notesCleared"]).toBe(false);
    expect(out["blockedBy"]).toContain("continuity-default-on");
  });

  it("an unacknowledged note fails closed; acknowledging it clears the block", async () => {
    const blocked = await run(specUpgrade, { spec: fx.CLI_SPEC_YAML });
    const ids = (blocked["notes"] as Array<Record<string, unknown>>).map((n) => String(n["id"]));
    const cleared = await run(specUpgrade, {
      spec: fx.CLI_SPEC_YAML,
      acknowledgedNoteIds: ids,
    });
    console.log(`ACK ${ids.join(",")} -> notesCleared=${String(cleared["notesCleared"])}`);
    expect(cleared["notesCleared"]).toBe(true);
    expect(cleared["blockedBy"]).toEqual([]);
    // An unknown note id does not clear anything.
    const wrongAck = await run(specUpgrade, {
      spec: fx.CLI_SPEC_YAML,
      acknowledgedNoteIds: ["some-note-that-does-not-exist"],
    });
    expect(wrongAck["notesCleared"]).toBe(false);
  });

  it("a spec the detectors could not read is a refusal, never 'no notes apply'", async () => {
    const out = await run(specUpgrade, { spec: "name: [unclosed\n" });
    console.log(`UPGRADE_UNPARSEABLE ${JSON.stringify(out)}`);
    expect(out["ok"]).toBe(false);
    expect(String(out["error"])).toMatch(/not parseable YAML/);
    // And specifically NOT the shape a clean spec returns.
    expect(out["notes"]).toBeUndefined();
  });

  it("a YAML document that is not a mapping is a refusal, not 'no notes apply'", async () => {
    // The second way `collectUpgradeNotes` answers "[]" without looking. Every
    // detector opens with `parseSpecObject` and gives up when the root is not a
    // mapping - which is perfectly valid YAML, so the syntax guard above lets
    // it through, and the empty list it produces used to come back as
    // ok:true / ready:true / noteCount:0 beside the list of releases
    // "checked". An unattended upgrade driver reads that as go.
    for (const [label, text] of [
      ["a sequence", "- a\n- b\n"],
      ["a scalar", "just a string\n"],
      ["an empty file", ""],
    ] as const) {
      const out = await run(specUpgrade, { spec: text });
      console.log(`UPGRADE_NOT_A_MAPPING ${label} ${JSON.stringify(out)}`);
      expect({ label, ok: out["ok"] }).toEqual({ label, ok: false });
      // The reason names the cause, not merely that something went wrong: a
      // crash or a timeout would also produce ok:false.
      expect(String(out["error"])).toMatch(/top level is not a mapping/);
      expect(String(out["error"])).toMatch(/nothing was checked/);
      // And specifically NOT the shape a checked spec returns.
      expect({ label, notes: out["notes"], cleared: out["notesCleared"] }).toEqual({
        label,
        notes: undefined,
        cleared: undefined,
      });
    }
  });

  it("a schema-INVALID mapping is still checked, because the detectors can read one", async () => {
    // The guard above must not swallow this case: the main reason to ask for
    // upgrade notes is a spec written against an older schema, which by
    // definition may not satisfy the current one. `cli` with no `agent` block
    // fails the schema and still trips the continuity detector.
    const out = await run(specUpgrade, { spec: "name: x\ntarget: cli\n" });
    const ids = (out["notes"] as Array<Record<string, unknown>>).map((n) => n["id"]);
    console.log(`UPGRADE_SCHEMA_INVALID ok=${String(out["ok"])} notes=${ids.join(",")}`);
    expect(out["ok"]).toBe(true);
    expect(ids).toContain("continuity-default-on");
    // ...and the version stamp is reported as unread, with the schema reason.
    const version = out["specVersion"] as Record<string, unknown>;
    expect(version["known"]).toBe(false);
    expect(String(version["reason"])).toMatch(/does not satisfy the schema/);
  });

  it("names its gate for the notes it measures, not for an upgrade it cannot clear", async () => {
    // A bare `ready: true` beside `schemaMigration.determined: false` is the
    // shape this package exists to refuse: the go/no-go needs both halves and
    // this tool only has one.
    const out = await run(specUpgrade, { spec: fx.CLI_SPEC_YAML, acknowledgedNoteIds: [] });
    console.log(`GATE_NAME keys=${Object.keys(out).join(",")}`);
    expect(Object.keys(out)).toContain("notesCleared");
    expect(Object.keys(out)).not.toContain("ready");
  });

  it("reports the schema migration as undetermined, and names what would determine it", async () => {
    const out = await run(specUpgrade, { spec: fx.CLI_SPEC_YAML });
    const migration = out["schemaMigration"] as Record<string, unknown>;
    console.log(`MIGRATION ${JSON.stringify(migration)}`);
    expect(migration["determined"]).toBe(false);
    expect(String(migration["reason"])).toMatch(/migration-engine/);
    expect(String(migration["reason"])).toMatch(/crewhaus upgrade/);
  });

  it("reads the version stamp when there is one, and says so when there is not", async () => {
    const without = await run(specUpgrade, { spec: fx.CLI_SPEC_YAML });
    expect((without["specVersion"] as Record<string, unknown>)["known"]).toBe(false);
    const stamped = await run(specUpgrade, {
      spec: `${fx.CLI_SPEC_YAML}version: 1\n`,
    });
    const version = stamped["specVersion"] as Record<string, unknown>;
    console.log(`VERSION ${JSON.stringify(version)}`);
    expect(version).toEqual({ known: true, version: 1 });
  });
});

// ---------------------------------------------------------------------------
// SpecAdvise
// ---------------------------------------------------------------------------

function seedSessions(files: Record<string, string>): void {
  const dir = join(workspace, ".crewhaus", "sessions");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

describe("SpecAdvise", () => {
  it("mines real session logs into findings, and pre-validates the patch it proposes", async () => {
    seedSessions({
      "sess_a.jsonl": fx.jsonl(fx.recoveryLines("MaxTokensError", "continue", 3)),
    });
    const out = await run(specAdvise, { spec: fx.CLI_SPEC_YAML });
    const findings = out["findings"] as Array<Record<string, unknown>>;
    console.log(
      `ADVISE complete=${String(out["complete"])} findings=${findings.length} patches=${String(out["patchCount"])}`,
    );
    expect({ complete: out["complete"], sessions: out["sessionsMined"] }).toEqual({
      complete: true,
      sessions: 1,
    });
    const truncation = findings.find((f) => f["id"] === "truncation-pressure");
    expect(truncation).toBeDefined();
    const suggestion = truncation?.["suggestion"] as Record<string, unknown>;
    expect(suggestion["kind"]).toBe("spec-patch");
    // patchCount is the count of findings carrying a patch, not a guess:
    // three truncation recoveries also cluster into a failure_taxonomy draft.
    const carryingPatches = findings.filter(
      (f) => (f["suggestion"] as Record<string, unknown>)["kind"] === "spec-patch",
    ).length;
    expect({ reported: out["patchCount"], counted: carryingPatches }).toEqual({
      reported: carryingPatches,
      counted: carryingPatches,
    });
    expect(carryingPatches).toBeGreaterThan(0);
  });

  it("a missing sessions directory is reported, not returned as a clean bill of health", async () => {
    const out = await run(specAdvise, {});
    console.log(`ADVISE_MISSING ${JSON.stringify(out["incomplete"])}`);
    expect(out["findingCount"]).toBe(0);
    // The whole point: zero findings AND a reason the caller cannot miss.
    expect(out["complete"]).toBe(false);
    expect((out["incomplete"] as string[]).join(" ")).toMatch(
      /sessions: .*(does not exist|unreadable)/,
    );
  });

  it("names a log it could not read, and counts the lines it could not parse", async () => {
    seedSessions({
      "sess_a.jsonl": `${fx.jsonl(fx.recoveryLines("MaxTokensError", "continue", 3))}NOT JSON\n`,
    });
    // A directory where a log should be: readable name, unreadable content.
    mkdirSync(join(workspace, ".crewhaus", "sessions", "sess_b.jsonl"), { recursive: true });
    const out = await run(specAdvise, {});
    const sources = (out["sources"] as Record<string, unknown>)["sessions"] as Record<
      string,
      unknown
    >;
    console.log(`ADVISE_PARTIAL ${JSON.stringify(sources)}`);
    expect(out["complete"]).toBe(false);
    expect(sources["malformedLines"]).toBe(1);
    expect(JSON.stringify(sources["unreadable"])).toMatch(/sess_b\.jsonl.*not a file/);
    // The findings that COULD be mined are still returned.
    expect(out["findingCount"]).toBeGreaterThan(0);
  });

  it("a truncated DEFAULT audit directory is an incomplete read, not a complete one", async () => {
    // `unavailable` used to carry two different answers - "the directory was
    // not there" and "I read part of it" - and the audit branch was allowed to
    // ignore the field entirely unless the caller named the directory. The
    // exemption is only sound for ABSENCE: a default `.crewhaus/audit` that
    // exists and is truncated at maxFiles came back complete:true with an
    // auditRecords count of the fraction that was read.
    seedSessions({ "sess_a.jsonl": fx.jsonl(fx.recoveryLines("MaxTokensError", "continue", 3)) });
    const auditDir = join(workspace, ".crewhaus", "audit");
    mkdirSync(auditDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(auditDir, `a${i}.jsonl`), `${JSON.stringify({ kind: "x" })}\n`);
    }
    const out = await run(specAdvise, { maxFiles: 2 });
    const audit = (out["sources"] as Record<string, unknown>)["audit"] as Record<string, unknown>;
    console.log(
      `AUDIT_TRUNCATED ${JSON.stringify(audit)} incomplete=${JSON.stringify(out["incomplete"])}`,
    );
    // The read really was partial - otherwise this asserts nothing.
    expect(audit["files"]).toBe(2);
    expect(out["auditRecords"]).toBe(2);
    expect(String(audit["truncated"])).toMatch(/only the first 2 of 5/);
    // Truncation is its own field: the absent-default exemption must not reach it.
    expect(audit["unavailable"]).toBeUndefined();
    expect(out["complete"]).toBe(false);
    expect((out["incomplete"] as string[]).join(" ")).toMatch(/audit: only the first 2 of 5/);
  });

  it("an absent DEFAULT audit directory is still not an incomplete read", async () => {
    // The other side of the same boundary: most harnesses have no audit
    // directory, no shipped rule fires on one, and reporting every such run as
    // incomplete would make the flag mean nothing.
    seedSessions({ "sess_a.jsonl": fx.jsonl(fx.recoveryLines("MaxTokensError", "continue", 3)) });
    const out = await run(specAdvise, {});
    const audit = (out["sources"] as Record<string, unknown>)["audit"] as Record<string, unknown>;
    console.log(`AUDIT_ABSENT ${JSON.stringify(audit)}`);
    expect(String(audit["unavailable"])).toMatch(/does not exist/);
    expect(out["complete"]).toBe(true);
  });

  it("counts the audit lines it could not parse instead of shrinking the record count in silence", async () => {
    seedSessions({ "sess_a.jsonl": fx.jsonl(fx.recoveryLines("MaxTokensError", "continue", 3)) });
    const auditDir = join(workspace, ".crewhaus", "audit");
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      join(auditDir, "a.jsonl"),
      `${JSON.stringify({ kind: "x" })}\nNOT JSON\nALSO NOT\n`,
    );
    const out = await run(specAdvise, {});
    const audit = (out["sources"] as Record<string, unknown>)["audit"] as Record<string, unknown>;
    console.log(`AUDIT_MALFORMED ${JSON.stringify(audit)}`);
    // The number a caller acts on, and the reason it is smaller than the file.
    expect(out["auditRecords"]).toBe(1);
    expect(audit["malformedLines"]).toBe(2);
    expect(out["complete"]).toBe(false);
    expect((out["incomplete"] as string[]).join(" ")).toMatch(/2 audit line\(s\)/);
  });

  it("says the routing scoreboard was not read at all, rather than reporting no routing findings", async () => {
    seedSessions({ "sess_a.jsonl": fx.jsonl(fx.noisyCascadeLines()) });
    const out = await run(specAdvise, { spec: fx.RULED_SPEC_YAML });
    const scoreboard = (out["sources"] as Record<string, unknown>)["routingScoreboard"] as Record<
      string,
      unknown
    >;
    console.log(`SCOREBOARD ${JSON.stringify(scoreboard)}`);
    expect(scoreboard["read"]).toBe(false);
    expect(String(scoreboard["reason"])).toMatch(/routing-store/);
    expect(String(scoreboard["reason"])).toMatch(/not evidence that routing is healthy/);
  });

  it("a spec that was given but did not parse downgrades to advice AND says so", async () => {
    seedSessions({
      "sess_a.jsonl": fx.jsonl(fx.recoveryLines("MaxTokensError", "continue", 3)),
    });
    const out = await run(specAdvise, { spec: "name: [unclosed\n" });
    const findings = out["findings"] as Array<Record<string, unknown>>;
    const specSource = (out["sources"] as Record<string, unknown>)["spec"] as Record<
      string,
      unknown
    >;
    console.log(`ADVISE_BAD_SPEC ${JSON.stringify(specSource)}`);
    expect({ given: specSource["given"], parsed: specSource["parsed"] }).toEqual({
      given: true,
      parsed: false,
    });
    expect(out["complete"]).toBe(false);
    expect(out["patchCount"]).toBe(0);
    expect(
      findings.every((f) => (f["suggestion"] as Record<string, unknown>)["kind"] === "advice"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DoctorFix
// ---------------------------------------------------------------------------

describe("DoctorFix", () => {
  it(
    "the dry run writes nothing, and the real run writes exactly what the dry run showed",
    async () => {
      const dry = await run(doctorFix, { fixes: ["scaffold-spec"], specName: "hello" });
      const changes = dry["changes"] as Array<Record<string, unknown>>;
      console.log(
        `FIX_DRY ${JSON.stringify(changes.map((c) => [c["kind"], c["path"], c["bytes"]]))}`,
      );
      expect({ wrote: dry["wrote"], count: changes.length }).toEqual({ wrote: false, count: 1 });
      expect(existsSync(join(workspace, "crewhaus.yaml"))).toBe(false);

      const real = await run(doctorFix, {
        fixes: ["scaffold-spec"],
        specName: "hello",
        dryRun: false,
      });
      const onDisk = readFileSync(join(workspace, "crewhaus.yaml"), "utf8");
      console.log(`FIX_REAL committed=${JSON.stringify(real["committed"])}`);
      // Identity, not similarity: the dry run ran the same fixer against an
      // overlay, so its bytes are the bytes.
      expect(onDisk).toBe(String(changes[0]?.["content"]));
      expect(real["wrote"]).toBe(true);
    },
    BUDGET_MS,
  );

  it("a second run finds nothing to do and says which fix was already satisfied", async () => {
    await run(doctorFix, { fixes: ["scaffold-spec"], specName: "hello", dryRun: false });
    const again = await run(doctorFix, { fixes: ["scaffold-spec"], specName: "hello" });
    console.log(`FIX_IDEMPOTENT ${JSON.stringify(again["skipped"])}`);
    expect((again["changes"] as unknown[]).length).toBe(0);
    expect(JSON.stringify(again["skipped"])).toMatch(/already exists/);
  });

  it("chains a scope fix onto the spec it just scaffolded, in one call", async () => {
    // Two fixers touching one file: the second reads through the overlay, so
    // it patches the scaffolded document rather than re-reading a file that
    // does not exist yet on disk.
    const out = await run(doctorFix, {
      fixes: ["scaffold-spec", "tool-scope"],
      specName: "hello",
      toolNames: ["Fetch"],
      dryRun: false,
    });
    const onDisk = readFileSync(join(workspace, "crewhaus.yaml"), "utf8");
    console.log(`FIX_CHAIN\n${onDisk}`);
    expect(out["ok"]).toBe(true);
    expect(onDisk).toContain("name: hello");
    expect(onDisk).toContain("tool_config:");
    expect(onDisk).toContain("scope: external");
    // One file, written once: the committed list is not two half-versions.
    expect((out["committed"] as unknown[]).length).toBe(1);
  });

  it("appends env stubs COMMENTED, with no field to pass a value through", async () => {
    const out = await run(doctorFix, {
      fixes: ["env-stubs"],
      envVars: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
      dryRun: false,
    });
    const env = readFileSync(join(workspace, ".env"), "utf8");
    console.log(`ENV\n${env}`);
    expect(out["ok"]).toBe(true);
    expect(env).toContain("# ANTHROPIC_API_KEY=");
    // Nothing is SET: every stub line is a comment, so a stub can never
    // shadow a real value from an earlier file in the chain.
    const assignments = env.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    expect(assignments).toEqual([]);
    const shape = Object.keys(
      (doctorFix.inputSchema as unknown as { shape: Record<string, unknown> }).shape,
    );
    console.log(`FIX_SCHEMA ${shape.join(",")}`);
    for (const forbidden of ["password", "secret", "token", "credential", "envValues"]) {
      expect({ field: forbidden, present: shape.includes(forbidden) }).toEqual({
        field: forbidden,
        present: false,
      });
    }
  });

  it("refuses an env var name that could inject a line, and writes nothing", async () => {
    const out = await run(doctorFix, {
      fixes: ["env-stubs"],
      envVars: ["GOOD_KEY\nEVIL_KEY=leaked"],
      dryRun: false,
    });
    console.log(`ENV_INJECTION ${JSON.stringify(out["problems"])}`);
    expect({ ok: out["ok"], wrote: out["wrote"] }).toEqual({ ok: false, wrote: false });
    expect(String((out["problems"] as string[])[0])).toMatch(/is not an env var name/);
    expect(existsSync(join(workspace, ".env"))).toBe(false);
  });

  it("refuses a spec name that could inject YAML into the scaffold", async () => {
    const out = await run(doctorFix, {
      fixes: ["scaffold-spec"],
      specName: "evil\npermissions:\n  mode: bypass",
      dryRun: false,
    });
    console.log(`NAME_INJECTION ${JSON.stringify(out["problems"])}`);
    expect(out["ok"]).toBe(false);
    expect(String((out["problems"] as string[])[0])).toMatch(/not a plain name/);
    expect(existsSync(join(workspace, "crewhaus.yaml"))).toBe(false);
  });

  it("refuses a spec name that scaffolds a document YAML does not read as a string", async () => {
    // Charset validation cannot catch this: "2026" passes SPEC_NAME_RE and
    // every injection test, and `name: 2026` is a NUMBER. The fixer writes raw
    // text with no re-parse, so the tool used to report ok:true / wrote:true
    // over a crewhaus.yaml that does not parse - the exact invariant this
    // package's header claims ("every write is re-validated through parseSpec")
    // and the scaffold fixer never had.
    for (const name of ["2026", "true", "1.5", "0x10"]) {
      const out = await run(doctorFix, { fixes: ["scaffold-spec"], specName: name, dryRun: false });
      console.log(`SCALAR_NAME ${name} -> ok=${String(out["ok"])} ${String(out["error"])}`);
      expect({ name, ok: out["ok"], wrote: out["wrote"] }).toEqual({
        name,
        ok: false,
        wrote: false,
      });
      // The reason, and specifically the parse reason.
      expect(String(out["error"])).toMatch(/does not parse/);
      expect(existsSync(join(workspace, "crewhaus.yaml"))).toBe(false);
    }
    // ...and a name YAML does read as a string still scaffolds.
    const good = await run(doctorFix, { fixes: ["scaffold-spec"], specName: "hi", dryRun: false });
    expect(good["ok"]).toBe(true);
    expect(parseSpec(readFileSync(join(workspace, "crewhaus.yaml"), "utf8")).name).toBe("hi");
  });

  it("catches the same thing when the name came from the working directory", async () => {
    // The dangerous spelling, because nobody typed it: `specName` defaults to
    // the cwd basename, and a project directory called 2026 is ordinary.
    const numeric = join(workspace, "2026");
    mkdirSync(numeric);
    process.chdir(numeric);
    const out = await run(doctorFix, { fixes: ["scaffold-spec"], dryRun: false });
    console.log(`CWD_NAME ${JSON.stringify(out["error"])}`);
    expect({ ok: out["ok"], wrote: out["wrote"] }).toEqual({ ok: false, wrote: false });
    expect(String(out["error"])).toMatch(/does not parse/);
    // The refusal points at the default, which is the only way a caller who
    // passed nothing can act on it.
    expect(String(out["error"])).toMatch(/specName defaulted/);
    expect(existsSync(join(numeric, "crewhaus.yaml"))).toBe(false);
  });

  it("commits a file into a directory the same batch creates", async () => {
    // The commit pre-check counts "some fix in this batch creates that parent"
    // as satisfied without regard to ORDER, and then wrote in capture order -
    // so a spec under the state dir cleared the pre-check and died at the
    // syscall with ENOENT, losing a batch for the one failure the pre-check
    // exists to make free.
    const out = await run(doctorFix, {
      fixes: ["scaffold-spec", "crewhaus-dirs"],
      specPath: ".crewhaus/crewhaus.yaml",
      specName: "hello",
      dryRun: false,
    });
    console.log(`DIR_BEFORE_FILE ${JSON.stringify(out["committed"])} err=${String(out["error"])}`);
    expect({ ok: out["ok"], error: out["error"] }).toEqual({ ok: true, error: undefined });
    expect(readFileSync(join(workspace, ".crewhaus", "crewhaus.yaml"), "utf8")).toContain(
      "name: hello",
    );
    // The directory landed first, which is what made the file possible.
    expect((out["committed"] as Array<Record<string, unknown>>)[0]?.["path"]).toBe(".crewhaus");
  });

  it("does not report fixes as applied when the commit wrote nothing", async () => {
    // `formatFixPlan`'s boolean means "applied", and the report used to be
    // built beside the plan - before the commit had happened. A refused commit
    // therefore came back with committed:[] and the prose line "doctor --fix:
    // applied 1 fix(es)" in the same object.
    const out = await run(doctorFix, {
      fixes: ["scaffold-spec"],
      specPath: "nope/crewhaus.yaml",
      specName: "hello",
      dryRun: false,
    });
    console.log(`FAILED_COMMIT report=${JSON.stringify(out["report"])}`);
    expect({ ok: out["ok"], wrote: out["wrote"], committed: out["committed"] }).toEqual({
      ok: false,
      wrote: false,
      committed: [],
    });
    expect(String(out["error"])).toMatch(/needs the directory "nope"/);
    // The half a human reads first must not contradict the half a driver does.
    expect(String(out["report"])).not.toMatch(/applied \d+ fix/);
    expect(String(out["report"])).toMatch(/dry-run|available/);
  });

  it("leaves a dynamic mcp__ sink advisory instead of stamping it", async () => {
    writeFileSync(join(workspace, "crewhaus.yaml"), fx.CLI_SPEC_YAML);
    const out = await run(doctorFix, {
      fixes: ["tool-scope"],
      toolNames: ["mcp__github__create_issue"],
      dryRun: false,
    });
    console.log(`MCP_SKIP ${JSON.stringify(out["skipped"])}`);
    expect((out["changes"] as unknown[]).length).toBe(0);
    expect(JSON.stringify(out["skipped"])).toMatch(/human/);
    expect(readFileSync(join(workspace, "crewhaus.yaml"), "utf8")).toBe(fx.CLI_SPEC_YAML);
  });

  it("declines to patch a spec that is not there, with the reason", async () => {
    const out = await run(doctorFix, { fixes: ["tool-scope"], toolNames: ["Fetch"] });
    console.log(`NO_SPEC ${JSON.stringify(out["skipped"])}`);
    expect(JSON.stringify(out["skipped"])).toMatch(/does not exist/);
    expect((out["changes"] as unknown[]).length).toBe(0);
  });

  it("declines to patch a spec that does not parse, rather than throwing", async () => {
    writeFileSync(join(workspace, "crewhaus.yaml"), "name: [unclosed\n");
    const out = await run(doctorFix, { fixes: ["tool-scope"], toolNames: ["Fetch"] });
    console.log(`BAD_SPEC ${JSON.stringify(out["skipped"])}`);
    expect(out["ok"]).toBe(true);
    expect(JSON.stringify(out["skipped"])).toMatch(/does not parse/);
  });

  it("creates the state directory only when asked, and only when it is missing", async () => {
    const out = await run(doctorFix, { fixes: ["crewhaus-dirs"], dryRun: false });
    console.log(`DIRS ${JSON.stringify(out["committed"])}`);
    expect(existsSync(join(workspace, ".crewhaus"))).toBe(true);
    const again = await run(doctorFix, { fixes: ["crewhaus-dirs"] });
    expect((again["changes"] as unknown[]).length).toBe(0);
  });

  it("refuses paths that escape the workspace before any fixer runs", async () => {
    const out = await run(doctorFix, {
      fixes: ["scaffold-spec"],
      specPath: "../escape.yaml",
      specName: "hello",
      dryRun: false,
    });
    console.log(`FIX_ESCAPE ${JSON.stringify(out["problems"])}`);
    expect(out["ok"]).toBe(false);
    expect(String((out["problems"] as string[])[0])).toMatch(/escapes the workspace/);
  });

  it("declares itself destructive, and SpecPatchApply does too", () => {
    expect({
      doctorFix: doctorFix.destructive,
      specPatchApply: specPatchApply.destructive,
    }).toEqual({ doctorFix: true, specPatchApply: true });
    // The read-only pair say so, which is what lets a supervisor run them
    // without a permission prompt.
    expect({ advise: specAdvise.readOnly, upgrade: specUpgrade.readOnly }).toEqual({
      advise: true,
      upgrade: true,
    });
  });
});
