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
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
 * Whether the browser runtime smoke is a HARD gate. Defaults OFF, so a
 * browser-shape failure does not block the release gate; the CLI runtime
 * smoke remains the hard gate.
 *
 * HISTORY — read before trusting this default. The advisory was introduced
 * (PR #33) on the theory that "live headless-chromium startup is flaky on the
 * CI runner". That diagnosis was wrong. The failure was deterministic, not
 * flaky: the docs/demos split (36140d81) deleted `playwright` from the root
 * devDependencies, so `bun install` stopped putting the PACKAGE in the tree
 * while the workflow kept installing only the BROWSER binaries. Every run
 * since died in `import("playwright")` inside the chromium driver, ~450ms in,
 * before a session log existed. The advisory then hid it: the job reported
 * green for weeks. Fixed by restoring the pinned devDependency.
 *
 * A failure here is therefore a REAL signal, never ambient flake.
 *
 * The `Smoke (runtime)` workflow now sets `CREWHAUS_RUNTIME_SMOKE_BROWSER=1`,
 * so in CI this shape is a HARD gate. It could not be one before: the fixture
 * page is served on loopback, which the SSRF floor refused in two layers with
 * no way for a spec to opt in — so the smoke failed 100% of the time and the
 * advisory was the only thing keeping the job green. The fixture now declares
 * `driver.allowPrivateTargets: true` and the shape passes.
 *
 * The advisory path below therefore survives only for local/ad-hoc runs. It
 * still annotates loudly (see `reportBrowserAdvisory`), because the failure
 * mode it was written for — an unattended green that means "quietly broken" —
 * is the one this whole file exists to prevent.
 */
export function browserRuntimeSmokeIsRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["CREWHAUS_RUNTIME_SMOKE_BROWSER"] === "1";
}

/**
 * Last few stderr lines from the spawned `crewhaus run`, flattened onto one
 * line. A boot failure (missing dependency, bad config) says exactly what
 * went wrong on stderr; the advisory path used to discard it entirely, which
 * is why "exited non-zero (1)" was all anyone ever saw of a one-line
 * "Playwright not installed" error.
 */
function stderrTail(stderr: string, lines = 3, max = 400): string {
  const tail = stderr
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-lines)
    .join(" | ")
    .trim();
  return tail.length > max ? `${tail.slice(0, max)}…` : tail;
}

