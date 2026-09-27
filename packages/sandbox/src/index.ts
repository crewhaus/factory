import { randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import { CrewhausError } from "@crewhaus/errors";
import {
  type SpawnBoundedResult,
  addHostExitHook,
  onAbort,
  spawnBounded,
} from "@crewhaus/tool-safety/streams";

/**
 * Catalog R8 `sandbox` — containerised exec environment.
 *
 * Backends:
 *   docker  — production default; assumes `docker` daemon reachable.
 *   podman  — drop-in replacement that swaps the CLI binary.
 *   noop    — in-process exec (NOT a security boundary). For tests and
 *             trusted callers that pick it themselves:
 *             `createSandbox({ backend: "noop" })`.
 *             `CREWHAUS_SANDBOX=noop` also selects it here, but to the
 *             code-execution tools that value means "code execution off":
 *             the permission engine refuses `requiresSandbox` tools, and
 *             `@crewhaus/tool-code-execution` refuses to run on a noop
 *             backend it did not choose itself.
 *
 * Defaults applied to every container:
 *   --network none
 *   --memory 512m
 *   --cpus 1.0
 *   --read-only
 *   --tmpfs /tmp:rw,size=64m,mode=1777,exec
 *   --name crewhaus-sbx-<random>, so the run can be stopped by name
 *   --label crewhaus.sandbox=1, so a leftover can be found:
 *     `docker ps -a --filter label=crewhaus.sandbox`
 *   60 second default wall-clock timeout (a caller may pass its own)
 *   1 MiB of stdout and 1 MiB of stderr kept (head and tail), the rest
 *   counted and dropped as it arrives
 *
 * A run is `<cli> create` and then `<cli> start -a -i`, not `<cli> run`, so
 * the container exists by name before anything can race to stop it.
 *
 * A timeout or an abort stops the CONTAINER, not just the CLI. While the
 * container is running: `<cli> kill <name>`, SIGKILL for the CLI's process
 * group, a short grace for output, then `<cli> rm -f <name>`. While it is
 * still being created: the sandbox waits for the create to answer (up to
 * 5 s) and then removes what it made. Cutting a create off let the daemon
 * commit a container after the last `rm -f` — left behind, and started by a
 * client that outlived its SIGTERM (C012). Signalling the CLI alone left the
 * container running, since its PID 1 ignores the SIGTERM the CLI proxies
 * (security-6#0, security-12#5, flag-truth-3#0). When a stopped run's
 * container cannot be confirmed gone, the result names it
 * (`strayContainer`) and a detached process retries the removal.
 *
 * If the HOST goes away mid-run, the containers still running are stopped
 * too: on `process.exit`, and on a SIGINT, SIGTERM or SIGHUP the host
 * neither handles nor ignores (a terminal Ctrl-C, a supervisor's stop), the
 * sandbox runs `<cli> kill` and `<cli> rm -f` for them synchronously before
 * the host is gone. The CLI leads its own process group, so a terminal
 * Ctrl-C no longer reaches it, and the timeout lived in the host.
 * For a host killed outright (SIGKILL, a crash), every run with a timeout
 * also has a watchdog: a detached `sh` that, 10 s after the run's timeout,
 * runs `<cli> kill` and `<cli> rm -f` for its container. It is its own
 * session, so it outlives the host, and it stops the whole container — a
 * program that keeps forking is ended as surely as one busy loop. It is
 * cancelled when the run ends. A run with no timeout has none.
 *
 * Image allowlist: any image string requested by `exec()` must appear
 * in the constructor's `allowedImages` set OR in
 * `CREWHAUS_SANDBOX_ALLOWED_IMAGES` (comma-separated). If neither is
 * set, only the curated default list is allowed:
 *   - python:3.13-slim
 *   - node:22-alpine
 *   - alpine:3.19
 *
 * Mount whitelist: callers pass `mounts: ReadonlyArray<{src,dst,readonly?}>`,
 * but only `src` paths inside `mountWhitelist` (or under `process.cwd()`
 * by default) are accepted. Path-traversal attempts (`..` segments,
 * non-absolute `src`) throw before docker is invoked.
 *
 * SECURITY: image strings and command strings are passed as separate
 * `Bun.spawn` argv elements, so shell metacharacters (`;`, `&&`, `$()`)
 * cannot escape the docker create invocation. Image and mount values are
 * additionally screened for line-feed and dash-prefix tampering before
 * the spawn so an attacker cannot smuggle CLI flags via input.
 *
 * Output is bounded as it arrives, not after: a program printing without
 * end used to be buffered whole on the host (security-12#4, security-6#8).
 * What was dropped is marked in the text and counted in the result.
 *
 * Layer R8 (production safety floor). Pairs with `tool-code-execution`
 * (R4) and `permission-engine` (R8 — the `requiresSandbox` floor).
 */

export type SandboxBackend = "docker" | "podman" | "noop";

export type SandboxMount = {
  /** Absolute host path. Must be inside `mountWhitelist` or cwd. */
  readonly src: string;
  /** Absolute container path. */
  readonly dst: string;
  /** Defaults to true (read-only mount). */
  readonly readonly?: boolean;
};

export type SandboxOptions = {
  /** Defaults to env `CREWHAUS_SANDBOX` (then "docker"). */
  readonly backend?: SandboxBackend;
  /** Non-empty subset of permitted images. Empty = use defaults+env. */
  readonly allowedImages?: ReadonlyArray<string>;
  /** Absolute paths under which `mounts.src` may live. Defaults to [cwd]. */
  readonly mountWhitelist?: ReadonlyArray<string>;
  /**
   * Default exec timeout in ms (60 000). A per-call `timeoutMs` replaces it;
   * a caller that takes the timeout from a model clamps it first
   * (tool-code-execution's `max_timeout_ms`).
   */
  readonly defaultTimeoutMs?: number;
  /**
   * Bytes of stdout, and separately of stderr, kept per exec (default
   * 1 MiB each): the first half and the last half. Past it the output is
   * read and dropped, and the drop is marked in the text. For trusted
   * callers only — never taken from a spec.
   */
  readonly maxOutputBytes?: number;
  /** Memory cap, e.g. "512m". */
  readonly memory?: string;
  /** CPU cap, e.g. "1.0". */
  readonly cpus?: string;
  /** When true, network is allowed (default false). Smoke checks rely on this default. */
  readonly network?: boolean;
};

export type SandboxExecOptions = {
  /** Container image (e.g. "python:3.13-slim"). Must be in allowlist. */
  readonly image: string;
  /** Argv form — passed as separate args to the interpreter. */
  readonly argv: ReadonlyArray<string>;
  /** Optional: piped to the container's stdin. */
  readonly stdin?: string;
  /** Optional: extra env vars (key/value, no shell interpolation). */
  readonly env?: Readonly<Record<string, string>>;
  /** Per-call mount additions; src must pass the whitelist. */
  readonly mounts?: ReadonlyArray<SandboxMount>;
  /** Override the sandbox's default timeout (ms, > 0). */
  readonly timeoutMs?: number;
  /**
   * Cancellation. Aborting stops the run the way a timeout does — the
   * container is killed — and the result says `aborted`.
   */
  readonly signal?: AbortSignal;
  /** Override the sandbox's `maxOutputBytes` for this call. */
  readonly maxOutputBytes?: number;
  /**
   * Output as it arrives, for streaming consumers. Only the part of each
   * stream the result keeps from its start is forwarded; past it, one
   * notice chunk says the rest is not streamed. A throw is ignored.
   */
  readonly onStdoutChunk?: (chunk: string) => void;
  readonly onStderrChunk?: (chunk: string) => void;
};

export type SandboxExecResult = {
  /**
   * What the program wrote, as UTF-8. When it wrote more than the cap, the
   * start and the end are kept and a line
   * `[stdout truncated: N bytes dropped]` stands where the middle was.
   */
  readonly stdout: string;
  readonly stderr: string;
  /**
   * The exit status; 128 + N when the process died of signal N (137 for a
   * SIGKILL). 125 when the container could not be created (the CLI's
   * message is in `stderr`). -1 when there is none to report: the run was
   * cancelled before it started, or its process could not be reaped after
   * the kill.
   */
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /**
   * The caller's `signal` stopped the run (the container was killed). The
   * built-in backends always set it; absent reads as false.
   */
  readonly aborted?: boolean;
  /** Bytes the program wrote to each stream, kept or not. */
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  /** Bytes of each stream that are not in the text (0 when all of it is). */
  readonly stdoutDroppedBytes?: number;
  readonly stderrDroppedBytes?: number;
  /**
   * False when reading stopped before the end of the output — something
   * the program started still held a pipe open after it exited, so the
   * text is what had arrived by then, not necessarily all of it.
   */
  readonly outputComplete?: boolean;
  /**
   * Set only when the container of a stopped run could not be confirmed
   * gone: the daemon was still creating it when the create had to be cut
   * off, or `<cli> rm -f` failed or did not answer. Its name, and why. The
   * sandbox retries the removal from a detached process; `<cli> rm -f
   * <name>` removes it by hand. Absent reads as "nothing left behind".
   */
  readonly strayContainer?: SandboxStrayContainer;
};

export type SandboxStrayContainer = {
  readonly name: string;
  readonly reason: string;
};

export class SandboxError extends CrewhausError {
  override readonly name = "SandboxError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export interface Sandbox {
  readonly backend: SandboxBackend;
  /**
   * What an exec runs with when it sets nothing itself: `timeoutMs`, in ms.
   * The built-in backends always say; a caller that caps timeouts reads it
   * to apply the cap to a call that sets no timeout of its own. Optional,
   * and named so it cannot collide with a field an existing implementation
   * already has (0.7.0's own classes kept a private `defaultTimeoutMs`).
   */
  readonly execDefaults?: { readonly timeoutMs: number };
  exec(opts: SandboxExecOptions): Promise<SandboxExecResult>;
  /** Idempotent. */
  close(): Promise<void>;
}

const DEFAULT_ALLOWED_IMAGES: ReadonlyArray<string> = [
  "python:3.13-slim",
  "node:22-alpine",
  "alpine:3.19",
];

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MEMORY = "512m";
const DEFAULT_CPUS = "1.0";
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** SIGTERM to SIGKILL for the noop backend's process group (the program itself). */
const KILL_GRACE_MS = 1_000;
/**
 * Once the run's process is gone, how long a pipe held open by something it
 * left behind may keep the result waiting before reading stops.
 */
const DRAIN_GRACE_MS = 750;
/** Bound on each `<cli> kill` / `<cli> rm -f` the sandbox runs itself. */
const CONTAINER_CONTROL_TIMEOUT_MS = 5_000;
/**
 * How long a run stopped (timeout or abort) while its container is still
 * being created waits for `<cli> create` to answer. Only then is the
 * create cut off — and the daemon may still commit it, so the result names
 * the container. Until the answer, a `kill` or `rm -f` can find nothing and
 * the container appear right after (C012).
 */
const CREATE_STOP_GRACE_MS = 5_000;
/** Bytes of `<cli> create`'s own output kept (its error, when it fails). */
const CREATE_OUTPUT_BYTES = 16 * 1024;
/** `docker run`'s status for a container it could not create; kept from 0.7.0. */
const CREATE_FAILED_EXIT_CODE = 125;
/**
 * Bound on each `<cli> kill` / `<cli> rm -f` run while the host is exiting.
 * These block the exit, so they are shorter; a daemon that has taken the
 * request finishes it after the CLI is gone.
 */
const HOST_EXIT_CONTROL_TIMEOUT_MS = 3_000;
/**
 * Seconds past a run's timeout before its watchdog stops the container: the
 * host's own stop comes first while the host lives.
 */
const WATCHDOG_GRACE_S = 10;
/** When a stopped run's container could not be confirmed gone: retry after these many seconds. */
const STRAY_RETRY_DELAYS_S: ReadonlyArray<number> = [5, 30];
/** The longest delay `setTimeout` honours; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** `<cli> rm -f`'s answer for a container that is gone or going. */
const GONE_RE = /no such container|already in progress/i;

/**
 * The label on every container the sandbox creates. List leftovers with
 * `docker ps -a --filter label=crewhaus.sandbox`.
 */
export const SANDBOX_CONTAINER_LABEL = "crewhaus.sandbox";
/** `$0` of the detached watchdog and retry processes, as `ps` shows it. */
export const SANDBOX_REAPER_TAG = "crewhaus-sandbox-reaper";

/**
 * Image strings must be `repository[:tag][@digest]`. We disallow leading
 * dashes (CLI flag injection), whitespace (newline-injection), and shell
 * metacharacters even though we never pass them to a shell — defense in
 * depth.
 */
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/]*(?::[a-zA-Z0-9._\-]+)?(?:@sha256:[a-f0-9]{64})?$/;

