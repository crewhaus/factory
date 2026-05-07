import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookConfigError, aggregateDecisions, buildHookEnv, loadHooks } from "./index";

function withTempHomeAndCwd(
  setup: (paths: { home: string; cwd: string }) => void,
  body: (paths: { home: string; cwd: string }) => Promise<void> | void,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hooks-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "hooks-cwd-"));
  try {
    setup({ home, cwd });
    return Promise.resolve(body({ home, cwd })).then(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    throw err;
  }
}

function writeSettings(dir: string, body: Record<string, unknown>): void {
  mkdirSync(join(dir, ".crewhaus"), { recursive: true });
  writeFileSync(join(dir, ".crewhaus", "settings.json"), JSON.stringify(body, null, 2));
}

describe("loadHooks", () => {
  test("returns [] when neither file exists", async () => {
    await withTempHomeAndCwd(
      () => {},
      async ({ home, cwd }) => {
        const hooks = await loadHooks({ cwd, homeDir: home });
        expect(hooks).toEqual([]);
      },
    );
  });

  test("parses project + user hooks; user first, project last", async () => {
    await withTempHomeAndCwd(
      ({ home, cwd }) => {
        writeSettings(home, {
          hooks: [{ event: "pre-tool", matcher: "Bash", command: "echo user" }],
        });
        writeSettings(cwd, {
          hooks: [{ event: "pre-tool", matcher: "Bash", command: "echo project" }],
        });
      },
      async ({ home, cwd }) => {
        const hooks = await loadHooks({ cwd, homeDir: home });
        expect(hooks.map((h) => h.command)).toEqual(["echo user", "echo project"]);
        expect(hooks[0]?.matcher).toBe("Bash");
      },
    );
  });

  test("rejects malformed event", async () => {
    await withTempHomeAndCwd(
      ({ cwd }) => {
        writeSettings(cwd, {
          hooks: [{ event: "not-a-thing", command: "echo" }],
        });
      },
      async ({ home, cwd }) => {
        await expect(loadHooks({ cwd, homeDir: home })).rejects.toBeInstanceOf(HookConfigError);
      },
    );
  });

  test("rejects malformed JSON", async () => {
    await withTempHomeAndCwd(
      ({ cwd }) => {
        mkdirSync(join(cwd, ".crewhaus"), { recursive: true });
        writeFileSync(join(cwd, ".crewhaus", "settings.json"), "{not json");
      },
      async ({ home, cwd }) => {
        await expect(loadHooks({ cwd, homeDir: home })).rejects.toBeInstanceOf(HookConfigError);
      },
    );
  });

  test("rejects non-array hooks", async () => {
    await withTempHomeAndCwd(
      ({ cwd }) => {
        writeSettings(cwd, { hooks: { event: "pre-tool", command: "x" } });
      },
      async ({ home, cwd }) => {
        await expect(loadHooks({ cwd, homeDir: home })).rejects.toBeInstanceOf(HookConfigError);
      },
    );
  });

  test("rejects empty command", async () => {
    await withTempHomeAndCwd(
      ({ cwd }) => {
        writeSettings(cwd, { hooks: [{ event: "pre-tool", command: "" }] });
      },
      async ({ home, cwd }) => {
        await expect(loadHooks({ cwd, homeDir: home })).rejects.toBeInstanceOf(HookConfigError);
      },
    );
  });

  test("ignores other top-level keys (permissions etc.)", async () => {
    await withTempHomeAndCwd(
      ({ cwd }) => {
        writeSettings(cwd, {
          hooks: [{ event: "stop", command: "echo" }],
          permissions: { mode: "default", rules: [] },
        });
      },
      async ({ home, cwd }) => {
        const hooks = await loadHooks({ cwd, homeDir: home });
        expect(hooks.length).toBe(1);
        expect(hooks[0]?.event).toBe("stop");
      },
    );
  });
});

describe("aggregateDecisions", () => {
  test("empty results → allowed", () => {
    expect(aggregateDecisions([])).toEqual({ allowed: true });
  });

  test("single allow → allowed", () => {
    const r = {
      hook: { event: "pre-tool" as const, command: "x" },
      decision: { decision: "allow" as const },
      durationMs: 1,
    };
    expect(aggregateDecisions([r])).toEqual({ allowed: true });
  });

  test("first deny short-circuits with reason", () => {
    const a = {
      hook: { event: "pre-tool" as const, command: "x" },
      decision: { decision: "allow" as const },
      durationMs: 1,
    };
    const d = {
      hook: { event: "pre-tool" as const, command: "y" },
      decision: { decision: "deny" as const, reason: "nope" },
      durationMs: 1,
    };
    const result = aggregateDecisions([a, d]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("nope");
  });

  test("block treated like deny", () => {
    const b = {
      hook: { event: "pre-tool" as const, command: "y" },
      decision: { decision: "block" as const, reason: "halt" },
      durationMs: 1,
    };
    const result = aggregateDecisions([b]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("halt");
  });

  test("merges mutate from successive allows (shallow)", () => {
    const r1 = {
      hook: { event: "pre-slash" as const, command: "x" },
      decision: { decision: "allow" as const, mutate: { a: 1 } },
      durationMs: 1,
    };
    const r2 = {
      hook: { event: "pre-slash" as const, command: "y" },
      decision: { decision: "allow" as const, mutate: { b: 2 } },
      durationMs: 1,
    };
    const result = aggregateDecisions([r1, r2]);
    expect(result.allowed).toBe(true);
    expect(result.mutate).toEqual({ a: 1, b: 2 });
  });
});

describe("buildHookEnv (T8 security)", () => {
  test("strips credentials", () => {
    const env = buildHookEnv({
      ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-xxx",
      ANTHROPIC_API_KEY: "sk-ant-yyy",
      AWS_ACCESS_KEY_ID: "AKIA...",
      AWS_SECRET_ACCESS_KEY: "secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/path/to/key.json",
      GH_TOKEN: "ghp_xxx",
      GITHUB_TOKEN: "ghp_yyy",
      NPM_TOKEN: "npm_xxx",
      OPENAI_API_KEY: "sk-zzz",
      HOME: "/home/user",
      USER: "user",
      PATH: "/should/be/replaced",
    });
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["AWS_ACCESS_KEY_ID"]).toBeUndefined();
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env["GOOGLE_APPLICATION_CREDENTIALS"]).toBeUndefined();
    expect(env["GH_TOKEN"]).toBeUndefined();
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["NPM_TOKEN"]).toBeUndefined();
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
  });

  test("retains HOME, USER, locale, hardcodes safe PATH", () => {
    const env = buildHookEnv({
      HOME: "/home/user",
      USER: "user",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LC_TIME: "en_US.UTF-8",
      TERM: "xterm-256color",
      TMPDIR: "/var/folders/x",
      PATH: "/should/be/replaced",
    });
    expect(env["HOME"]).toBe("/home/user");
    expect(env["USER"]).toBe("user");
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["LC_ALL"]).toBe("C");
    expect(env["LC_TIME"]).toBe("en_US.UTF-8");
    expect(env["TERM"]).toBe("xterm-256color");
    expect(env["TMPDIR"]).toBe("/var/folders/x");
    expect(env["PATH"]).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  test("PATH is always safe path even when parent has none", () => {
    const env = buildHookEnv({});
    expect(env["PATH"]).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });
});
