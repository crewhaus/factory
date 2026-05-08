import { CrewhausError } from "@crewhaus/errors";

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
 *   60 second wall-clock timeout
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
  /** Default exec timeout. Per-call timeout overrides this. */
  readonly defaultTimeoutMs?: number;
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
  /** Override the sandbox's default timeout. */
  readonly timeoutMs?: number;
  /** Optional cooperative cancellation. */
  readonly signal?: AbortSignal;
  /** Forwarded line-by-line for streaming consumers. */
  readonly onStdoutChunk?: (chunk: string) => void;
  readonly onStderrChunk?: (chunk: string) => void;
};

export type SandboxExecResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
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

/**
 * Image strings must be `repository[:tag][@digest]`. We disallow leading
 * dashes (CLI flag injection), whitespace (newline-injection), and shell
 * metacharacters even though we never pass them to a shell — defense in
 * depth.
 */
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/]*(?::[a-zA-Z0-9._\-]+)?(?:@sha256:[a-f0-9]{64})?$/;

function readEnvBackend(): SandboxBackend | undefined {
  const raw = (process.env["CREWHAUS_SANDBOX"] ?? "").trim().toLowerCase();
  if (raw === "") return undefined;
  if (raw === "docker" || raw === "podman" || raw === "noop") return raw;
  throw new SandboxError(`CREWHAUS_SANDBOX=${raw} is not one of docker|podman|noop`);
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

class DockerLikeSandbox implements Sandbox {
  readonly backend: SandboxBackend;
  private readonly cli: string;
  private readonly allowedImages: ReadonlySet<string>;
  private readonly mountWhitelist: ReadonlyArray<string>;
  private readonly defaultTimeoutMs: number;
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
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.memory = opts.memory ?? DEFAULT_MEMORY;
    this.cpus = opts.cpus ?? DEFAULT_CPUS;
    this.network = opts.network === true;
  }

  async exec(opts: SandboxExecOptions): Promise<SandboxExecResult> {
    if (this.closed) throw new SandboxError("sandbox is closed");
    validateImage(opts.image, this.allowedImages);
    const mounts = opts.mounts ?? [];
    for (const m of mounts) validateMount(m, this.mountWhitelist);

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const cliArgs: string[] = [
      "run",
      "--rm",
      "-i",
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

    const t0 = performance.now();
    const proc = Bun.spawn([this.cli, ...cliArgs], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    if (opts.stdin !== undefined) {
      proc.stdin.write(opts.stdin);
    }
    proc.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, timeoutMs);

    try {
      const stdoutP = collectStream(proc.stdout, opts.onStdoutChunk);
      const stderrP = collectStream(proc.stderr, opts.onStderrChunk);
      const exitCode = await proc.exited;
      const stdout = await stdoutP;
      const stderr = await stderrP;
      return {
        stdout,
        stderr,
        exitCode,
        timedOut,
        durationMs: performance.now() - t0,
      };
    } finally {
      clearTimeout(timer);
    }
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
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async exec(opts: SandboxExecOptions): Promise<SandboxExecResult> {
    if (this.closed) throw new SandboxError("sandbox is closed");
    validateImage(opts.image, this.allowedImages);
    const mounts = opts.mounts ?? [];
    for (const m of mounts) validateMount(m, this.mountWhitelist);
    if (opts.env !== undefined) {
      for (const k of Object.keys(opts.env)) validateEnvKey(k);
    }

    // The noop backend runs the requested argv directly via Bun.spawn —
    // there is NO isolation. It exists to make unit tests deterministic
    // without a docker daemon. Production paths reject this backend at
    // the permission layer (`requiresSandbox` denial).
    const t0 = performance.now();
    const argv = [...opts.argv];
    const env =
      opts.env !== undefined
        ? ({ ...process.env, ...opts.env } as Record<string, string>)
        : undefined;
    const proc = Bun.spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(env !== undefined ? { env } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    if (opts.stdin !== undefined) {
      proc.stdin.write(opts.stdin);
    }
    proc.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, opts.timeoutMs ?? this.defaultTimeoutMs);
    try {
      const stdoutP = collectStream(proc.stdout, opts.onStdoutChunk);
      const stderrP = collectStream(proc.stderr, opts.onStderrChunk);
      const exitCode = await proc.exited;
      const stdout = await stdoutP;
      const stderr = await stderrP;
      return {
        stdout,
        stderr,
        exitCode,
        timedOut,
        durationMs: performance.now() - t0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function collectStream(
  stream: ReadableStream<Uint8Array> | undefined,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  if (stream === undefined) return "";
  // When no streaming consumer is attached, take the fast path through
  // Response.text() which Bun has tuned for spawned-process pipes.
  if (onChunk === undefined) {
    return await new Response(stream).text();
  }
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let acc = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      acc += chunk;
      if (chunk.length > 0) onChunk(chunk);
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      acc += tail;
      onChunk(tail);
    }
  } finally {
    reader.releaseLock();
  }
  return acc;
}

export function createSandbox(opts: SandboxOptions = {}): Sandbox {
  const backend = opts.backend ?? readEnvBackend() ?? "docker";
  if (backend === "noop") return new NoopSandbox(opts);
  return new DockerLikeSandbox(backend, opts);
}

export const SANDBOX_DEFAULT_ALLOWED_IMAGES = DEFAULT_ALLOWED_IMAGES;
