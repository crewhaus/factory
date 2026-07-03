/**
 * Catalog R9 `hooks-engine` — lifecycle hooks loaded from
 * `.crewhaus/settings.json` (project) and `~/.crewhaus/settings.json` (user)
 * that intercept runtime moments via subprocess commands.
 *
 * Each hook is a `{ event, matcher?, command, timeoutMs? }` triple. At every
 * lifecycle moment the runtime calls `runHooks(event, payload, hooks)`, which
 * (1) filters by `event` plus a glob match against `payload.name`, (2) spawns
 * each surviving command with a restricted env (no `ANTHROPIC_AUTH_TOKEN`,
 * no `AWS_*`, no `GH_*`, just `PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
 * plus `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, `LC_*`), (3) writes the
 * payload as JSON to stdin and reads a JSON `HookDecision` from stdout, and
 * (4) returns one `HookResult` per fired hook.
 *
 * Decision shape: `{ decision: "allow" | "deny" | "block", reason?, mutate? }`.
 * Aggregation: any deny/block short-circuits with the first reason; allows
 * accumulate `mutate` via shallow-merge. v1 only honours `mutate` for the
 * `pre-slash` event (the `expanded` field) — other events log it but do
 * not apply it.
 *
 * Loading layer order: user hooks first, project hooks last. Project hooks
 * therefore evaluate "later" — but since aggregation short-circuits on the
 * first deny, in practice each hook runs in `Promise.all` and the first
 * deny in the array wins. Order is mostly for stability of `HookResult[]`
 * output across runs.
 *
 * Lifecycle events fired by `runtime-core`:
 *   session-start | stop | pre-tool | post-tool | pre-model | post-model
 *   pre-compact | post-compact | pre-slash
 *
 * Glob impl is a tokenizer adapted from `@crewhaus/tool-permission-matcher`'s
 * `globToRegex` (copied locally — extension packages must not depend on tool
 * packages). `*` matches any chars except `/`; `**` matches anything; `?`
 * matches a single char (excluding `/`); other regex specials are escaped.
 *
 * SECURITY: The restricted env is the central defense against a hook
 * command exfiltrating the user's API keys or cloud credentials. The T8
 * test asserts that `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `AWS_*`,
 * `GOOGLE_APPLICATION_CREDENTIALS`, `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`,
 * `OPENAI_API_KEY` are absent regardless of parent env.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { type Logger, createLogger } from "@crewhaus/logging";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";

export const HOOK_EVENTS = [
  "session-start",
  "stop",
  "pre-tool",
  "post-tool",
  "pre-model",
  "post-model",
  "pre-compact",
  "post-compact",
  "pre-slash",
  // Ops item 31 — fired by the alert watchdog when a per-session metric
  // breaches a baseline-derived threshold (CREWHAUS_ALERTS). Additive: a
  // settings.json hook with `event: "alert"` receives the breach payload
  // (metric, observed, threshold, detail) on stdin like any other hook.
  "alert",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS);

export type HookDef = {
  readonly event: HookEvent;
  readonly matcher?: string;
  readonly command: string;
  readonly timeoutMs?: number;
};

export type HookDecision = {
  readonly decision: "allow" | "deny" | "block";
  readonly reason?: string;
  readonly mutate?: Record<string, unknown>;
};

export type HookResult = {
  readonly hook: HookDef;
  readonly decision: HookDecision;
  readonly durationMs: number;
  readonly stderr?: string;
};

export type LoadHooksOptions = {
  readonly cwd?: string;
  readonly homeDir?: string;
};

export type RunHooksOptions = {
  /** Field on `payload` to glob-match `hook.matcher` against. Defaults to "name". */
  readonly matcherKey?: string;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  /** Override env source (testing). Defaults to `process.env`. */
  readonly parentEnv?: NodeJS.ProcessEnv;
  /** Optional Section 15 trace bus. Each fired hook emits a `hook_fired` event. */
  readonly eventBus?: TraceEventBus;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DRAIN_GRACE_MS = 250;
const SETTINGS_RELATIVE = ".crewhaus/settings.json";

export class HookConfigError extends CrewhausError {
  override readonly name = "HookConfigError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * Load and concatenate hooks from user + project `settings.json`. User entries
 * come first; project entries last. Missing files are not an error — returns
 * `[]` if neither path exists.
 *
 * Settings shape: `{ "hooks": HookDef[], ... }`. Other top-level keys (e.g.
 * `permissions`, consumed by the permission engine) are ignored here.
 */
export async function loadHooks(opts: LoadHooksOptions = {}): Promise<HookDef[]> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homeDir ?? homedir();
  const userPath = join(home, SETTINGS_RELATIVE);
  const projectPath = join(cwd, SETTINGS_RELATIVE);
  const out: HookDef[] = [];
  // Skip the user file when it resolves to the same path as the project file
  // (avoids duplicating hooks when cwd is the user's home directory).
  if (existsSync(userPath)) {
    out.push(...readHooksFile(userPath));
  }
  if (projectPath !== userPath && existsSync(projectPath)) {
    out.push(...readHooksFile(projectPath));
  }
  return out;
}

