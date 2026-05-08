/**
 * Catalog F5 `plugin-sdk` — Section 26 Studio.
 *
 * Typed surface for third-party studio plugins. A plugin is a single
 * TS module exporting `definePlugin({...})`; the studio-server
 * lazy-loads them from `~/.crewhaus/plugins/<name>/index.ts` at boot
 * (or on hot-reload).
 *
 * v0 hooks:
 *   - `onSpecLoad(spec)`           — observer; can return a side-pane
 *                                    contribution to inject into the UI
 *   - `onTraceEvent(event)`        — observer; called for every event
 *                                    streamed over SSE
 *   - `onEvalSampleRendered(sample)` — observer; called when an eval
 *                                    sample is being prepared for the
 *                                    UI panel
 *
 * v0 contributions: a plugin can declare `panes` — UI tabs the studio-
 * ui adds to its sidebar — defined as `{ id, title, html }`. The HTML
 * is rendered as innerHTML inside an iframe-shaped container; v0 ships
 * a path-based sandbox (file-system reads outside `~/.crewhaus/plugins/
 * <self>/` are rejected at load-time via `loadPlugin`'s allowlist) but
 * NOT script isolation (deferred — proper isolation requires a worker
 * or QuickJS sandbox).
 */
import { CrewhausError } from "@crewhaus/errors";

export class PluginSdkError extends CrewhausError {
  override readonly name = "PluginSdkError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type StudioPluginPane = {
  readonly id: string;
  readonly title: string;
  /**
   * Static HTML the studio-ui injects into the pane's container. Plugins
   * that want dynamic behaviour can include a <script> tag — but see the
   * sandbox notes above.
   */
  readonly html: string;
};

export type StudioPluginHooks = {
  /** Called when the studio loads a spec for editing/inspection. */
  onSpecLoad?(spec: { name: string; target: string; raw: string }): void;
  /** Called for every TraceEvent streamed over SSE for a live run. */
  onTraceEvent?(event: { kind: string; [k: string]: unknown }): void;
  /** Called when an eval sample is being prepared for the UI panel. */
  onEvalSampleRendered?(sample: { id: string; passed: boolean; [k: string]: unknown }): void;
};

/**
 * Section 31 — declared permissions schema. Plugins state up-front
 * exactly which filesystem paths they need to read (relative to their
 * sandbox root) and which network origins they can fetch. Runtime
 * enforces the allow-list — any I/O outside the declared scope is
 * blocked by the sandbox.
 *
 * Format:
 *   fs: ["read:~/.crewhaus/plugins/<self>/data/**", "read:./fixtures/**"]
 *   net: ["fetch:https://api.example.com/**", "fetch:https://*.example.com/**"]
 *
 * Patterns are minimatch-style globs against either filesystem paths
 * (relative to the plugin's sandbox root) or URL prefixes. The runtime
 * evaluator (`isFsAllowed` / `isNetAllowed`) is pure-string and
 * deterministic so callers can audit exactly what each plugin can do
 * before instantiating its sandbox.
 */
export type PluginPermissions = {
  readonly fs?: ReadonlyArray<string>;
  readonly net?: ReadonlyArray<string>;
};

export type StudioPluginDefinition = {
  readonly name: string;
  /** Semver-shaped version string. Studio renders this in the plugins panel. */
  readonly version: string;
  readonly hooks?: StudioPluginHooks;
  readonly panes?: ReadonlyArray<StudioPluginPane>;
  /**
   * Optional one-line description shown in the plugins panel.
   */
  readonly description?: string;
  /**
   * Section 31 — declared permissions allow-list. Optional; absent
   * means "no fs / no net access" (fail-closed).
   */
  readonly permissions?: PluginPermissions;
};

/**
 * Type-only helper. Plugins call:
 *   export default definePlugin({ name, version, hooks, panes });
 */
export function definePlugin(def: StudioPluginDefinition): StudioPluginDefinition {
  if (typeof def.name !== "string" || def.name.length === 0) {
    throw new PluginSdkError("definePlugin: `name` is required");
  }
  if (typeof def.version !== "string" || def.version.length === 0) {
    throw new PluginSdkError("definePlugin: `version` is required");
  }
  const ids = new Set<string>();
  for (const p of def.panes ?? []) {
    if (ids.has(p.id)) {
      throw new PluginSdkError(`definePlugin "${def.name}": duplicate pane id "${p.id}"`);
    }
    ids.add(p.id);
  }
  // Section 31 — validate the declared permissions schema.
  validatePermissions(def.permissions);
  return Object.freeze({ ...def });
}