/**
 * What `CREWHAUS_SANDBOX` selects. `fromEnv` is false when the variable is
 * unset or blank, which means docker. `ok: false` is a value that names no
 * backend — the caller must not guess which one was meant.
 */
export type SandboxBackendResolution =
  | { readonly ok: true; readonly backend: SandboxBackend; readonly fromEnv: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * THE one reading of `CREWHAUS_SANDBOX`: trimmed and lower-cased, then
 * checked against the three backends. Everything that decides from the
 * variable — `createSandbox`, the permission floor in `crewhaus run`, the
 * floor a compiled bundle emits — reads it through here.
 *
 * It used to be read two ways: the floor compared the raw value with "noop"
 * while `createSandbox` trimmed it, so `noop ` (or `noop\r` from a CRLF .env)
 * told the floor a sandbox existed and then ran model code on the host with
 * the noop backend (security-6#1).
 */
export function resolveSandboxBackend(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SandboxBackendResolution {
  const raw = env["CREWHAUS_SANDBOX"] ?? "";
  const value = raw.trim().toLowerCase();
  if (value === "") return { ok: true, backend: "docker", fromEnv: false };
  if (value === "docker" || value === "podman" || value === "noop") {
    return { ok: true, backend: value, fromEnv: true };
  }
  return {
    ok: false,
    reason: `CREWHAUS_SANDBOX=${JSON.stringify(raw)} is not a sandbox backend. Set it to docker or podman to run code in a container, or noop to turn code execution off.`,
  };
}

/**
 * Whether code-execution tools may treat the sandbox as real: only when
 * `CREWHAUS_SANDBOX` selects docker or podman (unset means docker). `noop`
 * and a value that names no backend are both "no sandbox", so the
 * permission floor denies those tools rather than guessing.
 */
export function sandboxAvailableFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const resolved = resolveSandboxBackend(env);
  return resolved.ok && resolved.backend !== "noop";
}

function readEnvBackend(): SandboxBackend | undefined {
  const resolved = resolveSandboxBackend();
  if (!resolved.ok) throw new SandboxError(resolved.reason);
  return resolved.fromEnv ? resolved.backend : undefined;
}

function readEnvAllowedImages(): ReadonlyArray<string> {
  const raw = process.env["CREWHAUS_SANDBOX_ALLOWED_IMAGES"];
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function validateImage(image: string, allow: ReadonlySet<string>): void {
  if (image.length === 0) throw new SandboxError("image is required");
  if (image.startsWith("-")) {
    throw new SandboxError(`image "${image}" looks like a CLI flag — refused`);
  }
  if (image.includes("\n") || image.includes(" ") || image.includes("\t")) {
    throw new SandboxError(`image "${image}" contains whitespace — refused`);
  }
  if (!IMAGE_RE.test(image)) {
    throw new SandboxError(`image "${image}" is not a valid registry reference`);
  }
  if (!allow.has(image)) {
    const list = [...allow].sort().join(", ");
    throw new SandboxError(
      `image "${image}" is not on the allowlist — allowed: ${list || "(empty)"}`,
    );
  }
}

function validateMount(m: SandboxMount, whitelist: ReadonlyArray<string>): void {
  if (!m.src.startsWith("/")) {
    throw new SandboxError(`mount src "${m.src}" must be absolute`);
  }
  if (!m.dst.startsWith("/")) {
    throw new SandboxError(`mount dst "${m.dst}" must be absolute`);
  }
  if (m.src.includes("..") || m.dst.includes("..")) {
    throw new SandboxError(`mount path may not contain ".." (src="${m.src}", dst="${m.dst}")`);
  }
  if (m.src.includes("\n") || m.dst.includes("\n")) {
    throw new SandboxError("mount path may not contain newlines");
  }
  const ok = whitelist.some((root) => m.src === root || m.src.startsWith(`${root}/`));
  if (!ok) {
    const roots = whitelist.join(", ");
    throw new SandboxError(`mount src "${m.src}" is not under any whitelisted root (${roots})`);
  }
}

function validateEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new SandboxError(`env key "${key}" is not a valid identifier`);
  }
}

/** A timeout in ms: > 0, or Infinity for none. */
function parseTimeoutMs(value: number): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    throw new SandboxError(`timeoutMs must be a number of milliseconds > 0, got ${String(value)}`);
  }
  return value;
}

