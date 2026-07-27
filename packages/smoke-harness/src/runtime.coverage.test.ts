import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
/**
 * Deterministic, fully-mocked coverage for `runtime.ts`.
 *
 * `runCliRuntimeSmoke` and `runBrowserRuntimeSmoke` normally spawn
 * `crewhaus run` as a child process and (for browser) stand up a real
 * `Bun.serve` loopback page. Both are replaced here:
 *
 *   - `Bun.spawn` is spied. The fake subprocess streams scripted
 *     stdout/stderr (via a ReadableStream so it can be produced
 *     asynchronously), resolves `exited` with a scripted code, and — to
 *     drive the private `readSessionEventLog`/`toolUseNames`/
 *     `assistantTexts` helpers — writes a synthetic `.jsonl` event log
 *     into the `CREWHAUS_SESSION_DIR` the harness passes in its spawn
 *     env. No real process is launched.
 *   - `Bun.serve` is spied. The fake never opens a socket; it captures
 *     the page `fetch` handler so the test can both (a) cover the page
 *     body and (b) recover the random phrase the harness embeds, and its
 *     `stop()` is a no-op the harness still awaits in its `finally`.
 *
 * For the two "ok" paths the fake subprocess must echo the harness's
 * per-run random phrase. We recover it without touching production code:
 *   - cli: the harness writes the prompt (containing the secret-file
 *     path) to the fake stdin; we read that file back and scrape the
 *     phrase.
 *   - browser: we render the captured server page and scrape the phrase.
 *
 * Every spy is restored in `afterEach`; the harness's own temp dirs are
 * cleaned by its `finally` blocks, so no handle outlives a test.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RuntimeSmokeResult,
  browserRuntimeSmokeIsRequired,
  renderBrowserAdvisory,
  renderBrowserAdvisorySummary,
  reportBrowserAdvisory,
  resolveSmokeModel,
  runBrowserRuntimeSmoke,
  runCliRuntimeSmoke,
  runtimeSmokeIsEnabled,
} from "./runtime.js";

// ---------------------------------------------------------------------------
// runtimeSmokeIsEnabled — pure, exported; cover every branch directly.
// ---------------------------------------------------------------------------

describe("runtimeSmokeIsEnabled", () => {
  test("true when ANTHROPIC_AUTH_TOKEN (OAuth) is set", () => {
    expect(runtimeSmokeIsEnabled({ ANTHROPIC_AUTH_TOKEN: "oauth" })).toBe(true);
  });

  test("true when a real ANTHROPIC_API_KEY is set", () => {
    expect(runtimeSmokeIsEnabled({ ANTHROPIC_API_KEY: "sk-ant-real" })).toBe(true);
  });

  test("false when the API key is the sentinel 'test-no-call'", () => {
    expect(runtimeSmokeIsEnabled({ ANTHROPIC_API_KEY: "test-no-call" })).toBe(false);
  });

  test("false when the API key is empty", () => {
    expect(runtimeSmokeIsEnabled({ ANTHROPIC_API_KEY: "" })).toBe(false);
  });

  test("false when neither credential is present", () => {
    expect(runtimeSmokeIsEnabled({})).toBe(false);
  });

  test("defaults to reading process.env when no arg is passed", () => {
    // No anthropic env in this suite → false. Exercises the default param.
    expect(runtimeSmokeIsEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared env + spy harness.
// ---------------------------------------------------------------------------

const TOUCHED_ENV = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CREWHAUS_SMOKE_MODEL"] as const;
let savedEnv: Record<string, string | undefined> = {};
let spawnSpy: ReturnType<typeof spyOn> | undefined;
let serveSpy: ReturnType<typeof spyOn> | undefined;
let capturedSpawnEnv: Record<string, string> | undefined;
let capturedSpawnArgv: string[] | undefined;
let capturedSpawnCwd: string | undefined;
let capturedFetch: ((req: Request) => Response) | undefined;

beforeEach(() => {
  savedEnv = {};
  for (const k of TOUCHED_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  capturedSpawnEnv = undefined;
  capturedSpawnArgv = undefined;
  capturedSpawnCwd = undefined;
  capturedFetch = undefined;
});

afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  spawnSpy?.mockRestore();
  serveSpy?.mockRestore();
  spawnSpy = undefined;
  serveSpy = undefined;
});

function enableAnthropic(): void {
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-smoke-real";
}

/** A ReadableStream of UTF-8 bytes produced lazily from an async factory. */
function asyncTextStream(factory: () => string | Promise<string>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const text = await factory();
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

type SpawnCfg = {
  /** Produced lazily so it can depend on the captured server/prompt. */
  stdout?: () => string | Promise<string>;
  exitCode?: number;
  /** Written verbatim to a `.jsonl` in CREWHAUS_SESSION_DIR (when set). */
  jsonl?: () => string | Promise<string>;
  /** When false, the fake subprocess exposes no stdin (covers the guard). */
  withStdin?: boolean;
  /** Invoked with each chunk the harness writes to stdin (the prompt). */
  onStdin?: (chunk: string) => void;
};

/**
 * Spawn a fake whose `exited` only resolves once `kill` runs, paired with
 * a synchronous setTimeout, so the watchdog-timeout callback
 * (`() => proc.kill("SIGKILL")`) fires deterministically with no real
 * delay and no dangling timer. Returns the kill mock + a restore fn.
 */
function installTimeoutKillSpawn(): { killed: () => boolean; restore: () => void } {
  let killed = false;
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExited = r;
  });
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(
    ((_cmd: unknown, _opts: unknown): ReturnType<typeof Bun.spawn> =>
      ({
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
        exited,
        kill: (_sig?: unknown) => {
          killed = true;
          resolveExited(137);
        },
        stdin: { write: () => {}, end: () => {} },
      }) as unknown as ReturnType<typeof Bun.spawn>) as unknown as typeof Bun.spawn,
  );
  const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: (...a: unknown[]) => void,
  ) => {
    fn(); // run the watchdog body immediately
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
    (() => {}) as unknown as typeof clearTimeout,
  );
  return {
    killed: () => killed,
    restore: () => {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    },
  };
}