function readHooksFile(path: string): HookDef[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new HookConfigError(`failed to read ${path}: ${(err as Error).message}`, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HookConfigError(`malformed JSON in ${path}: ${(err as Error).message}`, err);
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const hooksRaw = (parsed as Record<string, unknown>)["hooks"];
  if (hooksRaw === undefined) return [];
  if (!Array.isArray(hooksRaw)) {
    throw new HookConfigError(`${path}: \`hooks\` must be an array`);
  }
  return hooksRaw.map((entry, idx) => validateHookEntry(entry, path, idx));
}

function validateHookEntry(value: unknown, path: string, index: number): HookDef {
  if (typeof value !== "object" || value === null) {
    throw new HookConfigError(`${path} hooks[${index}]: entry must be an object`);
  }
  const v = value as Record<string, unknown>;
  const event = v["event"];
  if (typeof event !== "string" || !HOOK_EVENT_SET.has(event)) {
    throw new HookConfigError(
      `${path} hooks[${index}]: \`event\` must be one of ${HOOK_EVENTS.join(", ")} (got ${JSON.stringify(event)})`,
    );
  }
  const command = v["command"];
  if (typeof command !== "string" || command.length === 0) {
    throw new HookConfigError(`${path} hooks[${index}]: \`command\` must be a non-empty string`);
  }
  const matcher = v["matcher"];
  if (matcher !== undefined && typeof matcher !== "string") {
    throw new HookConfigError(`${path} hooks[${index}]: \`matcher\` must be a string when set`);
  }
  const timeoutMs = v["timeoutMs"];
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new HookConfigError(
      `${path} hooks[${index}]: \`timeoutMs\` must be a positive finite number when set`,
    );
  }
  const out: HookDef = {
    event: event as HookEvent,
    command,
    ...(typeof matcher === "string" ? { matcher } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
  return out;
}

/**
 * Run every hook matching `event` (and `payload[matcherKey]` against the
 * hook's matcher) in parallel. Each spawn gets a JSON-stringified payload
 * on stdin; the parsed JSON on stdout becomes the `HookDecision`. Malformed
 * output, non-zero exit, or timeout collapses into a synthetic
 * `decision: "deny"` so a misbehaving hook cannot silently pass.
 */
export async function runHooks(
  event: HookEvent,
  payload: unknown,
  hooks: ReadonlyArray<HookDef>,
  opts: RunHooksOptions = {},
): Promise<HookResult[]> {
  if (hooks.length === 0) return [];
  const matcherKey = opts.matcherKey ?? "name";
  const matchTarget = extractMatchTarget(payload, matcherKey);
  const filtered = hooks.filter((h) => {
    if (h.event !== event) return false;
    if (h.matcher === undefined || h.matcher === "" || h.matcher === "*") return true;
    if (matchTarget === undefined) return false;
    return globToRegex(h.matcher).test(matchTarget);
  });
  if (filtered.length === 0) return [];
  const logger = opts.logger;
  const bus = opts.eventBus;
  const env = buildHookEnv(opts.parentEnv ?? process.env);
  const results = await Promise.all(
    filtered.map((hook) => runOne(hook, payload, env, logger, opts.signal)),
  );
  if (bus) {
    for (const r of results) {
      const allowed = r.decision.decision === "allow";
      bus.publish({
        ...bus.envelope(),
        kind: "hook_fired",
        event,
        ...(r.hook.matcher ? { matcher: r.hook.matcher } : {}),
        allowed,
        durationMs: r.durationMs,
        ...(r.decision.reason ? { reason: r.decision.reason } : {}),
      });
    }
  }
  return results;
}

function extractMatchTarget(payload: unknown, matcherKey: string): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const v = (payload as Record<string, unknown>)[matcherKey];
  return typeof v === "string" ? v : undefined;
}

async function runOne(
  hook: HookDef,
  payload: unknown,
  env: NodeJS.ProcessEnv,
  logger: Logger | undefined,
  signal: AbortSignal | undefined,
): Promise<HookResult> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const proc = Bun.spawn(["sh", "-c", hook.command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
    ...(signal !== undefined ? { signal } : {}),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }, timeoutMs);
  try {
    // Write the JSON payload to stdin; close so the hook's `read` returns EOF.
    const stdin = proc.stdin as { write?: (chunk: string) => unknown; end?: () => unknown };
    if (typeof stdin.write === "function") {
      stdin.write(`${JSON.stringify(payload)}\n`);
    }
    if (typeof stdin.end === "function") {
      stdin.end();
    }
    // Start the reads but do not await them yet — if the hook's command
    // forks a long-running grandchild (e.g. `sleep 30`), SIGKILL on `sh`
    // leaves the orphan holding the pipe write-end open and `text()` never
    // EOFs. Race against `proc.exited` and a small drain grace window.
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const drainFallback = (): Promise<string> =>
      new Promise((resolve) => setTimeout(() => resolve(""), DRAIN_GRACE_MS));
    const [stdoutText, stderrText] = await Promise.all([
      Promise.race([stdoutPromise, drainFallback()]),
      Promise.race([stderrPromise, drainFallback()]),
    ]);
    const durationMs = Date.now() - start;
    if (timedOut) {
      logger?.warn("hook timeout", { command: hook.command, timeoutMs });
      return {
        hook,
        decision: { decision: "deny", reason: `hook timed out after ${timeoutMs}ms` },
        durationMs,
        stderr: stderrText,
      };
    }
    if (exitCode !== 0) {
      logger?.warn("hook nonzero exit", {
        command: hook.command,
        exitCode,
        stderr: stderrText.slice(0, 200),
      });
      return {
        hook,
        decision: {
          decision: "deny",
          reason: `hook exited with code ${exitCode}${stderrText.length > 0 ? `: ${stderrText.slice(0, 200).trim()}` : ""}`,
        },
        durationMs,
        stderr: stderrText,
      };
    }
    const decision = parseDecision(stdoutText, hook);
    if (decision === null) {
      return {
        hook,
        decision: {
          decision: "deny",
          reason: `hook returned malformed JSON: ${stdoutText.slice(0, 100).trim()}`,
        },
        durationMs,
        stderr: stderrText,
      };
    }
    return { hook, decision, durationMs, stderr: stderrText };
  } finally {
    clearTimeout(timer);
  }
}

