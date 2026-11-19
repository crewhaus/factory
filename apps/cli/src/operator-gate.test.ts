/**
 * The CLI's entry points and the operator record: which verbs are checked, in which mode,
 * and what each refusal exits with.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  { argv: ["runs", "resume", "sess_x", "--prompt", "x"], mode: "run" },
  { argv: ["runs", "resume", "sess_x"], mode: "interactive" },
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

  test("the read verbs, init, status, loadtest, the other runs verbs and --help are not gated", () => {
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
      ["runs", "inspect", "run_00000000000000000000000001"],
      ["runs", "list"],
      ["runs", "resume", "--help"],
      ["runs", "resume", "sess_x", "--prompt", "x", "-h"],
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

describe("runs resume follows the operator record exactly as run does", () => {
  const NOTICE = "Running although new work is paused (--ignore-pause).\n";
  const DISABLED =
    "gate-fixture is disabled by its operator, so this doesn't run. `crewhaus daemon enable` allows it again.\n";

  test("disabled: refused with or without --prompt", () => {
    const dir = harness("disabled");
    expect(gate(dir, ["runs", "resume", "sess_x", "--prompt", "x"])).toEqual({
      exit: 38,
      out: DISABLED,
    });
    expect(gate(dir, ["runs", "resume", "sess_x"])).toEqual({ exit: 38, out: DISABLED });
    expect(gate(dir, ["runs", "resume", "sess_x", "--prompt", "x", "--ignore-pause"]).exit).toBe(
      38,
    );
  });

  test("paused: a --prompt turn exits 39 unless --ignore-pause, which prints the notice; the REPL runs", () => {
    const dir = harness("paused");
    const refused = gate(dir, ["runs", "resume", "sess_x", "--prompt", "x"]);
    expect(refused.exit).toBe(39);
    expect(refused.out).toBe(
      "New work is paused on gate-fixture. `crewhaus daemon resume` reopens it, or pass --ignore-pause to run this once.\n",
    );
    expect(gate(dir, ["runs", "resume", "sess_x", "--prompt", "x", "--ignore-pause"])).toEqual({
      out: NOTICE,
    });
    expect(gate(dir, ["runs", "resume", "sess_x"])).toEqual({ out: "" });
    // --ignore-pause read as the verb reads it: a prompt's value is not the flag.
    expect(gate(dir, ["runs", "resume", "sess_x", "--prompt", "--ignore-pause"]).exit).toBe(39);
    // An argv the verb's parser refuses takes the stricter mode.
    expect(gate(dir, ["runs", "resume", "sess_x", "--input-file", "in.txt"]).exit).toBe(39);
  });

  test("its --spec directory is checked as well as the working directory, through a link too", () => {
    const disabled = harness("disabled");
    const cwd = harness("absent");
    const spec = join(disabled, "crewhaus.yaml");
    expect(gate(cwd, ["runs", "resume", "sess_x", "--spec", spec, "--prompt", "x"])).toEqual({
      exit: 38,
      out: DISABLED,
    });
    expect(gate(cwd, ["runs", "resume", "sess_x", "--spec", spec]).exit).toBe(38);
    expect(gate(cwd, ["runs", "resume", "sess_x", "--spec", relative(cwd, spec)]).exit).toBe(38);
    symlinkSync(spec, join(cwd, "linked.yaml"));
    expect(gate(cwd, ["runs", "resume", "sess_x", "--spec", "linked.yaml"]).exit).toBe(38);
    // The session or run id is never read as a spec.
    expect(gate(cwd, ["runs", "resume", spec, "--prompt", "x"])).toEqual({ out: "" });
    // The default spec is the working directory's crewhaus.yaml, wherever it leads.
    const viaDefault = harness("absent");
    rmSync(join(viaDefault, "crewhaus.yaml"));
    symlinkSync(spec, join(viaDefault, "crewhaus.yaml"));
    expect(gate(viaDefault, ["runs", "resume", "sess_x"]).exit).toBe(38);
  });

  test("help and the read-only runs verbs are not gated on a disabled harness", () => {
    const dir = harness("disabled");
    expect(gate(dir, ["runs", "resume", "--help"])).toEqual({ out: "" });
    expect(gate(dir, ["runs", "inspect", "run_00000000000000000000000001"])).toEqual({ out: "" });
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

  test("a spec reached through a link is checked where it resolves", () => {
    const disabled = harness("disabled");
    const cwd = harness("absent");
    symlinkSync(join(disabled, "crewhaus.yaml"), join(cwd, "link.yaml"));
    const refusal =
      "gate-fixture is disabled by its operator, so this doesn't run. `crewhaus daemon enable` allows it again.\n";
    expect(gate(cwd, ["serve", "--mcp", "link.yaml"])).toEqual({ exit: 38, out: refusal });
    expect(gate(cwd, ["run", "link.yaml", "--prompt", "x"])).toEqual({ exit: 38, out: refusal });
  });

  test("the spec a verb runs by default is checked where it resolves", () => {
    const disabled = harness("disabled");
    const cwd = harness("absent");
    rmSync(join(cwd, "crewhaus.yaml"));
    symlinkSync(join(disabled, "crewhaus.yaml"), join(cwd, "crewhaus.yaml"));
    const refusal =
      "gate-fixture is disabled by its operator, so this doesn't run. `crewhaus daemon enable` allows it again.\n";
    expect(gate(cwd, ["flywheel", "run"])).toEqual({ exit: 38, out: refusal });
    expect(gate(cwd, ["flywheel", "run", "crewhaus.yaml"])).toEqual({ exit: 38, out: refusal });
  });

  test("a dangling spec link is checked where it is named, and a link into an enabled harness passes", () => {
    const cwd = harness("absent");
    symlinkSync(join(cwd, "absent.yaml"), join(cwd, "gone.yaml"));
    expect(gate(cwd, ["serve", "--mcp", "gone.yaml"])).toEqual({ out: "" });
    const enabled = harness("absent");
    symlinkSync(join(enabled, "crewhaus.yaml"), join(cwd, "link.yaml"));
    expect(gate(cwd, ["serve", "--mcp", "link.yaml"])).toEqual({ out: "" });
    expect(gate(cwd, ["run", "link.yaml", "--prompt", "x"])).toEqual({ out: "" });
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

describe("a used-up budget period", () => {
  /** A harness whose period is used up until an hour from now, optionally paused too. */
  function exhausted(state: State): string {
    const dir = harness(state);
    writeFileSync(
      join(dir, ".crewhaus", "run", "control", "budget-state.json"),
      JSON.stringify({
        v: 1,
        periodId: "month-2026-11-01",
        exhaustedAt: "2026-11-18T00:00:00.000Z",
        renewsAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    return dir;
  }

  test("every run-mode verb exits 33 at admission, --ignore-pause included, and says how to raise it", () => {
    const dir = exhausted("absent");
    for (const row of ROWS.filter((r) => r.mode === "run")) {
      for (const extra of [[], ["--ignore-pause"]]) {
        const { exit, out } = gate(dir, [...row.argv, ...extra]);
        expect([row.argv.join(" "), exit]).toEqual([row.argv.join(" "), 33]);
        expect(out).toContain("has used its budget for this period");
        expect(out).toContain("crewhaus budget extend");
      }
    }
  });

  test("the REPL and the servers still start", () => {
    const dir = exhausted("absent");
    for (const row of ROWS.filter((r) => r.mode !== "run")) {
      expect(gate(dir, row.argv).exit).toBeUndefined();
    }
  });

  test("a disable outranks the budget, and the budget outranks a pause", () => {
    expect(gate(exhausted("disabled"), ["run", "crewhaus.yaml", "--prompt", "x"]).exit).toBe(38);
    expect(gate(exhausted("paused"), ["run", "crewhaus.yaml", "--prompt", "x"]).exit).toBe(33);
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

    // A spec reached through a link into a disabled harness exits at the gate.
    const enabled = harness("absent");
    symlinkSync(join(disabled, "crewhaus.yaml"), join(enabled, "link.yaml"));
    const linked = await cli(enabled, ["run", "link.yaml", "--prompt", "x"]);
    expect(linked.exitCode).toBe(38);
    expect(linked.stderr).toContain("is disabled by its operator");
  }, 20_000); // six CLI subprocesses, each loading the whole entry file

  test("runs resume exits 38 when disabled, with or without --prompt; 39 when paused, and --ignore-pause gets past the gate", async () => {
    const session = "sess_0123456789abcdef";
    const disabled = harness("disabled");
    for (const argv of [
      ["runs", "resume", session, "--prompt", "x"],
      ["runs", "resume", session],
    ]) {
      const got = await cli(disabled, argv);
      expect([argv.join(" "), got.exitCode]).toEqual([argv.join(" "), 38]);
      expect(got.stderr).toContain("is disabled by its operator");
    }
    const paused = harness("paused");
    const refused = await cli(paused, ["runs", "resume", session, "--prompt", "x"]);
    expect(refused.exitCode).toBe(39);
    expect(refused.stderr).toContain("New work is paused on gate-fixture.");
    const ignored = await cli(paused, [
      "runs",
      "resume",
      session,
      "--prompt",
      "x",
      "--ignore-pause",
    ]);
    expect(ignored.stderr).toContain("Running although new work is paused (--ignore-pause).");
    expect(ignored.exitCode).not.toBe(39);
  }, 20_000); // four CLI subprocesses, each loading the whole entry file
});

describe("the run stamp records --ignore-pause", () => {
  const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
  const reply = (text: string): string => {
    const base = {
      id: "chatcmpl-stub",
      object: "chat.completion.chunk",
      created: 1,
      model: "stub",
    };
    return [
      sse({
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      }),
      sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      sse({
        ...base,
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
      "data: [DONE]\n\n",
    ].join("");
  };
  // A loopback provider, so the run reaches its first turn and writes its stamp.
  const stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      req.method === "POST" && new URL(req.url).pathname.endsWith("/chat/completions")
        ? new Response(reply("ok"), { headers: { "content-type": "text/event-stream" } })
        : new Response("not found", { status: 404 }),
  });
  afterAll(() => stub.stop(true));

  function stubHarness(state: State): string {
    const dir = harness(state);
    writeFileSync(
      join(dir, "crewhaus.yaml"),
      [
        "name: gate-fixture",
        "target: cli",
        "agent:",
        `  model: local/stub@http://127.0.0.1:${stub.port}/v1`,
        "  instructions: Reply briefly.",
        "",
      ].join("\n"),
    );
    return dir;
  }

  const runOnce = async (
    dir: string,
    args: readonly string[],
    env: Record<string, string> = {},
  ) => {
    const proc = Bun.spawn([process.execPath, CLI_PATH, "run", "crewhaus.yaml", ...args], {
      cwd: dir,
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, CREWHAUS_NO_REGISTRY: "1", ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { stderr, exitCode };
  };

  /** Every `run_stamp` payload in the harness's session logs. */
  const stamps = (dir: string): Record<string, unknown>[] => {
    const sessions = join(dir, ".crewhaus", "sessions");
    const out: Record<string, unknown>[] = [];
    for (const name of readdirSync(sessions)) {
      if (!name.endsWith(".jsonl")) continue;
      for (const line of readFileSync(join(sessions, name), "utf8").split("\n")) {
        if (line === "") continue;
        const parsed = JSON.parse(line) as { kind?: string; payload?: Record<string, unknown> };
        if (parsed.kind === "run_stamp" && parsed.payload !== undefined) out.push(parsed.payload);
      }
    }
    return out;
  };

  test("a paused harness run with --ignore-pause says so; an open one, even with the variable exported, does not", async () => {
    const paused = stubHarness("paused");
    const ignored = await runOnce(paused, ["--prompt", "x", "--ignore-pause"]);
    expect(ignored.exitCode).toBe(0);
    const [pausedStamp] = stamps(paused);
    expect(pausedStamp?.["intake"]).toEqual({ pauseIgnored: true });

    const open = stubHarness("absent");
    expect((await runOnce(open, ["--prompt", "x"])).exitCode).toBe(0);
    const [openStamp] = stamps(open);
    expect(openStamp).toBeDefined();
    expect(openStamp !== undefined && "intake" in openStamp).toBe(false);

    const exported = stubHarness("absent");
    const forged = await runOnce(exported, ["--prompt", "x"], {
      CREWHAUS_INTAKE_PAUSE_IGNORED: "1",
    });
    expect(forged.exitCode).toBe(0);
    const [exportedStamp] = stamps(exported);
    expect(exportedStamp).toBeDefined();
    expect(exportedStamp !== undefined && "intake" in exportedStamp).toBe(false);
  }, 20_000); // three CLI subprocesses, each loading the whole entry file
});
