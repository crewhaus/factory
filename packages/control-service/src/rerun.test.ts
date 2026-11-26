/**
 * Run again's input: the recorded request while its input file exists (a `.json` file's
 * `input` only), else the run's seed message, read whole; refused, saying why, when it is
 * too large or was not kept.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintRunId } from "@crewhaus/control-contract";
import { append, controlPaths, runsLedger } from "@crewhaus/control-records";
import { RERUN_INPUT_MAX_BYTES, rerunInputOf } from "./rerun";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = "sess_00000000000000c3";
const OPTS = { envVars: {}, now: Date.parse("2026-11-20T00:00:00.000Z") };

function harness(): { readonly dir: string; readonly inputs: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "control-service-rerun-")));
  made.push(dir);
  writeFileSync(join(dir, "crewhaus.yaml"), "name: rerun\ntarget: cli\n");
  const inputs = join(dir, controlPaths(dir).inputsDir);
  mkdirSync(inputs, { recursive: true });
  return { dir, inputs };
}

/** A run whose session log holds its stamp and its seed message. */
function seeded(dir: string, run: string, seed: string): void {
  const sessions = join(dir, ".crewhaus", "sessions");
  mkdirSync(sessions, { recursive: true });
  const line = (kind: string, payload: unknown) =>
    JSON.stringify({ ts: 1, version: 1, kind, payload, run, span: "0000000000000101" });
  writeFileSync(
    join(sessions, `${SESSION}.jsonl`),
    `${line("run_stamp", { v: 1, run, trigger: { kind: "api" } })}\n${line("user_message", { content: seed })}\n`,
  );
  const written = append(runsLedger(dir), {
    at: "2026-11-20T00:00:00.000Z",
    id: run,
    state: "running",
    trigger: { kind: "api" },
    session: SESSION,
    sessionAt: 0,
  });
  if (!written.ok) throw new Error("row not written");
}

describe("rerunInputOf", () => {
  test("a .txt input file is the input; a .json file gives its input and never its subject", () => {
    const { dir, inputs } = harness();
    const txt = mintRunId();
    writeFileSync(join(inputs, `${txt}.txt`), "summarize the queue");
    expect(rerunInputOf(dir, txt, OPTS)).toEqual({
      ok: true,
      input: "summarize the queue",
      source: "input-file",
    });
    const json = mintRunId();
    writeFileSync(
      join(inputs, `${json}.json`),
      `${JSON.stringify({ v: 1, run: json, input: "triage", subject: "sub_alice", tenant: "t" })}\n`,
    );
    const got = rerunInputOf(dir, json, OPTS);
    expect(got).toEqual({ ok: true, input: "triage", source: "input-file" });
    expect(JSON.stringify(got)).not.toContain("sub_alice");
  });

  test("once the input file is gone, the seed message from the session log, whole", () => {
    const { dir } = harness();
    const run = mintRunId();
    const seed = `please look at ${"x".repeat(5000)}`;
    seeded(dir, run, seed);
    expect(rerunInputOf(dir, run, OPTS)).toEqual({ ok: true, input: seed, source: "seed" });
  });

  test("an input file that is a link is not read: the seed is used", () => {
    const { dir, inputs } = harness();
    const run = mintRunId();
    seeded(dir, run, "the seed");
    const elsewhere = join(dir, "elsewhere.txt");
    writeFileSync(elsewhere, "planted");
    symlinkSync(elsewhere, join(inputs, `${run}.txt`));
    expect(rerunInputOf(dir, run, OPTS)).toEqual({ ok: true, input: "the seed", source: "seed" });
  });

  test("too large, or not kept: refused, saying why", () => {
    const { dir, inputs } = harness();
    const big = mintRunId();
    writeFileSync(join(inputs, `${big}.txt`), "y".repeat(RERUN_INPUT_MAX_BYTES + 1));
    expect(rerunInputOf(dir, big, OPTS)).toMatchObject({
      ok: false,
      refusal: { code: "unsupported", reason: "input_too_large" },
    });
    const bigSeed = mintRunId();
    seeded(dir, bigSeed, "z".repeat(RERUN_INPUT_MAX_BYTES + 1));
    expect(rerunInputOf(dir, bigSeed, OPTS)).toMatchObject({
      ok: false,
      refusal: { code: "unsupported", reason: "input_too_large" },
    });
    expect(rerunInputOf(dir, mintRunId(), OPTS)).toMatchObject({
      ok: false,
      refusal: {
        code: "unsupported",
        reason: "input_not_kept",
        message: "This run's request was not kept, so it can't be run again.",
      },
    });
  });
});
