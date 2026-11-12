/**
 * Section 28 — `spec-registry`. Multi-version spec storage with
 * environment pinning + per-tenant overlays. File-backed by default;
 * the `RegistryAdapter` interface accepts SQLite/Postgres/S3 plugins
 * so production deployments can swap in their preferred storage.
 *
 * Layout (file-backed):
 *   <root>/
 *     <name>/
 *       v1.yaml
 *       v2.yaml
 *       manifest.json     ← `{ versions: ["v1", "v2"], pins: { prod: "v2", staging: "v1" } }`
 *     <other-name>/
 *       ...
 *     _tenants/<tenantId>/
 *       <name>.json       ← per-tenant pin overlay
 *
 * Operations:
 *   put(name, version, yaml)         write a version (replacing one of that name)
 *   putNew(name, version, yaml)      write a version that must not exist yet
 *   get(name, version)               read a specific version
 *   list(name)                       all versions for a spec
 *   pin(name, env, version)          attach an environment alias
 *   aliasFor(name, env)              resolve env → version
 *   pinForTenant(tenantId, name, env, version)
 *   aliasForTenant(tenantId, name, env)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { withFileLock } from "@crewhaus/infra-utils";
import { writeFileSafe } from "@crewhaus/tool-safety/fs";

export class SpecRegistryError extends CrewhausError {
  override readonly name = "SpecRegistryError";
  /**
   * Why the registry refused, when a caller can act on it. `exists`:
   * {@link RegistryAdapter.putNew} found the version already stored. (`code`
   * is the error family every `CrewhausError` carries.)
   */
  readonly failure: "exists" | undefined;
  constructor(message: string, cause?: unknown, failure?: "exists") {
    super("config", message, cause);
    this.failure = failure;
  }
}

/**
 * Version order: `v<digits>` versions first, by their number (`v2` before
 * `v10`), then every other version name lexicographically.
 */
