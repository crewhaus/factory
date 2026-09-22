/**
 * Item 2 — CLI integration for `crewhaus dataset mine` and `crewhaus dataset
 * synthesize`. Split out of the unit tests when the mine/synthesize core
 * moved to `@crewhaus/dataset-ops`: these spawn the CLI, so they stay with
 * the app. The two event builders below are copied from that unit file —
 * both halves seed sessions the same way.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoggedEvent } from "./feedback";

function user(text: string): LoggedEvent {
  return { kind: "user_message", payload: { content: text } };
}
function toolResult(isError: boolean): LoggedEvent {
  return { kind: "tool_result", payload: { toolUseId: "tu_1", content: "…", isError } };
}

// -------- CLI integration (offline — env carries only PATH) --------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-dataset-mine-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(cliArgs: ReadonlyArray<string>, cwd: string): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...cliArgs], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      CREWHAUS_DATASETS_DIR: join(cwd, ".crewhaus", "datasets"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await proc.exited };
}

const CLI_SPEC = `name: helper
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: You help.
tools: [read]
`;

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

describe("crewhaus dataset mine (CLI, offline)", () => {
  it("mines hard cases into a quarantine JSONL and lists them (non-TTY --review)", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const session = [
      user("deploy the payments service to production"),
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "trying" }] } },
      toolResult(true),
      toolResult(true),
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    writeFileSync(join(sessionsDir, "sess_00000000000000d1.jsonl"), `${session}\n`);

    const got = await runCli(["dataset", "mine"], root);
    expect(got.exitCode).toBe(0);
    const quarantinePath = join(
      root,
      ".crewhaus",
      "datasets",
      "_quarantine",
      "helper-hardcases.jsonl",
    );
    expect(existsSync(quarantinePath)).toBe(true);
    const cands = readJsonl(quarantinePath) as Array<{ metadata?: Record<string, unknown> }>;
    expect(cands.length).toBe(1);
    expect(cands[0]?.metadata?.["signal"]).toBe("tool-error");
    expect(cands[0]?.metadata?.["status"]).toBe("quarantine");

    // Non-TTY --review just lists (no interactive prompt), exit 0.
    expect((await runCli(["dataset", "mine", "--review"], root)).exitCode).toBe(0);
  });

  it("exits cleanly when there are no sessions", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    expect((await runCli(["dataset", "mine"], root)).exitCode).toBe(0);
  });

  // D45 — the eval_graded signal rides the session's trace SIDECAR, so the
  // CLI must read `<id>.events.jsonl` beside the transcript.
  it("harvests an in-loop eval_graded failure from the session trace sidecar", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const id = "sess_00000000000000d5";
    writeFileSync(
      join(sessionsDir, `${id}.jsonl`),
      `${JSON.stringify(user("explain the refund window for EU orders"))}\n`,
    );
    writeFileSync(
      join(sessionsDir, `${id}.events.jsonl`),
      `${JSON.stringify({
        kind: "eval_graded",
        score: 0.2,
        threshold: 0.7,
        verdict: "fail",
        graderType: "llm_judge",
        retryIndex: 0,
        turnNumber: 1,
        sessionId: id,
      })}\n`,
    );
    const got = await runCli(["dataset", "mine"], root);
    expect(got.exitCode).toBe(0);
    const cands = readJsonl(
      join(root, ".crewhaus", "datasets", "_quarantine", "helper-hardcases.jsonl"),
    ) as Array<{ metadata?: Record<string, unknown> }>;
    expect(cands.length).toBe(1);
    expect(cands[0]?.metadata?.["signal"]).toBe("eval-fail");
    expect(cands[0]?.metadata?.["eval_score"]).toBe(0.2);
  });

  // D45's precondition is OPT-IN (`CREWHAUS_WATCHME=1` writes the sidecar) and
  // readSessionTraceEvents degrades to [] in silence, so "zero eval-fail
  // candidates" is indistinguishable from "capture was never on" unless the
  // run says so.
  it("names CREWHAUS_WATCHME when no scanned session carries a trace sidecar", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "sess_00000000000000d6.jsonl"),
      `${JSON.stringify(user("explain the refund window for EU orders"))}\n`,
    );
    const proc = Bun.spawn([process.execPath, CLI_PATH, "dataset", "mine"], {
      cwd: root,
      env: {
        PATH: process.env["PATH"] ?? "",
        CREWHAUS_DATASETS_DIR: join(root, ".crewhaus", "datasets"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("0 with a trace sidecar");
    expect(stdout).toContain("CREWHAUS_WATCHME=1");
  });

  // F3 — non-TTY `--review` must NOT auto-promote without an explicit --yes.
  function seedHardCaseSession(root: string): void {
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const session = [
      user("deploy the payments service to production"),
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "trying" }] } },
      toolResult(true),
      toolResult(true),
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    writeFileSync(join(sessionsDir, "sess_00000000000000d2.jsonl"), `${session}\n`);
  }

  it("non-TTY --review WITHOUT --yes promotes nothing (F3)", async () => {
    const root = newTempRoot();
    seedHardCaseSession(root);

    const got = await runCli(["dataset", "mine", "--review"], root);
    expect(got.exitCode).toBe(0);
    // No mined registry dataset was created — nothing was promoted.
    expect(existsSync(join(root, ".crewhaus", "datasets", "helper-hardcases"))).toBe(false);
  });

  it("non-TTY --review WITH --yes promotes all listed candidates (F3)", async () => {
    const root = newTempRoot();
    seedHardCaseSession(root);

    const got = await runCli(["dataset", "mine", "--review", "--yes"], root);
    expect(got.exitCode).toBe(0);
    const registryDir = join(root, ".crewhaus", "datasets", "helper-hardcases");
    expect(existsSync(registryDir)).toBe(true);
    expect(existsSync(join(registryDir, "v1.json"))).toBe(true);
    const rec = JSON.parse(readFileSync(join(registryDir, "v1.json"), "utf-8"));
    const all = [...rec.splits.train, ...rec.splits.dev, ...(rec.splits.test ?? [])];
    expect(all.length).toBe(1);
  });

  // B23 — mined candidate text is PII/secret-redacted by default before the
  // quarantine file (and any promoted version) is written; --no-redact keeps
  // it raw for dev/local parity with `distill --no-redact`.
  it("redacts candidate inputs by default; --no-redact keeps them raw (B23)", async () => {
    const ssn = ["219", "09", "9999"].join("-");
    const seed = (root: string): void => {
      writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
      const sessionsDir = join(root, ".crewhaus", "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const session = [
        user(`deploy for ssn ${ssn} to production`),
        { kind: "assistant_message", payload: { content: [{ type: "text", text: "trying" }] } },
        toolResult(true),
        toolResult(true),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n");
      writeFileSync(join(sessionsDir, "sess_00000000000000d3.jsonl"), `${session}\n`);
    };
    const quarantineRel = join(".crewhaus", "datasets", "_quarantine", "helper-hardcases.jsonl");

    const redacted = newTempRoot();
    seed(redacted);
    expect((await runCli(["dataset", "mine"], redacted)).exitCode).toBe(0);
    const redactedText = readFileSync(join(redacted, quarantineRel), "utf-8");
    expect(redactedText).not.toContain(ssn);
    expect(redactedText).toContain("[REDACTED:ssn]");

    const raw = newTempRoot();
    seed(raw);
    expect((await runCli(["dataset", "mine", "--no-redact"], raw)).exitCode).toBe(0);
    expect(readFileSync(join(raw, quarantineRel), "utf-8")).toContain(ssn);
  }, 15000);
});

describe("crewhaus dataset synthesize (CLI, offline)", () => {
  it("generates a provenance-tagged synthetic split without touching golds", async () => {
    const root = newTempRoot();
    const goldPath = join(root, "gold.jsonl");
    writeFileSync(
      goldPath,
      [
        JSON.stringify({
          id: "g1",
          input: "Update the billing config for tenant Acme and redeploy the workers now.",
          expected_output: "done",
        }),
      ].join("\n"),
    );

    const got = await runCli(
      [
        "dataset",
        "synthesize",
        "--from",
        "gold.jsonl",
        "--count",
        "3",
        "--out-dataset",
        "helper-synth",
      ],
      root,
    );
    expect(got.exitCode).toBe(0);
    // Registered as a SEPARATE dataset.
    const registryDir = join(root, ".crewhaus", "datasets", "helper-synth");
    expect(existsSync(registryDir)).toBe(true);
    const rec = JSON.parse(readFileSync(join(registryDir, "v1.json"), "utf-8"));
    const all = [...rec.splits.train, ...rec.splits.dev, ...(rec.splits.test ?? [])];
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) {
      expect(s.metadata.source).toBe("synthetic");
      // No synthetic sample ever inherits the gold's expected_output.
      expect(s.expected_output).toBeUndefined();
    }
  });

  it("rejects a missing source", async () => {
    const root = newTempRoot();
    expect(
      (await runCli(["dataset", "synthesize", "--from", "nope.jsonl", "--out-dataset", "x"], root))
        .exitCode,
    ).toBe(1);
  });

  // F1 + F2 — redact-before-mutate-and-write ordering. Offline (no provider
  // credentials in env → the model-paraphrase branch never runs), so this
  // pins the ordering for the deterministic path: every written -synth
  // sample must be built from the REDACTED source input, never the raw one.
  it("redacts a fake SSN + email + API key before any -synth sample is written (F1/F2)", async () => {
    const root = newTempRoot();
    const goldPath = join(root, "gold.jsonl");
    const rawInput =
      "My SSN is 219-09-9999, email me at jane@example.com, and here is the key " +
      "sk-DEADBEEF1234567890ABCDEFGHIJ so you can redeploy the workers now please.";
    writeFileSync(goldPath, JSON.stringify({ id: "g1", input: rawInput, expected_output: "done" }));

    const got = await runCli(
      ["dataset", "synthesize", "--from", "gold.jsonl", "--count", "5", "--out-dataset", "leaky"],
      root,
    );
    expect(got.exitCode).toBe(0);

    const rec = JSON.parse(
      readFileSync(join(root, ".crewhaus", "datasets", "leaky", "v1.json"), "utf-8"),
    );
    const all = [...rec.splits.train, ...rec.splits.dev, ...(rec.splits.test ?? [])] as Array<{
      input: string;
      metadata: Record<string, unknown>;
    }>;
    expect(all.length).toBeGreaterThan(0);

    const asText = JSON.stringify(all);
    // No raw secret/PII anywhere in the written registry version, in ANY
    // variant — including the truncated one, which only keeps the first
    // half of the (already-redacted) sentence.
    expect(asText).not.toContain("sk-DEADBEEF1234567890ABCDEFGHIJ");
    expect(asText).not.toContain("219-09-9999");
    expect(asText).not.toContain("jane@example.com");
    for (const s of all) {
      expect(s.metadata["source"]).toBe("synthetic");
    }
    // Mutation is applied to the ALREADY-redacted text (redact-before-mutate
    // ordering): every non-truncated variant retains all three markers, and
    // at least one variant (paraphrase, which doesn't shorten) proves the
    // key marker survived the full pipeline.
    const nonTruncated = all.filter((s) => s.metadata["mutation"] !== "truncate");
    expect(nonTruncated.length).toBeGreaterThan(0);
    for (const s of nonTruncated) {
      if (s.metadata["mutation"] === "ambiguate") continue; // rewrites the whole sentence
      expect(s.input).toContain("[REDACTED:secret]");
      expect(s.input).toContain("[REDACTED:ssn]");
      expect(s.input).toContain("[REDACTED:email]");
    }
  });
});
