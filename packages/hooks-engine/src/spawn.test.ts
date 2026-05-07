import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type HookDef, runHooks } from "./index";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("runHooks (T3 integration)", () => {
  test("fixture deny script returns deny decision", async () => {
    const hook: HookDef = {
      event: "pre-tool",
      command: `sh "${join(FIXTURES, "hook-deny.sh")}"`,
    };
    const results = await runHooks("pre-tool", { name: "Bash" }, [hook]);
    expect(results.length).toBe(1);
    expect(results[0]?.decision.decision).toBe("deny");
    expect(results[0]?.decision.reason).toBe("fixture deny");
  });

  test("fixture allow script returns allow", async () => {
    const hook: HookDef = {
      event: "pre-tool",
      command: `sh "${join(FIXTURES, "hook-allow.sh")}"`,
    };
    const results = await runHooks("pre-tool", { name: "Bash" }, [hook]);
    expect(results.length).toBe(1);
    expect(results[0]?.decision.decision).toBe("allow");
  });

  test("matcher filters non-matching tool names", async () => {
    const hook: HookDef = {
      event: "pre-tool",
      matcher: "Bash",
      command: `sh "${join(FIXTURES, "hook-deny.sh")}"`,
    };
    const results = await runHooks("pre-tool", { name: "Read" }, [hook]);
    expect(results).toEqual([]);
  });

  test("matcher glob * matches everything", async () => {
    const hook: HookDef = {
      event: "pre-tool",
      matcher: "*",
      command: `sh "${join(FIXTURES, "hook-allow.sh")}"`,
    };
    const results = await runHooks("pre-tool", { name: "AnythingGoes" }, [hook]);
    expect(results.length).toBe(1);
  });

  test("event filter excludes non-matching events", async () => {
    const hook: HookDef = {
      event: "pre-tool",
      command: `sh "${join(FIXTURES, "hook-deny.sh")}"`,
    };
    const results = await runHooks("post-tool", { name: "Bash" }, [hook]);
    expect(results).toEqual([]);
  });

  test("malformed JSON output → synthetic deny", async () => {
    const hook: HookDef = {
      event: "stop",
      command: "printf 'not json at all\\n'",
    };
    const results = await runHooks("stop", { sessionId: "sess_x" }, [hook]);
    expect(results[0]?.decision.decision).toBe("deny");
    expect(results[0]?.decision.reason).toContain("malformed JSON");
  });

  test("non-zero exit → synthetic deny with stderr in reason", async () => {
    const hook: HookDef = {
      event: "stop",
      command: "echo failure-message >&2; exit 7",
    };
    const results = await runHooks("stop", { sessionId: "sess_x" }, [hook]);
    expect(results[0]?.decision.decision).toBe("deny");
    expect(results[0]?.decision.reason).toContain("exited with code 7");
    expect(results[0]?.decision.reason).toContain("failure-message");
  });

  test("timeout enforced via SIGKILL", async () => {
    const hook: HookDef = {
      event: "stop",
      command: `sh "${join(FIXTURES, "hook-slow.sh")}"`,
      timeoutMs: 200,
    };
    const start = Date.now();
    const results = await runHooks("stop", { sessionId: "sess_x" }, [hook]);
    const elapsed = Date.now() - start;
    expect(results[0]?.decision.decision).toBe("deny");
    expect(results[0]?.decision.reason).toContain("timed out after 200ms");
    expect(elapsed).toBeLessThan(2_000);
  });

  test("env strips secrets from spawned hook (T8 end-to-end)", async () => {
    const hook: HookDef = {
      event: "stop",
      command: `sh "${join(FIXTURES, "hook-env.sh")}"`,
    };
    const results = await runHooks("stop", { sessionId: "sess_x" }, [hook], {
      parentEnv: {
        ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-leaktest",
        ANTHROPIC_API_KEY: "leak2",
        AWS_ACCESS_KEY_ID: "AKIAleak",
        GH_TOKEN: "leak3",
        OPENAI_API_KEY: "leak4",
        HOME: "/tmp",
        USER: "tester",
        LANG: "en_US.UTF-8",
        PATH: "/parent/path:/should/be/dropped",
      },
    });
    expect(results.length).toBe(1);
    expect(results[0]?.decision.decision).toBe("allow");
    const reason = results[0]?.decision.reason ?? "";
    expect(reason.startsWith("ENV_KEYS=")).toBe(true);
    const keysCsv = reason.slice("ENV_KEYS=".length);
    const keys = new Set(keysCsv.split(",").filter((k) => k.length > 0));
    expect(keys.has("ANTHROPIC_AUTH_TOKEN")).toBe(false);
    expect(keys.has("ANTHROPIC_API_KEY")).toBe(false);
    expect(keys.has("AWS_ACCESS_KEY_ID")).toBe(false);
    expect(keys.has("GH_TOKEN")).toBe(false);
    expect(keys.has("OPENAI_API_KEY")).toBe(false);
    // The parent's PATH must NOT have leaked through; only the hardcoded
    // safe one. Easiest check: the leaked-marker substring is absent.
    expect(keysCsv.includes("/parent/path")).toBe(false);
    // HOME, USER, LANG, PATH should be present.
    expect(keys.has("HOME")).toBe(true);
    expect(keys.has("USER")).toBe(true);
    expect(keys.has("PATH")).toBe(true);
  });
});

describe("runHooks parallel execution", () => {
  test("multiple matching hooks fire in parallel", async () => {
    const hooks: HookDef[] = [
      { event: "stop", command: `sh "${join(FIXTURES, "hook-allow.sh")}"` },
      { event: "stop", command: `sh "${join(FIXTURES, "hook-allow.sh")}"` },
      { event: "stop", command: `sh "${join(FIXTURES, "hook-allow.sh")}"` },
    ];
    const results = await runHooks("stop", { sessionId: "x" }, hooks);
    expect(results.length).toBe(3);
    expect(results.every((r) => r.decision.decision === "allow")).toBe(true);
  });

  test("returns [] for empty input array fast", async () => {
    expect(await runHooks("stop", {}, [])).toEqual([]);
  });
});
