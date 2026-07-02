/**
 * Runtime smoke for the runnable target shapes (cli, browser) — Phase 3
 * of the smoke plan.
 *
 * Compile-time smoke (`./index.ts`) catches "did the emitter wire the
 * right imports?" but cannot catch "did the agent actually use the
 * tools at runtime?" That second class of failure is the one that bit
 * us at the start of this PR series: chromium launched, Screenshot
 * captured a blank page, and the model fell back to training knowledge
 * without ever navigating. Compile-time was green; the user experience
 * was broken.
 *
 * Common shape (both `runBrowserRuntimeSmoke` and `runCliRuntimeSmoke`):
 *   - Generate a randomised "magic phrase" that the agent can only
 *     learn by using a tool — a local Bun.serve page for browser, a
 *     temp file for cli — so guessing from training data fails.
 *   - Spawn `crewhaus run` as a subprocess with
 *     `CREWHAUS_SESSION_DIR=<tmp>` so the runtime's `.jsonl` event log
 *     lands somewhere we can read post-exit.
 *   - After exit, parse the event log and assert: (a) the expected
 *     `tool_use` events fired in the right order, and (b) the final
 *     assistant turn contains the magic phrase.
 *
 * Both tracks are gated on `ANTHROPIC_AUTH_TOKEN` (OAuth) or
 * `ANTHROPIC_API_KEY`. The main CI matrix runs key-free (tests skip
 * cleanly); the `Smoke (runtime)` workflow (nightly cron + dispatch +
 * the release gate via workflow_call) exports the secret and flips
 * skip → fail via `CREWHAUS_RUNTIME_SMOKE_REQUIRED=1`. Cost knob:
 * `CREWHAUS_SMOKE_MODEL` (see `resolveSmokeModel`) overrides the
 * fixtures' models so the unattended nightly pins the cheapest capable
 * model.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "runtime-fixtures");

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "cli",
  "src",
  "index.ts",
);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const DEFAULT_TIMEOUT_MS = 120_000;

export type RuntimeSmokeStatus = "ok" | "skipped" | "failed";

export type RuntimeSmokeResult = {
  readonly shape: string;
  readonly status: RuntimeSmokeStatus;
  readonly failures: readonly string[];
  readonly skipReason?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly events?: ReadonlyArray<{ kind: string; payload: unknown }>;
  readonly finalText?: string;
};

/** Honors both auth paths: ANTHROPIC_AUTH_TOKEN (OAuth) and ANTHROPIC_API_KEY. */
export function runtimeSmokeIsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const oauth = env["ANTHROPIC_AUTH_TOKEN"];
  const apiKey = env["ANTHROPIC_API_KEY"];
  if (oauth !== undefined && oauth !== "") return true;
  if (apiKey !== undefined && apiKey !== "" && apiKey !== "test-no-call") return true;
  return false;
}

/**
 * Optional model override for smoke runs — the nightly workflow's budget
 * knob (item 33). When set, `CREWHAUS_SMOKE_MODEL` (or the explicit
 * `opts.model` a caller passes) is forwarded to `crewhaus run --model <m>`,
 * overriding each fixture's default model so an unattended schedule can pin
 * the cheapest capable model. Empty string behaves like unset, so
 * `CREWHAUS_SMOKE_MODEL=""` in a workflow env block is inert.
 */
export function resolveSmokeModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const model = env["CREWHAUS_SMOKE_MODEL"];
  return model === undefined || model === "" ? undefined : model;
}

/**
 * Spin up a local Bun.serve serving one page that contains a randomised
 * magic phrase. Returns a teardown handle plus the URL + phrase so the
 * harness can hand them to the agent and assert the model echoed the
 * phrase back. Bound to 127.0.0.1 so headless chromium can reach it
 * without external network.
 */
function startMagicPhraseServer(): {
  url: string;
  phrase: string;
  stop: () => Promise<void>;
} {
  const phrase = `crewhaus-magic-${crypto.randomUUID().slice(0, 8)}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        `<!doctype html><html><head><title>CrewHaus runtime smoke</title></head><body><h1>Magic Phrase</h1><p id="phrase">${phrase}</p></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  return {
    url,
    phrase,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/**
 * Parse the cli subprocess's stdout for the `browser_done` JSON line and
 * return its `finalText`. The browser bundle emits one JSON object per
 * line via `emitEvent()`; we pluck the closing event off the end.
 */
function extractFinalText(stdout: string): string | undefined {
  for (const raw of stdout.split("\n").reverse()) {
    if (raw.length === 0) continue;
    let parsed: { kind?: string; finalText?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed.kind === "browser_done" && typeof parsed.finalText === "string") {
      return parsed.finalText;
    }
  }
  return undefined;
}

function readSessionEventLog(
  sessionDir: string,
): ReadonlyArray<{ kind: string; payload: unknown }> {
  const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return [];
  // If multiple sessions wrote here, pick the newest by lex order
  // (session ids include a timestamp + random suffix; for our harness
  // we expect exactly one).
  const target = files.sort().at(-1);
  if (target === undefined) return [];
  const lines = readFileSync(join(sessionDir, target), "utf-8").split("\n");
  const events: Array<{ kind: string; payload: unknown }> = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      const ev = JSON.parse(line) as { kind: string; payload: unknown };
      events.push({ kind: ev.kind, payload: ev.payload });
    } catch {
      // tolerate partial writes — caller will fail on missing anchors
    }
  }
  return events;
}

