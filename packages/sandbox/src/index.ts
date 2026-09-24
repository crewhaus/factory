import { randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import { CrewhausError } from "@crewhaus/errors";
import { type SpawnBoundedResult, spawnBounded } from "@crewhaus/tool-safety/streams";

/**
 * Catalog R8 `sandbox` — containerised exec environment.
 *
 * Backends:
 *   docker  — production default; assumes `docker` daemon reachable.
 *   podman  — drop-in replacement that swaps the CLI binary.
 *   noop    — in-process exec (NOT a security boundary). Test-only;
 *             must be opted in via `CREWHAUS_SANDBOX=noop`. The
 *             permission engine refuses to satisfy `requiresSandbox`
 *             tools when this backend is active.
 *
 * Defaults applied to every container:
 *   --network none
 *   --memory 512m
 *   --cpus 1.0
 *   --read-only
 *   --tmpfs /tmp:rw,size=64m,mode=1777,exec
 *   --name crewhaus-sbx-<random>, so the run can be stopped by name
 *   60 second default wall-clock timeout (a caller may pass its own)
 *   1 MiB of stdout and 1 MiB of stderr kept (head and tail), the rest
 *   counted and dropped as it arrives
 *
 * A timeout or an abort stops the CONTAINER, not just the CLI: the sandbox
 * runs `<cli> kill <name>`, kills the CLI's process group, stops waiting
 * for output after a short grace, and runs `<cli> rm -f <name>` for a
 * container created but never started. Signalling the CLI alone left the
 * container running — its PID 1 ignores the SIGTERM the CLI proxies — and
 * under Docker Desktop's wrapper the call waited for the program to end on
 * its own (security-6#0, security-12#5, flag-truth-3#0).
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
 * cannot escape the docker run invocation. Image and mount values are
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
   * SIGKILL). -1 when there is none to report: the run was cancelled before
   * it started, or its process could not be reaped after the kill.
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
};

export class SandboxError extends CrewhausError {
  override readonly name = "SandboxError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export interface Sandbox {
  readonly backend: SandboxBackend;
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
/** SIGTERM to SIGKILL for the process group a run leads (the CLI, or the noop program). */
const KILL_GRACE_MS = 1_000;
/**
 * Once the run's process is gone, how long a pipe held open by something it
 * left behind may keep the result waiting before reading stops.
 */
const DRAIN_GRACE_MS = 750;
/** Bound on each `<cli> kill` / `<cli> rm -f` the sandbox runs itself. */
const CONTAINER_CONTROL_TIMEOUT_MS = 5_000;

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
 * saying how many bytes were dropped, and the kept end. The count is taken
 * from the text itself, so a character cut at either edge is counted too.
 */
function keptText(
  label: "stdout" | "stderr",
  head: string,
  truncated: boolean,
  tail: string | undefined,
  totalBytes: number,
): { readonly text: string; readonly dropped: number } {
  if (!truncated) return { text: head, dropped: 0 };
  const end = tail ?? "";
  const dropped = totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(end, "utf8");
  const sep = head.length === 0 || head.endsWith("\n") ? "" : "\n";
  return { text: `${head}${sep}[${label} truncated: ${dropped} bytes dropped]\n${end}`, dropped };
}

/** 128 + N for signal N, as a shell reports it. */
function signalExitCode(signal: string | null): number | undefined {
  if (signal === null) return undefined;
  const n = (osConstants.signals as Record<string, number | undefined>)[signal];
  return n === undefined ? undefined : 128 + n;
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
  /**
   * Stops what the process is only a client of (the container). Started
   * when a timeout or abort begins the kill; the result waits for it.
   */
  readonly stopRemote?: () => Promise<void>;
  /** Runs once a killed run's process is gone (`rm -f` a late container). */
  readonly afterKill?: () => Promise<void>;
};

/**
 * Runs one exec for both backends: the process leads its own group, output
 * is capped as it arrives (half kept from the start, half from the end),
 * and a timeout or abort kills the group — after starting `stopRemote`,
 * which for docker/podman is what actually stops the container. Once the
 * process is gone, reading stops after a short grace even if something it
 * left behind still holds a pipe, and the result says so.
 */
async function superviseExec(o: SuperviseOptions): Promise<SandboxExecResult> {
  const t0 = performance.now();
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
    killGraceMs: KILL_GRACE_MS,
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
  if (reason !== undefined && o.afterKill !== undefined) {
    await o.afterKill().catch(() => undefined);
  }

  const out = keptText("stdout", r.stdout, r.stdoutTruncated, r.stdoutTail, r.stdoutBytes);
  const err = keptText("stderr", r.stderr, r.stderrTruncated, r.stderrTail, r.stderrBytes);
  return {
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
  };
}

class DockerLikeSandbox implements Sandbox {
  readonly backend: SandboxBackend;
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

    // Never derived from input: the name is how a timeout or abort finds
    // the container to kill.
    const name = `crewhaus-sbx-${randomBytes(8).toString("hex")}`;
    const cliArgs: string[] = [
      "run",
      "--rm",
      "-i",
      "--name",
      name,
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
      cliArgs.push("-v", `${m.src}:${m.dst}${ro ? ":ro" : ""}`);
    }
    if (opts.env !== undefined) {
      for (const [k, v] of Object.entries(opts.env)) {
        validateEnvKey(k);
        cliArgs.push("-e", `${k}=${v}`);
      }
    }
    cliArgs.push(opts.image, ...opts.argv);

    // `kill` stops a running container at once (`stop` would wait 10 s);
    // `rm -f` then removes one that was created but never started when the
    // kill landed (`--rm` covers every container that ran). Each is bounded,
    // and "No such container" is the expected answer when there is nothing
    // left to do.
    const control = async (verb: ReadonlyArray<string>): Promise<void> => {
      await spawnBounded({
        cmd: [this.cli, ...verb, name],
        timeoutMs: CONTAINER_CONTROL_TIMEOUT_MS,
        maxStdoutBytes: 4_096,
        maxStderrBytes: 4_096,
      });
    };
    return superviseExec({
      cmd: [this.cli, ...cliArgs],
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      timeoutMs,
      maxOutputBytes,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.onStdoutChunk !== undefined ? { onStdoutChunk: opts.onStdoutChunk } : {}),
      ...(opts.onStderrChunk !== undefined ? { onStderrChunk: opts.onStderrChunk } : {}),
      stopRemote: () => control(["kill"]),
      afterKill: () => control(["rm", "-f"]),
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class NoopSandbox implements Sandbox {
  readonly backend: SandboxBackend = "noop";
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
    return superviseExec({
      cmd: [...opts.argv],
      ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      timeoutMs,
      maxOutputBytes,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.onStdoutChunk !== undefined ? { onStdoutChunk: opts.onStdoutChunk } : {}),
      ...(opts.onStderrChunk !== undefined ? { onStderrChunk: opts.onStderrChunk } : {}),
    });
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