/** A per-stream output cap in bytes: a finite number >= 0. */
function parseMaxOutputBytes(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SandboxError(`maxOutputBytes must be a finite number >= 0, got ${String(value)}`);
  }
  return Math.floor(value);
}

/**
 * Forwards a stream's output to a live consumer, as text, up to `limit`
 * bytes — the part the result keeps from the start — then says once that
 * the rest is not streamed. A multi-byte character cut by the limit is
 * never emitted half.
 */
function liveForwarder(
  label: "stdout" | "stderr",
  sink: ((chunk: string) => void) | undefined,
  limit: number,
): { push: (chunk: Uint8Array) => void; end: () => void } | undefined {
  if (sink === undefined) return undefined;
  const decoder = new TextDecoder();
  let sent = 0;
  let cut = false;
  const emit = (text: string): void => {
    if (text.length === 0) return;
    try {
      sink(text);
    } catch {
      // A consumer's error must not stop the run or its drain.
    }
  };
  return {
    push: (chunk) => {
      if (cut) return;
      const room = limit - sent;
      if (chunk.length <= room) {
        sent += chunk.length;
        emit(decoder.decode(chunk, { stream: true }));
        return;
      }
      if (room > 0) emit(decoder.decode(chunk.subarray(0, room), { stream: true }));
      sent = limit;
      cut = true;
      emit(`\n[${label} truncated: output past ${limit} bytes is not streamed]\n`);
    },
    end: () => {
      if (!cut) emit(decoder.decode());
    },
  };
}

