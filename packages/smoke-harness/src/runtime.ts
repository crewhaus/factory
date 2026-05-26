/**
 * Runtime smoke for the browser target — Phase 3 of the smoke plan.
 *
 * Compile-time smoke (`./index.ts`) catches "did the emitter wire the
 * right imports?" but cannot catch "did the agent actually use the
 * tools at runtime?" That second class of failure is the one that bit
 * us at the start of this PR series: chromium launched, Screenshot
 * captured a blank page, and the model fell back to training knowledge
 * without ever navigating. Compile-time was green; the user experience
 * was broken.
 *
 * This harness drives the canonical bug-shape end-to-end:
 *   1. Spin up a local Bun.serve on 127.0.0.1 with a randomised magic
 *      phrase embedded in the HTML.
 *   2. Spawn `crewhaus run` on a browser fixture with --prompt that
 *      tells the model to navigate to that URL and report the phrase.
 *   3. After the subprocess exits, read the .jsonl event log out of
 *      `CREWHAUS_SESSION_DIR` and assert:
 *        - a `tool_use` event with name="Navigate" appeared
 *        - a `tool_use` event with name="Screenshot" appeared
 *        - the final `browser_done` event's `finalText` contains the
 *          magic phrase (proving the model grounded its answer in the
 *          page, not in training data).
 *
 * The whole track is gated on `ANTHROPIC_API_KEY` being set. CI runs
 * it via a separate opt-in job that exports the secret; the main
 * matrix stays key-free.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

export async function runBrowserRuntimeSmoke(
  opts: {
    timeoutMs?: number;
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

    const proc = Bun.spawn([process.execPath, CLI_PATH, "run", fixture, "--prompt", prompt], {
      cwd: REPO_ROOT,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

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
