import { describe, expect, test } from "bun:test";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { preparePermissionSubject } from "@crewhaus/tool-executor";
import { z } from "zod";
import {
  type WorkerPermissionRule,
  type WorkerPermissions,
  type WorkerToolCall,
  decideWorkerToolCall,
} from "./permissions";

/** A tool shaped like the edge's network tools: one `url` operative argument. */
function urlTool(
  name: string,
  flags: Partial<Pick<RegisteredTool, "readOnly" | "requiresSandbox" | "requireJustification">>,
): RegisteredTool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({ url: z.string() }),
    execute: async () => "ran",
    concurrencySafe: false,
    readOnly: flags.readOnly ?? true,
    destructive: false,
    requiresSandbox: flags.requiresSandbox ?? false,
    classifyOutput: false,
    scope: "external",
    requireJustification: flags.requireJustification ?? false,
    operativeArgs: [{ field: "url", kind: "url" }],
  };
}

const webFetch = urlTool("WebFetch", { readOnly: true });
const fetchTool = urlTool("Fetch", { readOnly: false });
const sandboxed = urlTool("Sandboxed", { requiresSandbox: true });
const justified = urlTool("Justified", { readOnly: false, requireJustification: true });

/** The call as the loop builds it: the input parsed by the tool's schema, its operative values read. */
function callFor(tool: RegisteredTool, url = "https://a.example/page"): WorkerToolCall {
  const subject = preparePermissionSubject(tool, { url });
  if (!subject.ok) throw new Error(subject.reason);
  return {
    toolName: tool.name,
    input: subject.input,
    ...(subject.operativeValues !== undefined ? { operativeValues: subject.operativeValues } : {}),
    readOnly: tool.readOnly,
    requiresSandbox: tool.requiresSandbox,
    requireJustification: tool.requireJustification,
  };
}

const allow = (pattern: string): WorkerPermissionRule => ({ type: "alwaysAllow", pattern });
const deny = (pattern: string): WorkerPermissionRule => ({ type: "alwaysDeny", pattern });
const ask = (pattern: string): WorkerPermissionRule => ({ type: "alwaysAsk", pattern });

function decide(
  call: WorkerToolCall,
  rules: ReadonlyArray<WorkerPermissionRule>,
  mode?: WorkerPermissions["mode"],
) {
  return decideWorkerToolCall(call, { ...(mode !== undefined ? { mode } : {}), rules });
}