/**
 * One stream's text for the result: everything, or the kept start, a line
 * saying how many bytes were dropped, and the kept end. For UTF-8 output the
 * count is taken from the text itself, so a character cut at either edge is
 * counted too; bytes that are not UTF-8 decode to replacement characters,
 * which are longer, so the count is never less than the bytes not kept.
 */
function keptText(
  label: "stdout" | "stderr",
  head: string,
  truncated: boolean,
  tail: string | undefined,
  totalBytes: number,
  omittedBytes: number,
): { readonly text: string; readonly dropped: number } {
  if (!truncated) return { text: head, dropped: 0 };
  const end = tail ?? "";
  const dropped = Math.max(
    omittedBytes,
    totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(end, "utf8"),
  );
  const sep = head.length === 0 || head.endsWith("\n") ? "" : "\n";
  return { text: `${head}${sep}[${label} truncated: ${dropped} bytes dropped]\n${end}`, dropped };
}

/** 128 + N for signal N, as a shell reports it. */
function signalExitCode(signal: string | null): number | undefined {
  if (signal === null) return undefined;
  const n = (osConstants.signals as Record<string, number | undefined>)[signal];
  return n === undefined ? undefined : 128 + n;
}

/** The first line of a CLI's message, for a reason shown to the caller. */
function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.trim().slice(0, 300);
}

/**
 * The `sh` script of a reaper: after each delay in turn, `<cli> kill` then
 * `<cli> rm -f` for one container. Arguments: cli, name, delays (seconds).
 */
const REAPER_SCRIPT =
  'cli=$1; name=$2; shift 2; for delay in "$@"; do sleep "$delay"; "$cli" kill "$name" >/dev/null 2>&1; "$cli" rm -f "$name" >/dev/null 2>&1; done';

/**
 * Starts a detached process that stops and removes one container after
 * each of `delaysS`, and returns a function that cancels it. It is a
 * session of its own with no pipes to the host, so it outlives the host —
 * a SIGKILL, a crash, a supervisor that kills the host's group — and never
 * holds a reader of the host's output open. It only ever touches the one
 * container name, which is random. Best effort: where it cannot start
 * (Windows, no `/bin/sh`), the run goes on without it.
 */