function installSpawn(cfg: SpawnCfg): void {
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
    cmd: unknown,
    opts: unknown,
  ): ReturnType<typeof Bun.spawn> => {
    capturedSpawnArgv = cmd as string[];
    const o = opts as { env?: Record<string, string>; cwd?: string };
    capturedSpawnEnv = o.env;
    capturedSpawnCwd = o.cwd;
    const sessionDir = o.env?.["CREWHAUS_SESSION_DIR"];

    // The harness writes the prompt to stdin *synchronously* right after
    // spawn() returns, but a ReadableStream's start() fires eagerly at
    // construction — i.e. before that write. When the test relies on
    // stdin (onStdin set), gate the stdout factory behind a deferred the
    // stdin write resolves, so the prompt is captured first.
    const usesStdin = cfg.onStdin !== undefined && cfg.withStdin !== false;
    let releaseStdin!: () => void;
    const stdinWritten = new Promise<void>((r) => {
      releaseStdin = r;
    });

    const writeLog = async () => {
      if (cfg.jsonl !== undefined && sessionDir !== undefined) {
        writeFileSync(join(sessionDir, "session.jsonl"), await cfg.jsonl());
      }
    };
    // Producing the log inside the stdout stream guarantees it lands
    // before the post-exit readSessionEventLog() runs (the harness awaits
    // Promise.all([text(stdout), text(stderr), exited])).
    const stdout = asyncTextStream(async () => {
      if (usesStdin) await stdinWritten;
      await writeLog();
      return cfg.stdout ? await cfg.stdout() : "";
    });
    const base = {
      stdout,
      stderr: new Blob([""]).stream(),
      exited: Promise.resolve(cfg.exitCode ?? 0),
      kill: (_sig?: unknown) => {},
    };
    const stdin = {
      write: (s: string) => {
        cfg.onStdin?.(s);
      },
      end: () => releaseStdin(),
    };
    const proc = cfg.withStdin === false ? base : { ...base, stdin };
    return proc as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn);
}

/** Spy Bun.serve so no socket opens; capture the page fetch handler. */
function installServe(): void {
  serveSpy = spyOn(Bun, "serve").mockImplementation(((
    opts: unknown,
  ): ReturnType<typeof Bun.serve> => {
    const o = opts as { fetch: (req: Request) => Response };
    capturedFetch = o.fetch;
    return {
      port: 54321,
      stop: async (_force?: boolean) => {},
    } as unknown as ReturnType<typeof Bun.serve>;
  }) as unknown as typeof Bun.serve);
}

/** Render the captured server page and scrape the embedded phrase. */
async function phraseFromServer(): Promise<string> {
  if (capturedFetch === undefined) throw new Error("Bun.serve was not captured");
  const html = await capturedFetch(new Request("http://127.0.0.1/")).text();
  const m = html.match(/id="phrase">([^<]+)</);
  if (m === null) throw new Error(`no phrase in served page: ${html}`);
  return m[1] as string;
}