function toolUseNames(events: ReadonlyArray<{ kind: string; payload: unknown }>): string[] {
  return events
    .filter((e) => e.kind === "tool_use")
    .map((e) => {
      const p = e.payload as { name?: unknown };
      return typeof p?.name === "string" ? p.name : "<unknown>";
    });
}

/**
 * Pull the text content out of every `assistant_message` event in spec
 * order. The runtime serialises the model's output as a discriminated
 * union of content blocks; we collapse the text-typed blocks per turn
 * and return one string per assistant turn.
 */
function assistantTexts(events: ReadonlyArray<{ kind: string; payload: unknown }>): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind !== "assistant_message") continue;
    const p = e.payload as { content?: unknown };
    const content = p?.content;
    if (typeof content === "string") {
      out.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts: string[] = [];
    for (const block of content) {
      const b = block as { type?: string; text?: unknown };
      if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
    if (parts.length > 0) out.push(parts.join(""));
  }
  return out;
}

/**
 * cli runtime smoke. Drives `crewhaus run` with target: cli (multi-turn
 * REPL) by piping a single prompt over stdin and then closing stdin —
 * the REPL processes the one turn and exits cleanly on EOF (see the
 * `STDIN_CLOSED` race in runtime-core/index.ts:1730). The fixture
 * spec declares the `read` tool, and the harness writes a randomised
 * magic-phrase file to a tmp dir so the only way for the agent to
 * answer correctly is to actually call `read`.
 */
