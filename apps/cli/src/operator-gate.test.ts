/**
 * The CLI's entry points and the operator record: which verbs are checked, in which mode,
 * and what each refusal exits with.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { readOperatorRecord } from "@crewhaus/control-records";
import { entryPointMode, gateEntryPoint } from "./operator-gate";
import { resolveScheduleJob } from "./schedule-generate";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CLI_PATH = join(dirname(new URL(import.meta.url).pathname), "index.ts");

type State = "absent" | "paused" | "disabled" | "unreadable";

function harness(state: State): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "operator-gate-")));
  roots.push(dir);
  writeFileSync(join(dir, "crewhaus.yaml"), "name: gate-fixture\ntarget: cli\n");
  const control = join(dir, ".crewhaus", "run", "control");
  mkdirSync(control, { recursive: true });
  const at = "2026-11-13T00:00:00.000Z";
  const body =
    state === "paused"
      ? { v: 1, rev: 1, intake: { paused: true, since: at }, deployment: null, desired: "running" }
      : state === "disabled"
        ? {
            v: 1,
            rev: 1,
            intake: null,
            deployment: { disabled: true, since: at },
            desired: "running",
          }
        : undefined;
  if (body !== undefined) writeFileSync(join(control, "operator.json"), JSON.stringify(body));
  if (state === "unreadable") writeFileSync(join(control, "operator.json"), "{ torn");
  readOperatorRecord.refresh(dir);
  return dir;
}

/** Run the gate the way `index.ts` does, capturing what it prints and how it exits. */
function gate(dir: string, argv: readonly string[]): { exit?: number; out: string } {
  let out = "";
  let exit: number | undefined;
  const [subcommand = "", ...rest] = argv;
  gateEntryPoint(subcommand, rest, {
    cwd: dir,
    write: (line) => {
      out += line;
    },
    exit: (code) => {
      exit = code;
    },
  });
  return { ...(exit !== undefined ? { exit } : {}), out };
}

const ROWS: ReadonlyArray<{ readonly argv: readonly string[]; readonly mode: string }> = [
  { argv: ["run", "crewhaus.yaml", "--prompt", "x"], mode: "run" },
  { argv: ["run", "crewhaus.yaml"], mode: "interactive" },
  { argv: ["eval", "crewhaus.yaml", "--dataset", "d"], mode: "run" },
  { argv: ["eval", "suite", "suite.yaml"], mode: "run" },
  { argv: ["flywheel", "run"], mode: "run" },
  { argv: ["optimize", "crewhaus.yaml"], mode: "run" },
  { argv: ["dream", "run", "crewhaus.yaml"], mode: "run" },
  { argv: ["dream", "crewhaus.yaml"], mode: "run" },
  { argv: ["serve", "--mcp", "crewhaus.yaml"], mode: "start" },
  { argv: ["dev", "crewhaus.yaml"], mode: "start" },
];

/** What each mode answers per state: the exit, or undefined when it runs. */
const EXPECTED: Readonly<Record<string, Readonly<Record<State, number | undefined>>>> = {
  run: { absent: undefined, paused: 39, disabled: 38, unreadable: 39 },
  interactive: { absent: undefined, paused: undefined, disabled: 38, unreadable: undefined },
  start: { absent: undefined, paused: undefined, disabled: 38, unreadable: 38 },
};