// ---------------------------------------------------------------------------
// runCliRuntimeSmoke
// ---------------------------------------------------------------------------

describe("runCliRuntimeSmoke", () => {
  test("skips cleanly when no Anthropic auth is configured", async () => {
    const result = await runCliRuntimeSmoke();
    expect(result.status).toBe("skipped");
    expect(result.shape).toBe("cli");
    expect(result.failures).toEqual([]);
  });

  test("happy path: read tool fired and final turn grounds in the file → ok", async () => {
    enableAnthropic();
    process.env["ANTHROPIC_AUTH_TOKEN"] = "oauth-xyz"; // exercise the oauth-forward branch

    // The harness writes the prompt (which names the workspace-relative
    // secret file) to our fake stdin. We recover the random phrase by
    // resolving that name against the spawn cwd (the harness's workDir) and
    // reading it back.
    let phrase = "";
    installSpawn({
      onStdin: (chunk) => {
        const m = chunk.match(/read (\S+\.txt)/);
        if (m !== null) {
          const rel = m[1] as string;
          const abs = capturedSpawnCwd !== undefined ? join(capturedSpawnCwd, rel) : rel;
          const content = readFileSync(abs, "utf-8");
          const pm = content.match(/magic phrase is: (\S+)/);
          if (pm !== null) phrase = pm[1] as string;
        }
      },
      // Runtime emits the RegisteredTool's PascalCase `.name` (`Read`), which
      // the case-insensitive assertion must accept.
      jsonl: () =>
        [
          JSON.stringify({ kind: "tool_use", payload: { name: "Read" } }),
          JSON.stringify({
            kind: "assistant_message",
            payload: { content: `The phrase: ${phrase}` },
          }),
        ].join("\n"),
      exitCode: 0,
    });

    const result = await runCliRuntimeSmoke();
    expect(result.status).toBe("ok");
    expect(result.failures).toEqual([]);
    expect(result.finalText).toContain("crewhaus-magic-cli-");
    expect(capturedSpawnEnv?.["ANTHROPIC_AUTH_TOKEN"]).toBe("oauth-xyz");
    expect(capturedSpawnEnv?.["ANTHROPIC_API_KEY"]).toBe("sk-ant-smoke-real");
  });

  test("collects failures: non-zero exit, empty log, missing read, ungrounded reply", async () => {
    enableAnthropic();
    installSpawn({ exitCode: 2, jsonl: () => "" });
    const result = await runCliRuntimeSmoke();
    expect(result.status).toBe("failed");
    const joined = result.failures.join("\n");
    expect(joined).toContain("exited non-zero (2)");
    expect(joined).toContain("no event-log .jsonl");
    expect(joined).toContain('name="Read"');
    expect(joined).toContain("magic phrase");
  });

  test("tolerates a partial/garbage log line, a nameless tool_use, and a missing stdin", async () => {
    enableAnthropic();
    // un-parseable line → catch in readSessionEventLog; tool_use without a
    // name → '<unknown>' branch of toolUseNames; withStdin:false → the
    // `if (proc.stdin)` false branch.
    installSpawn({
      exitCode: 0,
      withStdin: false,
      jsonl: () =>
        [
          "{ this is not valid json",
          JSON.stringify({ kind: "tool_use", payload: {} }),
          JSON.stringify({ kind: "assistant_message", payload: { content: "no phrase here" } }),
        ].join("\n"),
    });
    const result = await runCliRuntimeSmoke();
    expect(result.status).toBe("failed");
    const joined = result.failures.join("\n");
    expect(joined).toContain("<unknown>");
    expect(joined).toContain("magic phrase");
  });

  test("watchdog SIGKILLs the run when crewhaus overruns the timeout", async () => {
    enableAnthropic();
    const wd = installTimeoutKillSpawn();
    try {
      const result = await runCliRuntimeSmoke({ timeoutMs: 5 });
      expect(wd.killed()).toBe(true);
      expect(result.status).toBe("failed");
      expect(result.failures.join("\n")).toContain("exited non-zero (137)");
    } finally {
      wd.restore();
    }
  });

  test("assistantTexts covers string, text-blocks, non-text blocks, and absent content", async () => {
    enableAnthropic();
    installSpawn({
      exitCode: 0,
      jsonl: () =>
        [
          JSON.stringify({ kind: "tool_use", payload: { name: "Read" } }),
          // absent content → skipped (no push)
          JSON.stringify({ kind: "assistant_message", payload: {} }),
          // array of only non-text blocks → parts empty → skipped
          JSON.stringify({
            kind: "assistant_message",
            payload: { content: [{ type: "tool_use", id: "x" }] },
          }),
          // array of text blocks → joined
          JSON.stringify({
            kind: "assistant_message",
            payload: {
              content: [
                { type: "text", text: "FIRST " },
                { type: "text", text: "PART" },
              ],
            },
          }),
          // string content, last turn → grounding check runs against it
          JSON.stringify({ kind: "assistant_message", payload: { content: "ungrounded final" } }),
        ].join("\n"),
    });
    const result = await runCliRuntimeSmoke();
    expect(result.status).toBe("failed");
    expect(result.failures.join("\n")).toContain("magic phrase");
    expect(result.finalText).toBe("ungrounded final");
  });
});

