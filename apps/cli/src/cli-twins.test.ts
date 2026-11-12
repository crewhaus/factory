/**
 * Every command-line equivalent Home shows is a command the CLI runs.
 *
 * Home shows "the exact command that does the same thing in a terminal"
 * beside its actions and its empty states. That is only worth anything if the
 * command runs when pasted: one that fails teaches an operator the console's
 * commands are decorative. So every source of one is checked here, against
 * the CLI's own verb inventory (`verbs.ts`, every family's `CLI_FAMILY`) and
 * its real argument parser, by `__test__/twin-check.ts`:
 *
 *   1. the checker itself, on commands it must refuse and ones it must accept;
 *   2. the server's twin builders, by import;
 *   3. the console's twin builder, by import of its browser module;
 *   4. the job vocabulary, the same on both sides;
 *   5. the one quoting rule, the same on both sides and in a real shell;
 *   6. what a running Home actually serves, every read route swept;
 *   7. every command spelled in the server's and the console's source;
 *   8. a note, or a command, for every write the route table lists.
 *
 * Each source asserts how many commands it yielded, so a source that goes
 * quiet fails rather than passing on nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContinuityStore } from "@crewhaus/continuity-store";
import { CLI_VERBS, COMMAND_KINDS, OPERATIONS, renderTwin } from "@crewhaus/control-contract";
import {
  M3_ROUTES,
  actionCliTwins,
  demoAvailability,
  makeFixtureHarness,
  matchActions,
  onboardingView,
  proofCliTwin,
} from "@crewhaus/hangar-server";
import {
  EVAL_COMMAND,
  EVAL_JOB_ARGV,
  type LaunchOffers,
  OPTIMIZE_COMMAND,
  OPTIMIZE_JOB_ARGV,
  evalArgv,
  flywheelArgv,
  optimizeArgv,
  sentinelArgv,
} from "@crewhaus/hangar-server/eval-inputs";
import {
  ADVISOR_CLI_TWINS,
  MAX_FACT_FILE_BYTES,
  ROUTE_TABLE,
  ROUTE_TWIN_NOTES,
  devArgv,
  mcpArgv,
  runtimeOpTwin,
} from "@crewhaus/hangar-server/twin-sources";
import { shellQuote as supervisorQuote } from "@crewhaus/harness-supervisor";
import { JOB_KINDS, jobArgv } from "@crewhaus/harness-supervisor/job-kinds";
import { createWikiStore } from "@crewhaus/wiki-store";
import { VALUE, commandsIn, commandsUnder } from "./__test__/literals";
import {
  REQUIRED,
  checkLine,
  checkRequirement,
  realInventory,
  shellWords,
} from "./__test__/twin-check";
import { type TwinHome, bootTwinHome } from "./__test__/twin-home";
import type { Inventory } from "./verbs";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const REPO = join(import.meta.dir, "..", "..", "..");

let inv: Inventory;
beforeAll(async () => {
  inv = await realInventory();
});

/** Assert one line would run, naming the line and the reason on failure. */
function expectRunnable(label: string, line: string): void {
  expect(`${label} ⇒ ${line} ⇒ ${checkLine(inv, line) ?? "runs"}`).toBe(
    `${label} ⇒ ${line} ⇒ runs`,
  );
}

