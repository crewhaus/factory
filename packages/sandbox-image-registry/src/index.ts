import { CrewhausError } from "@crewhaus/errors";
import { SANDBOX_DEFAULT_ALLOWED_IMAGES } from "@crewhaus/sandbox";

/**
 * Catalog R8 `sandbox-image-registry` — runtime allow-list registry.
 *
 * Section 36 prereq for the polyglot sandbox images. Replaces the
 * hardcoded `CREWHAUS_SANDBOX_ALLOWED_IMAGES` env var with a runtime
 * registry pattern: callers `registerSandboxImage({ id, image,
 * healthcheck, defaultEntrypoint })` and the rest of the system reads
 * via `lookupSandboxImage(id)` / `listSandboxImages()`.
 *
 * The §18 trio (python / node / alpine) auto-registers at first
 * registry access for backwards compat — existing callers that depend
 * on `python:3.13-slim` etc. continue to work without code changes.
 *
 * The healthcheck contract is `{ command: string[], expectedExitCode,
 * timeoutMs }`. Sandbox boot waits for a healthcheck pass before
 * allowing the first `exec()`. Runtimes that don't run healthchecks
 * (the `noop` backend or pure unit tests) can call `markHealthy(id)`
 * to bypass.
 *
 * SECURITY: registration validates the same image-string grammar that
 * `@crewhaus/sandbox` uses (no leading dash for CLI flag injection,
 * no whitespace for newline injection, registry-reference shape).
 * Re-registering an id is rejected — `ImageRegistrationError`. The
 * registry is module-level singleton state; tests use `_resetSandboxImageRegistry()`.
 *
 * Layer R8.
 */

export type SandboxImageHealthcheck = {
  /** Argv passed to the container; e.g. ["go", "version"]. */
  readonly command: ReadonlyArray<string>;
  /** Expected exit code (typically 0). */
  readonly expectedExitCode: number;
  /** Per-call timeout. Defaults to 5_000 if omitted by callers. */
  readonly timeoutMs?: number;
};

export type SandboxImageEntry = {
  /** Stable opaque id used at lookup, e.g. "go", "python". */
  readonly id: string;
  /** Container image reference, e.g. "golang:1.23-alpine". */
  readonly image: string;
  /** Healthcheck contract; runs before the first exec(). */
  readonly healthcheck: SandboxImageHealthcheck;
  /** Default entrypoint argv for snippet-mode callers, e.g. ["go", "run", "-"]. */
  readonly defaultEntrypoint: ReadonlyArray<string>;
  /** Optional human-readable description shown by `crewhaus sandbox doctor`. */
  readonly description?: string;
};

export type SandboxImageRegistration = {
  readonly id: string;
  readonly image: string;
  readonly healthcheck: SandboxImageHealthcheck;
  readonly defaultEntrypoint: ReadonlyArray<string>;
  readonly description?: string;
};

export type SandboxImageStatus = {
  readonly id: string;
  readonly image: string;
  readonly healthy: boolean;
  /** ISO timestamp of last successful healthcheck, or null. */
  readonly lastHealthyAt: string | null;
  /** Last failure detail (image pull failure, exec fail, etc.). */
  readonly lastError: string | null;
};

