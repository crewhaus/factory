import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Section 32 — `@crewhaus/docker-images`
 *
 * Per-target-shape Dockerfiles (one per target shape: cli, workflow, channel,
 * graph, managed, pipeline, crew, research, batch, voice, browser, eval) plus
 * a `buildImage()` wrapper around `docker buildx build` that the
 * `crewhaus build-image <target>` CLI subcommand (apps/cli/src/index.ts) calls.
 *
 * v0 ships:
 *   - 12 multi-stage Dockerfiles under `docker/<target>/Dockerfile`,
 *     each with non-root user, read-only root, HEALTHCHECK, and
 *     target-specific system deps baked in (chromium for browser,
 *     libopus for voice, curl+ca-certs for daemon shapes).
 *   - `buildImage()` shells to `docker buildx build` (gated on `docker
 *     version` succeeding); injectable `runner` for tests.
 *   - `loadDigests()` / `recordDigest()` over a `docker/digests.json`
 *     lockfile so reproducible builds work offline.
 *   - `resolveImageDigest()` + `buildImageAndRecord()` — item 47 closes the
 *     digests.json loop: PUSHED builds record their registry manifest digest
 *     (the only digest `docker pull repo@sha256:…` accepts), and the release
 *     workflow records the pushed ghcr.io digests for each v* tag. A local
 *     `--load` build records NOTHING — `docker image inspect`'s `.Id` is the
 *     image CONFIG digest, which no registry can serve, so writing it into
 *     the lockfile would hand users an unpullable pin.
 */
import { CrewhausError } from "@crewhaus/errors";

