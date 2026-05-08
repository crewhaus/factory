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
 *   put(name, version, yaml)         write a new version
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

export class SpecRegistryError extends CrewhausError {
  override readonly name = "SpecRegistryError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type Manifest = {
  versions: string[];
  pins: Record<string, string>;
};

export interface RegistryAdapter {
  put(name: string, version: string, yaml: string): Promise<void>;
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

  return {
    async put(name, version, yaml): Promise<void> {
      mkdirSync(specDir(name), { recursive: true });
      const p = specVersionPath(name, version);
      writeFileSync(p, yaml, { mode: 0o600 });
      const m = loadManifest(name);
      if (!m.versions.includes(version)) m.versions.push(version);
      saveManifest(name, m);
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
      return [...m.versions].sort();
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
      const m = loadManifest(name);
      m.versions = m.versions.filter((v) => v !== version);
      // Remove any pin pointing at the deleted version.
      for (const [env, v] of Object.entries(m.pins)) {
        if (v === version) delete m.pins[env];
      }
      saveManifest(name, m);
    },
    async pin(name, environment, version): Promise<void> {
      ensureSafeEnv(environment);
      const m = loadManifest(name);
      if (!m.versions.includes(version)) {
        throw new SpecRegistryError(
          `cannot pin "${name}" "${environment}" → "${version}": version not in registry`,
        );
      }
      m.pins[environment] = version;
      saveManifest(name, m);
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