export class ImageRegistrationError extends CrewhausError {
  override readonly name = "ImageRegistrationError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export class ImageNotFoundError extends CrewhausError {
  override readonly name = "ImageNotFoundError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/]*(?::[a-zA-Z0-9._\-]+)?(?:@sha256:[a-f0-9]{64})?$/;
const ID_RE = /^[a-z][a-z0-9_-]*$/;

type RegistryRecord = {
  entry: SandboxImageEntry;
  healthy: boolean;
  lastHealthyAt: number | null;
  lastError: string | null;
};

const registry: Map<string, RegistryRecord> = new Map();
let bootstrapped = false;

function validateImage(image: string): void {
  if (image.length === 0) throw new ImageRegistrationError("image is required");
  if (image.startsWith("-")) {
    throw new ImageRegistrationError(`image "${image}" looks like a CLI flag — refused`);
  }
  if (image.includes("\n") || /\s/.test(image)) {
    throw new ImageRegistrationError(`image "${image}" contains whitespace — refused`);
  }
  if (!IMAGE_RE.test(image)) {
    throw new ImageRegistrationError(`image "${image}" is not a valid registry reference`);
  }
}

function validateId(id: string): void {
  if (id.length === 0) throw new ImageRegistrationError("id is required");
  if (!ID_RE.test(id)) {
    throw new ImageRegistrationError(
      `id "${id}" must match /^[a-z][a-z0-9_-]*$/ (lowercase, no spaces)`,
    );
  }
}

function validateHealthcheck(hc: SandboxImageHealthcheck): void {
  if (!Array.isArray(hc.command) || hc.command.length === 0) {
    throw new ImageRegistrationError("healthcheck.command must be a non-empty argv array");
  }
  for (const arg of hc.command) {
    if (typeof arg !== "string") {
      throw new ImageRegistrationError("healthcheck.command argv entries must be strings");
    }
    if (arg.includes("\n")) {
      throw new ImageRegistrationError("healthcheck.command argv entries may not contain newlines");
    }
  }
  if (!Number.isInteger(hc.expectedExitCode)) {
    throw new ImageRegistrationError("healthcheck.expectedExitCode must be an integer");
  }
  if (hc.timeoutMs !== undefined) {
    if (!Number.isFinite(hc.timeoutMs) || hc.timeoutMs <= 0) {
      throw new ImageRegistrationError("healthcheck.timeoutMs must be a positive number");
    }
  }
}

function validateEntrypoint(argv: ReadonlyArray<string>): void {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new ImageRegistrationError("defaultEntrypoint must be a non-empty argv array");
  }
  for (const arg of argv) {
    if (typeof arg !== "string") {
      throw new ImageRegistrationError("defaultEntrypoint argv entries must be strings");
    }
    if (arg.includes("\n")) {
      throw new ImageRegistrationError("defaultEntrypoint argv entries may not contain newlines");
    }
  }
}

function bootstrapDefaults(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  // Register the §18 trio so the existing tool-code-execution paths
  // continue to work unchanged. We swallow duplicate-registration
  // errors so deliberate test resets don't cascade.
  const trio: ReadonlyArray<SandboxImageRegistration> = [
    {
      id: "python",
      image: "python:3.13-slim",
      defaultEntrypoint: ["python3", "-c"],
      healthcheck: {
        command: ["python3", "-c", "print('ok')"],
        expectedExitCode: 0,
        timeoutMs: 4_000,
      },
      description: "Python 3.13 slim — §18 default for the Python tool.",
    },
    {
      id: "javascript",
      image: "node:22-alpine",
      defaultEntrypoint: ["node", "-e"],
      healthcheck: {
        command: ["node", "-e", "console.log('ok')"],
        expectedExitCode: 0,
        timeoutMs: 4_000,
      },
      description: "Node 22 alpine — §18 default for the JavaScript tool.",
    },
    {
      id: "shell",
      image: "alpine:3.19",
      defaultEntrypoint: ["sh", "-c"],
      healthcheck: {
        command: ["sh", "-c", "echo ok"],
        expectedExitCode: 0,
        timeoutMs: 500,
      },
      description: "Alpine 3.19 — §18 default for the Shell tool.",
    },
  ];
  for (const reg of trio) {
    if (!registry.has(reg.id)) registerInternal(reg, { allowOverride: false });
  }
}

function registerInternal(
  reg: SandboxImageRegistration,
  opts: { allowOverride: boolean },
): SandboxImageEntry {
  validateId(reg.id);
  validateImage(reg.image);
  validateHealthcheck(reg.healthcheck);
  validateEntrypoint(reg.defaultEntrypoint);
  if (registry.has(reg.id) && !opts.allowOverride) {
    throw new ImageRegistrationError(
      `sandbox image id "${reg.id}" is already registered — call _resetSandboxImageRegistry() in tests or pick a different id`,
    );
  }
  const entry: SandboxImageEntry = {
    id: reg.id,
    image: reg.image,
    healthcheck: {
      command: [...reg.healthcheck.command],
      expectedExitCode: reg.healthcheck.expectedExitCode,
      ...(reg.healthcheck.timeoutMs !== undefined ? { timeoutMs: reg.healthcheck.timeoutMs } : {}),
    },
    defaultEntrypoint: [...reg.defaultEntrypoint],
    ...(reg.description !== undefined ? { description: reg.description } : {}),
  };
  registry.set(reg.id, {
    entry,
    healthy: false,
    lastHealthyAt: null,
    lastError: null,
  });
  return entry;
}