function startReaper(cli: string, name: string, delaysS: ReadonlyArray<number>): () => void {
  if (delaysS.length === 0 || process.platform === "win32") return () => undefined;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      ["/bin/sh", "-c", REAPER_SCRIPT, SANDBOX_REAPER_TAG, cli, name, ...delaysS.map(String)],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true },
    );
  } catch {
    return () => undefined;
  }
  proc.unref();
  return () => {
    // Its group: `sh` and the `sleep` it waits on. While Bun has not seen
    // it exit, the pid cannot have been reused.
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // already gone
    }
  };
}

/**
 * Containers of runs in flight — being created, started, or stopped — by
 * name, with the CLI that owns them. While any is registered, a host-exit
 * hook stops them if the host goes away: the run's own timeout and abort
 * live in the host and die with it.
 */
const liveContainers = new Map<string, string>();
let removeExitHook: (() => void) | undefined;

function stopLiveContainersNow(): void {
  removeExitHook = undefined;
  const byCli = new Map<string, string[]>();
  for (const [name, cli] of liveContainers) byCli.set(cli, [...(byCli.get(cli) ?? []), name]);
  liveContainers.clear();
  for (const [cli, names] of byCli) {
    // `kill` first (SIGKILL at once; podman's `rm -f` would wait 10 s on a
    // PID 1 that ignores SIGTERM), then `rm -f` for one created but never
    // started. Synchronous, because the host is exiting; detached, so a
    // supervisor that SIGKILLs the host's group does not cut it short.
    for (const verb of [["kill"], ["rm", "-f"]]) {
      try {
        Bun.spawnSync([cli, ...verb, ...names], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          timeout: HOST_EXIT_CONTROL_TIMEOUT_MS,
          detached: true,
        });
      } catch {
        // The host is going away; the watchdog is still there.
      }
    }
  }
}

function trackContainer(name: string, cli: string): void {
  liveContainers.set(name, cli);
  removeExitHook ??= addHostExitHook(stopLiveContainersNow);
}

function untrackContainer(name: string): void {
  liveContainers.delete(name);
  if (liveContainers.size > 0 || removeExitHook === undefined) return;
  removeExitHook();
  removeExitHook = undefined;
}

type SuperviseOptions = {
  readonly cmd: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly onStdoutChunk?: (chunk: string) => void;
  readonly onStderrChunk?: (chunk: string) => void;
  /** SIGTERM to SIGKILL for the group, once a timeout or abort starts the kill. */
  readonly killGraceMs: number;
  /**
   * Stops what the process is only a client of (the container). Started
   * when a timeout or abort begins the kill; the result waits for it.
   */
  readonly stopRemote?: () => Promise<void>;
  /** When the run began, for `durationMs` (default: now). */
  readonly startedAt?: number;
};

type SupervisedRun = {
  readonly result: SandboxExecResult;
  /** A timeout or abort started the kill. */
  readonly killed: boolean;
  /**
   * The process ran and exited on its own with a status: for a container
   * client, the container's own exit, which `--rm` cleans up.
   */
  readonly clean: boolean;
};

/**
 * Runs one process for both backends: it leads its own group, output is
 * capped as it arrives (half kept from the start, half from the end), and a
 * timeout or abort kills the group — after starting `stopRemote`, which for
 * docker/podman is what actually stops the container. Once the process is
 * gone, reading stops after a short grace even if something it left behind
 * still holds a pipe, and the result says so.
 */
async function superviseExec(o: SuperviseOptions): Promise<SupervisedRun> {
  const t0 = o.startedAt ?? performance.now();
  const tailBytes = Math.floor(o.maxOutputBytes / 2);
  const headBytes = o.maxOutputBytes - tailBytes;
  const liveOut = liveForwarder("stdout", o.onStdoutChunk, headBytes);
  const liveErr = liveForwarder("stderr", o.onStderrChunk, headBytes);
  let reason: "timeout" | "abort" | "overflow" | undefined;
  let stopping: Promise<void> | undefined;

  const r: SpawnBoundedResult = await spawnBounded({
    cmd: o.cmd,
    ...(o.env !== undefined ? { env: o.env } : {}),
    ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
    timeoutMs: o.timeoutMs,
    maxStdoutBytes: o.maxOutputBytes,
    maxStderrBytes: o.maxOutputBytes,
    tailBytes,
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
    killGraceMs: o.killGraceMs,
    drainGraceMs: DRAIN_GRACE_MS,
    onKill: (why) => {
      reason = why;
      if (o.stopRemote !== undefined) stopping = o.stopRemote().catch(() => undefined);
    },
    ...(liveOut !== undefined ? { onStdoutChunk: liveOut.push } : {}),
    ...(liveErr !== undefined ? { onStderrChunk: liveErr.push } : {}),
  });
  if (r.spawnError !== undefined) {
    throw new SandboxError(`could not start ${o.cmd[0]}: ${r.spawnError}`);
  }
  if (r.outputComplete) {
    liveOut?.end();
    liveErr?.end();
  }
  if (stopping !== undefined) await stopping;

  const out = keptText(
    "stdout",
    r.stdout,
    r.stdoutTruncated,
    r.stdoutTail,
    r.stdoutBytes,
    r.stdoutOmittedBytes,
  );
  const err = keptText(
    "stderr",
    r.stderr,
    r.stderrTruncated,
    r.stderrTail,
    r.stderrBytes,
    r.stderrOmittedBytes,
  );
  return {
    result: {
      stdout: out.text,
      stderr: err.text,
      exitCode: r.exitCode ?? signalExitCode(r.signal) ?? -1,
      // The first of timeout and abort is the one reported.
      timedOut: r.timedOut && reason !== "abort",
      aborted: r.aborted && reason !== "timeout",
      durationMs: performance.now() - t0,
      stdoutBytes: r.stdoutBytes,
      stderrBytes: r.stderrBytes,
      stdoutDroppedBytes: out.dropped,
      stderrDroppedBytes: err.dropped,
      outputComplete: r.outputComplete,
    },
    killed: reason !== undefined,
    clean: reason === undefined && r.pid !== undefined && r.exitCode !== null,
  };
}

