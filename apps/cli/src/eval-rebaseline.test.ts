/**
 * `crewhaus eval --rebaseline --reason <code>`: the flag parse, and the
 * refusals the CLI makes before any dataset load or model spend.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { governedHome, project, removeGovernedDirs } from "./__test__/governed";
import {
  REBASELINE_CMD,
  REBASELINE_REASONS,
  parseRebaseline,
  reanchorDirRefusal,
} from "./eval-rebaseline";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI_PATH = join(SRC_DIR, "index.ts");
const HELLO_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-cli/crewhaus.yaml");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-rebaseline-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
  removeGovernedDirs();
});

const SPAWN_CWD = newTempRoot();
const REGISTRY_ROOT = newTempRoot();

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string = SPAWN_CWD,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      CREWHAUS_REGISTRY_ROOT: join(REGISTRY_ROOT, "registry"),
      CREWHAUS_WATCHME_ROOT: join(REGISTRY_ROOT, "watchme"),
      CREWHAUS_DATASETS_DIR: join(newTempRoot(), "datasets"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const BASE = ["eval", HELLO_SPEC, "--dataset", "d.jsonl", "--graders", "g.yaml"];

describe("parseRebaseline", () => {
  test("neither flag: nothing to re-anchor", () => {
    expect(parseRebaseline({})).toEqual({ ok: true });
  });

  test("each reason code re-anchors, recording the command", () => {
    for (const reason of REBASELINE_REASONS) {
      expect(parseRebaseline({ rebaseline: true, reason })).toEqual({
        ok: true,
        rebaseline: { reason, cmd: REBASELINE_CMD },
      });
    }
    expect(REBASELINE_REASONS).toEqual([
      "instrument-changed",
      "cases-changed",
      "baseline-unreadable",
      "reset",
    ]);
  });

  test("--reason without --rebaseline, --rebaseline without --reason, and an unknown code are refused", () => {
    expect(parseRebaseline({ reason: "reset" })).toEqual({
      ok: false,
      error: "--reason is only valid with --rebaseline",
    });
    const missing = parseRebaseline({ rebaseline: true });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("requires --reason <code>");
    const unknown = parseRebaseline({ rebaseline: true, reason: "manual" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error).toContain('"manual" is not a re-anchor reason');
      for (const code of REBASELINE_REASONS) expect(unknown.error).toContain(code);
    }
  });

  test("each flag a re-anchor cannot combine with is refused, naming it", () => {
    for (const [flag, value] of [
      ["no-promote", true],
      ["models", "a,b"],
      ["sentinel", true],
      ["resume", "run"],
      ["provability", "cited"],
    ] as const) {
      const parsed = parseRebaseline({ rebaseline: true, reason: "reset", [flag]: value });
      expect({ flag, ok: parsed.ok }).toEqual({ flag, ok: false });
      if (!parsed.ok)
        expect(parsed.error).toContain(`--rebaseline and --${flag} cannot be combined`);
    }
  });
});

describe("crewhaus eval --rebaseline — refused before anything runs", () => {
  test("--help documents --rebaseline and the not-comparable rules", async () => {
    const got = await runCli(["eval", "--help"]);
    expect(got.exitCode).toBe(0);
    expect(got.stdout).toContain("[--rebaseline --reason <code>]");
    expect(got.stdout).toContain("comparable with its baseline");
    expect(got.stdout).toContain("instrument-changed, cases-changed");
  }, 20_000);

  for (const [label, args, message] of [
    ["--reason alone", ["--reason", "reset"], "--reason is only valid with --rebaseline"],
    ["--rebaseline alone", ["--rebaseline"], "--rebaseline requires --reason"],
    ["an unknown code", ["--rebaseline", "--reason", "whim"], "is not a re-anchor reason"],
    [
      "--rebaseline with --no-promote",
      ["--rebaseline", "--reason", "reset", "--no-promote"],
      "--rebaseline and --no-promote cannot be combined",
    ],
  ] as const) {
    test(`${label} is refused`, async () => {
      const got = await runCli([...BASE, ...args]);
      expect(got.exitCode).toBe(1);
      expect(got.stderr).toContain(message);
    }, 20_000);
  }

  test("--rebaseline under --voice is refused, never silently ignored", async () => {
    for (const args of [["--rebaseline"], ["--reason", "reset"]]) {
      const got = await runCli(["eval", "--voice", ...args]);
      expect(got.exitCode).toBe(1);
      expect(got.stderr).toContain(`--voice does not support ${args[0]}`);
    }
  }, 20_000);
});

describe("a re-anchor runs from the spec's own directory, whose eval history it writes", () => {
  test("the spec's directory, or a link to it, may re-anchor; any other directory may not", () => {
    const harness = realpathSync(newTempRoot());
    writeFileSync(join(harness, "crewhaus.yaml"), "name: shop\n");
    const elsewhere = realpathSync(newTempRoot());
    const link = join(elsewhere, "to-harness");
    symlinkSync(harness, link);
    expect(reanchorDirRefusal("crewhaus.yaml", harness, "--rebaseline")).toBeUndefined();
    expect(reanchorDirRefusal("crewhaus.yaml", link, "--rebaseline")).toBeUndefined();
    // The spec named from another directory, or a link to it in another directory.
    const linked = join(elsewhere, "crewhaus.yaml");
    symlinkSync(join(harness, "crewhaus.yaml"), linked);
    for (const [spec, cwd] of [
      [join(harness, "crewhaus.yaml"), elsewhere],
      [linked, harness],
      ["crewhaus.yaml", join(harness, "missing")],
    ] as const) {
      for (const flag of ["--rebaseline", "--regrade-baseline"] as const) {
        const refused = reanchorDirRefusal(spec, cwd, flag);
        expect(refused).toContain(`${flag} re-anchors the baseline in the eval history`);
        expect(refused).toContain("runs from the spec's own directory");
      }
    }
  });

  test("from a governed harness, a spec outside it is refused before anything runs, and the pins keep their bytes", async () => {
    const home = await governedHome({ username: "owner", hostname: "elsewhere.invalid" });
    const harness = realpathSync(newTempRoot());
    copyFileSync(HELLO_SPEC, join(harness, "crewhaus.yaml"));
    project(harness, home.owner, [], home.hangarRoot);
    const evalsDir = join(harness, ".crewhaus", "evals");
    mkdirSync(evalsDir, { recursive: true });
    const pins = `${JSON.stringify({ "hello::smoke": { runId: "run_0000000000000001" } })}\n`;
    writeFileSync(join(evalsDir, "baselines.json"), pins);
    const outside = realpathSync(newTempRoot());
    copyFileSync(HELLO_SPEC, join(outside, "crewhaus.yaml"));
    for (const flags of [
      ["--rebaseline", "--reason", "instrument-changed"],
      ["--regrade-baseline"],
    ]) {
      const got = await runCli(
        [
          "eval",
          join(outside, "crewhaus.yaml"),
          "--dataset",
          "d.jsonl",
          "--graders",
          "g.yaml",
          ...flags,
        ],
        harness,
      );
      expect(got.exitCode).toBe(1);
      expect(got.stderr).toContain(`${flags[0]} re-anchors the baseline in the eval history`);
      expect(readFileSync(join(evalsDir, "baselines.json"), "utf8")).toBe(pins);
    }
  }, 20_000);
});