describe("decideWorkerToolCall", () => {
  test("a call no rule covers asks, and the reason says a worker has nobody to approve it", () => {
    const verdict = decide(callFor(webFetch), []);
    expect(verdict.decision).toBe("ask");
    expect(verdict.mode).toBe("default");
    expect(verdict.reason).toBe(
      "`WebFetch` needs approval, and this worker has nobody to give it. A tool runs on a worker only when an alwaysAllow rule covers the call: add { type: alwaysAllow, pattern: WebFetch } to permissions.rules",
    );
  });

  test("an alwaysAllow rule that covers the call allows it", () => {
    expect(decide(callFor(webFetch), [allow("WebFetch")])).toEqual({
      decision: "allow",
      mode: "default",
    });
  });

  test("a matching deny wins over an allow, whichever is listed first", () => {
    for (const rules of [
      [allow("WebFetch"), deny("WebFetch")],
      [deny("WebFetch"), allow("WebFetch")],
    ]) {
      const verdict = decide(callFor(webFetch), rules);
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toBe(
        "an alwaysDeny rule in this worker's permissions denies `WebFetch`",
      );
    }
  });

  test("a matching ask wins over an allow, and says nobody can approve it", () => {
    for (const rules of [
      [ask("WebFetch"), allow("WebFetch")],
      [allow("WebFetch"), ask("WebFetch")],
    ]) {
      const verdict = decide(callFor(webFetch), rules);
      expect(verdict.decision).toBe("ask");
      expect(verdict.reason).toBe(
        "an alwaysAsk rule needs a person to approve `WebFetch`, and this worker has nobody to give that approval",
      );
    }
  });

  test("an argument-scoped allow covers its own URLs and no other", () => {
    const rules = [allow("WebFetch(https://a.example/**)")];
    expect(decide(callFor(webFetch, "https://a.example/docs/x"), rules).decision).toBe("allow");
    expect(decide(callFor(webFetch, "https://b.example/docs/x"), rules).decision).toBe("ask");
  });

  test("an argument-scoped deny beats alwaysAllow *", () => {
    const rules = [allow("*"), deny("WebFetch(https://a.example/**)")];
    expect(decide(callFor(webFetch, "https://a.example/x"), rules).decision).toBe("deny");
    expect(decide(callFor(webFetch, "https://b.example/x"), rules).decision).toBe("allow");
  });

  test("a deny that does not compile still denies; an allow that does not compile grants nothing", () => {
    expect(decide(callFor(webFetch), [deny("WebFetch(")]).decision).toBe("deny");
    expect(decide(callFor(webFetch), [ask("WebFetch(")]).decision).toBe("ask");
    expect(decide(callFor(webFetch), [allow("WebFetch(")]).decision).toBe("ask");
    // The broken deny still guards beside a good allow.
    expect(decide(callFor(webFetch), [allow("WebFetch"), deny("WebFetch(")]).decision).toBe("deny");
  });

  test("plan mode runs only read-only tools, and only under an allow", () => {
    const writer = decide(callFor(fetchTool), [allow("Fetch")], "plan");
    expect(writer).toEqual({
      decision: "deny",
      mode: "plan",
      reason: "plan mode runs only read-only tools, and `Fetch` is not read-only",
    });
    expect(decide(callFor(webFetch), [allow("WebFetch")], "plan")).toEqual({
      decision: "allow",
      mode: "plan",
    });
    const unruled = decide(callFor(webFetch), [], "plan");
    expect(unruled.decision).toBe("ask");
    expect(unruled.mode).toBe("plan");
    // An ask rule in plan mode denies: plan mode asks nobody.
    expect(decide(callFor(webFetch), [ask("WebFetch"), allow("WebFetch")], "plan").decision).toBe(
      "deny",
    );
  });

  test("auto mode decides every case exactly as default mode does", () => {
    const cases: Array<[WorkerToolCall, WorkerPermissionRule[]]> = [
      [callFor(webFetch), []],
      [callFor(webFetch), [allow("WebFetch")]],
      [callFor(fetchTool), []],
      [callFor(fetchTool), [allow("Fetch")]],
      [callFor(webFetch), [ask("WebFetch"), allow("*")]],
      [callFor(webFetch), [allow("*"), deny("WebFetch")]],
      [callFor(sandboxed), [allow("*")]],
      [callFor(justified), [allow("*")]],
    ];
    for (const [call, rules] of cases) {
      expect(decide(call, rules, "auto")).toEqual(decide(call, rules, "default"));
      expect(decide(call, rules, "auto")).toEqual(decide(call, rules));
      expect(decide(call, rules, "auto").mode).toBe("default");
    }
    // In auto a read-only or non-destructive tool would run unruled on a
    // host; on a worker it still needs its allow.
    expect(decide(callFor(webFetch), [], "auto").decision).toBe("ask");
  });

  test("a tool that needs a sandbox is denied whatever rule matches", () => {
    const reason = "`Sandboxed` needs a sandbox, and a worker has none";
    for (const rules of [[], [ask("Sandboxed")], [allow("*")], [allow("Sandboxed")]]) {
      for (const mode of [undefined, "plan", "auto"] as const) {
        expect(decide(callFor(sandboxed), rules, mode)).toMatchObject({ decision: "deny", reason });
      }
    }
  });

  test("a tool that needs the intent gate is denied, even under an allow", () => {
    const verdict = decide(callFor(justified), [allow("*"), allow("Justified")]);
    expect(verdict).toEqual({
      decision: "deny",
      mode: "default",
      reason: "`Justified` needs the intent gate, which a worker does not run",
    });
  });

  test("no reason carries a rule's pattern", () => {
    const secret = "https://internal-billing.example/**";
    const patterns = [`WebFetch(${secret})`, `Web*(${secret})`, "Web*"];
    for (const pattern of patterns) {
      for (const rules of [[deny(pattern)], [ask(pattern)], [allow(pattern)], []]) {
        for (const mode of [undefined, "plan"] as const) {
          const verdict = decide(
            callFor(webFetch, "https://internal-billing.example/x"),
            rules,
            mode,
          );
          if (verdict.reason !== undefined) {
            expect(verdict.reason).not.toContain(secret);
            expect(verdict.reason).not.toContain("internal-billing");
            expect(verdict.reason).not.toContain("Web*");
          }
        }
      }
    }
    // The reasons above were really produced: each refusal kind is among them.
    const target = callFor(webFetch, "https://internal-billing.example/x");
    expect(decide(target, [deny(patterns[0] ?? "")]).decision).toBe("deny");
    expect(decide(target, [ask(patterns[1] ?? "")]).decision).toBe("ask");
    expect(decide(target, [allow("Fetch")]).decision).toBe("ask");
  });
});