export async function runCliRuntimeSmoke(
  opts: {
    timeoutMs?: number;
    /** Overrides the fixture's model (defaults to CREWHAUS_SMOKE_MODEL when set). */
    model?: string;
  } = {},
): Promise<RuntimeSmokeResult> {
  if (!runtimeSmokeIsEnabled()) {
    return {
      shape: "cli",
      status: "skipped",
      failures: [],
      skipReason: "neither ANTHROPIC_AUTH_TOKEN nor a real ANTHROPIC_API_KEY is set",
    };
  }

  const sessionDir = mkdtempSync(join(tmpdir(), "crewhaus-runtime-cli-"));
  const workDir = mkdtempSync(join(tmpdir(), "crewhaus-runtime-cli-work-"));
  const phrase = `crewhaus-magic-cli-${crypto.randomUUID().slice(0, 8)}`;
  const secretFile = join(workDir, "secret.txt");
  writeFileSync(secretFile, `The magic phrase is: ${phrase}\n`);

  try {
    const prompt = `Use the read tool to read ${secretFile}, then reply with the magic phrase verbatim and stop.`;
    const fixture = join(RUNTIME_FIXTURES_DIR, "cli.yaml");
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      CREWHAUS_SESSION_DIR: sessionDir,
    };
    const oauth = process.env["ANTHROPIC_AUTH_TOKEN"];
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (oauth !== undefined && oauth !== "") env["ANTHROPIC_AUTH_TOKEN"] = oauth;
    if (apiKey !== undefined && apiKey !== "") env["ANTHROPIC_API_KEY"] = apiKey;

    const model = opts.model ?? resolveSmokeModel();
    const proc = Bun.spawn(
      [
        process.execPath,
        CLI_PATH,
        "run",
        fixture,
        ...(model !== undefined ? ["--model", model] : []),
      ],
      {
        cwd: REPO_ROOT,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    // Write the single prompt then close stdin. The REPL's `you>` loop
    // races each rl.question against a closed-stdin signal, so EOF makes
    // it break cleanly after the one turn has finished.
    if (proc.stdin) {
      proc.stdin.write(`${prompt}\n`);
      proc.stdin.end();
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    const failures: string[] = [];
    if (exitCode !== 0) {
      failures.push(`crewhaus run exited non-zero (${exitCode})`);
    }

    const events = readSessionEventLog(sessionDir);
    if (events.length === 0) {
      failures.push(`no event-log .jsonl written to ${sessionDir}`);
    }

    const toolNames = toolUseNames(events);
    if (!toolNames.includes("read")) {
      failures.push(`expected a tool_use event with name="read", got [${toolNames.join(", ")}]`);
    }

    // Confirm the agent's final reply grounds in the file content. The
    // last assistant_message in the log is the model's terminal reply
    // to the user; any earlier ones happen before the read tool result
    // is fed back in.
    const turns = assistantTexts(events);
    const finalText = turns.at(-1) ?? "";
    if (!finalText.includes(phrase)) {
      failures.push(
        `final assistant turn does not contain the magic phrase ${JSON.stringify(phrase)} — ` +
          `the agent did not ground its answer in the file content. Last turn was: ${JSON.stringify(finalText.slice(0, 240))}`,
      );
    }

    return {
      shape: "cli",
      status: failures.length === 0 ? "ok" : "failed",
      failures,
      stdout,
      stderr,
      events,
      finalText,
    };
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

export async function runBrowserRuntimeSmoke(
  opts: {
    timeoutMs?: number;
    /** Overrides the fixture's model (defaults to CREWHAUS_SMOKE_MODEL when set). */
    model?: string;
  } = {},
): Promise<RuntimeSmokeResult> {
  if (!runtimeSmokeIsEnabled()) {
    return {
      shape: "browser",
      status: "skipped",
      failures: [],
      skipReason: "neither ANTHROPIC_AUTH_TOKEN nor a real ANTHROPIC_API_KEY is set",
    };
  }

  const sessionDir = mkdtempSync(join(tmpdir(), "crewhaus-runtime-smoke-"));
  const server = startMagicPhraseServer();
  try {
    const prompt = `Navigate to ${server.url}, take a screenshot, and report the magic phrase on the page.`;
    const fixture = join(RUNTIME_FIXTURES_DIR, "browser.yaml");
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      CREWHAUS_SESSION_DIR: sessionDir,
    };
    // Forward whichever auth path is configured. ANTHROPIC_AUTH_TOKEN
    // (Claude OAuth) takes precedence over ANTHROPIC_API_KEY (per the
    // runtime-core `resolveAuth` order).
    const oauth = process.env["ANTHROPIC_AUTH_TOKEN"];
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (oauth !== undefined && oauth !== "") env["ANTHROPIC_AUTH_TOKEN"] = oauth;
    if (apiKey !== undefined && apiKey !== "") env["ANTHROPIC_API_KEY"] = apiKey;

    const model = opts.model ?? resolveSmokeModel();
    const proc = Bun.spawn(
      [
        process.execPath,
        CLI_PATH,
        "run",
        fixture,
        ...(model !== undefined ? ["--model", model] : []),
        "--prompt",
        prompt,
      ],
      {
        cwd: REPO_ROOT,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    const failures: string[] = [];
    if (exitCode !== 0) {
      failures.push(`crewhaus run exited non-zero (${exitCode})`);
    }

    const events = readSessionEventLog(sessionDir);
    if (events.length === 0) {
      failures.push(`no event-log .jsonl written to ${sessionDir}`);
    }

    const toolNames = toolUseNames(events);
    const navIdx = toolNames.indexOf("Navigate");
    const screenshotIdx = toolNames.indexOf("Screenshot");
    if (navIdx === -1) {
      failures.push(
        `expected a tool_use event with name="Navigate", got [${toolNames.join(", ")}]`,
      );
    }
    if (screenshotIdx === -1) {
      failures.push(
        `expected a tool_use event with name="Screenshot", got [${toolNames.join(", ")}]`,
      );
    }
    if (navIdx !== -1 && screenshotIdx !== -1 && navIdx > screenshotIdx) {
      failures.push("Navigate must precede Screenshot — agent screenshot a blank page");
    }

    const finalText = extractFinalText(stdout);
    if (finalText === undefined) {
      failures.push("no browser_done event with finalText found in stdout");
    } else if (!finalText.includes(server.phrase)) {
      failures.push(
        `finalText does not contain the magic phrase ${JSON.stringify(server.phrase)} — ` +
          `the agent did not ground its answer in the page. finalText was: ${JSON.stringify(finalText.slice(0, 240))}`,
      );
    }

    return {
      shape: "browser",
      status: failures.length === 0 ? "ok" : "failed",
      failures,
      stdout,
      stderr,
      events,
      ...(finalText !== undefined ? { finalText } : {}),
    };
  } finally {
    await server.stop();
    rmSync(sessionDir, { recursive: true, force: true });
  }
}
