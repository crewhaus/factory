/**
 * 0.7.1 — the rules that tie a builtin's safety flags together, held over
 * every builtin (apps/cli/src/builtin-tools-for-tests.ts reads the set from
 * the code, never from a list).
 *
 * The permission engine decides on three flags, and a flag set the wrong way
 * is a silent grant: a read-only tool runs in plan mode without asking, a
 * non-destructive one runs in auto mode without asking, and a tool without
 * `requireJustification` skips the intent gate. Each rule below says when a
 * flag must be set; each list says which tools a rule lets through, with the
 * reason, so a new tool that lands on the permissive side fails here until
 * somebody writes the reason down.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { type RuleSet, evaluate } from "@crewhaus/permission-engine";
import { buildTool } from "@crewhaus/tool-builder";
import { type RegisteredTool, hasModelChosenDestination } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { loadAllBuiltinTools } from "./builtin-tools-for-tests";

let builtins: ReadonlyArray<RegisteredTool>;
beforeAll(async () => {
  builtins = (await loadAllBuiltinTools()).tools;
}, 60_000);

const names = (tools: ReadonlyArray<RegisteredTool>): string[] => tools.map((t) => t.name).sort();

describe("requireJustification (permission-integration#11)", () => {
  /**
   * THE RULE: a destructive tool that goes to a place the model chose — an
   * external tool with a `url` or `recipient` operative argument — sets
   * `requireJustification: true`. It changes or delivers something where the
   * model pointed it: a message, a post, an HTTP call, a download.
   *
   * Destructive tools that act only inside the workspace (Write, Edit,
   * RemovePath, Bash, the git writers) are NOT required to: the permission
   * gate already asks for them, and without an LLM judge an unjudged
   * justification fails closed in production, so gating them would stop
   * every write. AGENTS.md states the same rule.
   */
  test("every destructive tool with a model-chosen destination is justification-gated", () => {
    const inScope = builtins.filter((t) => t.destructive && hasModelChosenDestination(t));
    // The rule's hit count: HttpRequest, EmailSend, ChatPost, the issue and
    // pull-request writers, WebhookPost, DownloadFile, EvmSendTransaction, …
    expect(inScope.length).toBeGreaterThanOrEqual(18);
    for (const known of ["HttpRequest", "EmailSend", "DownloadFile", "EvmSendTransaction"]) {
      expect(names(inScope)).toContain(known);
    }
    expect(names(inScope.filter((t) => !t.requireJustification))).toEqual([]);
  });

  /**
   * Every gated tool, so a flag that changes in either direction is a
   * decision somebody makes here: turning the gate ON can stop a harness that
   * has no LLM judge, turning it OFF removes a check. Beyond the rule above,
   * the others are gated because their authors judged the effect worth an
   * intent check (fleet and store mutations, secret rotation, printing, a
   * remote delete by id, reading the clipboard).
   */
  const JUSTIFICATION_GATED = [
    "AlertAck",
    "ChatDelete",
    "ChatPost",
    "ChatReact",
    "ChatUpdate",
    "ClipboardRead",
    "CronDelete",
    "DeployRollback",
    "DownloadFile",
    "EmailSend",
    "EvmSendTransaction",
    "ExperimentLedger",
    "GoldenUpdate",
    "GraphqlQuery",
    "HarnessRetire",
    "HttpBatch",
    "HttpRequest",
    "IssueComment",
    "IssueCreate",
    "IssueUpdate",
    "KnowledgeSync",
    "ManifestDependencySet",
    "OpenExternal",
    "PackageInstall",
    "PrComment",
    "PrCreate",
    "PrReviewSubmit",
    "PrUpdate",
    "PrintDocument",
    "PushNotify",
    "ReleaseCreate",
    "RetentionEnforce",
    "RouteControl",
    "SecretRotate",
    "SendMessage",
    "SmsSend",
    "SpecPin",
    "StatusPagePost",
    "StoreMigrate",
    "VectorDelete",
    "WebhookPost",
    "WorkflowRunRerun",
  ];

  test("the gated set is exactly the reviewed one", () => {
    expect(names(builtins.filter((t) => t.requireJustification))).toEqual(JUSTIFICATION_GATED);
  });

  /**
   * Destructive tools whose loss cannot be undone from inside the workspace,
   * or that install standing automation, but which the rule does not reach
   * because they act in the workspace. Reviewed for 0.7.1 and deliberately
   * left ungated — the permission gate asks for each of them, and gating
   * them would deny every call on a harness without an LLM judge. Whether
   * they join the gated set is an 0.8 decision (permission-integration#11).
   */
  const UNGATED_FOR_NOW: Readonly<Record<string, string>> = {
    GitBranchDelete: "force deletes an unmerged branch",
    GitWorktreeRemove: "force discards a worktree's uncommitted work",
    HooksManage: "writes argv the supervisor later runs, like the gated CronDelete's schedules",
    RemovePath: "recursive unlinks a tree rather than moving it to the trash",
  };

  test("the reviewed irreversible workspace tools stay destructive and ungated", () => {
    const byName = new Map(builtins.map((t) => [t.name, t]));
    const got = Object.keys(UNGATED_FOR_NOW).map((name) => {
      const t = byName.get(name);
      return {
        name,
        destructive: t?.destructive,
        gated: t?.requireJustification,
        ruleApplies: t !== undefined && hasModelChosenDestination(t),
      };
    });
    expect(got).toEqual(
      Object.keys(UNGATED_FOR_NOW).map((name) => ({
        name,
        destructive: true,
        gated: false,
        ruleApplies: false,
      })),
    );
  });
});