/**
 * Path-sandbox guard: a plugin loader is given a root directory
 * (`~/.crewhaus/plugins/<self>/`) and must resolve all imports inside
 * that root. This helper is exposed so the loader can reject a plugin
 * whose `definePlugin({...})` body smuggles file-path strings outside
 * the sandbox boundary (e.g. an exfil attempt via a pane's html).
 *
 * v0 only checks the plugin's declared `panes[].html` for `file://`
 * URLs that escape the sandbox; full content-sandbox isolation lands
 * in a follow-up.
 */
export function assertPluginPathsStaySandboxed(
  plugin: StudioPluginDefinition,
  sandboxRoot: string,
): void {
  const root = sandboxRoot.endsWith("/") ? sandboxRoot.slice(0, -1) : sandboxRoot;
  for (const pane of plugin.panes ?? []) {
    const fileUrls = pane.html.match(/file:\/\/\S+/g) ?? [];
    for (const u of fileUrls) {
      const path = u.replace(/^file:\/\//, "");
      if (!path.startsWith(root)) {
        throw new PluginSdkError(
          `plugin "${plugin.name}" pane "${pane.id}" references file:// path outside its sandbox root: ${path}`,
        );
      }
    }
  }
}

/**
 * Section 31 — content-sandbox runtime checks. The two helpers below
 * accept a plugin's declared permissions and return whether a given
 * fs path / network URL is permitted. The runtime caller wires this
 * into the actual sandbox boundary (Web Worker postMessage gate for UI
 * plugins, VM2-style realm for server plugins) so attempts to read
 * `/etc/passwd` or fetch `https://exfil.example.com/...` are blocked
 * at the sandbox edge.
 *
 * Pattern matching:
 *  - `read:<path-glob>` — matches absolute or sandbox-relative paths.
 *    Globs use `**` for recursive and `*` for single-segment.
 *  - `fetch:<url-glob>` — matches request URLs by prefix + glob.
 *
 * Empty / undefined permissions = fail-closed (deny all).
 */
export function isFsAllowed(perms: PluginPermissions | undefined, path: string): boolean {
  if (!perms?.fs) return false;
  const patterns = perms.fs
    .filter((p) => p.startsWith("read:"))
    .map((p) => p.slice("read:".length));
  return patterns.some((pat) => globMatch(pat, path));
}

export function isNetAllowed(perms: PluginPermissions | undefined, url: string): boolean {
  if (!perms?.net) return false;
  const patterns = perms.net
    .filter((p) => p.startsWith("fetch:"))
    .map((p) => p.slice("fetch:".length));
  return patterns.some((pat) => globMatch(pat, url));
}

/**
 * Tiny minimatch shim — supports `**` (recursive), `*` (segment), and
 * literal-character matching. Sufficient for the plugin-permission
 * use case; for a more sophisticated patterning need we'd swap in
 * minimatch proper.
 */
function globMatch(pattern: string, value: string): boolean {
  // Convert glob to a regex anchored at start + end.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // ** must come BEFORE * — otherwise "*" replaces inside "**" first.
    .replace(/\*\*/g, "__GLOB_DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__GLOB_DOUBLE_STAR__/g, ".*");
  const re = new RegExp(`^${escaped}$`);
  return re.test(value);
}

/**
 * Section 31 — assert a plugin's declared permissions match the
 * actually-needed scope. Used at plugin-load time so a plugin that
 * declares overly broad permissions fails to load.
 *
 * v0 just runs structural validation (fs entries start with `read:`,
 * net entries start with `fetch:`); a follow-up adds policy-engine
 * integration so admins can refuse plugins whose declared net allow-
 * list includes broad wildcards.
 */
export function validatePermissions(perms: PluginPermissions | undefined): void {
  if (!perms) return;
  for (const f of perms.fs ?? []) {
    if (!f.startsWith("read:")) {
      throw new PluginSdkError(`fs permission "${f}" must start with "read:"`);
    }
  }
  for (const n of perms.net ?? []) {
    if (!n.startsWith("fetch:")) {
      throw new PluginSdkError(`net permission "${n}" must start with "fetch:"`);
    }
  }
}