describe("the checker", () => {
  test("refuses the commands that never existed, each with its reason", () => {
    const refused: ReadonlyArray<readonly [string, string]> = [
      ["crewhaus hangar add <dir>", 'unknown hangar verb "add"'],
      ["crewhaus feedback faq --distill", "unknown flag: --distill"],
      ["crewhaus distill --preferences", "unknown flag: --preferences"],
      ["crewhaus memory migrate", 'unknown memory sub-verb "migrate"'],
      ["crewhaus remember", 'unknown verb "remember"'],
      ["crewhaus eval --models", 'flag "--models" requires a value'],
      ["crewhaus run (cost tracking is on by default)", "a parenthesis"],
      ["crewhaus daemon start --dir /h", 'unknown flag "--dir"'],
      ["crewhaus harness scan-root add /h", 'unknown harness verb "scan-root"'],
      ["crewhaus x | sh", "a pipe"],
      ["crewhaus memory list --spec=fabric", "unknown flag: --spec=fabric"],
      ["crewhaus harness list --group=ops", "write the flag and its value apart"],
      ["crewhaus daemon wake --lane", "--lane needs a value"],
      ["crewhaus access mint --service s --expires 1d --expires 2d", "can be given once"],
      ["crewhaus memory list …", "an ellipsis"],
      ["crewhaus harness list [--json]", "glob"],
      ["crewhaus run $(id)", "expansion"],
      ["crewhaus run `id`", "backtick"],
      ["crewhaus run 'unbalanced", "unbalanced single quote"],
      ["crewhaus run > out.txt", "redirect"],
      ["crewhaus <verb> list", "stands where a verb must be named"],
      ["crewhaus memory list && rm -rf x", 'not a crewhaus command: "rm"'],
      ["echo hi", "no crewhaus command"],
      ["crewhaus version --json", "declares no flags"],
      ["crewhaus pricing", "needs a sub-verb"],
      ["crewhaus rate --session s --turn 1 up|down", "offers a choice"],
      // Parsed, but refused before it does anything.
      ["crewhaus run", "crewhaus run needs an argument"],
      ["crewhaus rate", "crewhaus rate needs --session"],
      ["crewhaus rate --session <session> --adjudicate", "needs one of --thumbs, --stars, --score"],
      ["crewhaus distill", "needs one of --out, --register"],
      ["crewhaus distill --register <dataset>", "needs one of --session, --all-sessions"],
      ["crewhaus experiment record --name <n> --version <v>", "needs --outcome"],
      ["crewhaus experiment assign --name <n>", "needs --key"],
      ["crewhaus harness add", "crewhaus harness add needs an argument"],
      ["crewhaus harness relocate <id>", "needs 2 arguments"],
      ["crewhaus hangar serve extra", "takes no arguments"],
      ["crewhaus hangar extra", "unknown hangar verb"],
      ["crewhaus access members extra", "takes no arguments"],
      ["crewhaus access grant --member <m>", "needs --role"],
      ["crewhaus access unlink", "needs an argument"],
    ];
    for (const [line, reason] of refused) {
      expect(`${line} ⇒ ${checkLine(inv, line) ?? "runs"}`).toContain(reason);
    }
  });

  test("accepts the forms the screens show", () => {
    for (const line of [
      "crewhaus daemon start --group g --parallel",
      // From the module's own flags: --member-order parses (it needs --add to run).
      "crewhaus harness group g --add <dir> --member-order 2",
      "cd '/srv/my harnesses/poly' && crewhaus daemon restart",
      "crewhaus 'run' 'crewhaus.yaml'",
      // `eval <spec>`: the spec is the verb's own positional.
      "crewhaus eval crewhaus.yaml --dataset <dataset> --graders <graders> --models <models>",
      // A choice in a flag value, and in a sub-verb.
      "crewhaus rate --session <s> --turn <n> --thumbs up|down --adjudicate",
      "crewhaus watchme start|stop",
      "crewhaus hangar --no-open",
      "crewhaus access mint --service s --permission a --permission b",
      "crewhaus memory list --spec fabric  # a comment",
      "crewhaus approvals",
      "cp -R <starter-dir> <dir> && crewhaus harness add <dir>",
      "crewhaus dream crewhaus.yaml",
      "crewhaus security corpus check",
      "crewhaus run crewhaus.yaml",
      "crewhaus distill --all-sessions --register <dataset>",
      "crewhaus distill --session <session> -o <file>",
      "crewhaus experiment record --name <name> --version <version> --outcome pass|fail",
      "crewhaus harness relocate <id> <dir>",
      "crewhaus access link <account> --member <member>",
    ]) {
      expectRunnable("accepted", line);
    }
  });

  test("each requirement it holds a command to is the CLI's own refusal", () => {
    const sources = new Map<string, string>();
    const read = (file: string): string => {
      let text = sources.get(file);
      if (text === undefined) {
        text = readFileSync(join(import.meta.dir, file), "utf8");
        sources.set(file, text);
      }
      return text;
    };
    let pins = 0;
    for (const [key, need] of Object.entries(REQUIRED)) {
      expect(`${key}: ${need.pins.length > 0}`).toBe(`${key}: true`);
      for (const pin of need.pins) {
        let text = read(pin.file);
        if (pin.within !== undefined) {
          const start = text.indexOf(pin.within);
          expect(`${key}: ${pin.within} ${start > -1}`).toBe(`${key}: ${pin.within} true`);
          const end = text.indexOf("\n}\n", start);
          text = text.slice(start, end === -1 ? undefined : end);
        }
        expect(`${key}: ${pin.file} holds ${pin.text}: ${text.includes(pin.text)}`).toBe(
          `${key}: ${pin.file} holds ${pin.text}: true`,
        );
        pins++;
      }
    }
    expect(Object.keys(REQUIRED).length).toBe(26);
    expect(pins).toBe(37);
  });

  test("a requirement it is given is applied, and a key it is not given is not", () => {
    const table = {
      "x y": { positionals: { min: 1, max: 2 }, flags: ["a"], oneOf: [["b", "c"]], pins: [] },
    };
    expect(checkRequirement("x y", 0, new Set(["a", "b"]), table)).toContain("needs an argument");
    expect(checkRequirement("x y", 3, new Set(["a", "b"]), table)).toContain("at most 2");
    expect(checkRequirement("x y", 1, new Set(["b"]), table)).toContain("needs --a");
    expect(checkRequirement("x y", 1, new Set(["a"]), table)).toContain("one of --b, --c");
    expect(checkRequirement("x y", 1, new Set(["a", "c"]), table)).toBeNull();
    expect(checkRequirement("x z", 0, new Set(), table)).toBeNull();
  });
});

