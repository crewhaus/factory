import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_BOOKKEEPING_RULES,
  BUILTIN_DEFAULT_RULES,
  type JustificationJudge,
  PermissionConfigError,
  type PermissionRule,
  RULE_BASED_JUDGE_MODEL,
  type RuleSet,
  type ToolCallContext,
  __resetRuleBasedJudgeWarningForTests,
  appendSettingsRule,
  emptyRuleSet,
  evaluate,
  evaluateJustification,
  evaluateWithReason,
  loadSettingsRules,
  parsePermissionsConfig,
  ruleBasedJustificationJudge,
  tagRules,
} from "./index";

const readCall: ToolCallContext = {
  toolName: "Read",
  input: { path: "x" },
  readOnly: true,
  destructive: false,
};
const bashRm: ToolCallContext = {
  toolName: "Bash",
  input: { command: "rm -rf /tmp/foo" },
  readOnly: false,
  destructive: true,
};
const bashLs: ToolCallContext = {
  toolName: "Bash",
  input: { command: "ls" },
  readOnly: false,
  destructive: true,
};
const writeCall: ToolCallContext = {
  toolName: "Write",
  input: { file_path: "/tmp/x" },
  readOnly: false,
  destructive: true,
};

function rule(
  type: PermissionRule["type"],
  pattern: string,
  source: PermissionRule["source"] = "yaml",
): PermissionRule {
  return { type, pattern, source };
}

describe("evaluate — modes", () => {
  test("bypass always allows", () => {
    expect(evaluate(bashRm, "bypass", emptyRuleSet)).toBe("allow");
    expect(evaluate(writeCall, "bypass", emptyRuleSet)).toBe("allow");
  });

  test("plan allows read-only, denies everything else (rules ignored)", () => {
    expect(evaluate(readCall, "plan", emptyRuleSet)).toBe("allow");
    expect(evaluate(writeCall, "plan", emptyRuleSet)).toBe("deny");
    // Even a permissive rule cannot override plan mode's no-write rule.
    const allowAllRules: RuleSet = {
      ...emptyRuleSet,
      yaml: [rule("alwaysAllow", "*")],
    };
    expect(evaluate(writeCall, "plan", allowAllRules)).toBe("deny");
  });

  test("default falls back to ask when no rule matches", () => {
    expect(evaluate(readCall, "default", emptyRuleSet)).toBe("ask");
    expect(evaluate(writeCall, "default", emptyRuleSet)).toBe("ask");
  });

  test("auto auto-allows read-only and asks for destructive when no rule matches", () => {
    expect(evaluate(readCall, "auto", emptyRuleSet)).toBe("allow");
    expect(evaluate(bashLs, "auto", emptyRuleSet)).toBe("ask");
  });
});