/** A run that never reached its program: nothing ran, nothing was read. */
function notStarted(
  startedAt: number,
  stopped: "timeout" | "abort" | undefined,
  stray?: SandboxStrayContainer,
): SandboxExecResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: -1,
    timedOut: stopped === "timeout",
    aborted: stopped === "abort",
    durationMs: performance.now() - startedAt,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputComplete: true,
    ...(stray !== undefined ? { strayContainer: stray } : {}),
  };
}

/**
 * Watches for the first of a run's timeout and its caller's abort while the
 * container is being created, WITHOUT stopping the create: `cut` aborts
 * only {@link CREATE_STOP_GRACE_MS} after it.
 */
function watchStop(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): {
  readonly cut: AbortSignal;
  readonly reason: () => "timeout" | "abort" | undefined;
  readonly dispose: () => void;
} {
  const cut = new AbortController();
  let reason: "timeout" | "abort" | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const begin = (why: "timeout" | "abort"): void => {
    if (reason !== undefined) return;
    reason = why;
    grace = setTimeout(() => cut.abort(), CREATE_STOP_GRACE_MS);
  };
  const deadline =
    timeoutMs <= MAX_TIMER_MS ? setTimeout(() => begin("timeout"), timeoutMs) : undefined;
  const unsubscribe = onAbort(signal, () => begin("abort"));
  return {
    cut: cut.signal,
    reason: () => reason,
    dispose: () => {
      clearTimeout(deadline);
      clearTimeout(grace);
      unsubscribe();
    },
  };
}

type Removal =
  | { readonly ok: true; readonly existed: boolean }
  | { readonly ok: false; readonly reason: string };

class DockerLikeSandbox implements Sandbox {
  readonly backend: SandboxBackend;
  readonly execDefaults: { readonly timeoutMs: number };
  private readonly cli: string;
  private readonly allowedImages: ReadonlySet<string>;
  private readonly mountWhitelist: ReadonlyArray<string>;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly network: boolean;
  private closed = false;