const OFFERS: LaunchOffers = {
  eval: { offered: true, shapeOk: true, note: null, verb: "crewhaus x" },
  optimize: { offered: true, shapeOk: true, note: null, verb: "crewhaus x" },
  flywheel: { offered: true, shapeOk: true, note: null, verb: "crewhaus x" },
  conventional: { dataset: true, graders: true },
};

describe("the server's twins, by import", () => {
  test("the omnibox's, with a path that needs quoting", () => {
    const twins = actionCliTwins("/srv/harnesses/poly");
    expect(twins.length).toBe(4);
    for (const twin of twins) {
      expectRunnable("omnibox", twin);
      expect(twin).not.toContain("--dir");
    }
    const spaced = matchActions("restart poly", [
      { id: "hrn_00000000000000a1", specName: "poly", dir: "/srv/my harnesses/poly" },
    ]);
    expect(spaced[0]?.cliTwin).toBe("crewhaus daemon restart '/srv/my harnesses/poly'");
    expectRunnable("omnibox (spaced path)", spaced[0]?.cliTwin ?? "");
  });

  test("the first screen a new operator sees", () => {
    const twins = onboardingView({
      harnessCount: 0,
      scanRootCount: 0,
      suggestions: [],
      demo: demoAvailability({}),
      completedAt: null,
    }).cliTwins;
    expect(Object.keys(twins).length).toBe(5);
    for (const [name, twin] of Object.entries(twins)) expectRunnable(`onboarding.${name}`, twin);
  });

  test("the advisor's job commands", () => {
    const twins = Object.entries(ADVISOR_CLI_TWINS);
    expect(twins.length).toBe(10);
    for (const [kind, twin] of twins) expectRunnable(`advisor.${kind}`, twin);
  });

  test("the proof twin, whose session id and tenants root are quoted", () => {
    const session = "sess_it's here";
    const twins = [
      proofCliTwin("/srv/my harnesses/poly", "sess_0123456789abcdef", 7),
      proofCliTwin("/srv/poly", session, 7, ".crewhaus/tenants'root"),
      proofCliTwin("/srv/poly", session, 7, ".crewhaus/tenants", 2),
    ];
    for (const twin of twins) expectRunnable("proof", twin);
    const words = shellWords(twins[1] ?? "");
    expect(words[1]).toContain(session);
    expect(words[1]).toContain(".crewhaus/tenants'root");
  });

  test("the runtime operations' twins, over each argv they are built with", () => {
    const twins = [
      runtimeOpTwin("/srv/my harnesses/poly", mcpArgv("crewhaus.yaml", "stdio", 8000)),
      runtimeOpTwin("/srv/poly", mcpArgv("crewhaus.yaml", "sse", 8123)),
      runtimeOpTwin("/srv/poly", devArgv("crewhaus.yaml", false)),
      runtimeOpTwin("/srv/poly", devArgv("crewhaus.yaml", true)),
    ];
    for (const twin of twins) expectRunnable("runtime-ops", twin);
    // Every argv word arrives quoted, the verb included.
    expect(shellWords(twins[0] ?? "")[1]?.slice(0, 3)).toEqual(["crewhaus", "serve", "--mcp"]);
  });

  test("the eval stack's commands, from the argv builders the jobs run", () => {
    const lines = [
      EVAL_COMMAND,
      OPTIMIZE_COMMAND,
      `crewhaus ${EVAL_JOB_ARGV.join(" ")}`,
      `crewhaus ${OPTIMIZE_JOB_ARGV.join(" ")}`,
      `crewhaus ${evalArgv({ slice: "easy", repeats: 2, gate: true }, OFFERS).argv.join(" ")}`,
      `crewhaus ${optimizeArgv({ mutator: "rule-based" }, OFFERS).argv.join(" ")}`,
      `crewhaus ${sentinelArgv({}, OFFERS).argv.join(" ")}`,
      `crewhaus ${flywheelArgv({ action: "run", budgetUsd: 1, iterations: 2 }, OFFERS).argv.join(" ")}`,
      `crewhaus ${optimizeArgv({ fromAdvice: true }, OFFERS).argv.join(" ")}`,
      `crewhaus ${flywheelArgv({ action: "init" }, OFFERS).argv.join(" ")}`,
    ];
    for (const line of lines) expectRunnable("eval-inputs", line);
  });

  test("the control contract's verbs are all in the inventory", () => {
    let pairs = 0;
    for (const [noun, verbs] of Object.entries(CLI_VERBS)) {
      for (const verb of verbs) {
        // The vocabulary a twin may start with; a verb that takes an argument gets one.
        const args = " <arg>".repeat(REQUIRED[`${noun} ${verb}`]?.positionals?.min ?? 0);
        expectRunnable(`CLI_VERBS ${noun}`, `crewhaus ${noun} ${verb}${args}`);
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThanOrEqual(9);
  });

  test("operations, command kinds and the route table's core twins, both choices", () => {
    const SAMPLES = [
      {
        hrn: "hrn_0123456789abcdef",
        appr: "appr_0123456789abcdef",
        dir: "/srv/poly",
        choice: "grant",
        dep: "dep_01m76e6f05hp514w9j4v3qymka",
      },
      {
        hrn: "hrn_0123456789abcdef",
        appr: "appr_0123456789abcdef",
        dir: "/srv/poly",
        choice: "deny",
        dep: "dep_01m76e6f05hp514w9j4v3qymka",
      },
    ];
    const twins = [
      ...OPERATIONS.map((op) => [op.id, op.cliTwin] as const),
      ...Object.values(COMMAND_KINDS).map((kind) => [kind.id, kind.cliTwin] as const),
      ...ROUTE_TABLE.flatMap((row) =>
        row.cliTwin !== null ? [[row.key, row.cliTwin] as const] : [],
      ),
    ];
    let checked = 0;
    for (const [id, twin] of twins) {
      if (twin === null) continue;
      for (const sample of SAMPLES) {
        const rendered = renderTwin(twin, sample);
        if (!("argv" in rendered)) throw new Error(`${id}: ${JSON.stringify(rendered)}`);
        expectRunnable(id, `crewhaus ${rendered.argv.join(" ")}`);
        checked++;
      }
    }
    // Ten operation twins, six command kinds and eight route rows, each rendered twice.
    expect(checked).toBeGreaterThanOrEqual(48);
  });
});

type Supervision = {
  readonly TWIN_ACTIONS: readonly string[];
  readonly JOB_COMMANDS: Readonly<Record<string, string>>;
  readonly NO_TWIN_NOTES: Readonly<Record<string, string>>;
  cliTwinFor(action: string, args?: Record<string, unknown>): string | null;
  shellQuote(value: string): string;
  twinSafe(value: string): boolean;
};

/** The console's twin module, a browser ES module loaded by URL. */
async function loadSupervision(): Promise<Supervision> {
  const url = new URL("../../../packages/hangar-ui/assets/js/supervision.js", import.meta.url).href;
  return (await import(url)) as Supervision;
}

/** Every value an action's twin can carry, chosen so each needs quoting. */
const FULL_ARGS: Readonly<Record<string, unknown>> = {
  dir: "/srv/my harnesses/it's poly",
  force: true,
  acknowledge: ["channel.slack", "mcp $(id)"],
  lane: "heart beat",
  runId: "run_1 `x`",
  id: "appr_1; rm",
  sessionId: "sess_1 && x",
  turn: 3,
  verdict: "up",
  kind: "eval",
};

describe("the console's twins, by import", () => {
  test("every action, rendered with every value and with none", async () => {
    const sup = await loadSupervision();
    expect(sup.TWIN_ACTIONS.length).toBe(12);
    for (const action of sup.TWIN_ACTIONS) {
      const full = sup.cliTwinFor(action, FULL_ARGS) ?? "";
      expectRunnable(`${action} (every value)`, full);
      expect(`${action}: ${/<[a-z][a-z0-9-]*>/.test(full)}`).toBe(`${action}: false`);
      // Each value round-trips: the shell hands the CLI exactly what Home holds.
      const words = shellWords(full).flat();
      for (const key of ["dir", "lane", "runId", "id", "sessionId"] as const) {
        const value = FULL_ARGS[key] as string;
        if (full.includes(supervisorQuote(value))) {
          expect(`${action} ${key}: ${words.includes(value)}`).toBe(`${action} ${key}: true`);
        }
      }
      const bare = sup.cliTwinFor(action, action === "job" ? { kind: "doctor" } : {}) ?? "";
      expectRunnable(`${action} (no values)`, bare);
      expect(bare).not.toContain("'");
    }
    // Pass and fail resolve the item; down adjudicates too.
    expectRunnable(
      "review fail",
      sup.cliTwinFor("review", { ...FULL_ARGS, verdict: "fail" }) ?? "",
    );
    expectRunnable(
      "adjudicate down",
      sup.cliTwinFor("adjudicate", { ...FULL_ARGS, verdict: "down" }) ?? "",
    );
    // The acknowledged ids travel as one value.
    const start = shellWords(sup.cliTwinFor("start", FULL_ARGS) ?? "").flat();
    expect(start).toContain("channel.slack,mcp $(id)");
  });

  test("the job commands", async () => {
    const sup = await loadSupervision();
    const entries = Object.entries(sup.JOB_COMMANDS);
    expect(entries.length).toBe(4);
    for (const [kind, line] of entries) expectRunnable(`job ${kind}`, line);
  });

  test("the job vocabulary is the same on both sides", async () => {
    const sup = await loadSupervision();
    expect(Object.keys(sup.JOB_COMMANDS).sort()).toEqual([...JOB_KINDS].sort());
    expect(sup.JOB_COMMANDS["eval"]).toBe(EVAL_COMMAND);
    for (const kind of JOB_KINDS) {
      if (kind === "eval") continue;
      expect(sup.JOB_COMMANDS[kind]).toBe(`crewhaus ${jobArgv(kind).join(" ")}`);
    }
  });
});

describe("one quoting rule", () => {
  const SAMPLES = [
    "",
    " ",
    "'",
    '"',
    "$(id)",
    "`id`",
    ";",
    "&&",
    "*",
    "\n",
    "\t",
    "é",
    "🙂",
    "a'b c",
  ];

  test("the console quotes exactly as the supervisor does, and the shell reads each value back whole", async () => {
    const sup = await loadSupervision();
    for (const value of SAMPLES) {
      expect(sup.shellQuote(value)).toBe(supervisorQuote(value));
      expect(shellWords(sup.shellQuote(value))).toEqual([[value]]);
    }
  });

  test("a value with a control character is never put into a command-line equivalent", async () => {
    const sup = await loadSupervision();
    const CONTROL = ["\u0003", "\u0015", "\u001b[201~", "\u007f", "\u009b", "\n"];
    let twins = 0;
    for (const mark of CONTROL) {
      const tainted = (value: string): string => `${value}${mark}x`;
      const args: Record<string, unknown> = {
        ...FULL_ARGS,
        dir: tainted("/srv/poly"),
        acknowledge: [tainted("channel.slack")],
        lane: tainted("heart"),
        runId: tainted("run_1"),
        id: tainted("appr_1"),
        sessionId: tainted("sess_1"),
      };
      const lines = [
        ...sup.TWIN_ACTIONS.map((action) => sup.cliTwinFor(action, args) ?? ""),
        ...actionCliTwins(tainted("/srv/poly")),
        proofCliTwin(tainted("/srv/poly"), tainted("sess_1"), 1, tainted(".crewhaus/tenants")),
        runtimeOpTwin(tainted("/srv/poly"), devArgv("crewhaus.yaml", false)),
        runtimeOpTwin("/srv/poly", ["dev", tainted("crewhaus.yaml")]),
      ];
      for (const line of lines) {
        const shown = JSON.stringify(line);
        expect(`${shown} holds it: ${line.includes(mark)}`).toBe(`${shown} holds it: false`);
        expect(`${shown}: ${sup.twinSafe(line)}`).toBe(`${shown}: true`);
        expectRunnable(`tainted ${JSON.stringify(mark)}`, line);
        twins++;
      }
      // What stands in its place is the placeholder, never a quoted fragment.
      expect(sup.cliTwinFor("stop", { dir: tainted("/srv/poly") })).toBe(
        "cd <dir> && crewhaus daemon stop",
      );
      expect(sup.twinSafe(tainted("a"))).toBe(false);
    }
    expect(twins).toBe(CONTROL.length * (sup.TWIN_ACTIONS.length + 4 + 1 + 2));
    // A plain value is still quoted exactly as before.
    expect(sup.cliTwinFor("stop", { dir: "/srv/my poly" })).toBe(
      "cd '/srv/my poly' && crewhaus daemon stop",
    );
  });

  test.skipIf(process.platform === "win32")("a real shell prints each value back unchanged", () => {
    // One shell for every value: each is printed whole, then a NUL.
    const script = `printf '%s\\0' ${SAMPLES.map(supervisorQuote).join(" ")}`;
    const run = Bun.spawnSync(["sh", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    expect(run.stdout.toString().split("\0").slice(0, -1)).toEqual(SAMPLES);
  });
});

/** A string under one of these keys in a served body is a command-line equivalent. */
const TWIN_KEYS = new Set(["verb", "cliTwin", "twin", "command"]);

/** Every string under a twin key that mentions `crewhaus `, anywhere in `body`. */
function servedTwins(body: unknown, out: string[] = []): string[] {
  if (Array.isArray(body)) {
    for (const item of body) servedTwins(item, out);
  } else if (body !== null && typeof body === "object") {
    for (const [key, value] of Object.entries(body)) {
      if (TWIN_KEYS.has(key) && typeof value === "string" && value.includes("crewhaus ")) {
        out.push(value);
      } else if (TWIN_KEYS.has(key) && value !== null && typeof value === "object") {
        for (const inner of Object.values(value)) {
          if (typeof inner === "string" && inner.includes("crewhaus ")) out.push(inner);
        }
        servedTwins(value, out);
      } else {
        servedTwins(value, out);
      }
    }
  }
  return out;
}

/** The commands one served string holds: itself, or its backtick spans. */
function linesOf(served: string): string[] {
  const own = commandsIn(served);
  return own.length > 0 ? own : [served];
}

type RouteDef = { readonly method: string; readonly path: string; readonly stream?: string };

describe("what a running Home serves", () => {
  let home: TwinHome;
  let filledId = "";
  let emptyId = "";

  beforeAll(async () => {
    home = bootTwinHome(() => NOW);
    const emptyDir = makeFixtureHarness(join(home.harnessesRoot, "bare"), { specName: "bare" });
    const filledDir = makeFixtureHarness(join(home.harnessesRoot, "filled"), {
      specName: "filled",
      specExtra: "memory:\n  dream:\n    every: 24h",
    });
    const stores = { rootDir: join(filledDir, ".crewhaus", "wiki"), specName: "filled" };
    await createWikiStore(stores).write({ slug: "one", title: "One", body: "first" });
    await createWikiStore(stores).write({
      slug: "one",
      title: "One",
      body: "second",
      expectedVersion: 1,
    });
    await createContinuityStore({
      specName: "filled",
      rootDir: join(filledDir, ".crewhaus", "state"),
      sessionRootDir: join(filledDir, ".crewhaus", "sessions"),
    }).writeFocus("ship it");
    const memories = join(filledDir, ".crewhaus", "memories");
    mkdirSync(memories, { recursive: true });
    const big = join(memories, "big.jsonl");
    writeFileSync(big, "");
    truncateSync(big, MAX_FACT_FILE_BYTES + 1);
    const register = async (dir: string): Promise<string> => {
      const { body } = await home.api("/api/harnesses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir }),
      });
      return (body as { entry: { id: string } }).entry.id;
    };
    emptyId = await register(emptyDir);
    filledId = await register(filledDir);
  }, 20_000); // two fixture harnesses and a seeded wiki before the first read

  afterAll(async () => {
    await home?.stop();
  });

  test("every read route's command-line equivalents run", async () => {
    const url = new URL("../../../packages/hangar-ui/assets/js/routes.js", import.meta.url).href;
    const { ROUTES } = (await import(url)) as { ROUTES: Record<string, RouteDef> };
    const reads = Object.entries(ROUTES).filter(
      ([, r]) => r.method === "GET" && r.stream !== "sse",
    );
    expect(reads.length).toBeGreaterThanOrEqual(120);
    const params: Record<string, string> = {
      runId: "run_0123456789abcdef",
      sess: "sess_0123456789abcdef",
      spec: "filled",
      slug: "one",
      version: "1",
      name: "ops",
      verb: "start",
      area: "facts",
      store: "skills",
      cell: "claude",
      sampleId: "s1",
      recordId: "rec_1",
      plugin: "none",
      pane: "none",
      stamp: "20260101",
    };
    let bodies = 0;
    const found: string[] = [];
    for (const id of [emptyId, filledId]) {
      for (const [key, route] of reads) {
        const path = route.path.replace(/:([a-zA-Z]+)/g, (_m, name: string) =>
          name === "id" ? id : (params[name] ?? "x"),
        );
        const res = await home.api(path);
        if (res.status < 200 || res.status >= 300 || typeof res.body !== "object") continue;
        bodies++;
        for (const served of servedTwins(res.body)) {
          for (const line of linesOf(served)) {
            expectRunnable(`GET ${path} (${key})`, line);
            found.push(line);
          }
        }
      }
    }
    // About 265 bodies and 155 equivalents (58 distinct) when this was written.
    expect(bodies).toBeGreaterThanOrEqual(240);
    expect(found.length).toBeGreaterThanOrEqual(140);
    expect(new Set(found).size).toBeGreaterThanOrEqual(50);
    // The notifications read has no equivalent yet, and says so with null.
    const notifications = await home.api("/api/notifications");
    expect(notifications.status).toBe(200);
    expect((notifications.body as Record<string, unknown>)["cliTwin"]).toBeNull();
  }, 60_000); // some 280 reads against a live server; slow on a loaded runner

  test("every verb the memory reads answer with, empty or filled", async () => {
    const reads = M3_ROUTES.filter((r) => r.method === "GET" && r.path.includes("/memory/"));
    const seen: string[] = [];
    for (const [id, spec] of [
      [emptyId, "bare"],
      [filledId, "big"],
    ] as const) {
      for (const route of reads) {
        const path = route.path
          .replace(":id", id)
          .replace(":spec", spec)
          .replace(":slug", "one")
          .replace(":version", "1")
          .replace(":stamp", "20260101");
        const res = await home.api(path);
        expect(`${path} ${res.status}`).toBe(`${path} 200`);
        const verb = (res.body as Record<string, unknown>)["verb"];
        if (typeof verb !== "string") continue;
        expectRunnable(`${route.key} on ${spec}`, verb);
        seen.push(`${route.key}: ${verb}`);
      }
    }
    // Pinned, so this guard cannot go quiet: fifteen reads swept twice.
    expect(reads.length).toBe(15);
    expect(seen.length).toBe(18);
    expect(seen.filter((v) => v.endsWith(": crewhaus state trash"))).toHaveLength(2);
    expect(
      seen.filter((v) => v.endsWith(": crewhaus wiki write <slug> --body-file <file> --expect 0")),
    ).toHaveLength(1);
  }, 20_000); // thirty reads against a live server

  test("the writes that answer with their command answer with one that runs", async () => {
    const post = async (path: string, body: Record<string, unknown>): Promise<string> => {
      const res = await home.api(`/api/h/${filledId}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(`${path} ${res.status}`).toBe(`${path} 200`);
      return String((res.body as Record<string, unknown>)["verb"]);
    };
    const served = [
      await post("/evals/experiments", { action: "record", name: "exp1" }),
      await post("/evals/experiments", { action: "record", name: "exp1", version: "a" }),
      await post("/evals/experiments", {
        action: "record",
        name: "exp1",
        version: "a",
        outcome: "pass",
      }),
      await post("/evals/experiments", { action: "assign", name: "exp1" }),
      await post("/evals/experiments", { action: "assign", name: "exp1", request: "req-1" }),
      await post("/feedback/distill", {}),
      await post("/feedback/distill", { judge: true, register: true }),
      await post("/data/refresh-goldens", { name: "filled-ratings" }),
    ];
    for (const verb of served) expectRunnable("write", verb);
    expect(served[2]).toBe(
      "crewhaus 'experiment' 'record' '--name' 'exp1' '--version' 'a' '--outcome' 'pass'",
    );
    expect(served[4]).toBe("crewhaus 'experiment' 'assign' '--name' 'exp1' '--key' 'req-1'");
  }, 20_000); // eight writes against a live server

  test("the search answers with runnable actions", async () => {
    const search = await home.api("/api/search?q=start%20bare");
    const actions = (search.body as { actions: Array<{ id: string; cliTwin: string }> }).actions;
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expectRunnable(`GET /api/search ${action.id}`, action.cliTwin);
    const onboarding = (await home.api("/api/onboarding")).body as {
      cliTwins: Record<string, string>;
    };
    for (const [name, twin] of Object.entries(onboarding.cliTwins)) {
      expectRunnable(`GET /api/onboarding ${name}`, twin);
    }
  }, 20_000);
});

/**
 * Commands built from a closed vocabulary at run time: the literal holds
 * `<value>` where a word of that vocabulary goes. Each is listed with the
 * words it is built from, and every expansion is checked. The list is held to
 * the source both ways: a new built command fails until it is listed here.
 */
const BUILT: ReadonlyArray<{
  readonly file: string;
  readonly command: string;
  readonly values: ReadonlyArray<readonly string[]>;
}> = [
  {
    file: "data-ops.ts",
    command: `crewhaus ${VALUE}`,
    values: [["dataset mine"], ["dataset synthesize"]],
  },
  {
    file: "eval-inputs.ts",
    command: `crewhaus ${VALUE}`,
    values: [[EVAL_JOB_ARGV.join(" ")], [OPTIMIZE_JOB_ARGV.join(" ")]],
  },
  {
    file: "evals-ops.ts",
    command: `crewhaus ${VALUE}`,
    values: [
      [evalArgv({}, OFFERS).argv.join(" ")],
      [sentinelArgv({}, OFFERS).argv.join(" ")],
      [optimizeArgv({ mutator: "rule-based" }, OFFERS).argv.join(" ")],
    ],
  },
  { file: "evals-ops.ts", command: `crewhaus flywheel ${VALUE}`, values: [["init"], ["run"]] },
  {
    file: "memory-ops.ts",
    command: `crewhaus memory ${VALUE}`,
    values: [["list"], ["sweep"]],
  },
  {
    file: "memory-ops.ts",
    command: `crewhaus memory ${VALUE} --spec ${VALUE}`,
    values: [
      ["list", "fabric"],
      ["sweep", "fabric"],
    ],
  },
  // A lease holder's kind is the CLI verb that took the lease.
  { file: "process.ts", command: `crewhaus ${VALUE}`, values: [["eval"], ["optimize"]] },
];

function expand(command: string, values: readonly string[]): string {
  let at = 0;
  return command.replaceAll(VALUE, () => values[at++] ?? VALUE);
}

describe("every command spelled in the source", () => {
  const FAKES = [
    "crewhaus hangar add",
    "crewhaus feedback faq",
    "crewhaus distill --preferences",
    "crewhaus memory migrate",
    "crewhaus eval --models",
    "crewhaus run (",
  ];

  test("the server's, and the console's, each one runs", () => {
    const server = commandsUnder(join(REPO, "packages", "hangar-server", "src"), "ts", (rel) =>
      rel.endsWith("/")
        ? rel !== "__test__/"
        : rel.endsWith(".ts") &&
          !rel.endsWith(".test.ts") &&
          rel !== "testkit.ts" &&
          !rel.startsWith("fixture"),
    );
    const ui = commandsUnder(
      join(REPO, "packages", "hangar-ui", "assets", "js"),
      "js",
      (rel) => rel.endsWith("/") || rel.endsWith(".js"),
    );
    expect(server.length).toBeGreaterThanOrEqual(200);
    expect(ui.length).toBeGreaterThanOrEqual(50);
    const built = new Set<string>();
    for (const { file, command } of [...server, ...ui]) {
      const entry = BUILT.find((b) => b.file === file && b.command === command);
      if (entry !== undefined) {
        built.add(`${file}: ${command}`);
        for (const values of entry.values) expectRunnable(file, expand(command, values));
        continue;
      }
      expectRunnable(file, command);
      for (const fake of FAKES) expect(`${file}: ${command}`).not.toContain(fake);
    }
    expect([...built].sort()).toEqual(BUILT.map((b) => `${b.file}: ${b.command}`).sort());
  });

  test("the scan reads literals, never comments or regular expressions", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-twins-scan-"));
    try {
      writeFileSync(
        join(dir, "planted.ts"),
        [
          "// crewhaus hangar add <dir>",
          "/* `crewhaus remember` */",
          'const a: string = "crewhaus harness list";',
          "const b = (spec: string) => `crewhaus memory list --spec ${spec}`;",
          'const re = /crewhaus "x"/;',
          "const c = 'note: run `crewhaus doctor` first';",
          "export { a, b, re, c };",
        ].join("\n"),
      );
      const found = commandsUnder(dir, "ts", (rel) => rel === "planted.ts").map((f) => f.command);
      expect(found).toEqual([
        "crewhaus harness list",
        `crewhaus memory list --spec ${VALUE}`,
        "crewhaus doctor",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("every write has an equivalent or a note", () => {
  /** Writes without one, and notes that name no write. */
  function coverage(
    table: ReadonlyArray<{ key: string; receipt: string; cliTwin: unknown; note?: string }>,
    notes: Readonly<Record<string, string>>,
  ): { readonly uncovered: string[]; readonly stray: string[] } {
    const writes = table.filter((row) => row.receipt !== "none");
    return {
      uncovered: writes
        .filter((row) => row.cliTwin === null && row.note === undefined)
        .map((row) => row.key),
      stray: Object.keys(notes).filter(
        (key) => !writes.some((row) => row.key === key && row.cliTwin === null),
      ),
    };
  }

  test("the route table's writes", () => {
    expect(coverage(ROUTE_TABLE, ROUTE_TWIN_NOTES)).toEqual({ uncovered: [], stray: [] });
    expect(Object.keys(ROUTE_TWIN_NOTES).length).toBe(101);
    for (const [key, note] of Object.entries(ROUTE_TWIN_NOTES)) {
      expect(ROUTE_TABLE.find((row) => row.key === key)?.note).toBe(note);
    }
  });

  /**
   * The writes whose handler previews by default (`isDryRun`) and asks for a
   * typed confirmation before the real run, and how the command-line form
   * the note names first is held to a preview too: it carries `--dry-run`,
   * or it lacks the flag that makes the command write.
   */
  const PREVIEW_FIRST: Readonly<
    Record<string, { readonly has: string } | { readonly lacks: string }>
  > = {
    retentionSweep: { has: "--dry-run" },
    retentionPurge: { has: "--dry-run" },
    memoryMigrate: { has: "--dry-run" },
    knowledgeSync: { has: "--dry-run" },
    watchmePublish: { has: "--dry-run" },
    datasetRefreshGoldens: { lacks: "--apply" },
    piiTune: { lacks: "--write" },
    // The CLI has no dry run here; the note says so.
    memorySweep: { lacks: "--dry-run" },
    // The command proposes and writes nothing to the spec.
    onchainTune: { lacks: "--out" },
  };

  test("a write Home previews first names the command's preview first, and the difference", () => {
    const server = join(REPO, "packages", "hangar-server", "src");
    // Every handler that previews by default, so a new one is listed here.
    let calls = 0;
    for (const file of readdirSync(server)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      calls += readFileSync(join(server, file), "utf8").split("isDryRun(ctx.body)").length - 1;
    }
    // Nine call sites: the read-only lint, and eight handlers behind nine
    // routes (retention's sweep and purge share one).
    expect(calls).toBe(9);
    expect(Object.keys(PREVIEW_FIRST).length).toBe(9);
    for (const [key, rule] of Object.entries(PREVIEW_FIRST)) {
      const note = ROUTE_TWIN_NOTES[key] ?? "";
      const first = commandsIn(note)[0] ?? "";
      expect(`${key}: ${first !== ""}`).toBe(`${key}: true`);
      if ("has" in rule) {
        expect(`${key}: ${first}`).toContain(rule.has);
        expect(note).toContain(`without \`${rule.has}\``);
      } else {
        expect(`${key}: ${first}`).not.toContain(rule.lacks);
      }
    }
  });

  test("a note for a route that does not exist, or a write without one, is reported", () => {
    const table = [
      { key: "a", receipt: "harness", cliTwin: null, note: "No command-line equivalent." },
      { key: "b", receipt: "harness", cliTwin: null },
      { key: "c", receipt: "none", cliTwin: null },
    ];
    expect(coverage(table, { a: "x", gone: "y" })).toEqual({ uncovered: ["b"], stray: ["gone"] });
  });
});
