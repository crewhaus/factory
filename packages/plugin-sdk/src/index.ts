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
  // Pane id uniqueness within the plugin
  const ids = new Set<string>();
  for (const p of def.panes ?? []) {
    if (ids.has(p.id)) {
      throw new PluginSdkError(`definePlugin "${def.name}": duplicate pane id "${p.id}"`);
    }
    ids.add(p.id);
  }
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