export function compareVersions(a: string, b: string): number {
  const na = /^v(\d+)$/.exec(a);
  const nb = /^v(\d+)$/.exec(b);
  if (na !== null && nb !== null) {
    const x = BigInt(na[1] as string);
    const y = BigInt(nb[1] as string);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export type Manifest = {
  versions: string[];
  pins: Record<string, string>;
};

export interface RegistryAdapter {
  put(name: string, version: string, yaml: string): Promise<void>;
  /** Write a version that must not exist yet; an existing one is refused (`SpecRegistryError`, failure `exists`) and left as it is. */
  putNew(name: string, version: string, yaml: string): Promise<void>;
  get(name: string, version: string): Promise<string>;
  list(name: string): Promise<ReadonlyArray<string>>;
  listSpecs(): Promise<ReadonlyArray<string>>;
  delete(name: string, version: string): Promise<void>;

  pin(name: string, environment: string, version: string): Promise<void>;
  aliasFor(name: string, environment: string): Promise<string | undefined>;
  manifest(name: string): Promise<Manifest>;

  pinForTenant(tenantId: string, name: string, environment: string, version: string): Promise<void>;
  aliasForTenant(tenantId: string, name: string, environment: string): Promise<string | undefined>;
}

const MANIFEST_FILE = "manifest.json";
const NAME_REGEX = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const VERSION_REGEX = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const ENV_REGEX = /^[A-Za-z0-9_-]+$/;
const TENANT_REGEX = /^[A-Za-z0-9_-]+$/;

function ensureSafeName(s: string): void {
  if (!NAME_REGEX.test(s)) throw new SpecRegistryError(`invalid spec name "${s}"`);
}
function ensureSafeVersion(v: string): void {
  if (!VERSION_REGEX.test(v)) throw new SpecRegistryError(`invalid version "${v}"`);
}
function ensureSafeEnv(e: string): void {
  if (!ENV_REGEX.test(e)) throw new SpecRegistryError(`invalid environment "${e}"`);
}
function ensureSafeTenant(t: string): void {
  if (!TENANT_REGEX.test(t)) throw new SpecRegistryError(`invalid tenant id "${t}"`);
}

export type FileBackedRegistryOptions = {
  /** Default: `.crewhaus/specs`. */
  readonly rootDir: string;
  /** Test seam: runs after a manifest is read inside a read-modify-write. */
  readonly hooks?: { readonly afterManifestRead?: () => void };
};

export function createFileBackedRegistry(opts: FileBackedRegistryOptions): RegistryAdapter {
  const rootDir = opts.rootDir;

  function specDir(name: string): string {
    ensureSafeName(name);
    return join(rootDir, name);
  }
  function specVersionPath(name: string, version: string): string {
    ensureSafeVersion(version);
    return join(specDir(name), `${version}.yaml`);
  }
  function manifestPath(name: string): string {
    return join(specDir(name), MANIFEST_FILE);
  }
  function tenantDir(tenantId: string): string {
    ensureSafeTenant(tenantId);
    return join(rootDir, "_tenants", tenantId);
  }
  function tenantPinPath(tenantId: string, name: string): string {
    return join(tenantDir(tenantId), `${name}.json`);
  }

  function loadManifest(name: string): Manifest {
    const p = manifestPath(name);
    if (!existsSync(p)) return { versions: [], pins: {} };
    return JSON.parse(readFileSync(p, "utf8")) as Manifest;
  }
  function saveManifest(name: string, m: Manifest): void {
    const p = manifestPath(name);
    mkdirSync(specDir(name), { recursive: true });
    writeFileSync(p, JSON.stringify(m, null, 2), { mode: 0o600 });
  }
  /** Read, change and save one spec's manifest under its lock, so concurrent writers never lose each other's change. */
  async function updateManifest<T>(name: string, change: (m: Manifest) => T): Promise<T> {
    mkdirSync(specDir(name), { recursive: true });
    return await withFileLock(
      join(specDir(name), "manifest.lock"),
      async () => {
        const m = loadManifest(name);
        opts.hooks?.afterManifestRead?.();
        const out = change(m);
        saveManifest(name, m);
        return out;
      },
      { label: "spec-registry", waitMs: 10_000 },
    );
  }

  return {
    async put(name, version, yaml): Promise<void> {
      mkdirSync(specDir(name), { recursive: true });
      const p = specVersionPath(name, version);
      writeFileSync(p, yaml, { mode: 0o600 });
      await updateManifest(name, (m) => {
        if (!m.versions.includes(version)) m.versions.push(version);
      });
    },
    async putNew(name, version, yaml): Promise<void> {
      mkdirSync(specDir(name), { recursive: true });
      ensureSafeVersion(version);
      const written = writeFileSafe(specDir(name), `${version}.yaml`, yaml, {
        overwrite: false,
        mode: 0o600,
      });
      if (!written.ok) {
        throw written.code === "exists"
          ? new SpecRegistryError(
              `spec "${name}" version "${version}" already exists; it was not replaced`,
              undefined,
              "exists",
            )
          : new SpecRegistryError(
              `spec "${name}" version "${version}" could not be written: ${written.reason}`,
            );
      }
      await updateManifest(name, (m) => {
        if (!m.versions.includes(version)) m.versions.push(version);
      });
    },
    async get(name, version): Promise<string> {
      const p = specVersionPath(name, version);
      if (!existsSync(p)) {
        throw new SpecRegistryError(`spec "${name}" version "${version}" not found at ${p}`);
      }
      return readFileSync(p, "utf8");
    },
    async list(name): Promise<ReadonlyArray<string>> {
      const m = loadManifest(name);
      return [...m.versions].sort(compareVersions);
    },
    async listSpecs(): Promise<ReadonlyArray<string>> {
      if (!existsSync(rootDir)) return [];
      return readdirSync(rootDir).filter(
        (d) => d !== "_tenants" && !d.startsWith("_") && !d.startsWith("."),
      );
    },
    async delete(name, version): Promise<void> {
      const p = specVersionPath(name, version);
      if (existsSync(p)) rmSync(p);
      await updateManifest(name, (m) => {
        m.versions = m.versions.filter((v) => v !== version);
        // Remove any pin pointing at the deleted version.
        for (const [env, v] of Object.entries(m.pins)) {
          if (v === version) delete m.pins[env];
        }
      });
    },
    async pin(name, environment, version): Promise<void> {
      ensureSafeEnv(environment);
      await updateManifest(name, (m) => {
        if (!m.versions.includes(version)) {
          throw new SpecRegistryError(
            `cannot pin "${name}" "${environment}" → "${version}": version not in registry`,
          );
        }
        m.pins[environment] = version;
      });
    },
    async aliasFor(name, environment): Promise<string | undefined> {
      ensureSafeEnv(environment);
      const m = loadManifest(name);
      return m.pins[environment];
    },
    async manifest(name): Promise<Manifest> {
      return loadManifest(name);
    },
    async pinForTenant(tenantId, name, environment, version): Promise<void> {
      ensureSafeTenant(tenantId);
      ensureSafeName(name);
      ensureSafeEnv(environment);
      // Verify the version exists in the global registry first.
      const m = loadManifest(name);
      if (!m.versions.includes(version)) {
        throw new SpecRegistryError(
          `cannot pin tenant "${tenantId}" "${name}" "${environment}" → "${version}": version not in registry`,
        );
      }
      mkdirSync(tenantDir(tenantId), { recursive: true });
      const path = tenantPinPath(tenantId, name);
      let overlay: Record<string, string> = {};
      if (existsSync(path)) overlay = JSON.parse(readFileSync(path, "utf8"));
      overlay[environment] = version;
      writeFileSync(path, JSON.stringify(overlay, null, 2), { mode: 0o600 });
    },
    async aliasForTenant(tenantId, name, environment): Promise<string | undefined> {
      ensureSafeTenant(tenantId);
      ensureSafeEnv(environment);
      const path = tenantPinPath(tenantId, name);
      if (existsSync(path)) {
        const overlay = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
        if (overlay[environment]) return overlay[environment];
      }
      // Fall through to global pin.
      const m = loadManifest(name);
      return m.pins[environment];
    },
  };
}
