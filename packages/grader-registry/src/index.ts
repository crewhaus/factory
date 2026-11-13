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
import type { Grader, GraderKind } from "@crewhaus/eval-grader";

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

/**
 * What a registered grader declares about itself.
 *
 * - `kind` — how its verdict is reached (`deterministic`, `model`, `proof`,
 *   `human`, `custom`). Absent reads as `custom`.
 * - `regradable` — it reads nothing but the sample, the agent's output, the
 *   transcript, the trace events and the proof bundle, so a recorded run can
 *   be graded with it again. Absent reads as false.
 */
export type GraderMeta = {
  readonly kind?: GraderKind;
  readonly regradable?: boolean;
};

/** The kinds a `.crewhaus/graders` plugin may declare: every kind but `proof`. */
export const PLUGIN_GRADER_KINDS: ReadonlyArray<GraderKind> = Object.freeze([
  "deterministic",
  "model",
  "human",
  "custom",
]);

export class GraderRegistry {
  private readonly graders: Map<string, Grader>;
  private readonly meta = new Map<string, GraderMeta>();

  constructor() {
    this.graders = new Map<string, Grader>();
  }

  register(name: string, grader: Grader, meta?: GraderMeta): void {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
      throw new GraderRegistryError(`invalid grader name "${name}"`);
    }
    if (this.graders.has(name)) {
      throw new GraderRegistryError(`grader "${name}" already registered`);
    }
    this.graders.set(name, grader);
    this.meta.set(name, { ...(meta ?? {}) });
  }

  /**
   * Replace an existing entry (tests + plugin reload). The entry's metadata is
   * replaced too: what the replaced grader declared says nothing about this one.
   */
  upsert(name: string, grader: Grader, meta?: GraderMeta): void {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
      throw new GraderRegistryError(`invalid grader name "${name}"`);
    }
    this.graders.set(name, grader);
    this.meta.set(name, { ...(meta ?? {}) });
  }

  /** What a registered grader declared about itself; `undefined` for an unknown name. */
  metaOf(name: string): GraderMeta | undefined {
    if (!this.graders.has(name)) return undefined;
    return this.meta.get(name) ?? {};
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
    this.meta.clear();
  }
}

/**
 * Discover plugin graders under `<pluginRoot>/<plugin>/index.{ts,js}` and
 * register them with the supplied registry. Returns the names registered.
 * `onModule` hears each registered name with the entry file it came from.
 *
 * A plugin may declare its `kind` (any of {@link PLUGIN_GRADER_KINDS}; never
 * `proof`, which only a built-in proof checker carries). Without one it reads
 * `custom`, and a plugin is never regradable, also when it takes over a
 * built-in name.
 */
export async function discoverPluginGraders(
  registry: GraderRegistry,
  pluginRoot: string,
  onModule?: (name: string, modulePath: string) => void,
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
      const kind: unknown = (it as { kind?: unknown }).kind;
      if (kind === "proof") {
        throw new GraderRegistryError(
          `plugin "${e}" grader "${it.name}" declares kind "proof" — only a built-in proof checker carries that kind; declare deterministic, model, human or custom`,
        );
      }
      if (kind !== undefined && !(PLUGIN_GRADER_KINDS as ReadonlyArray<unknown>).includes(kind)) {
        throw new GraderRegistryError(
          `plugin "${e}" grader "${it.name}" declares kind ${JSON.stringify(kind)} — one of ${PLUGIN_GRADER_KINDS.join(", ")}`,
        );
      }
      registry.upsert(it.name, it.grader, { kind: (kind as GraderKind | undefined) ?? "custom" });
      registered.push(it.name);
      onModule?.(it.name, modulePath);
    }
  }
  return registered;
}