describe("entryPointMode", () => {
  test("every gated verb answers its mode", () => {
    const dir = harness("absent");
    for (const row of ROWS) {
      const [sub = "", ...rest] = row.argv;
      expect([row.argv.join(" "), entryPointMode(sub, rest, { cwd: dir })]).toEqual([
        row.argv.join(" "),
        row.mode,
      ]);
    }
  });

  test("the read verbs, init, status, loadtest, runs resume and --help are not gated", () => {
    const dir = harness("disabled");
    for (const argv of [
      ["eval", "coverage"],
      ["eval", "plan", "--target-delta", "0.1"],
      ["eval", "leaderboard", "matrix"],
      ["eval", "history"],
      ["eval", "baselines"],
      ["eval", "diff", "a", "b"],
      ["flywheel", "init"],
      ["dream", "status", "crewhaus.yaml"],
      ["dream", "init", "crewhaus.yaml"],
      ["loadtest", "crewhaus.yaml"],
      ["runs", "resume", "sess_x"],
      ["eval", "crewhaus.yaml", "--help"],
      ["run", "crewhaus.yaml", "--prompt", "x", "-h"],
      ["compile", "crewhaus.yaml"],
    ]) {
      const [sub = "", ...rest] = argv;
      expect([argv.join(" "), entryPointMode(sub, rest, { cwd: dir })]).toEqual([
        argv.join(" "),
        undefined,
      ]);
      expect(gate(dir, argv).exit).toBeUndefined();
    }
  });

  test("a spec file named like a read verb still takes the run path", () => {
    const dir = harness("absent");
    writeFileSync(join(dir, "plan"), "name: plan\n");
    writeFileSync(join(dir, "history"), "name: history\n");
    expect(entryPointMode("eval", ["plan"], { cwd: dir })).toBe("run");
    expect(entryPointMode("eval", ["history"], { cwd: dir })).toBe("run");
  });
});

describe("gateEntryPoint", () => {
  for (const state of ["absent", "paused", "disabled", "unreadable"] as const) {
    test(`each verb against a ${state} record exits as its mode says, with and without --ignore-pause`, () => {
      const dir = harness(state);
      for (const row of ROWS) {
        const want = EXPECTED[row.mode]?.[state];
        const plain = gate(dir, row.argv);
        expect([row.argv.join(" "), plain.exit]).toEqual([row.argv.join(" "), want]);
        const ignored = gate(dir, [...row.argv, "--ignore-pause"]);
        // --ignore-pause lifts a pause on the run path, and nothing else: an unreadable
        // record still exits 39 and a disabled one 38.
        const lifted = state === "paused" && row.mode === "run" ? undefined : want;
        expect([row.argv.join(" "), ignored.exit]).toEqual([row.argv.join(" "), lifted]);
        if (state === "paused" && row.mode === "run") {
          expect(ignored.out).toBe("Running although new work is paused (--ignore-pause).\n");
        }
      }
    });
  }

  test("a flag is read as the verb's own parser reads it: a value or a token after -- is not a flag", () => {
    const rows: ReadonlyArray<{
      readonly argv: readonly string[];
      readonly state: State;
      readonly exit: number;
    }> = [
      { argv: ["run", "crewhaus.yaml", "--prompt", "-h"], state: "disabled", exit: 38 },
      { argv: ["run", "crewhaus.yaml", "--prompt", "--help"], state: "disabled", exit: 38 },
      {
        argv: ["run", "crewhaus.yaml", "--prompt", "x", "--", "--help"],
        state: "disabled",
        exit: 38,
      },
      { argv: ["eval", "crewhaus.yaml", "--dataset", "-h"], state: "disabled", exit: 38 },
      { argv: ["eval", "suite", "suite.yaml", "--", "--help"], state: "disabled", exit: 38 },
      { argv: ["flywheel", "run", "--", "-h"], state: "disabled", exit: 38 },
      { argv: ["serve", "crewhaus.yaml", "--", "-h"], state: "disabled", exit: 38 },
      { argv: ["dev", "crewhaus.yaml", "--", "--help"], state: "disabled", exit: 38 },
      { argv: ["run", "crewhaus.yaml", "--prompt", "-h"], state: "paused", exit: 39 },
      { argv: ["run", "crewhaus.yaml", "--prompt", "--ignore-pause"], state: "paused", exit: 39 },
      {
        argv: ["run", "crewhaus.yaml", "--prompt", "x", "--", "--ignore-pause"],
        state: "paused",
        exit: 39,
      },
      { argv: ["optimize", "crewhaus.yaml", "--", "--ignore-pause"], state: "paused", exit: 39 },
    ];
    for (const row of rows) {
      const got = gate(harness(row.state), row.argv);
      expect([row.state, row.argv.join(" "), got.exit]).toEqual([
        row.state,
        row.argv.join(" "),
        row.exit,
      ]);
      expect(got.out).not.toContain("--ignore-pause).");
    }
  });

  test("an argv the verb's parser refuses is still checked, in its strictest mode", () => {
    for (const argv of [
      ["run", "crewhaus.yaml", "--no-such-flag"],
      ["run", "crewhaus.yaml", "--prompt"],
      // The parser has no `--name=value` form: the dispatch dies on it, so it lifts nothing.
      ["run", "crewhaus.yaml", "--prompt=x", "--ignore-pause"],
      ["eval", "crewhaus.yaml", "--no-such-flag", "-h"],
    ]) {
      expect([argv.join(" "), gate(harness("paused"), argv).exit]).toEqual([argv.join(" "), 39]);
      expect([argv.join(" "), gate(harness("disabled"), argv).exit]).toEqual([argv.join(" "), 38]);
    }
    expect(gate(harness("disabled"), ["serve", "crewhaus.yaml", "--no-such-flag"]).exit).toBe(38);
  });

  test("each refusal says why in one line and names the verb that lifts it", () => {
    expect(gate(harness("disabled"), ["eval", "crewhaus.yaml"]).out).toBe(
      "gate-fixture is disabled by its operator, so this doesn't run. `crewhaus daemon enable` allows it again.\n",
    );
    expect(gate(harness("paused"), ["optimize", "crewhaus.yaml"]).out).toBe(
      "New work is paused on gate-fixture. `crewhaus daemon resume` reopens it, or pass --ignore-pause to run this once.\n",
    );
    const unreadable = gate(harness("unreadable"), ["flywheel", "run"]).out;
    expect(unreadable).toStartWith("The operator record can't be read (");
    expect(unreadable).toContain("operator.json");
    expect(unreadable).toEndWith("), so nothing runs here.\n");
  });

  test("a scheduled unit's command is refused on a disabled harness", () => {
    const dir = harness("disabled");
    for (const target of ["flywheel", "eval-gate"] as const) {
      const job = resolveScheduleJob({ target, dir } as Parameters<typeof resolveScheduleJob>[0]);
      const argv = job.command.split(" ").slice(1);
      expect(argv[0]).toBe(target === "flywheel" ? "flywheel" : "eval");
      expect(gate(dir, argv).exit).toBe(38);
    }
  });
});