/**
 * Register a sandbox image. Throws `ImageRegistrationError` if the id
 * is already registered or if any field violates the validation rules.
 */
export function registerSandboxImage(reg: SandboxImageRegistration): SandboxImageEntry {
  bootstrapDefaults();
  return registerInternal(reg, { allowOverride: false });
}

/**
 * Look up a registered image by id. Throws `ImageNotFoundError` if the
 * id is not in the registry.
 */
export function lookupSandboxImage(id: string): SandboxImageEntry {
  bootstrapDefaults();
  const rec = registry.get(id);
  if (rec === undefined) {
    const known = [...registry.keys()].sort().join(", ") || "(empty)";
    throw new ImageNotFoundError(`sandbox image "${id}" is not registered — known: ${known}`);
  }
  return rec.entry;
}

/** Returns true if the image is registered. */
export function hasSandboxImage(id: string): boolean {
  bootstrapDefaults();
  return registry.has(id);
}

/** List all registered images, sorted by id. */
export function listSandboxImages(): ReadonlyArray<SandboxImageEntry> {
  bootstrapDefaults();
  return [...registry.values()].map((r) => r.entry).sort((a, b) => a.id.localeCompare(b.id));
}

/** List images flattened to their image-reference strings (for sandbox `allowedImages`). */
export function listAllowedImageRefs(): ReadonlyArray<string> {
  return listSandboxImages().map((e) => e.image);
}

/**
 * Mark an image healthy without invoking docker. Used by the noop
 * backend, smoke tests, and `crewhaus sandbox doctor` after a
 * successful out-of-band probe.
 */
export function markHealthy(id: string, when: number = Date.now()): void {
  bootstrapDefaults();
  const rec = registry.get(id);
  if (rec === undefined) {
    throw new ImageNotFoundError(`sandbox image "${id}" is not registered`);
  }
  rec.healthy = true;
  rec.lastHealthyAt = when;
  rec.lastError = null;
}

/** Mark an image unhealthy with a human-readable error. */
export function markUnhealthy(id: string, error: string): void {
  bootstrapDefaults();
  const rec = registry.get(id);
  if (rec === undefined) {
    throw new ImageNotFoundError(`sandbox image "${id}" is not registered`);
  }
  rec.healthy = false;
  rec.lastError = error;
}

/** Snapshot of every registered image's healthcheck status. */
export function snapshotImageStatuses(): ReadonlyArray<SandboxImageStatus> {
  bootstrapDefaults();
  return [...registry.values()]
    .map((rec) => ({
      id: rec.entry.id,
      image: rec.entry.image,
      healthy: rec.healthy,
      lastHealthyAt: rec.lastHealthyAt === null ? null : new Date(rec.lastHealthyAt).toISOString(),
      lastError: rec.lastError,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Probe runner: execs each registered image's healthcheck via the
 * caller-supplied probe function and updates internal status. The
 * probe function abstracts docker/podman/noop so this package never
 * spawns processes itself — keeping the registry pure.
 */
export async function runHealthchecks(
  probe: (entry: SandboxImageEntry) => Promise<{ exitCode: number; stderr: string }>,
): Promise<ReadonlyArray<SandboxImageStatus>> {
  bootstrapDefaults();
  for (const rec of registry.values()) {
    try {
      const result = await probe(rec.entry);
      if (result.exitCode === rec.entry.healthcheck.expectedExitCode) {
        rec.healthy = true;
        rec.lastHealthyAt = Date.now();
        rec.lastError = null;
      } else {
        rec.healthy = false;
        rec.lastError = `healthcheck exit ${result.exitCode}: ${result.stderr.trim().slice(0, 200)}`;
      }
    } catch (err) {
      rec.healthy = false;
      rec.lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return snapshotImageStatuses();
}

/**
 * Test-only — clears the registry. Bootstrapped defaults will be
 * re-registered on the next public-API call.
 */
export function _resetSandboxImageRegistry(): void {
  registry.clear();
  bootstrapped = false;
}

/** Re-export for callers configuring a sandbox from registry contents. */
export { SANDBOX_DEFAULT_ALLOWED_IMAGES };