describe("evaluate — rule types", () => {
  test("alwaysAllow matches → allow", () => {
    const rs: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAllow", "Read")] };
    expect(evaluate(readCall, "default", rs)).toBe("allow");
  });

  test("alwaysDeny matches → deny", () => {
    // `**` glob crosses `/`, so this matches `rm -rf /tmp/foo`.
    const rs: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysDeny", "Bash(rm**)")] };
    expect(evaluate(bashRm, "default", rs)).toBe("deny");
  });

  test("alwaysAsk matches → ask", () => {
    const rs: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAsk", "Bash(*)")] };
    expect(evaluate(bashLs, "default", rs)).toBe("ask");
  });

  test("a malformed alwaysAllow is skipped (a broken grant is not honored)", () => {
    const rs: RuleSet = {
      ...emptyRuleSet,
      yaml: [rule("alwaysAllow", "Bash(unclosed"), rule("alwaysAllow", "Read")],
    };
    // First rule errors → skipped (fail closed: no grant); second matches → allow.
    expect(evaluate(readCall, "default", rs)).toBe("allow");
  });

  // SECURITY: a malformed guard rule must NOT silently fail open. An attacker
  // who can influence a sub-agent definition could otherwise ship a deny whose
  // pattern fails to compile and watch it get dropped.
  test("a malformed alwaysDeny fails CLOSED (gates instead of being dropped)", () => {
    const rs: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysDeny", "Bash(unclosed")] };
    expect(evaluate(bashRm, "default", rs)).toBe("deny");
  });

  test("a malformed alwaysAsk fails CLOSED (gates instead of being dropped)", () => {
    const rs: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAsk", "Bash(unclosed")] };
    expect(evaluate(bashLs, "default", rs)).toBe("ask");
  });
});

describe("T9 — rule precedence", () => {
  test("settings (deny) beats yaml (allow): higher source wins", () => {
    const rs: RuleSet = {
      ...emptyRuleSet,
      settings: [rule("alwaysDeny", "Bash(*)", "settings")],
      yaml: [rule("alwaysAllow", "Bash(*)", "yaml")],
    };
    expect(evaluate(bashLs, "default", rs)).toBe("deny");
  });

  test("flag (allow) beats settings (deny)", () => {
    const rs: RuleSet = {
      ...emptyRuleSet,
      flag: [rule("alwaysAllow", "Bash(*)", "flag")],
      settings: [rule("alwaysDeny", "Bash(*)", "settings")],
    };
    expect(evaluate(bashLs, "default", rs)).toBe("allow");
  });

  test("hook decision overrides builtin default", () => {
    const rs: RuleSet = {
      ...emptyRuleSet,
      hooks: [rule("alwaysDeny", "Read", "hook")],
      builtin: [...BUILTIN_DEFAULT_RULES],
    };
    expect(evaluate(readCall, "default", rs)).toBe("deny");
  });

  test("first rule within a source wins over later rules in same source", () => {
    const rs: RuleSet = {
      ...emptyRuleSet,
      yaml: [
        rule("alwaysAllow", "Bash(ls)"),
        rule("alwaysDeny", "Bash(*)"), // would also match, but loses to first
      ],
    };
    expect(evaluate(bashLs, "default", rs)).toBe("allow");
  });

  // Regression — issue #17. A catch-all `Bash(**)` compiled to a regex that
  // only matched "" or a string starting with "/", so the rule never fired and
  // the decision fell through to the mode default. In `auto` a non-destructive
  // Bash call falls through to ALLOW, which makes the difference visible.
  test("a catch-all alwaysAsk Bash(**) actually gates (#17)", () => {
    const call: ToolCallContext = {
      toolName: "Bash",
      input: { command: "echo hi" },
      readOnly: false,
      destructive: false,
    };
    expect(evaluate(call, "auto", emptyRuleSet)).toBe("allow"); // no rule → fallback
    const rs: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAsk", "Bash(**)")] };
    expect(evaluate(call, "auto", rs)).toBe("ask");
    expect(evaluate(bashLs, "default", rs)).toBe("ask");
  });

  // Regression — the builtin floor is written with `**` precisely so it catches
  // arguments containing "/". A newline must not slip past it either.
  test("builtin Bash(rm**) floor fires on a multi-line command (#17)", () => {
    const call: ToolCallContext = {
      toolName: "Bash",
      input: { command: "rm -rf /tmp/foo\necho done" },
      readOnly: false,
      destructive: false,
    };
    const rs: RuleSet = { ...emptyRuleSet, builtin: [...BUILTIN_DEFAULT_RULES] };
    expect(evaluate(call, "auto", rs)).toBe("ask");
  });

  test("property: random RuleSet — decision matches highest-priority matching source", () => {
    const tools = ["Read", "Bash", "Write"];
    const types: PermissionRule["type"][] = ["alwaysAllow", "alwaysDeny", "alwaysAsk"];
    const sources: PermissionRule["source"][] = ["flag", "settings", "yaml", "hook", "builtin"];
    const sourceKeyMap = {
      flag: "flag",
      settings: "settings",
      yaml: "yaml",
      hook: "hooks",
      builtin: "builtin",
    } as const;

    for (let trial = 0; trial < 200; trial++) {
      const ruleCount = 1 + Math.floor(Math.random() * 8);
      const all: PermissionRule[] = [];
      for (let i = 0; i < ruleCount; i++) {
        const tool = tools[Math.floor(Math.random() * tools.length)] as string;
        const t = types[Math.floor(Math.random() * types.length)] as PermissionRule["type"];
        const s = sources[Math.floor(Math.random() * sources.length)] as PermissionRule["source"];
        all.push({ type: t, pattern: tool, source: s });
      }

      const rs: RuleSet = {
        flag: all.filter((r) => r.source === "flag"),
        settings: all.filter((r) => r.source === "settings"),
        yaml: all.filter((r) => r.source === "yaml"),
        hooks: all.filter((r) => r.source === "hook"),
        builtin: all.filter((r) => r.source === "builtin"),
      };
      const target = tools[Math.floor(Math.random() * tools.length)] as string;

      // Compute oracle: walk the priority order ourselves.
      const priority: PermissionRule["source"][] = ["flag", "settings", "yaml", "hook", "builtin"];
      let oracle: ReturnType<typeof evaluate> = "ask"; // default fallback
      for (const src of priority) {
        const list = rs[sourceKeyMap[src]];
        const match = list.find((r) => r.pattern === target);
        if (match) {
          oracle =
            match.type === "alwaysAllow" ? "allow" : match.type === "alwaysDeny" ? "deny" : "ask";
          break;
        }
      }

      const call: ToolCallContext = {
        toolName: target,
        input: {},
        readOnly: false,
        destructive: false,
      };
      const decision = evaluate(call, "default", rs);
      expect(decision).toBe(oracle);
    }
  });
});

describe("parsePermissionsConfig — happy path", () => {
  test("parses mode + rules", () => {
    const out = parsePermissionsConfig(
      {
        mode: "auto",
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysDeny", pattern: "Bash(rm *)" },
        ],
      },
      "yaml",
    );
    expect(out.mode).toBe("auto");
    expect(out.rules).toHaveLength(2);
  });

  test("undefined / null → empty rules", () => {
    expect(parsePermissionsConfig(undefined, "yaml")).toEqual({ rules: [] });
    expect(parsePermissionsConfig(null, "yaml")).toEqual({ rules: [] });
  });

  test("rejects unknown rule type", () => {
    expect(() =>
      parsePermissionsConfig({ rules: [{ type: "neverAllow", pattern: "x" }] }, "yaml"),
    ).toThrow(PermissionConfigError);
  });

  test("rejects unknown top-level keys (strict)", () => {
    expect(() => parsePermissionsConfig({ extra: 1 }, "yaml")).toThrow(PermissionConfigError);
  });
});

describe("T8 — bypass mode security lockdown", () => {
  test("rejects mode: bypass from yaml source", () => {
    expect(() => parsePermissionsConfig({ mode: "bypass", rules: [] }, "yaml")).toThrow(
      PermissionConfigError,
    );
    expect(() => parsePermissionsConfig({ mode: "bypass", rules: [] }, "yaml")).toThrow(
      /bypass mode cannot be set from yaml/,
    );
  });

  test("rejects mode: bypass from settings source", () => {
    expect(() => parsePermissionsConfig({ mode: "bypass", rules: [] }, "settings")).toThrow(
      PermissionConfigError,
    );
    expect(() => parsePermissionsConfig({ mode: "bypass", rules: [] }, "settings")).toThrow(
      /bypass mode cannot be set from settings/,
    );
  });

  test("the schema's mode enum does NOT include 'bypass' (defense in depth)", () => {
    // Even if the explicit string-check at the top of parsePermissionsConfig were
    // bypassed (e.g. via a clever Object.create(null) shape), the Zod enum would
    // still reject it. We assert by trying a shape where `mode` is a frozen string
    // primitive — both layers should still reject.
    const maliciousShape = Object.create(null) as { mode: string };
    maliciousShape.mode = "bypass";
    expect(() => parsePermissionsConfig(maliciousShape, "yaml")).toThrow(PermissionConfigError);
  });

  test("bypass IS a legal runtime mode for evaluate() — it just can't enter via config", () => {
    expect(evaluate(bashRm, "bypass", emptyRuleSet)).toBe("allow");
  });
});

describe("tagRules", () => {
  test("attaches source to each rule", () => {
    const out = tagRules(
      [
        { type: "alwaysAllow", pattern: "Read" },
        { type: "alwaysDeny", pattern: "Bash(rm *)" },
      ],
      "yaml",
    );
    expect(out[0]?.source).toBe("yaml");
    expect(out[1]?.source).toBe("yaml");
  });
});

describe("Section 18 — requiresSandbox floor", () => {
  const pythonCall: ToolCallContext = {
    toolName: "Python",
    input: { code: "print('hi')" },
    readOnly: false,
    destructive: true,
    requiresSandbox: true,
  };

  test("denies in default mode when no rule + no sandbox", () => {
    const r = evaluateWithReason(pythonCall, "default", emptyRuleSet);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("requires a sandbox");
  });

  test("denies even with rule when sandbox not available", () => {
    const rules: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAllow", "Python")] };
    const r = evaluateWithReason(pythonCall, "default", rules, { sandboxAvailable: false });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("requires a sandbox");
  });

  test("denies in default mode with sandbox but no allow rule", () => {
    const r = evaluateWithReason(pythonCall, "default", emptyRuleSet, {
      sandboxAvailable: true,
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("alwaysAllow rule");
  });

  test("allows when sandbox available AND alwaysAllow matches", () => {
    const rules: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAllow", "Python")] };
    const r = evaluateWithReason(pythonCall, "default", rules, { sandboxAvailable: true });
    expect(r.decision).toBe("allow");
  });

  test("denies when sandbox available but alwaysAsk matches (ask is not allow)", () => {
    const rules: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAsk", "Python")] };
    const r = evaluateWithReason(pythonCall, "default", rules, { sandboxAvailable: true });
    expect(r.decision).toBe("deny");
  });

  test("auto mode still applies floor — denies without alwaysAllow even when destructive auto-asks would say ask", () => {
    const r = evaluateWithReason(pythonCall, "auto", emptyRuleSet, { sandboxAvailable: true });
    expect(r.decision).toBe("deny");
  });

  test("plan mode unaffected by sandbox floor — still denies non-readOnly", () => {
    const r = evaluateWithReason(pythonCall, "plan", emptyRuleSet, { sandboxAvailable: true });
    expect(r.decision).toBe("deny");
  });

  test("bypass mode unaffected — bypass is a deliberate operator override", () => {
    const r = evaluateWithReason(pythonCall, "bypass", emptyRuleSet);
    expect(r.decision).toBe("allow");
  });

  test("non-sandbox tools unaffected by sandboxAvailable=false", () => {
    const r = evaluateWithReason(readCall, "default", emptyRuleSet, {
      sandboxAvailable: false,
    });
    // readCall doesn't set requiresSandbox; floor doesn't apply.
    expect(r.decision).toBe("ask");
  });
});

describe("0.8.0 — the runtime-state floor (protectedRoots)", () => {
  // What the runtime hands the floor: its session-log root and proofs root,
  // absolute and workspace-relative (design/0.8.0-provability-release.md §5.2).
  const ROOTS = [
    "/srv/ws/.crewhaus/sessions",
    "/srv/ws/.crewhaus/proofs",
    ".crewhaus/sessions",
    ".crewhaus/proofs",
  ];
  const writeTo = (rel: string, over: Partial<ToolCallContext> = {}): ToolCallContext => ({
    toolName: "Write",
    input: { path: rel, content: "x" },
    operativeValues: [{ kind: "path", canonical: [rel, `/srv/ws/${rel}`] }],
    readOnly: false,
    destructive: true,
    ...over,
  });
  const LOG = ".crewhaus/sessions/sess_00000000000000aa.jsonl";
  const allowEverywhere: RuleSet = {
    ...emptyRuleSet,
    flag: [rule("alwaysAllow", "Write", "flag")],
    settings: [rule("alwaysAllow", "Write(**)", "settings")],
    yaml: [rule("alwaysAllow", "Write(**)")],
  };

  test("a write into the session logs is denied whatever a rule allows, in default, auto and plan", () => {
    for (const mode of ["default", "auto", "plan"] as const) {
      const r = evaluateWithReason(writeTo(LOG), mode, allowEverywhere, { protectedRoots: ROOTS });
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain("the runtime keeps its own record of the run");
    }
  });

  test("the proof bundles and artifacts are walled off the same way, the roots themselves included", () => {
    for (const rel of [
      ".crewhaus/proofs/support-bot/sess_00000000000000aa/turn-1.json",
      ".crewhaus/proofs/support-bot/artifacts/prf_0123456789abcdef.json",
      ".crewhaus/sessions",
    ]) {
      const r = evaluateWithReason(writeTo(rel), "auto", allowEverywhere, {
        protectedRoots: ROOTS,
      });
      expect(r.decision).toBe("deny");
    }
  });

  test("every spelling counts: an absolute path, a symlinked one, a case the filesystem folds", () => {
    const absolute: ToolCallContext = {
      ...writeTo(LOG),
      operativeValues: [{ kind: "path", canonical: [`/srv/ws/${LOG}`], outsideWorkspace: true }],
    };
    expect(
      evaluateWithReason(absolute, "auto", allowEverywhere, { protectedRoots: ROOTS }).decision,
    ).toBe("deny");
    const viaLink: ToolCallContext = {
      ...writeTo("logs/sess.jsonl"),
      operativeValues: [
        { kind: "path", canonical: [LOG, `/srv/ws/${LOG}`], spellings: ["logs/sess.jsonl"] },
      ],
    };
    expect(
      evaluateWithReason(viaLink, "auto", allowEverywhere, { protectedRoots: ROOTS }).decision,
    ).toBe("deny");
    const shouted: ToolCallContext = {
      ...writeTo(".CREWHAUS/Sessions/x.jsonl"),
      operativeValues: [
        { kind: "path", canonical: [".CREWHAUS/Sessions/x.jsonl"], caseInsensitive: true },
      ],
    };
    expect(
      evaluateWithReason(shouted, "auto", allowEverywhere, { protectedRoots: ROOTS }).decision,
    ).toBe("deny");
  });

  test("an extract or a patch: a destination inside a root is denied here; the workspace root is the tool's to check", () => {
    // ArchiveExtract's destination and GitApplyPatch's cwd are walked
    // (`beneath: "all"`). Named inside the session logs, the floor denies.
    const extractInto = (dest: string): ToolCallContext => ({
      toolName: "ArchiveExtract",
      input: { archive: "a.tar", destination: dest },
      operativeValues: [
        { kind: "path", canonical: ["a.tar", "/srv/ws/a.tar"] },
        {
          kind: "path",
          canonical: [dest, `/srv/ws/${dest}`],
          beneath: [`${dest}/`, `/srv/ws/${dest}/`],
        },
      ],
      readOnly: false,
      destructive: true,
    });
    const rules: RuleSet = {
      ...emptyRuleSet,
      flag: [rule("alwaysAllow", "ArchiveExtract", "flag")],
    };
    expect(
      evaluateWithReason(extractInto(".crewhaus/sessions/unpacked"), "auto", rules, {
        protectedRoots: ROOTS,
      }).decision,
    ).toBe("deny");
    // Named at the WORKSPACE ROOT, the floor cannot tell a write that lands
    // in a root from one that does not — a patch's files, an archive's
    // members — and a git pathspec or a patch's `cwd` defaults to `.`, so it
    // leaves the call to the rules, and the tool checks its own targets
    // against the roots the runtime hands it on the bridge (tool-safety
    // `protectedRootsOf`).
    const patchAtRoot: ToolCallContext = {
      toolName: "GitApplyPatch",
      input: { cwd: ".", patch: "…" },
      operativeValues: [{ kind: "path", canonical: [".", "/srv/ws"], beneath: ["", "/srv/ws/"] }],
      readOnly: false,
      destructive: true,
    };
    const patchRules: RuleSet = {
      ...emptyRuleSet,
      flag: [rule("alwaysAllow", "GitApplyPatch", "flag")],
    };
    expect(
      evaluateWithReason(patchAtRoot, "auto", patchRules, { protectedRoots: ROOTS }).decision,
    ).toBe("allow");
    // Named at a workspace directory that HOLDS a root, everything beneath
    // it is the call's: `.crewhaus` holds the session logs.
    const above = evaluateWithReason(extractInto(".crewhaus"), "auto", rules, {
      protectedRoots: ROOTS,
    });
    expect(above.decision).toBe("deny");
    expect(above.reason).toBe(
      "`ArchiveExtract` is not read-only and acts on everything beneath `.crewhaus`, where the runtime keeps its own record of the run (session logs, spilled tool results, proof bundles) or the files that control it (the harness's run files, settings, gate records, environment files, compiled bundle and dependencies, Hangar's directory) — no rule can allow that",
    );
  });

  test("a writer that acts beneath a directory holding a root is denied: StateImport and StoreMigrate cannot fill the logs from `.crewhaus` (I12)", () => {
    // What the runtime hands the floor for a `beneath: "all"` path field:
    // the directory's spellings, and the prefixes everything under it starts with.
    const beneath = (dir: string) => ({
      kind: "path" as const,
      canonical: [dir, `/srv/ws/${dir}`],
      beneath: [`${dir}/`, `./${dir}/`, `/srv/ws/${dir}/`],
    });
    const rules: RuleSet = {
      ...emptyRuleSet,
      flag: [
        rule("alwaysAllow", "StateImport", "flag"),
        rule("alwaysAllow", "StoreMigrate", "flag"),
      ],
    };
    // StateImport {stateDir: ".crewhaus", files: [sessions/<sid>.jsonl]}.
    const stateImport: ToolCallContext = {
      toolName: "StateImport",
      input: { stateDir: ".crewhaus", mode: "merge" },
      operativeValues: [beneath(".crewhaus")],
      readOnly: false,
      destructive: true,
    };
    // StoreMigrate {dir: "fake", to: ".crewhaus"}.
    const storeMigrate: ToolCallContext = {
      toolName: "StoreMigrate",
      input: { dir: "fake", to: ".crewhaus" },
      operativeValues: [beneath("fake"), beneath(".crewhaus")],
      readOnly: false,
      destructive: true,
    };
    for (const call of [stateImport, storeMigrate]) {
      for (const mode of ["default", "auto"] as const) {
        const r = evaluateWithReason(call, mode, rules, { protectedRoots: ROOTS });
        expect({ tool: call.toolName, mode, decision: r.decision }).toEqual({
          tool: call.toolName,
          mode,
          decision: "deny",
        });
        expect(r.reason).toContain("acts on everything beneath `.crewhaus`");
      }
    }
    // A case the filesystem folds is the same directory.
    const shouted: ToolCallContext = {
      ...stateImport,
      operativeValues: [{ ...beneath(".CREWHAUS"), caseInsensitive: true }],
    };
    expect(evaluateWithReason(shouted, "auto", rules, { protectedRoots: ROOTS }).decision).toBe(
      "deny",
    );
  });

  test("acting beneath the workspace root, a sibling, or a directory read alone is not the floor's", () => {
    const rules: RuleSet = { ...emptyRuleSet, flag: [rule("alwaysAllow", "*", "flag")] };
    const call = (operativeValues: ToolCallContext["operativeValues"]): ToolCallContext => ({
      toolName: "StoreMigrate",
      input: {},
      ...(operativeValues !== undefined ? { operativeValues } : {}),
      readOnly: false,
      destructive: true,
    });
    for (const values of [
      // GitAdd / GitCommit / StoreMigrate's own default: the workspace root.
      [{ kind: "path" as const, canonical: [".", "/srv/ws"], beneath: ["", "./", "/srv/ws/"] }],
      // A sibling of the record, and the store a KvSet works in.
      [{ kind: "path" as const, canonical: [".crewhaus/state"], beneath: [".crewhaus/state/"] }],
      [{ kind: "path" as const, canonical: ["src"], beneath: ["src/", "/srv/ws/src/"] }],
      // `.crewhaus` named as itself alone (TempDir without `clear`): no `beneath`.
      [{ kind: "path" as const, canonical: [".crewhaus", "/srv/ws/.crewhaus"] }],
      // A walk that skips hidden names never opens `.crewhaus` under `a`.
      [
        {
          kind: "path" as const,
          canonical: ["a"],
          beneath: ["a/"],
          beneathSkipsHidden: true,
        },
      ],
    ]) {
      expect(
        evaluateWithReason(call(values), "auto", rules, {
          protectedRoots: [...ROOTS, "a/.crewhaus/sessions"],
        }).decision,
      ).toBe("allow");
    }
    // An absolute-only root (sessions kept outside the workspace) is read
    // inside alone: no workspace directory holds it.
    expect(
      evaluateWithReason(
        call([{ kind: "path", canonical: ["/var/x"], beneath: ["/var/x/"] }]),
        "auto",
        rules,
        { protectedRoots: ["/var/x/sessions"] },
      ).decision,
    ).toBe("allow");
  });

  test("Windows spellings: a drive path is absolute, so the workspace root is still the rules' (I2, round 3)", () => {
    // What runtimeStateRoots hands the floor on Windows (path.win32), and
    // what the runtime's canonicaliser spells the workspace root as there:
    // `[".", toPosix(realpath)]`, its prefixes `["", "./", "C:/srv/ws/"]`.
    const WIN_ROOTS = [
      "C:\\srv\\ws\\.crewhaus\\sessions",
      "C:\\srv\\ws\\.crewhaus\\tool-results",
      "C:\\srv\\ws\\.crewhaus\\proofs",
      ".crewhaus\\sessions",
      ".crewhaus\\tool-results",
      ".crewhaus\\proofs",
    ];
    const rules: RuleSet = { ...emptyRuleSet, flag: [rule("alwaysAllow", "*", "flag")] };
    const at = (
      toolName: string,
      operativeValues: NonNullable<ToolCallContext["operativeValues"]>,
    ): ToolCallContext => ({
      toolName,
      input: {},
      operativeValues,
      readOnly: false,
      destructive: true,
    });
    const workspaceRoot = {
      kind: "path" as const,
      canonical: [".", "C:/srv/ws"],
      beneath: ["", "./", "C:/srv/ws/"],
      caseInsensitive: true,
    };
    // GitCommit with no paths, GitAdd `.`, Lint, Format, Typecheck: each
    // acts beneath the workspace root, in default and auto mode alike.
    for (const tool of ["GitCommit", "GitAdd", "Lint", "Format", "Typecheck", "CopyPath"]) {
      for (const mode of ["default", "auto"] as const) {
        const r = evaluateWithReason(at(tool, [workspaceRoot]), mode, rules, {
          protectedRoots: WIN_ROOTS,
        });
        expect({ tool, mode, decision: r.decision, reason: r.reason }).toEqual({
          tool,
          mode,
          decision: "allow",
          reason: undefined,
        });
      }
    }
    // A different drive, its root outside the workspace: read inside alone.
    expect(
      evaluateWithReason(
        at("StoreMigrate", [
          { kind: "path", canonical: ["D:/x"], beneath: ["D:/x/"], caseInsensitive: true },
        ]),
        "auto",
        rules,
        { protectedRoots: ["D:\\x\\sessions"] },
      ).decision,
    ).toBe("allow");
    // The floor itself holds on Windows: `.crewhaus` named beneath ...
    const crewhaus = evaluateWithReason(
      at("StateImport", [
        {
          kind: "path",
          canonical: [".crewhaus", "C:/srv/ws/.crewhaus"],
          beneath: [".crewhaus/", "./.crewhaus/", "C:/srv/ws/.crewhaus/"],
          caseInsensitive: true,
        },
      ]),
      "auto",
      rules,
      { protectedRoots: WIN_ROOTS },
    );
    expect(crewhaus.decision).toBe("deny");
    expect(crewhaus.reason).toContain("acts on everything beneath `.crewhaus`");
    // ... and a write into a root, by its drive spelling in any case or a
    // `..` that cannot climb past the drive (`C:\..` is `C:\`).
    for (const spelled of [
      "C:/srv/ws/.crewhaus/sessions/sess_00000000000000aa.jsonl",
      "c:\\SRV\\ws\\.crewhaus\\Sessions\\x.jsonl",
      "C:/../../srv/ws/.crewhaus/proofs/x.json",
    ]) {
      const write: ToolCallContext = {
        toolName: "Write",
        input: { path: spelled, content: "x" },
        operativeValues: [
          { kind: "path", canonical: [spelled], outsideWorkspace: true, caseInsensitive: true },
        ],
        readOnly: false,
        destructive: true,
      };
      expect({
        spelled,
        decision: evaluateWithReason(write, "auto", rules, { protectedRoots: WIN_ROOTS }).decision,
      }).toEqual({
        spelled,
        decision: "deny",
      });
    }
    // On POSIX a name `C:` is a directory: `C:/../` climbs back out of it,
    // read from a tool's input strings as written.
    const mcpWrite: ToolCallContext = {
      toolName: "mcp__fs__write_file",
      input: { path: `C:/../${LOG}`, content: "x" },
      readOnly: false,
      destructive: true,
    };
    expect(evaluateWithReason(mcpWrite, "auto", rules, { protectedRoots: ROOTS }).decision).toBe(
      "deny",
    );
  });

  test("a tool that declares no operative arguments is read from its input strings", () => {
    const mcpWrite: ToolCallContext = {
      toolName: "mcp__fs__write_file",
      input: { target: { path: `./${LOG}` }, content: "x" },
      readOnly: false,
      destructive: true,
    };
    const rules: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAllow", "mcp__fs__write_file")] };
    expect(evaluateWithReason(mcpWrite, "default", rules, { protectedRoots: ROOTS }).decision).toBe(
      "deny",
    );
  });

  test("nothing else changes: reads, writes elsewhere, a sibling with the root as a prefix, no roots given", () => {
    const readLog: ToolCallContext = {
      toolName: "Read",
      input: { path: LOG },
      operativeValues: [{ kind: "path", canonical: [LOG, `/srv/ws/${LOG}`] }],
      readOnly: true,
      destructive: false,
    };
    expect(
      evaluateWithReason(readLog, "default", BUILTIN_RULES_ONLY, { protectedRoots: ROOTS })
        .decision,
    ).toBe("allow");
    for (const rel of [
      "src/app.ts",
      ".crewhaus/sessions-archive/x.jsonl",
      ".crewhaus/settings.json",
    ]) {
      expect(
        evaluateWithReason(writeTo(rel), "auto", allowEverywhere, { protectedRoots: ROOTS })
          .decision,
      ).toBe("allow");
    }
    // A write OUTSIDE the workspace is not the floor's business: the rules decide.
    const outside: ToolCallContext = {
      ...writeTo("/tmp/x"),
      operativeValues: [{ kind: "path", canonical: ["/tmp/x"], outsideWorkspace: true }],
    };
    expect(
      evaluateWithReason(outside, "auto", allowEverywhere, { protectedRoots: ROOTS }).decision,
    ).toBe("allow");
    expect(evaluateWithReason(writeTo(LOG), "auto", allowEverywhere).decision).toBe("allow");
  });

  test("the runtime's floorValues decide where a call writes: a store directory it only works in does not trip the floor", () => {
    // EmitTraceEvent's shape: its relocating `dir` is the session store
    // (namespaced custom.* lines), and the runtime leaves it out of floorValues.
    const emit: ToolCallContext = {
      toolName: "EmitTraceEvent",
      input: { dir: ".crewhaus/sessions", sessionId: "sess_00000000000000aa" },
      operativeValues: [
        { kind: "path", canonical: [".crewhaus/sessions", "/srv/ws/.crewhaus/sessions"] },
        { kind: "id", canonical: ["sess_00000000000000aa"] },
      ],
      floorValues: [{ kind: "id", canonical: ["sess_00000000000000aa"] }],
      readOnly: false,
      destructive: false,
    };
    const rules: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAllow", "EmitTraceEvent")] };
    expect(evaluateWithReason(emit, "default", rules, { protectedRoots: ROOTS }).decision).toBe(
      "allow",
    );
    // Without the runtime's reading, every operative value counts.
    const { floorValues: _ignored, ...unread } = emit;
    expect(evaluateWithReason(unread, "default", rules, { protectedRoots: ROOTS }).decision).toBe(
      "deny",
    );
  });

  test("bypass consults nothing, the floor included (the documented operator override)", () => {
    expect(
      evaluateWithReason(writeTo(LOG), "bypass", emptyRuleSet, { protectedRoots: ROOTS }).decision,
    ).toBe("allow");
  });
});

const BUILTIN_RULES_ONLY: RuleSet = { ...emptyRuleSet, builtin: BUILTIN_DEFAULT_RULES };

describe("the runtime-state floor: the files that control a run, one root an exact file", () => {
  // What the runtime hands the floor for them, built by hand (this package
  // cannot import runtime-core; runtime-core's own roots go through this
  // engine in scripts/control-files-floor.test.ts): the run directory whole
  // and the settings file exactly, absolute and workspace-relative, and
  // Hangar's directory outside the workspace, which is spelled absolute alone.
  const ROOTS = [
    "/srv/ws/.crewhaus/run",
    "/srv/ws/.crewhaus/settings.json",
    "/home/u/.crewhaus/hangar",
    ".crewhaus/run",
    ".crewhaus/settings.json",
  ];
  const RECORD = "where the runtime keeps its own record of the run";
  const CONTROL =
    "or the files that control it (the harness's run files, settings, gate records, environment files, compiled bundle and dependencies, Hangar's directory) — no rule can allow that";
  type Value = NonNullable<ToolCallContext["operativeValues"]>[number];
  const writing = (name: string, value: Value, toolName = "Write"): ToolCallContext => ({
    toolName,
    input: { path: name, content: "{}" },
    operativeValues: [value],
    readOnly: false,
    destructive: true,
  });
  /** A path as a tool spells it inside the workspace: the name as sent, which the floor normalises. */
  const inside = (name: string, over: Partial<Value> = {}): ToolCallContext =>
    writing(name, { kind: "path", canonical: [name], ...over });
  /** A path outside the workspace: no canonical spelling, its lexical ones only. */
  const outside = (abs: string): ToolCallContext =>
    writing(abs, { kind: "path", canonical: [], spellings: [abs], outsideWorkspace: true });
  const allowWrite: RuleSet = {
    ...emptyRuleSet,
    flag: [rule("alwaysAllow", "Write", "flag")],
    settings: [rule("alwaysAllow", "Write(**)", "settings")],
    yaml: [rule("alwaysAllow", "Write(**)")],
  };
  const decide = (call: ToolCallContext, mode: "default" | "auto" | "plan" = "auto") =>
    evaluateWithReason(call, mode, allowWrite, { protectedRoots: ROOTS });

  test("the settings file is one exact file: its spellings, and anything under it, are denied", () => {
    for (const name of [
      ".crewhaus/settings.json",
      "./.crewhaus/settings.json",
      "src/../.crewhaus/settings.json",
      ".crewhaus//settings.json",
      ".crewhaus/settings.json/x",
      "/srv/ws/.crewhaus/settings.json",
    ]) {
      for (const mode of ["default", "auto", "plan"] as const) {
        const r = decide(inside(name), mode);
        expect({ name, mode, decision: r.decision }).toEqual({ name, mode, decision: "deny" });
        expect(r.reason).toContain(RECORD);
        expect(r.reason).toContain(CONTROL);
      }
    }
  });

  test("its neighbours are not the file: a name it is a prefix of is the rules' to decide", () => {
    for (const name of [
      ".crewhaus/settings.json.bak",
      ".crewhaus/settings.jsonx",
      ".crewhaus/settings",
      ".crewhaus/notes.md",
      "src/.crewhaus/settings.json",
    ]) {
      const r = decide(inside(name));
      expect({ name, decision: r.decision, reason: r.reason }).toEqual({
        name,
        decision: "allow",
        reason: undefined,
      });
    }
  });

  test("a folded spelling is the file where the filesystem folds case, and another file where it does not", () => {
    const shouted = ".CREWHAUS/Settings.JSON";
    const folded = decide(inside(shouted, { caseInsensitive: true }));
    expect(folded.decision).toBe("deny");
    expect(folded.reason).toContain(CONTROL);
    expect(decide(inside(shouted)).decision).toBe("allow");
  });

  test("the run directory is protected whole, and a sibling it is a prefix of is not", () => {
    for (const name of [
      ".crewhaus/run",
      ".crewhaus/run/control-token",
      ".crewhaus/run/logs/a.log",
    ]) {
      const r = decide(inside(name));
      expect({ name, decision: r.decision }).toEqual({ name, decision: "deny" });
      expect(r.reason).toContain(CONTROL);
    }
    for (const name of [".crewhaus/runbook/x", ".crewhaus/run.md", ".crewhaus/running"]) {
      expect({ name, decision: decide(inside(name)).decision }).toEqual({
        name,
        decision: "allow",
      });
    }
  });

  test("Hangar's directory outside the workspace is read as written, and only it", () => {
    for (const abs of [
      "/home/u/.crewhaus/hangar",
      "/home/u/.crewhaus/hangar/token",
      "/home/u/.crewhaus/hangar/access/members.json",
      "/home/u/.crewhaus/hangar/../hangar/settings.json",
    ]) {
      const r = decide(outside(abs));
      expect({ abs, decision: r.decision }).toEqual({ abs, decision: "deny" });
      expect(r.reason).toContain(CONTROL);
    }
    for (const abs of ["/home/u/.crewhaus/hangar-old/token", "/home/u/.crewhaus/settings.json"]) {
      expect({ abs, decision: decide(outside(abs)).decision }).toEqual({ abs, decision: "allow" });
    }
  });

  test("an alwaysAllow in any of the five sources does not lift it, and bypass consults nothing", () => {
    const sources = ["flag", "settings", "yaml", "hooks", "builtin"] as const;
    for (const source of sources) {
      const rules: RuleSet = { ...emptyRuleSet, [source]: [rule("alwaysAllow", "Write", source)] };
      for (const mode of ["default", "auto"] as const) {
        const r = evaluateWithReason(inside(".crewhaus/settings.json"), mode, rules, {
          protectedRoots: ROOTS,
        });
        expect({ source, mode, decision: r.decision }).toEqual({ source, mode, decision: "deny" });
        expect(r.reason).toContain(CONTROL);
      }
    }
    expect(
      evaluateWithReason(inside(".crewhaus/settings.json"), "bypass", emptyRuleSet, {
        protectedRoots: ROOTS,
      }),
    ).toEqual({ decision: "allow" });
  });

  test("a writer that acts beneath `.crewhaus` is denied with the roots of the record moved out (a tenant's)", () => {
    // No session, tool-result or proof root under `.crewhaus` here: the
    // control files alone put a root beneath it.
    const stateImport: ToolCallContext = {
      toolName: "StateImport",
      input: { stateDir: ".crewhaus" },
      operativeValues: [
        {
          kind: "path",
          canonical: [".crewhaus", "/srv/ws/.crewhaus"],
          beneath: [".crewhaus/", "./.crewhaus/", "/srv/ws/.crewhaus/"],
        },
      ],
      readOnly: false,
      destructive: true,
    };
    const rules: RuleSet = { ...emptyRuleSet, flag: [rule("alwaysAllow", "StateImport", "flag")] };
    const r = evaluateWithReason(stateImport, "auto", rules, { protectedRoots: ROOTS });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("acts on everything beneath `.crewhaus`, where");
    expect(r.reason).toContain(RECORD);
    expect(r.reason).toContain(CONTROL);
  });

  test("a read-only call is outside the floor, and other writes are the rules' to decide", () => {
    for (const toolName of ["Read", "Grep", "Glob"]) {
      for (const name of [".crewhaus/settings.json", ".crewhaus/run/daemon.json"]) {
        const read: ToolCallContext = {
          toolName,
          input: { path: name },
          operativeValues: [{ kind: "path", canonical: [name] }],
          readOnly: true,
          destructive: false,
        };
        expect({
          toolName,
          name,
          decision: evaluateWithReason(read, "default", BUILTIN_RULES_ONLY, {
            protectedRoots: ROOTS,
          }).decision,
        }).toEqual({ toolName, name, decision: "allow" });
      }
    }
    // Unruled, a write beside the roots asks; a rule decides it either way.
    const notes = inside(".crewhaus/notes.md");
    expect(
      evaluateWithReason(notes, "default", emptyRuleSet, { protectedRoots: ROOTS }).decision,
    ).toBe("ask");
    const denied = evaluateWithReason(
      notes,
      "default",
      { ...emptyRuleSet, yaml: [rule("alwaysDeny", "Write(.crewhaus/**)")] },
      { protectedRoots: ROOTS },
    );
    expect(denied.decision).toBe("deny");
    expect(denied.reason ?? "").not.toContain(RECORD);
  });
});

describe("the runtime-state floor: a path with a name git treats as its own directory", () => {
  const ROOTS = [".crewhaus/sessions"];
  const REASON =
    "is not read-only and names a path inside a repository's git directory, which belongs to git and to the person running it — no rule can allow that";
  const allow: RuleSet = {
    ...emptyRuleSet,
    flag: [
      rule("alwaysAllow", "Write", "flag"),
      rule("alwaysAllow", "Post", "flag"),
      rule("alwaysAllow", "mcp__fs__search", "flag"),
    ],
  };
  const writing = (rel: string, over: Record<string, unknown> = {}): ToolCallContext => ({
    toolName: "Write",
    input: { path: rel },
    operativeValues: [{ kind: "path", canonical: [rel], ...over }],
    readOnly: false,
    destructive: true,
  });
  /** A tool that declares no paths: the floor reads the strings in its input. */
  const posting = (text: string): ToolCallContext => ({
    toolName: "Post",
    input: { text },
    readOnly: false,
    destructive: false,
  });
  const floor = (call: ToolCallContext, protectedRoots: readonly string[] = ROOTS) =>
    evaluateWithReason(call, "auto", allow, { protectedRoots });

  test("denied before any rule, with its own reason, in every mode but bypass", () => {
    for (const rel of [
      ".git/config",
      ".git/hooks/pre-commit",
      "n/.git/config",
      "n/.git",
      ".GIT/config",
      ".git./config",
      "git~1/config",
      "n\\.git\\config",
    ]) {
      for (const over of [{}, { caseInsensitive: true }]) {
        const r = floor(writing(rel, over));
        expect({ rel, decision: r.decision, reason: r.reason }).toEqual({
          rel,
          decision: "deny",
          reason: `\`Write\` ${REASON}`,
        });
      }
    }
    for (const mode of ["default", "plan"] as const) {
      const r = evaluateWithReason(writing(".git/config"), mode, allow, { protectedRoots: ROOTS });
      expect({ mode, reason: r.reason }).toEqual({ mode, reason: `\`Write\` ${REASON}` });
    }
    expect(
      evaluateWithReason(writing(".git/config"), "bypass", allow, { protectedRoots: ROOTS })
        .decision,
    ).toBe("allow");
  });

  test("a name that only starts or ends like one is the rules' to decide", () => {
    for (const rel of [".gitignore", ".gitattributes", ".github/x", "foo.git/x", ".gitmodules"]) {
      const r = floor(writing(rel));
      expect({ rel, decision: r.decision }).toEqual({ rel, decision: "allow" });
    }
  });

  test("a read-only call on one is the rules' to decide", () => {
    const read: ToolCallContext = {
      ...writing(".git/config"),
      toolName: "Read",
      readOnly: true,
      destructive: false,
    };
    expect(evaluateWithReason(read, "auto", emptyRuleSet, { protectedRoots: ROOTS }).decision).toBe(
      "allow",
    );
  });

  test("a value is read by its workspace-relative spellings", () => {
    // The workspace's absolute path to the file, as the canonicaliser gives it.
    const absolute = writing("/srv/ws/.git/config", { spellings: [".git/config"] });
    expect(floor(absolute).reason).toBe(`\`Write\` ${REASON}`);
    // A link to a git directory, caught by where it leads.
    const linked = writing("lnk/config", { spellings: [".git/config"] });
    expect(floor(linked).reason).toBe(`\`Write\` ${REASON}`);
    // A workspace that itself sits under such a name is not walled off.
    const under = writing("/srv/.git/ws/notes.md", { spellings: ["notes.md"] });
    expect(floor(under).decision).toBe("allow");
    // Nor is a path that is not in the workspace read by its names.
    expect(floor(writing("../other/.git/config")).decision).toBe("allow");
    // A name that resolves away is not there.
    expect(floor(writing(".git/../notes.md")).decision).toBe("allow");
  });

  test("a field that only relocates the tool is left out: its writer adds its own layout", () => {
    const store = writing(".git", { relocates: true });
    expect(floor(store).decision).toBe("allow");
    const named: ToolCallContext = {
      ...writing("record"),
      operativeValues: [
        { kind: "path", canonical: ["n/.git"], relocates: true },
        { kind: "path", canonical: [".git/config"] },
      ],
    };
    expect(floor(named).reason).toBe(`\`Write\` ${REASON}`);
  });

  test("a string from a tool with no declared paths: a path, not a URL or a sentence", () => {
    for (const text of [".git/config", "foo/.git/config", ".GIT/config", "/srv/ws/.git/config"]) {
      const r = floor(posting(text));
      expect({ text, reason: r.reason }).toEqual({ text, reason: `\`Post\` ${REASON}` });
    }
    for (const text of [
      "https://h/r/.git/x",
      "see foo/.git/config now",
      "a\n.git/config",
      ".gitignore",
      // No name follows it, or it is a pattern: an exclude argument, a search term.
      ".git",
      ".git/",
      "n/.git",
      "**/.git/**",
      ".git/*",
      ".git/[ch]*",
      "{.git,dist}/config",
    ]) {
      const r = floor(posting(text));
      expect({ text, decision: r.decision }).toEqual({ text, decision: "allow" });
    }
  });

  test("an undeclared tool's exclude arguments are the rules' to decide, at any depth of its input", () => {
    const calling = (input: Record<string, unknown>): ToolCallContext => ({
      toolName: "mcp__fs__search",
      input,
      readOnly: false,
      destructive: false,
    });
    for (const input of [
      { path: "src", excludePatterns: ["node_modules", ".git"] },
      { excludePatterns: ["**/.git/**"] },
      { exclude: ".git/" },
      { query: ".git" },
      { filter: { skip: [{ name: "vendor/.git" }] } },
    ]) {
      expect({ input, decision: floor(calling(input)).decision }).toEqual({
        input,
        decision: "allow",
      });
    }
    // A rule still decides them.
    const denied = evaluateWithReason(
      calling({ exclude: ".git" }),
      "auto",
      { ...emptyRuleSet, yaml: [rule("alwaysDeny", "mcp__fs__search")] },
      { protectedRoots: ROOTS },
    );
    expect(denied.decision).toBe("deny");
    expect(denied.reason ?? "").not.toContain("git directory");
    // A file in one, however deep in the input, is still denied.
    expect(floor(calling({ edits: [{ file: "n/.git/config" }] })).reason).toBe(
      `\`mcp__fs__search\` ${REASON}`,
    );
  });

  test("with no protected roots the run has no floor", () => {
    expect(floor(writing(".git/config"), []).decision).toBe("allow");
    expect(evaluateWithReason(writing(".git/config"), "auto", allow).decision).toBe("allow");
  });

  test("a root's own reason is unchanged", () => {
    expect(floor(writing(".crewhaus/sessions/x.jsonl")).reason).toContain(
      "the runtime keeps its own record of the run",
    );
  });
});

describe("Pillar 3 — ruleBasedJustificationJudge", () => {
  test("denies brief justifications", async () => {
    const v = await evaluateJustification({
      toolName: "SendMessage",
      justification: "ok",
      sessionGoal: "summarize the user's emails",
      input: {},
    });
    expect(v.allow).toBe(false);
    expect(v.reason).toMatch(/too brief/);
    expect(v.judgeModel).toBe("rule-based");
  });

  test("allows when no session goal is supplied (audit-only path)", async () => {
    const v = await evaluateJustification({
      toolName: "SendMessage",
      justification: "user wants a confirmation message sent to slack #team",
      sessionGoal: "",
      input: {},
    });
    expect(v.allow).toBe(true);
    expect(v.confidence).toBe(0);
  });

  test("denies when justification shares no salient tokens with goal", async () => {
    const v = await evaluateJustification({
      toolName: "EvmSendTransaction",
      justification: "broadcasting a transaction to mint the new NFT collection",
      sessionGoal: "summarize the customer's recent email correspondence",
      input: {},
    });
    expect(v.allow).toBe(false);
    expect(v.reason).toMatch(/no salient tokens/);
  });

  test("allows when justification overlaps the goal", async () => {
    const v = await evaluateJustification({
      toolName: "SendMessage",
      justification: "post the email summary to the #customer-success channel",
      sessionGoal: "summarize the customer's recent email correspondence",
      input: {},
    });
    expect(v.allow).toBe(true);
    expect(v.confidence ?? 0).toBeGreaterThan(0);
  });

  // SECURITY: the rule-based judge is gameable (the same model writes the
  // justification), so its `allow` must NOT stand in production.
  const OVERLAPPING = {
    toolName: "SendMessage",
    justification: "post the email summary to the #customer-success channel",
    sessionGoal: "summarize the customer's recent email correspondence",
    input: {},
  } as const;

  test("fails closed in production when the rule-based judge would allow", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevOptIn = process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"];
    process.env.NODE_ENV = "production";
    process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"] = ""; // not "1" → fail-closed
    __resetRuleBasedJudgeWarningForTests();
    try {
      const v = await evaluateJustification({ ...OVERLAPPING });
      expect(v.allow).toBe(false);
      expect(v.reason).toMatch(/fail-closed/);
    } finally {
      process.env.NODE_ENV = prevEnv ?? "test";
      process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"] = prevOptIn ?? "";
    }
  });

  // 0.7.1 review: NODE_ENV=test is ambient. A compiled bundle, or `crewhaus
  // run`, started under it is not the test runner, and its rule-based
  // judge's `allow` must not stand. A child process whose entry is not a
  // test file stands in for the bundle.
  test("NODE_ENV=test outside the test runner opens nothing: the allow still fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "pe-node-env-"));
    try {
      const script = join(dir, "agent.ts");
      writeFileSync(
        script,
        [
          `import { evaluateJustification } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};`,
          `const v = await evaluateJustification(${JSON.stringify(OVERLAPPING)});`,
          "process.stdout.write(JSON.stringify(v));",
        ].join("\n"),
      );
      const verdict = (env: Record<string, string>) => {
        const out = Bun.spawnSync([process.execPath, script], {
          env: { PATH: process.env["PATH"] ?? "", ...env },
          stderr: "pipe",
        });
        return JSON.parse(out.stdout.toString()) as { allow: boolean; reason: string };
      };
      const underTestEnv = verdict({ NODE_ENV: "test" });
      expect(underTestEnv.allow).toBe(false);
      expect(underTestEnv.reason).toMatch(/fail-closed/);
      // The operator's explicit opt-in is the one way to accept it.
      expect(
        verdict({ NODE_ENV: "test", CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION: "1" }).allow,
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("under the test runner the rule-based judge still answers for itself", async () => {
    // This file is the runner's entry, and Bun set NODE_ENV=test.
    expect(process.env.NODE_ENV).toBe("test");
    const prevOptIn = process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"];
    process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"] = "";
    try {
      expect((await evaluateJustification({ ...OVERLAPPING })).allow).toBe(true);
    } finally {
      process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"] = prevOptIn ?? "";
    }
  });

  test("CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION=1 restores the rule-based allow in production", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevOptIn = process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"];
    process.env.NODE_ENV = "production";
    process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"] = "1";
    __resetRuleBasedJudgeWarningForTests();
    try {
      const v = await evaluateJustification({ ...OVERLAPPING });
      expect(v.allow).toBe(true);
    } finally {
      process.env.NODE_ENV = prevEnv ?? "test";
      process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"] = prevOptIn ?? "";
    }
  });

  test("custom judge overrides the default", async () => {
    const custom: JustificationJudge = () => ({
      allow: false,
      reason: "denied by test judge",
      judgeModel: "test-judge",
    });
    const v = await evaluateJustification(
      {
        toolName: "SendMessage",
        justification: "long enough justification text here",
        sessionGoal: "long enough justification text here",
        input: {},
      },
      custom,
    );
    expect(v.allow).toBe(false);
    expect(v.judgeModel).toBe("test-judge");
  });

  test("async judge is awaited", async () => {
    const asyncJudge: JustificationJudge = async () => ({
      allow: true,
      reason: "async ok",
      judgeModel: "async-test",
    });
    const v = await evaluateJustification(
      {
        toolName: "X",
        justification: "long enough justification text here",
        sessionGoal: "long enough justification text here",
        input: {},
      },
      asyncJudge,
    );
    expect(v.allow).toBe(true);
    expect(v.judgeModel).toBe("async-test");
  });

  // FR-004 — a model-backed judge plugs into evaluateJustification with no
  // signature change; its judgeModel + confidence propagate onto the
  // verdict. Stub stands in for @crewhaus/justification-judge-claude so this
  // assertion stays in-package and deterministic.
  test("model-backed judge round-trips judgeModel + confidence (no signature change)", async () => {
    const modelBackedJudge: JustificationJudge = async (input) => ({
      allow: true,
      reason: `model judged "${input.toolName}" consistent with the session goal`,
      confidence: 0.83,
      judgeModel: "claude-haiku-4-5",
    });
    const v = await evaluateJustification(
      {
        toolName: "SendMessage",
        justification: "acknowledge the ticket the user pointed me at",
        sessionGoal: "Acknowledge support tickets the user points you at.",
        input: { body: "got it" },
      },
      modelBackedJudge,
    );
    expect(v.allow).toBe(true);
    expect(v.judgeModel).toBe("claude-haiku-4-5");
    expect(v.confidence).toBe(0.83);
    expect(v.reason).toContain("SendMessage");
  });
});

// #161 (CWE-807) — the rule-based judge is satisfiable by attacker-influenced
// justification text, so in a real (non-test) run evaluateJustification must
// surface a prominent one-time warning that it offers no protection and that
// production needs an LLM-backed judge. A model-backed judge must NOT trip it.
describe("Pillar 3 — rule-based judge weakness warning (#161)", () => {
  const originalWarn = console.warn;
  const originalNodeEnv = process.env.NODE_ENV;
  let warnings: string[] = [];

  beforeEach(() => {
    warnings = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    // The guard latches per process; reset it so each test asserts for the
    // right reason regardless of order.
    __resetRuleBasedJudgeWarningForTests();
  });

  afterEach(() => {
    console.warn = originalWarn;
    process.env.NODE_ENV = originalNodeEnv;
    __resetRuleBasedJudgeWarningForTests();
  });

  test("warns for the rule-based judge path in a non-test run", async () => {
    process.env.NODE_ENV = "production";
    await evaluateJustification({
      toolName: "EvmSendTransaction",
      justification: "broadcasting a transaction to mint the new NFT collection",
      sessionGoal: "summarize the customer's recent email correspondence",
      input: {},
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[permission-engine]");
    expect(warnings[0]).toContain("SECURITY");
    expect(warnings[0]).toContain("EvmSendTransaction");
    expect(warnings[0]).toContain("security.justification.judge: claude");
    // Warning is decoupled from the verdict — it fires on allow paths too.
  });

  test("warns on the rule-based allow path AND fails it closed in production", async () => {
    process.env.NODE_ENV = "production";
    const v = await evaluateJustification({
      toolName: "SendMessage",
      justification: "post the email summary to the #customer-success channel",
      sessionGoal: "summarize the customer's recent email correspondence",
      input: {},
    });
    // The rule-based judge would have allowed (token overlap), so the warning
    // fires — but the allow is overridden to a fail-closed deny in production.
    expect(v.allow).toBe(false);
    expect(v.reason).toMatch(/fail-closed/);
    expect(v.judgeModel).toBe(RULE_BASED_JUDGE_MODEL);
    expect(warnings).toHaveLength(1);
  });

  test("fires at most once per process even across many tool calls", async () => {
    process.env.NODE_ENV = "production";
    for (let i = 0; i < 5; i++) {
      await evaluateJustification({
        toolName: `Tool${i}`,
        justification: "broadcasting a transaction to mint the new NFT collection",
        sessionGoal: "summarize the customer's recent email correspondence",
        input: {},
      });
    }
    expect(warnings).toHaveLength(1);
    // First-seen tool name is the one captured in the one-time warning.
    expect(warnings[0]).toContain("Tool0");
  });

  test("does NOT warn for an injected model-backed judge", async () => {
    process.env.NODE_ENV = "production";
    const modelBackedJudge: JustificationJudge = async (input) => ({
      allow: true,
      reason: `model judged "${input.toolName}" consistent with the session goal`,
      confidence: 0.91,
      judgeModel: "claude-haiku-4-5",
    });
    const v = await evaluateJustification(
      {
        toolName: "EvmSendTransaction",
        justification: "broadcasting a transaction to mint the new NFT collection",
        sessionGoal: "summarize the customer's recent email correspondence",
        input: {},
      },
      modelBackedJudge,
    );
    expect(v.judgeModel).toBe("claude-haiku-4-5");
    expect(warnings).toHaveLength(0);
  });

  test("stays silent under NODE_ENV=test even on the rule-based path", async () => {
    process.env.NODE_ENV = "test";
    await evaluateJustification({
      toolName: "EvmSendTransaction",
      justification: "broadcasting a transaction to mint the new NFT collection",
      sessionGoal: "summarize the customer's recent email correspondence",
      input: {},
    });
    expect(warnings).toHaveLength(0);
  });
});

describe("#383 — builtin bookkeeping rules", () => {
  const bookkeepingCall = (toolName: string): ToolCallContext => ({
    toolName,
    input: {},
    readOnly: false,
    destructive: false,
  });

  test("BUILTIN_BOOKKEEPING_RULES are folded into BUILTIN_DEFAULT_RULES", () => {
    for (const r of BUILTIN_BOOKKEEPING_RULES) {
      expect(BUILTIN_DEFAULT_RULES).toContainEqual(r);
      expect(r.type).toBe("alwaysAllow");
      expect(r.source).toBe("builtin");
    }
  });

  test("Skill and the continuity tools allow in default mode with only builtin rules", () => {
    const rs: RuleSet = { ...emptyRuleSet, builtin: [...BUILTIN_DEFAULT_RULES] };
    for (const name of [
      "Skill",
      "FocusRead",
      "FocusWrite",
      "PlanRead",
      "PlanUpdate",
      "PlanComplete",
      "GoalWrite",
      "GoalUpdate",
      "GoalList",
    ]) {
      expect(evaluate(bookkeepingCall(name), "default", rs)).toBe("allow");
    }
  });

  test("MemoryClear is deliberately NOT pre-allowed (destructive bookkeeping)", () => {
    const rs: RuleSet = { ...emptyRuleSet, builtin: [...BUILTIN_DEFAULT_RULES] };
    expect(evaluate(bookkeepingCall("MemoryClear"), "default", rs)).toBe("ask");
  });

  test("0.8.0 — the provability gate's read-only tools allow; ProofCheck allows the builtin checker alone", () => {
    const rs: RuleSet = { ...emptyRuleSet, builtin: [...BUILTIN_DEFAULT_RULES] };
    const call = (toolName: string, readOnly: boolean): ToolCallContext => ({
      toolName,
      input: {},
      readOnly,
      destructive: !readOnly,
    });
    expect(evaluate(call("ProvabilityPreflight", true), "default", rs)).toBe("allow");
    expect(evaluate(call("ProofCheckers", true), "default", rs)).toBe("allow");
    // ProofCheck's one operative arg is the checker (`kind: "id"`): the
    // sandbox-free builtin is allowed, a container checker keeps the mode
    // default, and a call the runtime could not read the checker of asks.
    const proofCheck = (checker: string): ToolCallContext => ({
      toolName: "ProofCheck",
      input: { checker },
      readOnly: false,
      destructive: true,
      operativeValues: [{ kind: "id", canonical: [checker] }],
    });
    expect(evaluate(proofCheck("builtin"), "default", rs)).toBe("allow");
    expect(evaluate(proofCheck("builtin"), "auto", rs)).toBe("allow");
    expect(evaluate(proofCheck("smt"), "default", rs)).toBe("ask");
    expect(evaluate(proofCheck("lean4"), "auto", rs)).toBe("ask");
    expect(evaluate(proofCheck("builtin-ish"), "default", rs)).toBe("ask");
    expect(evaluate(call("ProofCheck", false), "default", rs)).toBe("ask");
    // Plan mode never widens: the tool writes an artifact, so it is denied there.
    expect(evaluate(proofCheck("builtin"), "plan", rs)).toBe("deny");
    // A spec rule outranks the builtin grant.
    const asked: RuleSet = {
      ...emptyRuleSet,
      yaml: [rule("alwaysAsk", "ProofCheck")],
      builtin: [...BUILTIN_DEFAULT_RULES],
    };
    expect(evaluate(proofCheck("builtin"), "default", asked)).toBe("ask");
    // A spec rule still outranks the builtin grant.
    const denied: RuleSet = {
      ...emptyRuleSet,
      yaml: [rule("alwaysDeny", "ProvabilityPreflight")],
      builtin: [...BUILTIN_DEFAULT_RULES],
    };
    expect(evaluate(call("ProvabilityPreflight", true), "default", denied)).toBe("deny");
  });

  test("a spec-level alwaysAsk still outranks the builtin bookkeeping allow", () => {
    const rs: RuleSet = {
      ...emptyRuleSet,
      yaml: [rule("alwaysAsk", "Skill")],
      builtin: [...BUILTIN_DEFAULT_RULES],
    };
    expect(evaluate(bookkeepingCall("Skill"), "default", rs)).toBe("ask");
  });
});

describe("#383 — settings file helpers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "permission-engine-settings-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const settingsPath = (): string => join(dir, ".crewhaus", "settings.json");
  const writeSettings = (root: unknown): void => {
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(settingsPath(), typeof root === "string" ? root : JSON.stringify(root));
  };

  test("loadSettingsRules: missing file → []", () => {
    expect(loadSettingsRules(dir)).toEqual([]);
  });

  test("loadSettingsRules: reads permissions.rules tagged with the settings source", () => {
    writeSettings({
      permissions: { rules: [{ type: "alwaysAllow", pattern: "Skill" }] },
      hooks: { "pre-tool": [] },
    });
    expect(loadSettingsRules(dir)).toEqual([
      { type: "alwaysAllow", pattern: "Skill", source: "settings" },
    ]);
  });

  test("loadSettingsRules: a settings root without a permissions key → []", () => {
    writeSettings({ hooks: {} });
    expect(loadSettingsRules(dir)).toEqual([]);
  });

  test("loadSettingsRules: malformed JSON fails closed", () => {
    writeSettings("{not json");
    expect(() => loadSettingsRules(dir)).toThrow(PermissionConfigError);
  });

  test("loadSettingsRules: mode bypass is rejected from settings", () => {
    writeSettings({ permissions: { mode: "bypass" } });
    expect(() => loadSettingsRules(dir)).toThrow(/bypass mode cannot be set from settings/);
  });

  test("appendSettingsRule: creates .crewhaus/settings.json when absent", () => {
    const res = appendSettingsRule(dir, { type: "alwaysAllow", pattern: "Skill" });
    expect(res.added).toBe(true);
    expect(res.path).toBe(settingsPath());
    expect(loadSettingsRules(dir)).toEqual([
      { type: "alwaysAllow", pattern: "Skill", source: "settings" },
    ]);
    // Pretty-printed with a trailing newline, like `permissions suggest --apply`.
    expect(readFileSync(settingsPath(), "utf8")).toEndWith("\n");
  });

  test("appendSettingsRule: dedupes on (type, pattern)", () => {
    expect(appendSettingsRule(dir, { type: "alwaysAllow", pattern: "Skill" }).added).toBe(true);
    expect(appendSettingsRule(dir, { type: "alwaysAllow", pattern: "Skill" }).added).toBe(false);
    expect(loadSettingsRules(dir)).toHaveLength(1);
    // A different type for the same pattern is a distinct rule.
    expect(appendSettingsRule(dir, { type: "alwaysAsk", pattern: "Skill" }).added).toBe(true);
    expect(loadSettingsRules(dir)).toHaveLength(2);
  });

  test("appendSettingsRule: preserves unrelated settings keys and permissions.mode", () => {
    writeSettings({
      permissions: { mode: "auto", rules: [{ type: "alwaysDeny", pattern: "Bash(rm**)" }] },
      hooks: { "pre-tool": [{ match: "*", command: "echo hi" }] },
    });
    appendSettingsRule(dir, { type: "alwaysAllow", pattern: "log_knowledge_gap" });
    const root = JSON.parse(readFileSync(settingsPath(), "utf8")) as {
      permissions: { mode: string; rules: unknown[] };
      hooks: unknown;
    };
    expect(root.permissions.mode).toBe("auto");
    expect(root.hooks).toEqual({ "pre-tool": [{ match: "*", command: "echo hi" }] });
    expect(root.permissions.rules).toEqual([
      { type: "alwaysDeny", pattern: "Bash(rm**)" },
      { type: "alwaysAllow", pattern: "log_knowledge_gap" },
    ]);
  });

  test("appendSettingsRule: refuses to clobber a file it cannot parse", () => {
    writeSettings("{broken");
    expect(() => appendSettingsRule(dir, { type: "alwaysAllow", pattern: "Skill" })).toThrow(
      PermissionConfigError,
    );
    expect(readFileSync(settingsPath(), "utf8")).toBe("{broken");
  });

  test("appendSettingsRule: refuses when the existing permissions config is invalid", () => {
    writeSettings({ permissions: { rules: [{ type: "allowAll", pattern: "*" }] } });
    expect(() => appendSettingsRule(dir, { type: "alwaysAllow", pattern: "Skill" })).toThrow(
      PermissionConfigError,
    );
  });
});

describe("the runtime-state floor: a root under the spellings a folding filesystem opens it by", () => {
  const ROOTS = [
    ".crewhaus/settings.json",
    ".crewhaus/run",
    ".crewhaus/sessions",
    ".crewhaus/lists",
  ];
  const allow: RuleSet = { ...emptyRuleSet, flag: [rule("alwaysAllow", "Write", "flag")] };
  const call = (rel: string, over: Record<string, unknown> = {}): ToolCallContext => ({
    toolName: "Write",
    input: { path: rel },
    operativeValues: [{ kind: "path", canonical: [rel], ...over }],
    readOnly: false,
    destructive: true,
  });
  const decision = (c: ToolCallContext): string =>
    evaluateWithReason(c, "auto", allow, { protectedRoots: ROOTS }).decision;
  const SAME_NAME = [
    // Full case folds toLowerCase does not make (APFS: U+017F, U+00DF, U+1E9E, U+FB05, U+FB06).
    ".crewhaus/ſettingſ.json",
    ".crewhaus/settings.jſon",
    ".crewhauſ/settings.json",
    ".crewhauſ/run/control-token",
    ".crewhaus/seßions/x.jsonl",
    ".crewhaus/SEẞIONS/x.jsonl",
    ".crewhaus/liﬅs/x",
    ".crewhaus/liﬆs/x",
    // Case, and another normal form of the fold.
    ".CREWHAUS/SETTINGS.JSON",
    ".crewhaus/RUN/x",
    // Ignored by HFS+.
    ".crewhaus/setti‌ngs.json",
    ".crew﻿haus/run/x",
    // Trimmed or read as a stream by Windows.
    ".crewhaus/settings.json.",
    ".crewhaus/settings.json ",
    ".crewhaus/settings.json. .",
    ".crewhaus/settings.json::$DATA",
    ".crewhaus./settings.json",
    ".crewhaus\\run.\\x",
    ".crewhaus::$INDEX_ALLOCATION\\settings.json",
    ".crewhaus:$I30:$INDEX_ALLOCATION/run/x",
  ];

  test("each is denied where the volume folds, and is another file where it does not", () => {
    for (const rel of SAME_NAME) {
      expect({ rel, decision: decision(call(rel, { caseInsensitive: true })) }).toEqual({
        rel,
        decision: "deny",
      });
      expect({ rel, decision: decision(call(rel)) }).toEqual({ rel, decision: "allow" });
    }
  });

  test("a neighbour stays a neighbour, under the fold too", () => {
    for (const rel of [
      ".crewhaus/settings.json.bak",
      ".crewhaus/settings.jsonx",
      ".crewhaus/ſetting.json",
      ".crewhaus/runbook/x",
      ".crewhaus/runs",
      ".crewhaus/...",
      ".crewhaus/ ",
      ".crewhaus/notes.md",
    ]) {
      expect({ rel, decision: decision(call(rel, { caseInsensitive: true })) }).toEqual({
        rel,
        decision: "allow",
      });
    }
  });

  test("a directory the call acts beneath is folded as the root is", () => {
    const beneath = (rel: string): ToolCallContext =>
      call(rel, { caseInsensitive: true, beneath: [rel, `${rel}/**`] });
    const r = evaluateWithReason(beneath(".crewhauſ"), "auto", allow, {
      protectedRoots: ROOTS,
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("acts on everything beneath");
  });

  test("a path outside the workspace, and text from a tool that declares no paths, are folded", () => {
    const outside = "/home/u/.CREWHAUS/hangar/token";
    expect(
      evaluateWithReason(
        call(outside, { canonical: [], spellings: [outside], outsideWorkspace: true }),
        "auto",
        allow,
        { protectedRoots: ["/home/u/.crewhaus/hangar"] },
      ).decision,
    ).toBe("deny");
    for (const path of [".crewhaus/SETTINGS.JSON", ".CREWHAUS/run/x", ".crewhaus/ſettings.json"]) {
      const undeclared: ToolCallContext = {
        toolName: "Write",
        input: { path },
        readOnly: false,
        destructive: false,
      };
      expect({ path, decision: decision(undeclared) }).toEqual({ path, decision: "deny" });
    }
  });

  test("a root whose own names fold is compared by the same fold", () => {
    for (const [root, path] of [
      ["/home/Stra\u00DFe/.crewhaus/hangar", "/home/STRASSE/.crewhaus/hangar/token"],
      ["/home/\u017Fam/.crewhaus/hangar", "/home/SAM/.crewhaus/hangar/token"],
    ] as const) {
      const outside = call(path, { canonical: [], spellings: [path], outsideWorkspace: true });
      expect({
        root,
        decision: evaluateWithReason(outside, "auto", allow, { protectedRoots: [root] }).decision,
      }).toEqual({ root, decision: "deny" });
    }
  });

  test("a name that would fold to `..` stays a name, and does not climb out of a root", () => {
    for (const rel of [".crewhaus/run/..\u200C/x", ".crewhaus/run/.\u200C.\u200C/x"]) {
      expect({ rel, decision: decision(call(rel, { caseInsensitive: true })) }).toEqual({
        rel,
        decision: "deny",
      });
    }
  });

  test("a name of dots a megabyte long is read in one pass", () => {
    expect(decision(call(`${".".repeat(1 << 20)}x/y`, { caseInsensitive: true }))).toBe("allow");
  });
});

describe("the names a tool that declares no paths uses in its text", () => {
  const ABSOLUTE = "/srv/ws/dist";
  const ROOTS = ["dist", "build", "node_modules", ".env", "crewhaus.yaml", ABSOLUTE];
  const allow: RuleSet = { ...emptyRuleSet, flag: [rule("alwaysAllow", "*", "flag")] };
  /** A tool with no declared fields: every MCP tool, which is never read-only. */
  const mcp = (input: Record<string, unknown>): ToolCallContext => ({
    toolName: "mcp__server__do_thing",
    input,
    readOnly: false,
    destructive: false,
  });
  const decide = (call: ToolCallContext, roots: readonly string[] = ROOTS) =>
    evaluateWithReason(call, "auto", allow, { protectedRoots: roots });

  test("is not a path: labels, a channel, a branch and a title with those names", () => {
    for (const input of [
      { labels: ["build"] },
      { channel: "dist" },
      { head: "build/fix-ci" },
      { title: "Node_Modules" },
      { title: "node_modules" },
      { nested: { deep: ["dist/release-notes"] } },
    ]) {
      expect({ input, decision: decide(mcp(input)).decision }).toEqual({
        input,
        decision: "allow",
      });
    }
  });

  test("a file of another system with one of those names is not a path either", () => {
    const roots = ["package.json", "tsconfig.json", "jsconfig.json"];
    for (const path of roots) {
      expect({ path, decision: decide(mcp({ path }), roots).decision }).toEqual({
        path,
        decision: "allow",
      });
    }
  });

  test("any other relative root is read, with or without a dot in it", () => {
    for (const [root, path] of [
      ["logs/sessions", "logs/sessions/s1.jsonl"],
      ["home", "home/token"],
      ["config/secrets", "config/secrets"],
      ["secrets", "secrets"],
      ["live/tenants", "live/tenants/a/x"],
      ["out", "out/daemon.ts"],
      ["sub/dist", "sub/dist/daemon.ts"],
    ] as const) {
      const r = decide(mcp({ path }), [root]);
      expect({ root, decision: r.decision }).toEqual({ root, decision: "deny" });
      expect(r.reason).toContain("no rule can allow that");
    }
  });

  test("a dotted root is still read, and so is an absolute spelling", () => {
    for (const input of [
      { path: ".env" },
      { path: "./.env" },
      { path: "crewhaus.yaml" },
      { path: `${ABSOLUTE}/x` },
      { path: ABSOLUTE },
      { nested: { deep: [".env"] } },
    ]) {
      const r = decide(mcp(input));
      expect({ input, decision: r.decision }).toEqual({ input, decision: "deny" });
      expect(r.reason).toContain("no rule can allow that");
    }
  });

  test("a root beneath a dotted directory and a dotted name below a word stay read", () => {
    const roots = [".crewhaus/run", "config/shared.env"];
    expect(decide(mcp({ path: ".crewhaus/run/x" }), roots).decision).toBe("deny");
    expect(decide(mcp({ path: "config/shared.env" }), roots).decision).toBe("deny");
  });

  test("a tool that declares its path is read whichever the root's spelling", () => {
    for (const path of ["build/x", "dist", "node_modules/.bin/crewhaus"]) {
      const declared: ToolCallContext = {
        toolName: "Write",
        input: { path, content: "x" },
        operativeValues: [{ kind: "path", canonical: [path] }],
        readOnly: false,
        destructive: true,
      };
      const r = decide(declared);
      expect({ path, decision: r.decision }).toEqual({ path, decision: "deny" });
      expect(r.reason).toContain("no rule can allow that");
    }
  });

  test("a tool the runtime names the written fields of is read the same way", () => {
    const floorValues: NonNullable<ToolCallContext["floorValues"]> = [
      { kind: "path", canonical: ["build/x"] },
    ];
    const call: ToolCallContext = { ...mcp({ path: "build/x" }), floorValues };
    expect(decide(call).decision).toBe("deny");
  });

  test("a directory acted beneath is read the same way for a word root", () => {
    const call: ToolCallContext = {
      toolName: "RemovePath",
      input: { path: "out" },
      operativeValues: [{ kind: "path", canonical: ["out"], beneath: ["out/"] }],
      readOnly: false,
      destructive: true,
    };
    const r = decide(call, ["out/dist"]);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("acts on everything beneath `out`");
  });
});

describe("credential files (credentialRoots)", () => {
  const ROOTS = [
    ".env",
    ".crewhaus/secrets",
    ".crewhaus/identity.json",
    ".crewhaus/run/control-token",
    "/srv/ws/.crewhaus/run/control-token",
  ];
  const read = (rel: string, over: Record<string, unknown> = {}): ToolCallContext => ({
    toolName: "Read",
    input: { path: rel },
    operativeValues: [{ kind: "path", canonical: [rel, `/srv/ws/${rel}`], ...over }],
    readOnly: true,
    destructive: false,
  });
  /** A tool that declares nothing: its strings are read as written. */
  const undeclared = (text: string): ToolCallContext => ({
    toolName: "SomeTool",
    input: { text },
    readOnly: true,
    destructive: false,
  });
  const decide = (call: ToolCallContext, mode: PermissionMode = "auto", rules = emptyRuleSet) =>
    evaluateWithReason(call, mode, rules, { credentialRoots: ROOTS });
  const REASON = "`Read` names a credential file this run keeps from its tools";

  test("with the option absent, the rules decide a read", () => {
    expect(evaluateWithReason(read(".env"), "auto", emptyRuleSet, {}).decision).toBe("allow");
    expect(
      evaluateWithReason(read(".env"), "auto", emptyRuleSet, {
        protectedRoots: [".env"],
      }).decision,
    ).toBe("allow");
  });

  for (const mode of ["auto", "default", "plan"] as const) {
    test(`a read-only call is denied in ${mode}, with the reason`, () => {
      const details = decide(read(".env"), mode);
      expect(details.decision).toBe("deny");
      expect(details.reason).toContain(REASON);
    });
  }

  test("only bypass skips it", () => {
    expect(decide(read(".env"), "bypass").decision).toBe("allow");
  });

  test("a call that writes is denied by this check too, and the write floor's reason comes first", () => {
    const write: ToolCallContext = {
      toolName: "Write",
      input: { path: "sub/.env" },
      operativeValues: [{ kind: "path", canonical: ["sub/.env"] }],
      readOnly: false,
      destructive: true,
    };
    const details = decide(write);
    expect(details.decision).toBe("deny");
    expect(details.reason).toContain("`Write` names a credential file");
    const both = evaluateWithReason({ ...write, input: { path: ".env" } }, "auto", emptyRuleSet, {
      protectedRoots: ["sub/.env"],
      credentialRoots: ROOTS,
    });
    expect(both.reason).toContain("is not read-only and names a path where");
  });

  for (const name of [
    ".env",
    ".env.local",
    ".env.staging",
    ".env.example.local",
    "sub/.env",
    "a/b/.env.production",
    ".npmrc",
    "sub/.npmrc",
    ".ENV",
    "SUB/.Env.Local",
    ".NPMRC",
  ]) {
    test(`the file name ${name} is denied`, () => {
      const details = decide(read(name));
      expect(details.decision).toBe("deny");
      expect(details.reason).toContain(REASON);
    });
  }

  for (const name of [
    ".env.example",
    ".env.sample",
    ".env.template",
    "sub/.env.example",
    ".ENV.EXAMPLE",
    ".envrc",
    "env",
    "notes.env",
    "my.npmrc",
    ".npmrc.bak",
    ".env-local",
    "notes.md",
    ".crewhaus/run/daemon.json",
    ".crewhaus/tool-results/part-1.txt",
    ".git/HEAD",
  ]) {
    test(`the file name ${name} is allowed`, () => {
      expect(decide(read(name)).decision).toBe("allow");
    });
  }

  test("a name a folding volume opens as the same file is denied where the value folds", () => {
    for (const name of [".ENV", ".env.teſt", ".e\u200Cnv", ".env.", ".env::$DATA"]) {
      expect({ name, ...pick(decide(read(name, { caseInsensitive: true }))) }).toEqual({
        name,
        decision: "deny",
      });
    }
    // Compared exactly, a zero-width joiner is another file's name.
    expect(decide(read(".e\u200Cnv")).decision).toBe("allow");
  });

  test("a listed root and what lies under it are denied, in each spelling", () => {
    for (const path of [
      ".crewhaus/secrets",
      ".crewhaus/secrets/anything",
      ".crewhaus/identity.json",
      ".crewhaus/run/control-token",
      ".env/inner",
      "sub/../.crewhaus/secrets/x",
    ]) {
      expect({ path, ...pick(decide(read(path))) }).toEqual({ path, decision: "deny" });
    }
    expect(decide(read("x", { spellings: [".crewhaus/secrets/y"] })).decision).toBe("deny");
    expect(decide(read(".CREWHAUS/SECRETS/x", { caseInsensitive: true })).decision).toBe("deny");
    expect(decide(read(".CREWHAUS/SECRETS/x")).decision).toBe("allow");
  });

  test("a neighbour of an exact file is allowed", () => {
    expect(decide(read(".crewhaus/identity.json.bak")).decision).toBe("allow");
    expect(decide(read(".crewhaus/run/control-token.old")).decision).toBe("allow");
  });

  test("a directory the call reads beneath that holds a root is denied", () => {
    const beneath = (dir: string): ToolCallContext => ({
      toolName: "Tree",
      input: { path: dir },
      operativeValues: [{ kind: "path", canonical: [dir], beneath: [dir] }],
      readOnly: true,
      destructive: false,
    });
    expect(decide(beneath(".crewhaus")).decision).toBe("deny");
    expect(decide(beneath(".crewhaus/run")).decision).toBe("deny");
    expect(decide(beneath("src")).decision).toBe("allow");
    const inSub = { credentialRoots: ["sub/.hidden/file"] };
    expect(evaluateWithReason(beneath("sub"), "auto", emptyRuleSet, inSub).decision).toBe("deny");
  });

  test("a value the write floor's reading leaves out counts here", () => {
    const attached: ToolCallContext = {
      toolName: "EmailSend",
      input: { to: "a@example.test", attachments: [{ path: ".env" }] },
      operativeValues: [{ kind: "path", canonical: [".env"] }],
      floorValues: [],
      readOnly: false,
      destructive: true,
    };
    const details = decide(attached);
    expect(details.decision).toBe("deny");
    expect(details.reason).toContain("`EmailSend` names a credential file");
    // The same call with no option: the write floor reads the empty list.
    expect(
      evaluateWithReason(attached, "auto", emptyRuleSet, { protectedRoots: [".env"] }).decision,
    ).toBe("ask");
  });

  test("a tool that declares nothing has its strings read as written", () => {
    expect(decide(undeclared(".env")).decision).toBe("deny");
    expect(decide(undeclared("deploy/.env")).decision).toBe("deny");
    expect(decide(undeclared(".crewhaus/secrets/x")).decision).toBe("deny");
    expect(decide(undeclared("the settings live in .env for now")).decision).toBe("allow");
    expect(decide(undeclared("notes about .npmrc and .env")).decision).toBe("allow");
  });

  test("a string that reads as text goes on, from a tool that declares nothing", () => {
    for (const text of [
      ".env.local is where the region goes",
      ".env.example is what you copy",
      "the region lives in config/.env.local for now",
      "see config/.env: it holds the region",
      "see config/.env.",
      "see config/.env.local,",
      ".env: missing",
      ".npmrc: holds the registry",
      "a/.env.production\nline two of a longer body with no slash",
      "https://example.test/docs/.env.example?x=1",
      "https://example.test/.env",
      ".crewhaus/identity.json is where it lives",
      ".crewhaus/secrets: the directory",
    ]) {
      expect({ text, ...pick(decide(undeclared(text))) }).toEqual({ text, decision: "allow" });
    }
  });

  test("a string that reads as a path is denied, from a tool that declares nothing", () => {
    for (const text of [
      ".env",
      "deploy/.env",
      "my dir/.env",
      "my dir/.env.local",
      ".env.local",
      "./.env",
      ".env/",
      ".ENV",
      ".env.",
      ".env ",
      "sub/.env.",
      ".env::$DATA",
      "x://../.env",
      "line one\nsub/.env",
      ".crewhaus/secrets/api",
      ".crewhaus/secrets/two words",
      ".CREWHAUS/Secrets/two words",
      ".crewhaus/run/control-token",
    ]) {
      expect({ text, ...pick(decide(undeclared(text))) }).toEqual({ text, decision: "deny" });
    }
  });

  test("a listed file whose own name holds a space is denied as written", () => {
    const opts = { credentialRoots: ["config/my secrets.env"] };
    for (const text of ["config/my secrets.env", "CONFIG/My Secrets.env"]) {
      expect(evaluateWithReason(undeclared(text), "auto", emptyRuleSet, opts).decision).toBe(
        "deny",
      );
    }
    expect(
      evaluateWithReason(undeclared("config/my secrets.env is here"), "auto", emptyRuleSet, opts)
        .decision,
    ).toBe("allow");
  });

  test("a declared value is read as a path whatever it holds", () => {
    expect(decide(read("my dir/.env")).decision).toBe("deny");
    expect(decide(read(".env: missing", { caseInsensitive: true })).decision).toBe("deny");
    expect(decide(read(".crewhaus/secrets/two words")).decision).toBe("deny");
  });

  test("the write floor reads text as it did, with no name check", () => {
    const write: ToolCallContext = {
      toolName: "SomeWriter",
      input: { text: ".env: missing" },
      readOnly: false,
      destructive: true,
    };
    const details = evaluateWithReason(write, "auto", emptyRuleSet, { protectedRoots: [".env"] });
    expect(details.decision).toBe("deny");
    expect(details.reason).toContain("is not read-only and names a path where");
  });

  test("a tool that declares `[]` carries text, read-only or not", () => {
    const text = (readOnly: boolean): ToolCallContext => ({
      toolName: "TodoWrite",
      input: { items: ["update deploy/.env"] },
      floorValues: [],
      readOnly,
      destructive: false,
    });
    expect(decide(text(false)).decision).toBe("allow");
    expect(decide(text(true)).decision).toBe("allow");
  });

  test("an allow rule loses, in each source", () => {
    const allow: RuleSet = {
      ...emptyRuleSet,
      flag: [rule("alwaysAllow", "Read(.env)", "flag")],
      settings: [rule("alwaysAllow", "Read", "settings")],
      yaml: [rule("alwaysAllow", "Read(**)")],
    };
    expect(evaluateWithReason(read(".env"), "auto", allow, {}).decision).toBe("allow");
    const details = decide(read(".env"), "auto", allow);
    expect(details.decision).toBe("deny");
    expect(details.reason).toContain(REASON);
  });

  test("a long name reads in one pass", () => {
    expect(decide(read(`.env.${"a".repeat(1 << 20)}`)).decision).toBe("deny");
    expect(decide(read(`${"a/".repeat(1 << 19)}notes.md`)).decision).toBe("allow");
    expect(decide(undeclared(`${".env ".repeat(1 << 18)}and more`)).decision).toBe("allow");
  });
});

/** A decision without its reason, for a table that names the input it checks. */
function pick(details: { readonly decision: string }): { readonly decision: string } {
  return { decision: details.decision };
}

describe("a store's own files (protectedFiles)", () => {
  const FOCUS = "/srv/ws/.crewhaus/state/s/focus.md";
  const FILES = [FOCUS, ".crewhaus/state/s/focus.md", "/srv/ws/.crewhaus/state/s/plans"];
  const rules: RuleSet = {
    ...emptyRuleSet,
    flag: [rule("alwaysAllow", "Write", "flag"), rule("alwaysAllow", "StateImport", "flag")],
  };
  const write = (rel: string): ToolCallContext => ({
    toolName: "Write",
    input: { path: rel, content: "x" },
    operativeValues: [{ kind: "path", canonical: [rel, `/srv/ws/${rel}`] }],
    readOnly: false,
    destructive: true,
  });
  // StateImport with its default `stateDir: .crewhaus/state` (`beneath: "all"`).
  const stateImport: ToolCallContext = {
    toolName: "StateImport",
    input: { stateDir: ".crewhaus/state", mode: "merge" },
    operativeValues: [
      {
        kind: "path",
        canonical: [".crewhaus/state", "/srv/ws/.crewhaus/state"],
        beneath: [".crewhaus/state/", "./.crewhaus/state/", "/srv/ws/.crewhaus/state/"],
      },
    ],
    readOnly: false,
    destructive: true,
  };

  test("a Write to one, or inside one, is denied whatever a rule allows", () => {
    for (const path of [".crewhaus/state/s/focus.md", ".crewhaus/state/s/plans/plan-0001-x.md"]) {
      for (const mode of ["default", "auto"] as const) {
        const r = evaluateWithReason(write(path), mode, rules, { protectedFiles: FILES });
        expect({ path, mode, decision: r.decision }).toEqual({ path, mode, decision: "deny" });
        expect(r.reason).toContain("names a file a store keeps for itself");
      }
    }
    // A neighbour is the rules' to decide.
    expect(
      evaluateWithReason(write(".crewhaus/state/s/kv/x.json"), "auto", rules, {
        protectedFiles: FILES,
      }).decision,
    ).toBe("allow");
  });

  test("StateImport with the default stateDir is not denied for them", () => {
    expect(evaluateWithReason(stateImport, "auto", rules, { protectedFiles: FILES }).decision).toBe(
      "allow",
    );
  });

  test("the same paths as protectedRoots do deny it: the two readings differ", () => {
    const r = evaluateWithReason(stateImport, "auto", rules, { protectedRoots: FILES });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("acts on everything beneath `.crewhaus/state`");
  });

  test("a read-only call, and bypass, are not refused", () => {
    const read: ToolCallContext = { ...write(".crewhaus/state/s/focus.md"), readOnly: true };
    expect(evaluateWithReason(read, "auto", rules, { protectedFiles: FILES }).decision).toBe(
      "allow",
    );
    expect(
      evaluateWithReason(write(".crewhaus/state/s/focus.md"), "bypass", rules, {
        protectedFiles: FILES,
      }).decision,
    ).toBe("allow");
  });
});