describe("readOnly (permission-integration#7)", () => {
  /**
   * THE RULE: a read-only tool may spawn a process only when the program is
   * fixed by the tool — a system utility found on PATH — and never one the
   * workspace supplies (node_modules/.bin, a project config that is code).
   * Plan mode runs every read-only tool without asking, so a read-only tool
   * that ran the project's linter ran a cloned repository's code in a plan.
   *
   * Each entry names the program. The git readers (and DiffLint) run the
   * system git, with every program a repository's own config could name —
   * the fsmonitor hook, diff drivers, textconv, its filter drivers, a
   * signature program — switched off for the read, and an embedded bare
   * repository refused (tool-git/src/hardening.ts, 0.7.1 C007).
   */
  const READ_ONLY_SPAWNS: Readonly<Record<string, string>> = {
    ClipboardRead: "pbpaste / wl-paste / xclip",
    CronList: "crontab, launchctl, systemctl",
    DiffLint: "git diff, when no diff text is given",
    GitBlame: "git",
    GitBranchList: "git",
    GitConflicts: "git",
    GitDiff: "git",
    GitFileHistory: "git",
    GitLog: "git",
    GitMergeBase: "git",
    GitRemoteList: "git",
    GitRevParse: "git",
    GitShow: "git",
    GitStashList: "git",
    GitStatus: "git",
    GitTagList: "git",
    GitWorktreeList: "git",
    NetworkInfo: "ifconfig / ip / netstat",
    OsIndexSearch: "mdfind / plocate / locate",
    PackageQuery: "the system package manager (brew, dpkg, rpm, pacman, winget, choco)",
    PortInspect: "lsof / ss / netstat",
    SecretLookup: "the secret store's CLI (security, pass, op), to check a reference resolves",
    SystemInfo: "sysctl / uname / pmset",
    UserPresence: "ioreg / loginctl / xprintidle",
    WindowList: "osascript / wmctrl",
  };

  test("a read-only tool that spawns runs only a program it fixes", () => {
    const spawning = builtins.filter((t) => t.readOnly && t.ioCapability === "process");
    expect(spawning.length).toBeGreaterThanOrEqual(20);
    expect(names(spawning)).toEqual(Object.keys(READ_ONLY_SPAWNS).sort());
  });

  test("the tools that run the project's own toolchain are not read-only", () => {
    const byName = new Map(builtins.map((t) => [t.name, t]));
    for (const name of ["Typecheck", "Lint", "FormatCheck", "Diagnostics", "CliVersionPin"]) {
      expect({ name, readOnly: byName.get(name)?.readOnly }).toEqual({ name, readOnly: false });
    }
  });
});

describe("what auto mode runs without asking (permission-integration#13)", () => {
  /**
   * Auto mode allows a tool that is neither read-only nor destructive with no
   * rule at all. Every such tool is listed with why that is acceptable, so a
   * new one is a decision, not a default.
   */
  const AUTO_ALLOWED: Readonly<Record<string, string>> = {
    BashOutput: "reads output from a shell this session started",
    CliVersionPin:
      "reads a harness CLI's version from its package.json and never runs a workspace CLI; runs `--version` only on the operator's own standalone install outside the workspace, with allowExternalCli; changes nothing",
    DesktopNotify: "shows a local notification",
    Diagnostics: "runs the project's type checker and linter to report; changes nothing",
    Fetch:
      "only reaches origins the operator allow-listed, and its egress is blocked on tool-sourced text; a per-method gate (POST/PUT/DELETE) is 0.8 work",
    FormatCheck: "runs the project's formatter in check mode; changes nothing",
    ImageGenerate: "sends a prompt to the configured image provider",
    Lint: "runs the project's linter without --fix; changes nothing",
    MediaProbe: "runs ffprobe on a workspace file",
    ProcessOutput: "reads output from a process this session started",
    TodoWrite: "writes this session's own task list",
    Typecheck: "runs the project's type checker with --noEmit; changes nothing",
  };

  test("the tools auto mode allows without a rule are exactly the reviewed ones", () => {
    const allowed = builtins.filter((t) => !t.readOnly && !t.destructive);
    expect(allowed.length).toBeGreaterThanOrEqual(10);
    expect(names(allowed)).toEqual(Object.keys(AUTO_ALLOWED).sort());
  });

  /**
   * security-7#11 — buildTool's docstring once called its defaults
   * fail-closed. They are not: a tool that sets no flag is neither read-only
   * nor destructive, and the engine allows it in auto mode. This pins the
   * posture the docstring now describes, through the real engine.
   */
  test("a tool that sets no flag runs unasked in auto mode; destructive: true is asked", () => {
    const def = {
      name: "WipeCache",
      description: "rm -rf a cache directory",
      inputSchema: z.object({}),
      execute: async () => "",
    };
    const none: RuleSet = { flag: [], settings: [], yaml: [], hooks: [], builtin: [] };
    const decide = (tool: RegisteredTool, mode: "auto" | "default" | "plan") =>
      evaluate(
        {
          toolName: tool.name,
          input: {},
          readOnly: tool.readOnly,
          destructive: tool.destructive,
          requiresSandbox: tool.requiresSandbox,
        },
        mode,
        none,
      );
    const bare = buildTool(def);
    expect({
      auto: decide(bare, "auto"),
      default: decide(bare, "default"),
      plan: decide(bare, "plan"),
    }).toEqual({ auto: "allow", default: "ask", plan: "deny" });
    expect(decide(buildTool({ ...def, destructive: true }), "auto")).toBe("ask");
  });
});