function parseDecision(stdout: string, hook: HookDef): HookDecision | null {
  const trimmed = stdout.trim();
  // Allow an empty stdout to mean "allow" — useful for purely-observational hooks.
  if (trimmed.length === 0) return { decision: "allow" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  const decision = v["decision"];
  if (decision !== "allow" && decision !== "deny" && decision !== "block") return null;
  const reason = typeof v["reason"] === "string" ? v["reason"] : undefined;
  const mutateRaw = v["mutate"];
  const mutate =
    typeof mutateRaw === "object" && mutateRaw !== null
      ? (mutateRaw as Record<string, unknown>)
      : undefined;
  void hook;
  return {
    decision,
    ...(reason !== undefined ? { reason } : {}),
    ...(mutate !== undefined ? { mutate } : {}),
  };
}

/**
 * Reduce a set of `HookResult`s to a single decision: any deny/block wins
 * (with the first such reason); otherwise allowed, with shallow-merged
 * mutate objects from the allow results.
 */
export function aggregateDecisions(results: ReadonlyArray<HookResult>): {
  allowed: boolean;
  reason?: string;
  mutate?: Record<string, unknown>;
} {
  let mutate: Record<string, unknown> | undefined;
  for (const r of results) {
    if (r.decision.decision === "deny" || r.decision.decision === "block") {
      const reason = r.decision.reason ?? `hook ${r.decision.decision}`;
      return { allowed: false, reason };
    }
    if (r.decision.mutate !== undefined) {
      mutate = { ...(mutate ?? {}), ...r.decision.mutate };
    }
  }
  return mutate !== undefined ? { allowed: true, mutate } : { allowed: true };
}

const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const ENV_ALLOWLIST: ReadonlyArray<string> = ["HOME", "USER", "LANG", "TERM", "TMPDIR"];
const LC_PREFIX = "LC_";

/**
 * Build the env that hook subprocesses inherit. Strips every variable that
 * could exfiltrate credentials; allows only a hard-coded `PATH`, locale
 * vars, and a few harmless identity bits. Used internally by `runHooks`;
 * exported for the T8 security test.
 */
export function buildHookEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: SAFE_PATH };
  for (const k of ENV_ALLOWLIST) {
    const v = parent[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  for (const [k, v] of Object.entries(parent)) {
    if (k.startsWith(LC_PREFIX) && typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * Tokenizing glob → regex. Adapted from `@crewhaus/tool-permission-matcher`
 * with the parenthesized-arg-glob portion removed (hook matchers only need
 * to test simple names like `Bash`, `everything__*`, `tool-fs/*`).
 */
function globToRegex(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 2;
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

// Fallback exported logger factory so callers without a runtime logger can
// still emit structured warnings about misbehaving hooks.
export function defaultLogger(): Logger {
  return createLogger({ bindings: { component: "hooks-engine" } });
}
