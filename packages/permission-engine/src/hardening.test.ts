/**
 * 0.7.1 — how the engine reads a rule now depends on which way it points, and
 * plan mode honours the operator's denies.
 *
 * The matcher-level semantics are pinned in tool-permission-matcher; these
 * tests pin that the ENGINE hands each rule its own polarity (a deny that fell
 * through to a later bare allow was the whole bypass), and the plan-mode fix.
 */
import { describe, expect, test } from "bun:test";
import type { OperativeValue } from "@crewhaus/tool-permission-matcher";
import {
  BUILTIN_DEFAULT_RULES,
  type PermissionMode,
  type PermissionRule,
  type RuleSet,
  type RuleType,
  emptyRuleSet,
  evaluateWithReason,
} from "./index";

const rules = (...list: Array<[RuleType, string]>): RuleSet => ({
  ...emptyRuleSet,
  yaml: list.map(([type, pattern]): PermissionRule => ({ type, pattern, source: "yaml" })),
});

const call = (
  toolName: string,
  input: unknown,
  flags: { readOnly?: boolean; destructive?: boolean } = {},
  operativeValues?: ReadonlyArray<OperativeValue>,
) => ({
  toolName,
  input,
  readOnly: flags.readOnly ?? false,
  destructive: flags.destructive ?? false,
  ...(operativeValues !== undefined ? { operativeValues } : {}),
});

const MODES: readonly PermissionMode[] = ["default", "auto", "plan"];

describe("a scoped deny/ask in front of a bare allow cannot be dodged (permission-integration#0)", () => {
  // The shape the finding describes: a bare allow for the tool plus a scoped
  // guard. The guard used to fire only when EVERY string matched, so any extra
  // argument fell through to the allow.
  const rs = rules(
    ["alwaysDeny", "HttpRequest(http://169.254.169.254/**)"],
    ["alwaysDeny", "RemovePath(.git/**)"],
    ["alwaysAsk", "GitBranchDelete(main)"],
    ["alwaysAllow", "HttpRequest"],
    ["alwaysAllow", "RemovePath"],
    ["alwaysAllow", "GitBranchDelete"],
  );
  const metadata = "http://169.254.169.254/latest/meta-data/iam";

  const cases: Array<[string, unknown, "deny" | "ask"]> = [
    ["HttpRequest", { url: metadata }, "deny"],
    ["HttpRequest", { url: metadata, method: "GET" }, "deny"],
    ["HttpRequest", { url: metadata, note: "x" }, "deny"],
    ["RemovePath", { path: ".git/hooks", recursive: true }, "deny"],
    ["RemovePath", { path: ".git/hooks", recursive: true, reason: "cleanup" }, "deny"],
    ["GitBranchDelete", { name: "main", force: true }, "ask"],
    ["GitBranchDelete", { name: "main", force: true, cwd: "." }, "ask"],
    ["GitBranchDelete", { name: "main", force: true, comment: "stale" }, "ask"],
  ];
  for (const [tool, input, want] of cases) {
    test(`${tool} ${JSON.stringify(input)} → ${want} in default and auto; deny in plan`, () => {
      expect(evaluateWithReason(call(tool, input), "default", rs).decision).toBe(want);
      expect(evaluateWithReason(call(tool, input), "auto", rs).decision).toBe(want);
      expect(evaluateWithReason(call(tool, input), "plan", rs).decision).toBe("deny");
    });
  }

  test("the bare allow still grants an unguarded call", () => {
    expect(
      evaluateWithReason(call("RemovePath", { path: "build/out", reason: "x" }), "default", rs)
        .decision,
    ).toBe("allow");
  });
});