// ---------------------------------------------------------------------------
// runBrowserRuntimeSmoke
// ---------------------------------------------------------------------------

describe("runBrowserRuntimeSmoke", () => {
  test("skips cleanly when no Anthropic auth is configured", async () => {
    const result = await runBrowserRuntimeSmoke();
    expect(result.status).toBe("skipped");
    expect(result.shape).toBe("browser");
  });

  test("happy path: Navigate→Screenshot order, browser_done finalText grounds → ok", async () => {
    enableAnthropic();
    installServe();
    installSpawn({
      jsonl: () =>
        [
          JSON.stringify({ kind: "tool_use", payload: { name: "Navigate" } }),
          JSON.stringify({ kind: "tool_use", payload: { name: "Screenshot" } }),
        ].join("\n"),
      stdout: async () => {
        const phrase = await phraseFromServer();
        return JSON.stringify({ kind: "browser_done", finalText: `The phrase is ${phrase}` });
      },
      exitCode: 0,
    });
    const result = await runBrowserRuntimeSmoke();
    expect(result.status).toBe("ok");
    expect(result.failures).toEqual([]);
    expect(result.finalText).toContain("crewhaus-magic-");
    expect(serveSpy).toHaveBeenCalled();
  });

  test("the magic-phrase page body contains the served phrase + html content-type", async () => {
    enableAnthropic();
    installServe();
    installSpawn({ exitCode: 1, jsonl: () => "" });
    await runBrowserRuntimeSmoke();
    expect(capturedFetch).toBeDefined();
    const res = (capturedFetch as (r: Request) => Response)(new Request("http://127.0.0.1/"));
    const body = await res.text();
    expect(body).toContain("crewhaus-magic-");
    expect(body).toContain('id="phrase"');
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("collects failures: non-zero exit, empty log, missing tools, no browser_done", async () => {
    enableAnthropic();
    installServe();
    installSpawn({ stdout: () => "plain text, no json\n", exitCode: 5, jsonl: () => "" });
    const result = await runBrowserRuntimeSmoke();
    expect(result.status).toBe("failed");
    const joined = result.failures.join("\n");
    expect(joined).toContain("exited non-zero (5)");
    expect(joined).toContain("no event-log .jsonl");
    expect(joined).toContain('name="Navigate"');
    expect(joined).toContain('name="Screenshot"');
    expect(joined).toContain("no browser_done event");
  });

  test("flags out-of-order tools and an ungrounded (but present) finalText", async () => {
    enableAnthropic();
    installServe();
    installSpawn({
      // Screenshot BEFORE Navigate → order check; browser_done without the
      // phrase → grounding failure with a defined finalText (spread branch).
      stdout: () => JSON.stringify({ kind: "browser_done", finalText: "I made up an answer" }),
      exitCode: 0,
      jsonl: () =>
        [
          JSON.stringify({ kind: "tool_use", payload: { name: "Screenshot" } }),
          JSON.stringify({ kind: "tool_use", payload: { name: "Navigate" } }),
        ].join("\n"),
    });
    const result = await runBrowserRuntimeSmoke();
    expect(result.status).toBe("failed");
    const joined = result.failures.join("\n");
    expect(joined).toContain("Navigate must precede Screenshot");
    expect(joined).toContain("does not contain the magic phrase");
    expect(result.finalText).toBe("I made up an answer");
  });

  test("watchdog SIGKILLs the run when crewhaus overruns the timeout", async () => {
    enableAnthropic();
    installServe();
    const wd = installTimeoutKillSpawn();
    try {
      const result = await runBrowserRuntimeSmoke({ timeoutMs: 5 });
      expect(wd.killed()).toBe(true);
      expect(result.status).toBe("failed");
      expect(result.failures.join("\n")).toContain("exited non-zero (137)");
    } finally {
      wd.restore();
    }
  });

  test("extractFinalText skips blank + non-JSON + non-browser_done lines before matching", async () => {
    enableAnthropic();
    installServe();
    installSpawn({
      // extractFinalText walks stdout from the END, so the matching
      // browser_done is placed FIRST and the skip categories AFTER it,
      // forcing the reverse walk to skip a blank line, a non-JSON line, a
      // non-browser_done event, and a browser_done lacking finalText before
      // it reaches the real match.
      stdout: () =>
        [
          JSON.stringify({ kind: "browser_done", finalText: "GROUND_TOKEN" }),
          JSON.stringify({ kind: "browser_done" }), // browser_done but no finalText → skipped
          JSON.stringify({ kind: "noise" }), // wrong kind → skipped
          "not-json", // parse failure → skipped
          "", // blank → continue
        ].join("\n"),
      exitCode: 0,
      jsonl: () =>
        [
          JSON.stringify({ kind: "tool_use", payload: { name: "Navigate" } }),
          JSON.stringify({ kind: "tool_use", payload: { name: "Screenshot" } }),
        ].join("\n"),
    });
    const result = await runBrowserRuntimeSmoke();
    expect(result.finalText).toBe("GROUND_TOKEN");
    expect(result.status).toBe("failed"); // GROUND_TOKEN != the random page phrase
  });
});

// ---------------------------------------------------------------------------
// resolveSmokeModel + --model passthrough (item 33 — the nightly budget knob).
// ---------------------------------------------------------------------------

describe("resolveSmokeModel", () => {
  test("returns the model when CREWHAUS_SMOKE_MODEL is set", () => {
    expect(resolveSmokeModel({ CREWHAUS_SMOKE_MODEL: "claude-haiku-4-5-20251001" })).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  test("empty string behaves like unset (inert workflow env block)", () => {
    expect(resolveSmokeModel({ CREWHAUS_SMOKE_MODEL: "" })).toBeUndefined();
  });

  test("undefined when the env var is absent", () => {
    expect(resolveSmokeModel({})).toBeUndefined();
  });

  test("defaults to reading process.env when no arg is passed", () => {
    // TOUCHED_ENV clears CREWHAUS_SMOKE_MODEL in beforeEach → undefined.
    expect(resolveSmokeModel()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// browserRuntimeSmokeIsRequired — browser runtime smoke is advisory by
// default; only CREWHAUS_RUNTIME_SMOKE_BROWSER=1 promotes it to a hard gate.
// ---------------------------------------------------------------------------

describe("browserRuntimeSmokeIsRequired", () => {
  test("true only when CREWHAUS_RUNTIME_SMOKE_BROWSER=1", () => {
    expect(browserRuntimeSmokeIsRequired({ CREWHAUS_RUNTIME_SMOKE_BROWSER: "1" })).toBe(true);
  });

  test("false when unset (advisory by default)", () => {
    expect(browserRuntimeSmokeIsRequired({})).toBe(false);
  });

  test('false for any value other than exactly "1"', () => {
    expect(browserRuntimeSmokeIsRequired({ CREWHAUS_RUNTIME_SMOKE_BROWSER: "true" })).toBe(false);
    expect(browserRuntimeSmokeIsRequired({ CREWHAUS_RUNTIME_SMOKE_BROWSER: "0" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Advisory reporting — an advisory failure stays non-fatal but must be
// IMPOSSIBLE to miss. The old one-line stdout note let a deterministic boot
// failure ride green for weeks; these cover the annotation + job summary.
// ---------------------------------------------------------------------------

const advisoryResult: RuntimeSmokeResult = {
  shape: "browser",
  status: "failed",
  failures: [
    "crewhaus run exited non-zero (1) — stderr: crewhaus: Playwright not installed.",
    "no event-log .jsonl written to /tmp/crewhaus-runtime-smoke-abc123",
  ],
  stderr: "crewhaus: Playwright not installed.\n",
};

describe("renderBrowserAdvisory", () => {
  test("emits a GitHub error annotation under Actions", () => {
    const line = renderBrowserAdvisory(advisoryResult, { GITHUB_ACTIONS: "true" });
    expect(line.startsWith("::error title=")).toBe(true);
    expect(line).toContain("Playwright not installed");
    expect(line).toContain("CREWHAUS_RUNTIME_SMOKE_BROWSER=1");
  });

  test("annotation stays single-line (newlines escaped as %0A)", () => {
    const line = renderBrowserAdvisory(
      { ...advisoryResult, failures: ["first\nsecond", "100% broken"] },
      { GITHUB_ACTIONS: "true" },
    );
    expect(line.includes("\n")).toBe(false);
    expect(line).toContain("%0A");
    expect(line).toContain("100%25 broken");
  });

  test("falls back to a plain stdout line outside Actions", () => {
    const line = renderBrowserAdvisory(advisoryResult, {});
    expect(line.startsWith("[smoke:runtime browser] ADVISORY")).toBe(true);
    expect(line).toContain("Playwright not installed");
  });
});

describe("renderBrowserAdvisorySummary", () => {
  test("lists every failure and includes the stderr tail", () => {
    const md = renderBrowserAdvisorySummary(advisoryResult);
    expect(md).toContain("Browser runtime smoke failed");
    for (const f of advisoryResult.failures) expect(md).toContain(f);
    expect(md).toContain("stderr tail");
    expect(md).toContain("Playwright not installed");
  });

  test("omits the stderr block when the subprocess wrote nothing", () => {
    const md = renderBrowserAdvisorySummary({ ...advisoryResult, stderr: "" });
    expect(md).not.toContain("stderr tail");
  });
});

describe("reportBrowserAdvisory", () => {
  test("writes the annotation and appends to $GITHUB_STEP_SUMMARY", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-advisory-"));
    const summaryPath = join(dir, "summary.md");
    writeFileSync(summaryPath, "# existing\n");
    const written: string[] = [];
    try {
      reportBrowserAdvisory(
        advisoryResult,
        { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summaryPath },
        (t) => written.push(t),
      );
      expect(written.join("")).toContain("::error title=");
      const summary = readFileSync(summaryPath, "utf-8");
      expect(summary).toContain("# existing");
      expect(summary).toContain("Browser runtime smoke failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no summary env → stdout only, no throw", () => {
    const written: string[] = [];
    reportBrowserAdvisory(advisoryResult, {}, (t) => written.push(t));
    expect(written.join("")).toContain("[smoke:runtime browser] ADVISORY");
  });

  test("an unwritable summary path is swallowed — reporting never fails the run", () => {
    const written: string[] = [];
    expect(() =>
      reportBrowserAdvisory(
        advisoryResult,
        { GITHUB_STEP_SUMMARY: "/nonexistent-dir-crewhaus/summary.md" },
        (t) => written.push(t),
      ),
    ).not.toThrow();
    expect(written.length).toBe(1);
  });
});

describe("--model passthrough into `crewhaus run`", () => {
  test("cli: CREWHAUS_SMOKE_MODEL is forwarded as --model", async () => {
    enableAnthropic();
    process.env["CREWHAUS_SMOKE_MODEL"] = "claude-haiku-4-5-20251001";
    installSpawn({ exitCode: 2, jsonl: () => "" });
    await runCliRuntimeSmoke();
    const argv = capturedSpawnArgv ?? [];
    const i = argv.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("claude-haiku-4-5-20251001");
  });

  test("cli: opts.model wins over the env knob", async () => {
    enableAnthropic();
    process.env["CREWHAUS_SMOKE_MODEL"] = "env-model";
    installSpawn({ exitCode: 2, jsonl: () => "" });
    await runCliRuntimeSmoke({ model: "opts-model" });
    const argv = capturedSpawnArgv ?? [];
    expect(argv[argv.indexOf("--model") + 1]).toBe("opts-model");
  });

  test("cli: no --model flag when neither opts nor env provide one", async () => {
    enableAnthropic();
    installSpawn({ exitCode: 2, jsonl: () => "" });
    await runCliRuntimeSmoke();
    expect((capturedSpawnArgv ?? []).includes("--model")).toBe(false);
  });

  test("browser: the override rides along with --prompt", async () => {
    enableAnthropic();
    process.env["CREWHAUS_SMOKE_MODEL"] = "claude-haiku-4-5-20251001";
    installServe();
    installSpawn({ exitCode: 2 });
    await runBrowserRuntimeSmoke();
    const argv = capturedSpawnArgv ?? [];
    const i = argv.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("claude-haiku-4-5-20251001");
    expect(argv.indexOf("--prompt")).toBeGreaterThan(i);
  });
});