export class DockerImagesError extends CrewhausError {
  override readonly name = "DockerImagesError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * The 12 target shapes that ship a Dockerfile. Sourced from
 * `packages/spec/src/index.ts` discriminator literals; we keep the
 * canonical list locally because this package owns the "which shapes
 * have a deployable image" question.
 */
export const TARGET_SHAPES = [
  "cli",
  "workflow",
  "channel",
  "graph",
  "managed",
  "pipeline",
  "crew",
  "research",
  "batch",
  "voice",
  "browser",
  "eval",
] as const;

export type TargetShape = (typeof TARGET_SHAPES)[number];

export function isTargetShape(value: unknown): value is TargetShape {
  return typeof value === "string" && (TARGET_SHAPES as readonly string[]).includes(value);
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCKER_ROOT = join(PACKAGE_ROOT, "docker");
const DIGESTS_PATH = join(DOCKER_ROOT, "digests.json");

export function dockerRoot(): string {
  return DOCKER_ROOT;
}

export function digestsPath(): string {
  return DIGESTS_PATH;
}

export function dockerfilePath(target: TargetShape): string {
  return join(DOCKER_ROOT, target, "Dockerfile");
}

export function readDockerfile(target: TargetShape): string {
  const path = dockerfilePath(target);
  if (!existsSync(path)) {
    throw new DockerImagesError(`dockerfile missing for target ${target} (expected at ${path})`);
  }
  return readFileSync(path, "utf8");
}

export function dockerfileSize(target: TargetShape): number {
  return statSync(dockerfilePath(target)).size;
}

export function listAvailableTargets(): readonly TargetShape[] {
  return TARGET_SHAPES.filter((t) => existsSync(dockerfilePath(t)));
}

export type BuildRunner = (
  argv: readonly string[],
  cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type BuildImageOptions = {
  readonly target: TargetShape;
  readonly tag: string;
  /** Optional build context path; defaults to the workspace root. */
  readonly contextPath?: string;
  /** Optional buildx platform string, e.g. `linux/amd64,linux/arm64`. */
  readonly platform?: string;
  /** Whether to push to a registry after build. Defaults to false. */
  readonly push?: boolean;
  /** Test injection point — defaults to a node:child_process spawn of `docker`. */
  readonly runner?: BuildRunner;
};

export type BuildImageResult = {
  readonly tag: string;
  readonly target: TargetShape;
  readonly buildArgv: readonly string[];
};

export async function buildImage(opts: BuildImageOptions): Promise<BuildImageResult> {
  if (!isTargetShape(opts.target)) {
    throw new DockerImagesError(`unknown target shape: ${String(opts.target)}`);
  }
  if (!opts.tag || /[\s\n\r]/.test(opts.tag)) {
    throw new DockerImagesError(
      `invalid tag: ${JSON.stringify(opts.tag)} — must be non-empty and contain no whitespace`,
    );
  }
  const dockerfile = dockerfilePath(opts.target);
  if (!existsSync(dockerfile)) {
    throw new DockerImagesError(
      `dockerfile missing for target ${opts.target} (expected at ${dockerfile})`,
    );
  }
  const contextPath = opts.contextPath ?? resolve(PACKAGE_ROOT, "..", "..");
  const argv: string[] = [
    "docker",
    "buildx",
    "build",
    "--file",
    dockerfile,
    "--tag",
    `crewhaus/${opts.target}:${opts.tag}`,
  ];
  if (opts.platform) {
    argv.push("--platform", opts.platform);
  }
  argv.push(opts.push ? "--push" : "--load");
  argv.push(contextPath);

  const runner = opts.runner ?? defaultRunner;
  const { exitCode, stderr } = await runner(argv, contextPath);
  if (exitCode !== 0) {
    throw new DockerImagesError(
      `docker buildx build exited with code ${exitCode}: ${stderr.slice(0, 1024)}`,
    );
  }
  return { tag: opts.tag, target: opts.target, buildArgv: argv };
}

export const defaultRunner: BuildRunner = async (argv, cwd) => {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve_) => {
    const head = argv[0] ?? "docker";
    const child = spawn(head, argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", (e) =>
      resolve_({ exitCode: 1, stdout: "", stderr: String((e as Error).message) }),
    );
    child.on("close", (code) =>
      resolve_({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
};

// ─── digests lockfile ────────────────────────────────────────────────────────

export type DigestEntry = { readonly sha256: string; readonly builtAt: string };
export type DigestsFile = {
  _format_version: number;
  [target: string]: unknown;
};

export function loadDigests(path: string = DIGESTS_PATH): DigestsFile {
  if (!existsSync(path)) {
    return { _format_version: 1 };
  }
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as DigestsFile;
  } catch (cause) {
    throw new DockerImagesError(`failed to parse digests.json at ${path}`, cause);
  }
}

export function recordDigest(
  target: TargetShape,
  tag: string,
  sha256: string,
  path: string = DIGESTS_PATH,
): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(sha256)) {
    throw new DockerImagesError(`invalid sha256: ${sha256}`);
  }
  const current = loadDigests(path);
  const targetEntry = (current[target] as Record<string, DigestEntry> | undefined) ?? {};
  targetEntry[tag] = { sha256, builtAt: new Date().toISOString() };
  current[target] = targetEntry;
  current._format_version = 1;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o644 });
}

// ─── digest resolution + record-after-build (item 47) ────────────────────────

export type ResolveImageDigestOptions = {
  readonly target: TargetShape;
  readonly tag: string;
  /** Test injection point — defaults to the same spawn runner as buildImage. */
  readonly runner?: BuildRunner;
};

const SHA256_DIGEST_RE = /sha256:[0-9a-f]{64}/;

/**
 * Resolve a PUSHED image's registry manifest digest via `docker buildx
 * imagetools inspect`. Only the manifest digest is pullable
 * (`docker pull repo@sha256:…`); the local image store's `.Id` is the image
 * CONFIG digest, which registries do not serve — so there is deliberately no
 * local-inspect fallback here (a `--load` build has no recordable digest).
 */
export async function resolveImageDigest(opts: ResolveImageDigestOptions): Promise<string> {
  const ref = `crewhaus/${opts.target}:${opts.tag}`;
  const argv = ["docker", "buildx", "imagetools", "inspect", ref];
  const runner = opts.runner ?? defaultRunner;
  const { exitCode, stdout, stderr } = await runner(argv, process.cwd());
  if (exitCode !== 0) {
    throw new DockerImagesError(
      `could not inspect ${ref} for its digest (exit ${exitCode}): ${stderr.slice(0, 512)}`,
    );
  }
  const match = SHA256_DIGEST_RE.exec(stdout);
  if (match === null) {
    throw new DockerImagesError(`no sha256 digest in docker inspect output for ${ref}`);
  }
  return match[0];
}

export type BuildImageAndRecordOptions = BuildImageOptions & {
  /** Record the built image's digest into docker/digests.json. Default true. */
  readonly record?: boolean;
  /** Override the digests.json location (tests / CI checkouts). */
  readonly digestsFile?: string;
  /** Test injection point for the recording seam. Defaults to {@link recordDigest}. */
  readonly recordDigestFn?: typeof recordDigest;
};

export type BuildImageAndRecordResult = BuildImageResult & {
  /** Registry manifest digest of the pushed image; undefined when recording was skipped or failed. */
  readonly digest?: string;
  readonly recorded: boolean;
  /** Why the digest was not recorded (set only when recording was requested but failed). */
  readonly recordError?: string;
  /**
   * Set when recording was requested but is not applicable: a `--load` build
   * only produces a local image whose ID is a CONFIG digest, not a pullable
   * registry manifest digest, so nothing truthful can land in the lockfile.
   */
  readonly recordSkippedReason?: string;
};

/**
 * `buildImage()` + close the digests.json loop: after a successful PUSHED
 * build, resolve the image's registry manifest digest (`docker buildx
 * imagetools inspect`) and record it in the lockfile — the maintenance the
 * digests.json header always promised. `crewhaus build-image --push` calls
 * this (recording is default-on there; `--no-record` opts out). A local
 * `--load` build records NOTHING (see `recordSkippedReason`): its image ID is
 * a config digest that `docker pull repo@sha256:…` cannot resolve, and the
 * lockfile must only ever contain pullable pins. A digest-resolution/record
 * failure does NOT fail the build — the image exists; the caller decides how
 * loudly to surface the stale lockfile (the CLI prints a warning).
 */
export async function buildImageAndRecord(
  opts: BuildImageAndRecordOptions,
): Promise<BuildImageAndRecordResult> {
  const result = await buildImage(opts);
  if (opts.record === false) {
    return { ...result, recorded: false };
  }
  if (opts.push !== true) {
    return {
      ...result,
      recorded: false,
      recordSkippedReason:
        "local image ID is not a registry digest — use --push to record a pullable digest",
    };
  }
  const record = opts.recordDigestFn ?? recordDigest;
  try {
    const digest = await resolveImageDigest({
      target: opts.target,
      tag: opts.tag,
      runner: opts.runner,
    });
    record(opts.target, opts.tag, digest, opts.digestsFile);
    return { ...result, digest, recorded: true };
  } catch (err) {
    return { ...result, recorded: false, recordError: (err as Error).message };
  }
}

// ─── Dockerfile structural fingerprint (consumed by tests) ───────────────────

export type DockerfileFingerprint = {
  readonly stages: ReadonlyArray<{ readonly image: string; readonly stage?: string }>;
  readonly hasHealthcheck: boolean;
  readonly nonRootUser?: string;
  readonly workdir?: string;
  readonly entrypoint?: string;
  readonly cmd?: string;
  readonly exposedPorts: readonly number[];
  readonly envs: readonly string[];
};

export function fingerprintDockerfile(text: string): DockerfileFingerprint {
  const lines = text.split(/\r?\n/);
  const fromStages = lines
    .map((l) => /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(l.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ image: m[1] ?? "", stage: (m[2] ?? "").toLowerCase() || undefined }));
  const exposedPorts = lines
    .filter((l) => /^EXPOSE\s+\d+/i.test(l.trim()))
    .map((l) => Number(l.trim().split(/\s+/)[1]));
  return {
    stages: fromStages,
    hasHealthcheck: /^HEALTHCHECK\s+/im.test(text),
    nonRootUser: /^USER\s+(\S+)/im.exec(text)?.[1],
    workdir: /^WORKDIR\s+(\S+)/im.exec(text)?.[1],
    entrypoint: /^ENTRYPOINT\s+(.+)$/im.exec(text)?.[1]?.trim(),
    cmd: /^CMD\s+(.+)$/im.exec(text)?.[1]?.trim(),
    exposedPorts,
    envs: lines
      .filter((l) => /^ENV\s+/i.test(l.trim()))
      .flatMap((l) =>
        l
          .trim()
          .replace(/^ENV\s+/i, "")
          .split(/\s+/)
          .map((kv) => (kv.split("=")[0] ?? "").trim())
          .filter((k) => k.length > 0 && /^[A-Z_][A-Z0-9_]*$/.test(k)),
      ),
  };
}