describe("a scoped allow is not widened by a decoy (security-1#0, security-8#1)", () => {
  const rs = rules(["alwaysAllow", "Write(src/**)"]);
  test("both aliases present: every one must match", () => {
    const decoy = {
      file_path: "src/ok.ts",
      path: ".github/workflows/pwn.yml",
      content: "on: push",
    };
    for (const mode of ["default", "auto"] as const) {
      const d = evaluateWithReason(call("Write", decoy, { destructive: true }), mode, rs);
      expect(d.decision).toBe("ask");
    }
    expect(
      evaluateWithReason(
        call("Write", { path: "src/a.ts", content: "x" }, { destructive: true }),
        "default",
        rs,
      ).decision,
    ).toBe("allow");
  });

  test("declared operative values are what the engine matches, not the input", () => {
    const outside: OperativeValue = {
      kind: "path",
      canonical: [".crewhaus/settings.json", "/ws/.crewhaus/settings.json"],
      spellings: ["src/../.crewhaus/settings.json"],
    };
    const input = { path: "src/../.crewhaus/settings.json", content: "{}" };
    // The raw string matches `src/**`; the canonical location does not.
    expect(
      evaluateWithReason(call("Write", input, { destructive: true }, [outside]), "default", rs)
        .decision,
    ).toBe("ask");
    const deny = rules(["alwaysDeny", "Write(.crewhaus/**)"], ["alwaysAllow", "Write"]);
    for (const mode of MODES) {
      expect(
        evaluateWithReason(call("Write", input, { destructive: true }, [outside]), mode, deny)
          .decision,
      ).toBe("deny");
    }
  });
});

describe("plan mode honours deny and ask rules (permission-integration#6)", () => {
  const rs = rules(
    ["alwaysDeny", "HttpPaginate"],
    ["alwaysDeny", "SseRead(**)"],
    ["alwaysAsk", "Lint"],
    ["alwaysDeny", "SecretLookup"],
  );
  const readOnly = { readOnly: true };

  test("an explicit deny on a read-only tool denies in plan mode, with the rule named", () => {
    const d = evaluateWithReason(call("HttpPaginate", { url: "https://x" }, readOnly), "plan", rs);
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe(
      "plan mode: the rule alwaysDeny HttpPaginate (yaml) denies `HttpPaginate`",
    );
    expect(
      evaluateWithReason(call("SseRead", { url: "https://x" }, readOnly), "plan", rs).decision,
    ).toBe("deny");
    expect(
      evaluateWithReason(call("SecretLookup", { ref: "env:X" }, readOnly), "plan", rs).decision,
    ).toBe("deny");
  });

  test("an ask becomes a deny: plan mode has no one to ask", () => {
    const d = evaluateWithReason(call("Lint", {}, readOnly), "plan", rs);
    expect(d.decision).toBe("deny");
    expect(d.reason).toMatch(
      /alwaysAsk Lint \(yaml\) needs a person to approve `Lint`, and plan mode cannot ask/,
    );
  });

  test("allows are still ignored: plan mode is never widened", () => {
    const allowAll = rules(["alwaysAllow", "*"], ["alwaysAllow", "Write(**)"]);
    expect(evaluateWithReason(call("Write", { path: "a" }), "plan", allowAll).decision).toBe(
      "deny",
    );
    // …and a higher-priority allow cannot shadow a lower-priority deny.
    const shadow: RuleSet = {
      ...emptyRuleSet,
      flag: [{ type: "alwaysAllow", pattern: "HttpPaginate", source: "flag" }],
      yaml: [{ type: "alwaysDeny", pattern: "HttpPaginate", source: "yaml" }],
    };
    expect(evaluateWithReason(call("HttpPaginate", {}, readOnly), "plan", shadow).decision).toBe(
      "deny",
    );
  });

  test("with no matching guard, plan mode is what it always was", () => {
    expect(evaluateWithReason(call("Read", { path: "a" }, readOnly), "plan", rs).decision).toBe(
      "allow",
    );
    expect(evaluateWithReason(call("Write", { path: "a" }), "plan", rs).decision).toBe("deny");
    // The builtin floor's `alwaysAsk Bash(rm**)` now also reads in plan mode;
    // Bash is not read-only, so the answer is deny either way.
    const floor: RuleSet = { ...emptyRuleSet, builtin: BUILTIN_DEFAULT_RULES };
    expect(evaluateWithReason(call("Read", { path: "a" }, readOnly), "plan", floor).decision).toBe(
      "allow",
    );
  });

  test("a malformed deny still fails closed in plan mode", () => {
    const broken = rules(["alwaysDeny", "Tool(("]);
    expect(evaluateWithReason(call("Read", {}, readOnly), "plan", broken).decision).toBe("deny");
  });
});