  constructor(backend: "docker" | "podman", opts: SandboxOptions) {
    this.backend = backend;
    this.cli = backend;
    const ownAllowed = (opts.allowedImages ?? []).filter((s) => s.length > 0);
    const envAllowed = readEnvAllowedImages();
    const merged = new Set<string>(
      ownAllowed.length > 0 || envAllowed.length > 0
        ? [...ownAllowed, ...envAllowed]
        : DEFAULT_ALLOWED_IMAGES,
    );
    this.allowedImages = merged;
    this.mountWhitelist = (opts.mountWhitelist ?? [process.cwd()]).map((p) => {
      if (!p.startsWith("/")) {
        throw new SandboxError(`mountWhitelist entry "${p}" must be absolute`);
      }
      return p;
    });
    this.defaultTimeoutMs = parseTimeoutMs(opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.execDefaults = { timeoutMs: this.defaultTimeoutMs };
    this.maxOutputBytes = parseMaxOutputBytes(opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    this.memory = opts.memory ?? DEFAULT_MEMORY;
    this.cpus = opts.cpus ?? DEFAULT_CPUS;
    this.network = opts.network === true;
  }

  async exec(opts: SandboxExecOptions): Promise<SandboxExecResult> {
    if (this.closed) throw new SandboxError("sandbox is closed");
    validateImage(opts.image, this.allowedImages);
    const mounts = opts.mounts ?? [];
    for (const m of mounts) validateMount(m, this.mountWhitelist);
    const timeoutMs = parseTimeoutMs(opts.timeoutMs ?? this.defaultTimeoutMs);
    const maxOutputBytes = parseMaxOutputBytes(opts.maxOutputBytes ?? this.maxOutputBytes);
    // Never derived from input: the name is how every stop finds the container.
    const name = `crewhaus-sbx-${randomBytes(8).toString("hex")}`;
    const createArgs = this.createArgs(name, opts, mounts);
    const startedAt = performance.now();
    if (opts.signal?.aborted === true) return notStarted(startedAt, "abort");

    // Registered before the CLI starts and until every stop has finished, so
    // a host that exits at any point in between stops the container too.
    trackContainer(name, this.cli);
    const cancelWatchdog = Number.isFinite(timeoutMs)
      ? startReaper(this.cli, name, [Math.ceil(timeoutMs / 1000) + WATCHDOG_GRACE_S])
      : () => undefined;
    try {
      return await this.createAndStart(
        name,
        createArgs,
        opts,
        timeoutMs,
        maxOutputBytes,
        startedAt,
      );
    } finally {
      untrackContainer(name);
      cancelWatchdog();
    }
  }

  private createArgs(
    name: string,
    opts: SandboxExecOptions,
    mounts: ReadonlyArray<SandboxMount>,
  ): string[] {
    const args: string[] = [
      "create",
      "--rm",
      "-i",
      "--name",
      name,
      "--label",
      `${SANDBOX_CONTAINER_LABEL}=1`,
      this.network ? "--network=bridge" : "--network=none",
      `--memory=${this.memory}`,
      `--cpus=${this.cpus}`,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=64m,mode=1777,exec",
      "--security-opt",
      "no-new-privileges",
    ];
    for (const m of mounts) {
      const ro = m.readonly !== false;
      args.push("-v", `${m.src}:${m.dst}${ro ? ":ro" : ""}`);
    }
    if (opts.env !== undefined) {
      for (const [k, v] of Object.entries(opts.env)) {
        validateEnvKey(k);
        args.push("-e", `${k}=${v}`);
      }
    }
    args.push(opts.image, ...opts.argv);
    return args;
  }

  private async createAndStart(
    name: string,
    createArgs: ReadonlyArray<string>,
    opts: SandboxExecOptions,
    timeoutMs: number,
    maxOutputBytes: number,
    startedAt: number,
  ): Promise<SandboxExecResult> {
    // 1. Create. A timeout or abort does not cut the create off: a daemon
    // commits a create whether or not its client is still there, so a
    // `kill` or `rm -f` sent before the answer can find nothing and the
    // container appear after it. The answer is waited for, up to
    // CREATE_STOP_GRACE_MS, and then what it made is removed.
    const stop = watchStop(timeoutMs, opts.signal);
    let created: SpawnBoundedResult;
    try {
      created = await spawnBounded({
        cmd: [this.cli, ...createArgs],
        timeoutMs: Number.POSITIVE_INFINITY,
        maxStdoutBytes: CREATE_OUTPUT_BYTES,
        maxStderrBytes: CREATE_OUTPUT_BYTES,
        tailBytes: CREATE_OUTPUT_BYTES / 2,
        signal: stop.cut,
        killGraceMs: 0,
      });
    } finally {
      stop.dispose();
    }
    if (created.spawnError !== undefined) {
      throw new SandboxError(`could not start ${this.cli}: ${created.spawnError}`);
    }
    const stopped = stop.reason();
    if (created.exitCode === null) {
      // No answer: cut off after the grace, or killed from outside. The
      // daemon may still create the container; nothing will start it.
      const gone = await this.remove(name, false);
      if (gone.ok && gone.existed) return notStarted(startedAt, stopped);
      const why = created.aborted
        ? `the run was stopped while ${this.cli} was still creating its container, and the create did not answer within ${CREATE_STOP_GRACE_MS / 1000}s`
        : `${this.cli} create was killed before it answered`;
      return notStarted(
        startedAt,
        stopped,
        this.leftBehind(name, `${why}; the daemon may still create it (it is never started)`),
      );
    }
    if (created.exitCode !== 0) {
      // The CLI answered: the create failed, so nothing was made. Its own
      // message is the run's stderr, and the status is 125, as `<cli> run`
      // reported a container it could not create (`create` exits 1 for a
      // daemon error).
      const err = keptText(
        "stderr",
        created.stderr,
        created.stderrTruncated,
        created.stderrTail,
        created.stderrBytes,
        created.stderrOmittedBytes,
      );
      return {
        ...notStarted(startedAt, stopped),
        stderr: err.text,
        exitCode: CREATE_FAILED_EXIT_CODE,
        stderrBytes: created.stderrBytes,
        stderrDroppedBytes: err.dropped,
      };
    }
    const remaining = timeoutMs - (performance.now() - startedAt);
    if (stopped !== undefined || remaining <= 0) {
      const gone = await this.remove(name, false);
      return notStarted(
        startedAt,
        stopped ?? "timeout",
        gone.ok ? undefined : this.leftBehind(name, gone.reason),
      );
    }

    // 2. Start it attached, for what is left of the timeout. A SIGTERM buys
    // nothing here: the container is stopped by name, and a client that
    // proxies TERM to the container lives on — so the group gets SIGKILL.
    let run: SupervisedRun;
    try {
      run = await superviseExec({
        cmd: [this.cli, "start", "-a", "-i", name],
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
        timeoutMs: remaining,
        maxOutputBytes,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.onStdoutChunk !== undefined ? { onStdoutChunk: opts.onStdoutChunk } : {}),
        ...(opts.onStderrChunk !== undefined ? { onStderrChunk: opts.onStderrChunk } : {}),
        killGraceMs: 0,
        stopRemote: async () => {
          await this.control(["kill"], name);
        },
        startedAt,
      });
    } catch (err) {
      const gone = await this.remove(name, false);
      if (!gone.ok) this.leftBehind(name, gone.reason);
      throw err;
    }
    if (run.clean) return run.result;
    // Stopped, never reaped, or the CLI died of a signal nobody here sent:
    // the container may be left, created or running.
    const gone = await this.remove(name, !run.killed);
    return gone.ok
      ? run.result
      : { ...run.result, strayContainer: this.leftBehind(name, gone.reason) };
  }

  /** `<cli> <verb…> <name>`, bounded. "No such container" is an answer, not an error. */
  private control(verb: ReadonlyArray<string>, name: string): Promise<SpawnBoundedResult> {
    return spawnBounded({
      cmd: [this.cli, ...verb, name],
      timeoutMs: CONTAINER_CONTROL_TIMEOUT_MS,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
      killGraceMs: 0,
    });
  }

  /**
   * `<cli> rm -f <name>`, after `<cli> kill` when the container may still
   * be running (`rm -f` alone waits out podman's stop timeout). `ok` when
   * the container is gone or going; `existed` when this removed it.
   */
  private async remove(name: string, killFirst: boolean): Promise<Removal> {
    if (killFirst) await this.control(["kill"], name);
    const r = await this.control(["rm", "-f"], name);
    if (r.spawnError !== undefined) {
      return { ok: false, reason: `could not run ${this.cli} rm -f: ${r.spawnError}` };
    }
    if (r.timedOut) {
      return {
        ok: false,
        reason: `${this.cli} rm -f did not answer within ${CONTAINER_CONTROL_TIMEOUT_MS / 1000}s`,
      };
    }
    if (GONE_RE.test(r.stderr)) return { ok: true, existed: false };
    if (r.exitCode === 0) return { ok: true, existed: true };
    return {
      ok: false,
      reason: `${this.cli} rm -f failed: ${firstLine(r.stderr) || `exit ${r.exitCode ?? r.signal}`}`,
    };
  }

  /** Hands a container that may be left to a detached retry, and says so. */
  private leftBehind(name: string, reason: string): SandboxStrayContainer {
    startReaper(this.cli, name, STRAY_RETRY_DELAYS_S);
    return { name, reason };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class NoopSandbox implements Sandbox {
  readonly backend: SandboxBackend = "noop";
  readonly execDefaults: { readonly timeoutMs: number };
  private readonly allowedImages: ReadonlySet<string>;
  private readonly mountWhitelist: ReadonlyArray<string>;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private closed = false;

  constructor(opts: SandboxOptions = {}) {
    const ownAllowed = (opts.allowedImages ?? []).filter((s) => s.length > 0);
    const envAllowed = readEnvAllowedImages();
    const merged = new Set<string>(
      ownAllowed.length > 0 || envAllowed.length > 0
        ? [...ownAllowed, ...envAllowed]
        : DEFAULT_ALLOWED_IMAGES,
    );
    this.allowedImages = merged;
    this.mountWhitelist = (opts.mountWhitelist ?? [process.cwd()]).map((p) => {
      if (!p.startsWith("/")) {
        throw new SandboxError(`mountWhitelist entry "${p}" must be absolute`);
      }
      return p;
    });
    this.defaultTimeoutMs = parseTimeoutMs(opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.execDefaults = { timeoutMs: this.defaultTimeoutMs };
    this.maxOutputBytes = parseMaxOutputBytes(opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  }

  async exec(opts: SandboxExecOptions): Promise<SandboxExecResult> {
    if (this.closed) throw new SandboxError("sandbox is closed");
    validateImage(opts.image, this.allowedImages);
    const mounts = opts.mounts ?? [];
    for (const m of mounts) validateMount(m, this.mountWhitelist);
    if (opts.env !== undefined) {
      for (const k of Object.keys(opts.env)) validateEnvKey(k);
    }
    const timeoutMs = parseTimeoutMs(opts.timeoutMs ?? this.defaultTimeoutMs);
    const maxOutputBytes = parseMaxOutputBytes(opts.maxOutputBytes ?? this.maxOutputBytes);

    // The noop backend runs the requested argv directly on the host —
    // there is NO isolation. It exists to make unit tests deterministic
    // without a docker daemon. Production paths reject this backend at
    // the permission layer (`requiresSandbox` denial). The program still
    // leads its own process group, so a timeout takes down what it started.
    const run = await superviseExec({
      cmd: [...opts.argv],
      ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      timeoutMs,
      maxOutputBytes,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.onStdoutChunk !== undefined ? { onStdoutChunk: opts.onStdoutChunk } : {}),
      ...(opts.onStderrChunk !== undefined ? { onStderrChunk: opts.onStderrChunk } : {}),
      killGraceMs: KILL_GRACE_MS,
    });
    return run.result;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export function createSandbox(opts: SandboxOptions = {}): Sandbox {
  const backend = opts.backend ?? readEnvBackend() ?? "docker";
  if (backend === "noop") return new NoopSandbox(opts);
  return new DockerLikeSandbox(backend, opts);
}

export const SANDBOX_DEFAULT_ALLOWED_IMAGES = DEFAULT_ALLOWED_IMAGES;
/** The wall-clock timeout an exec gets when neither the sandbox nor the call sets one. */
export const SANDBOX_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
/** Bytes of stdout, and of stderr, an exec keeps when nothing sets `maxOutputBytes`. */
export const SANDBOX_DEFAULT_MAX_OUTPUT_BYTES = DEFAULT_MAX_OUTPUT_BYTES;