describe("the entry gate checks the spec's own directory and the working directory", () => {
  test("a spec in a disabled harness, run from an enabled directory, exits 38 naming that harness", () => {
    const disabled = harness("disabled");
    const cwd = harness("absent");
    for (const argv of [
      ["serve", join(disabled, "crewhaus.yaml")],
      ["dev", join(disabled, "crewhaus.yaml")],
      ["run", join(disabled, "crewhaus.yaml"), "--prompt", "x"],
      ["eval", join(disabled, "crewhaus.yaml"), "--dataset", "d"],
      ["optimize", join(disabled, "crewhaus.yaml")],
      ["flywheel", "run", join(disabled, "crewhaus.yaml")],
      ["dream", "run", join(disabled, "crewhaus.yaml")],
    ]) {
      const got = gate(cwd, argv);
      expect([argv[0], got.exit]).toEqual([argv[0], 38]);
      expect(got.out).toBe(
        "gate-fixture is disabled by its operator, so this doesn't run. `crewhaus daemon enable` allows it again.\n",
      );
    }
    // A relative path names the same directory.
    const sibling = relative(cwd, join(disabled, "crewhaus.yaml"));
    expect(gate(cwd, ["serve", sibling]).exit).toBe(38);
  });

  test("a spec in an enabled harness, run from a disabled directory, still exits 38", () => {
    const enabled = harness("absent");
    expect(gate(harness("disabled"), ["serve", join(enabled, "crewhaus.yaml")]).exit).toBe(38);
  });

  test("a spec in an enabled harness, run from an enabled directory, passes the gate", () => {
    const enabled = harness("absent");
    const got = gate(harness("absent"), ["serve", join(enabled, "crewhaus.yaml")]);
    expect(got).toEqual({ out: "" });
  });

  test("an eval suite is checked against each spec it runs, not the manifest's directory", () => {
    const disabled = harness("disabled");
    const cwd = harness("absent");
    const disabledSpec = join(disabled, "crewhaus.yaml");
    const suite = (spec: string | undefined, at: string = cwd): string => {
      const path = join(at, "suite.yaml");
      const entry = `      - name: e1\n        dataset: d.jsonl\n        graders: g.yaml\n        thresholds: { min_pass_rate: 0.5 }\n${spec === undefined ? "" : `        spec: ${JSON.stringify(spec)}\n`}`;
      writeFileSync(path, `name: s\ntiers:\n  fast:\n${entry}`);
      return path;
    };
    const refusal =
      "gate-fixture is disabled by its operator, so this doesn't run. `crewhaus daemon enable` allows it again.\n";
    // --spec overrides every entry's spec, so its directory is checked.
    suite(undefined);
    const overridden = gate(cwd, ["eval", "suite", "suite.yaml", "--spec", disabledSpec]);
    expect(overridden).toEqual({ exit: 38, out: refusal });
    // An entry's own spec, resolved from the working directory as the verb resolves it.
    suite(relative(cwd, disabledSpec));
    expect(gate(cwd, ["eval", "suite", "suite.yaml"])).toEqual({ exit: 38, out: refusal });
    // --spec replaces the entry's spec: an enabled override runs.
    const enabledSpec = join(harness("absent"), "crewhaus.yaml");
    expect(gate(cwd, ["eval", "suite", "suite.yaml", "--spec", enabledSpec])).toEqual({ out: "" });
    // The manifest's own directory is not a spec the suite runs.
    const inDisabled = suite(join(cwd, "crewhaus.yaml"), disabled);
    expect(gate(cwd, ["eval", "suite", inDisabled])).toEqual({ out: "" });
  });

  test("the stricter verdict decides: a disabled spec directory outranks a paused working directory", () => {
    const disabled = harness("disabled");
    const got = gate(harness("paused"), ["run", join(disabled, "crewhaus.yaml"), "--prompt", "x"]);
    expect(got.exit).toBe(38);
    expect(got.out).toContain("is disabled by its operator");
    // A paused spec directory refuses a run, and --ignore-pause lifts both pauses.
    const paused = harness("paused");
    const argv = ["run", join(paused, "crewhaus.yaml"), "--prompt", "x"];
    expect(gate(harness("absent"), argv).exit).toBe(39);
    const ignored = gate(harness("paused"), [...argv, "--ignore-pause"]);
    expect(ignored).toEqual({ out: "Running although new work is paused (--ignore-pause).\n" });
  });
});

