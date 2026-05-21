/**
 * Section 29 — `grader-registry`. A global, pluggable registry of named
 * graders. `eval-runner` and `prompt-optimizer` look up custom graders by
 * name; built-in §16 graders auto-register at first access.
 *
 * Plugin discovery: `discoverPluginGraders(rootDir)` walks
 * `<rootDir>/<plugin-name>/index.{ts,js}` and dynamically imports each
 * file. The plugin module's default export must be a `{ name, grader }`
 * (or array thereof) — anything else throws.
 *
 * The discovery walker does NOT execute arbitrary code beyond the dynamic
 * import; runtime sandboxing of the imported plugins is §31's
 * `plugin-sdk` content-isolation responsibility. Until that lands, plugins
 * are trusted code on the host (consistent with §26's path-only sandbox).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type { Grader } from "@crewhaus/eval-grader";

export class GraderRegistryError extends CrewhausError {
  override readonly name = "GraderRegistryError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type RegisteredGrader = {
  readonly name: string;
  readonly grader: Grader;
};

export class GraderRegistry {
  private readonly graders = new Map<string, Grader>();

  register(name: string, grader: Grader): void {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
      throw new GraderRegistryError(`invalid grader name "${name}"`);
    }
    if (this.graders.has(name)) {
      throw new GraderRegistryError(`grader "${name}" already registered`);
    }
    this.graders.set(name, grader);
  }

  /** Replace an existing entry (tests + plugin reload). */
  upsert(name: string, grader: Grader): void {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
      throw new GraderRegistryError(`invalid grader name "${name}"`);
    }
    this.graders.set(name, grader);
  }

  lookup(name: string): Grader {
    const g = this.graders.get(name);
    if (!g) throw new GraderRegistryError(`no grader registered as "${name}"`);
    return g;
  }

  has(name: string): boolean {
    return this.graders.has(name);
  }

  list(): ReadonlyArray<string> {
    return [...this.graders.keys()].sort();
  }

  clear(): void {
    this.graders.clear();
  }
}

/**
 * Discover plugin graders under `<pluginRoot>/<plugin>/index.{ts,js}` and
 * register them with the supplied registry. Returns the names registered.
 */
export async function discoverPluginGraders(
  registry: GraderRegistry,
  pluginRoot: string,
): Promise<ReadonlyArray<string>> {
  if (!existsSync(pluginRoot)) return [];
  const registered: string[] = [];
  const entries = readdirSync(pluginRoot);
  for (const e of entries) {
    if (e.startsWith(".") || e.startsWith("_")) continue;
    const dir = join(pluginRoot, e);
    if (!statSync(dir).isDirectory()) continue;
    const candidates = ["index.ts", "index.js", "index.mjs"];
    let modulePath: string | undefined;
    for (const c of candidates) {
      const p = join(dir, c);
      if (existsSync(p)) {
        modulePath = p;
        break;
      }
    }
    if (!modulePath) continue;
    const mod = await import(modulePath);
    const def = mod.default;
    if (!def) {
      throw new GraderRegistryError(`plugin "${e}" missing default export at ${modulePath}`);
    }
    const items = Array.isArray(def) ? def : [def];
    for (const it of items) {
      if (
        !it ||
        typeof it !== "object" ||
        typeof it.name !== "string" ||
        typeof it.grader !== "function"
      ) {
        throw new GraderRegistryError(
          `plugin "${e}" default export must be { name, grader } or [{ name, grader }, ...]`,
        );
      }
      registry.upsert(it.name, it.grader);
      registered.push(it.name);
    }
  }
  return registered;
}