/** GitHub Actions annotation messages are single-line; newlines are %0A. */
function escapeAnnotation(message: string): string {
  return message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Text printed when the browser runtime smoke fails while advisory. Inside
 * GitHub Actions this is an `::error::` workflow command, which surfaces the
 * failure as a run annotation even though the job stays green — the whole
 * point being that a persistently-failing smoke can be seen without reading
 * the log.
 */
export function renderBrowserAdvisory(
  result: RuntimeSmokeResult,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const detail = `browser runtime smoke FAILED (non-fatal — set CREWHAUS_RUNTIME_SMOKE_BROWSER=1 to enforce). Failures: ${result.failures.join("; ")}`;
  if (env["GITHUB_ACTIONS"] === "true") {
    return `::error title=Browser runtime smoke failed (advisory)::${escapeAnnotation(detail)}`;
  }
  return `[smoke:runtime browser] ADVISORY — ${detail}`;
}

/** Markdown appended to `$GITHUB_STEP_SUMMARY` for an advisory failure. */
export function renderBrowserAdvisorySummary(result: RuntimeSmokeResult): string {
  const failures = result.failures.map((f) => `- ${f}`).join("\n");
  const tail = stderrTail(result.stderr ?? "", 10, 2000);
  return [
    "### ⚠️ Browser runtime smoke failed (advisory — job still green)",
    "",
    "This shape is not a release gate, but a failure here is a real signal.",
    "",
    failures,
    "",
    ...(tail.length > 0
      ? ["<details><summary>stderr tail</summary>", "", "```", tail, "```", "", "</details>", ""]
      : []),
    "Set `CREWHAUS_RUNTIME_SMOKE_BROWSER=1` to make this a hard failure.",
    "",
  ].join("\n");
}

/**
 * Report an advisory browser failure loudly: stdout line (an annotation under
 * Actions) plus a job-summary entry. Summary-append failures are swallowed —
 * reporting must never be what breaks the run.
 */
export function reportBrowserAdvisory(
  result: RuntimeSmokeResult,
  env: NodeJS.ProcessEnv = process.env,
  write: (text: string) => void = (text) => process.stdout.write(text),
): void {
  write(`${renderBrowserAdvisory(result, env)}\n`);
  const summaryPath = env["GITHUB_STEP_SUMMARY"];
  if (summaryPath === undefined || summaryPath === "") return;
  try {
    appendFileSync(summaryPath, renderBrowserAdvisorySummary(result));
  } catch {
    // best-effort — a missing/unwritable summary file must not fail the test
  }
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
 * The error result, if any, for the FIRST call to `name`.
 *
 * A `tool_use` event alone does not prove the tool ran: runtime-core logs it
 * when the model REQUESTS the tool, before the permission gate and before
 * `execute()`. A denied tool and a working tool are therefore identical in
 * the `tool_use` stream, which made the Navigate/Screenshot assertions below
 * non-load-bearing — they passed while both tools were being denied outright
 * ("defaulted to \"ask\" and this non-interactive surface has no way to
 * prompt"), and the smoke then blamed the model for not grounding its answer.
 * Pairing each `tool_use` with its `tool_result` is what makes "the agent
 * actually used the tool" a real assertion.
 */
function toolCallError(
  events: ReadonlyArray<{ kind: string; payload: unknown }>,
  name: string,
): string | undefined {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.kind !== "tool_use") continue;
    const p = e.payload as { id?: unknown; name?: unknown };
    if (typeof p?.name === "string" && p.name.toLowerCase() === name.toLowerCase()) {
      if (typeof p.id === "string") ids.add(p.id);
    }
  }
  if (ids.size === 0) return undefined;
  for (const e of events) {
    if (e.kind !== "tool_result") continue;
    const p = e.payload as { toolUseId?: unknown; isError?: unknown; content?: unknown };
    if (typeof p?.toolUseId !== "string" || !ids.has(p.toolUseId)) continue;
    if (p.isError !== true) continue;
    const detail = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
    return detail.slice(0, 300);
  }
  return undefined;
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
  // realpath the workdir: on macOS `tmpdir()` lives under the `/var → /private/var`
  // symlink, and the spawned CLI's `process.cwd()` reports the resolved
  // `/private/var/...` form. The Read tool sandboxes to `process.cwd()` via a
  // lexical prefix check, so an un-resolved `/var/...` path handed to the agent
  // would be rejected as "outside the workspace root" even though it is in-tree.
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-runtime-cli-work-")));
  const phrase = `crewhaus-magic-cli-${crypto.randomUUID().slice(0, 8)}`;
  // Read against a workspace-relative filename (`secret.txt`), not an absolute
  // path — a relative path resolves cleanly against the sandbox root regardless
  // of any symlinks in the cwd prefix.
  const secretName = "secret.txt";
  const secretFile = join(workDir, secretName);
  writeFileSync(secretFile, `The magic phrase is: ${phrase}\n`);

  try {
    const prompt = `Use the read tool to read ${secretName}, then reply with the magic phrase verbatim and stop.`;
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
    // Spawn with cwd = workDir (the dir holding secret.txt), never the repo
    // root. The built-in `Read` tool sandboxes every path to `process.cwd()`
    // (tool-fs resolveSafe), so a repo-root cwd makes the /tmp secret file
    // legitimately out-of-workspace and the read is correctly denied — the
    // agent tries, the permission engine rejects, the smoke fails. Running
    // from workDir puts secret.txt in-workspace so the read is allowed.
    // CLI_PATH, fixture, and CREWHAUS_SESSION_DIR are all absolute, so the
    // changed cwd does not disturb the CLI/session wiring.
    const proc = Bun.spawn(
      [
        process.execPath,
        CLI_PATH,
        "run",
        fixture,
        ...(model !== undefined ? ["--model", model] : []),
      ],
      {
        cwd: workDir,
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
      const tail = stderrTail(stderr);
      failures.push(
        `crewhaus run exited non-zero (${exitCode})${tail.length > 0 ? ` — stderr: ${tail}` : ""}`,
      );
    }

    const events = readSessionEventLog(sessionDir);
    if (events.length === 0) {
      failures.push(`no event-log .jsonl written to ${sessionDir}`);
    }

    // The fixture declares `tools: [read]` (camelCase) but tool_use events
    // carry the RegisteredTool's runtime `.name`, which is PascalCase `Read`
    // (see tool-fs `read` → `{ name: "Read" }`). Match case-insensitively so
    // the assertion tracks the actual emitted name, not the spec spelling.
    const toolNames = toolUseNames(events);
    if (!toolNames.some((n) => n.toLowerCase() === "read")) {
      failures.push(`expected a tool_use event with name="Read", got [${toolNames.join(", ")}]`);
    }
    // Same reason as the browser shape: a `tool_use` event proves the model
    // asked, not that the read succeeded.
    const readErr = toolCallError(events, "Read");
    if (readErr !== undefined) {
      failures.push(`Read was called but returned an error: ${readErr}`);
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
  // Spawn cwd, for the same reason the CLI smoke above uses `workDir`:
  // `CREWHAUS_SESSION_DIR` relocates the sessions root but NOT the security
  // audit root, which the CLI opens at `<cwd>/.crewhaus/audit` and which
  // `openAuditLog` mkdir's eagerly (mode 0700). With cwd at the repo root that
  // created a 0700 `.crewhaus/audit/` inside the operator's checkout on every
  // credentialed smoke run. CLI_PATH, the fixture and CREWHAUS_SESSION_DIR are
  // all absolute, so the changed cwd disturbs nothing else.
  const workDir = mkdtempSync(join(tmpdir(), "crewhaus-runtime-smoke-cwd-"));
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
        cwd: workDir,
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
      // Carry the stderr tail INTO the failure string: this list is all the
      // advisory path prints, and a sub-second non-zero exit is always a boot
      // error whose reason is on stderr.
      const tail = stderrTail(stderr);
      failures.push(
        `crewhaus run exited non-zero (${exitCode})${tail.length > 0 ? ` — stderr: ${tail}` : ""}`,
      );
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
    // Requesting a tool is not using it — see `toolCallError`. Without these,
    // a denied or throwing tool still satisfies the two assertions above and
    // the smoke reports the far more confusing "the agent did not ground its
    // answer" instead of naming what actually failed.
    for (const name of ["Navigate", "Screenshot"]) {
      const err = toolCallError(events, name);
      if (err !== undefined) failures.push(`${name} was called but returned an error: ${err}`);
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
    rmSync(workDir, { recursive: true, force: true });
  }
}