describe("the crewhaus binary", () => {
  const cli = async (dir: string, args: readonly string[]) => {
    const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
      cwd: dir,
      // No credentials: a run the gate lets through fails before any model call.
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, CREWHAUS_NO_REGISTRY: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { stderr, exitCode };
  };

  test("eval and run --prompt exit 38 when disabled; run --prompt exits 39 when paused, and --ignore-pause gets past the gate", async () => {
    const disabled = harness("disabled");
    const evaled = await cli(disabled, ["eval", "crewhaus.yaml", "--dataset", "d"]);
    expect(evaled.exitCode).toBe(38);
    expect(evaled.stderr).toContain("is disabled by its operator");
    expect((await cli(disabled, ["run", "crewhaus.yaml", "--prompt", "x"])).exitCode).toBe(38);
    expect((await cli(disabled, ["run", "crewhaus.yaml", "--prompt", "-h"])).exitCode).toBe(38);

    const paused = harness("paused");
    const refused = await cli(paused, ["run", "crewhaus.yaml", "--prompt", "x"]);
    expect(refused.exitCode).toBe(39);
    expect(refused.stderr).toContain("New work is paused on gate-fixture.");
    const ignored = await cli(paused, ["run", "crewhaus.yaml", "--prompt", "x", "--ignore-pause"]);
    expect(ignored.stderr).toContain("Running although new work is paused (--ignore-pause).");
    expect(ignored.exitCode).not.toBe(39);
  }, 20_000); // five CLI subprocesses, each loading the whole entry file
});
