/**
 * HM-179 — the plugin SDK's MINIMAL honest wiring.
 *
 * Two extension points are wired, and exactly two:
 *
 *   - **`onTraceEvent`** — an observer on the run feed. A plugin declaring
 *     it is offered the scrubbed TraceEvents the console already streams,
 *     for the harnesses its `permissions.fs` allow-list actually covers.
 *   - **`panes`** — per-harness tabs, rendered inside an iframe with an
 *     opaque origin and a Content-Security-Policy computed from the
 *     plugin's `permissions.net` allow-list.
 *
 * `onSpecLoad` and `onEvalSampleRendered` are DEFERRED, and this module says
 * so in its payload rather than in a changelog: a plugin declaring one gets
 * a row in the console reading "declared, not wired — deferred past 0.5.0",
 * with the reason. Half-wiring an extension point twice is the outcome this
 * item exists to avoid; a point that is not wired must be visibly not wired.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DO: EXECUTE PLUGIN CODE
 * ---------------------------------------------------------------------------
 * The manager holds every harness's `.env` chain in memory and can start
 * processes; `import()`-ing a third-party module into it would hand that
 * capability to whatever is in `~/.crewhaus/plugins`, and no permission
 * table checked afterwards can take it back. So the wiring here is
 * DECLARATIVE on the server — it reads manifests, evaluates permissions and
 * serves pane documents — and the plugin's own code runs only where it is
 * contained: inside the sandboxed iframe, in the browser, with no
 * same-origin access to the console and no network beyond its allow-list.
 * `plugin-loader`'s `activatePlugins` (which does import) stays where it is,
 * in the runtime that compiles bundles.
 *
 * Permissions are evaluated with `@crewhaus/plugin-loader`'s OWN
 * `isFsAllowed`/`isNetAllowed` — fail-closed by construction (an undefined
 * section means zero access) — rather than a second implementation that
 * could drift from them.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isFsAllowed, isNetAllowed } from "@crewhaus/plugin-loader";
import type { PluginManifest, PluginPermissions } from "@crewhaus/plugin-sdk";
import { SAFE_SEGMENT_RE } from "./constants";
import { resolveInside } from "./safety";

/** The extension points this build actually honours. */
export const WIRED_EXTENSION_POINTS = ["onTraceEvent", "panes"] as const;
export type WiredExtensionPoint = (typeof WIRED_EXTENSION_POINTS)[number];

/** Declared-but-deferred points, each with the reason it is not wired. */
export const DEFERRED_EXTENSION_POINTS: Readonly<Record<string, string>> = {
  onSpecLoad:
    "deferred past 0.5.0 — a spec hook runs before the spec is trusted, so it needs the trust-tier work the spec editor introduced, not a callback slot",
  onEvalSampleRendered:
    "deferred past 0.5.0 — eval samples carry model output and tool results, so a render hook needs the boundary classification Ask-Hangar is gated on",
};

export type PluginPaneDecl = {
  readonly id: string;
  readonly title: string;
  /** Document file, relative to the plugin directory. */
  readonly file: string;
};

export type PluginExtensionStatus = {
  readonly point: string;
  readonly declared: boolean;
  readonly wired: boolean;
  /** Why it is not wired, when it is not. */
  readonly reason: string | null;
};

export type PluginRow = {
  readonly name: string;
  readonly version: string;
  readonly description: string | null;
  /** Absolute plugin directory. */
  readonly dir: string;
  readonly panes: readonly PluginPaneDecl[];
  readonly extensionPoints: readonly PluginExtensionStatus[];
  /** Permission allow-lists, verbatim — the console shows the capability
   *  surface rather than a "trusted" badge. */
  readonly permissions: {
    readonly fs: readonly string[];
    readonly net: readonly string[];
  };
  /** Problems that stopped this entry being read as a plugin. */
  readonly problems: readonly string[];
};

export type PluginInventory = {
  readonly pluginsDir: string;
  readonly plugins: readonly PluginRow[];
  /** Points this build honours, for the "what is wired" note in the UI. */
  readonly wired: readonly string[];
  readonly deferred: Readonly<Record<string, string>>;
};

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

/** Pane declarations from a manifest, shape-checked. A pane whose file name
 *  is not a safe segment is dropped: it can never be served anyway. */
export function readPaneDecls(manifest: unknown): readonly PluginPaneDecl[] {
  const panes = (manifest as { panes?: unknown } | null)?.panes;
  if (!Array.isArray(panes)) return [];
  const out: PluginPaneDecl[] = [];
  for (const raw of panes) {
    if (typeof raw !== "object" || raw === null) continue;
    const pane = raw as Record<string, unknown>;
    const id = pane["id"];
    const file = pane["file"];
    if (typeof id !== "string" || !SAFE_SEGMENT_RE.test(id)) continue;
    if (typeof file !== "string" || !SAFE_SEGMENT_RE.test(file) || !file.endsWith(".html")) {
      continue;
    }
    out.push({ id, title: typeof pane["title"] === "string" ? pane["title"] : id, file });
  }
  return out;
}

/** Classify every extension point a manifest declares. */
export function classifyExtensionPoints(manifest: unknown): readonly PluginExtensionStatus[] {
  const record = (manifest ?? {}) as Record<string, unknown>;
  const out: PluginExtensionStatus[] = [];
  for (const point of WIRED_EXTENSION_POINTS) {
    const declared =
      point === "panes" ? readPaneDecls(manifest).length > 0 : record[point] === true;
    out.push({ point, declared, wired: declared, reason: null });
  }
  for (const [point, reason] of Object.entries(DEFERRED_EXTENSION_POINTS)) {
    out.push({
      point,
      declared: record[point] === true,
      wired: false,
      reason,
    });
  }
  return out;
}

/**
 * The iframe `sandbox` token list for a pane. `allow-scripts` WITHOUT
 * `allow-same-origin` — the combination that gives the document an opaque
 * origin, so it cannot reach the console's DOM, its sessionStorage (where
 * the bearer token lives) or its cookies (there are none). Adding
 * `allow-same-origin` alongside `allow-scripts` would dissolve the sandbox
 * entirely, which is why this is a constant and not an option.
 */
export const PANE_SANDBOX = "allow-scripts";

/**
 * The CSP for a pane document, from the plugin's `net` allow-list.
 * Fail-closed: no `net` permission ⇒ `connect-src 'none'`, and every other
 * fetching directive is `'none'` regardless, so a pane cannot pull a script
 * or a pixel from anywhere.
 */
export function panePolicy(permissions: PluginPermissions | undefined): {
  readonly csp: string;
  readonly connectSrc: readonly string[];
} {
  const declared = permissions?.net ?? [];
  // `net` entries are `fetch:<glob>`; a CSP source cannot express a glob, so
  // only the ORIGIN is taken from each and `isNetAllowed` remains the check
  // that decides an individual URL. A pattern with no usable origin is
  // dropped rather than widened.
  const origins = new Set<string>();
  for (const entry of declared) {
    const colon = entry.indexOf(":");
    if (colon === -1 || entry.slice(0, colon) !== "fetch") continue;
    const pattern = entry.slice(colon + 1);
    const m = pattern.match(/^(https?:\/\/[^/*?]+)/);
    if (m?.[1] !== undefined) origins.add(m[1]);
  }
  const connectSrc = [...origins].sort();
  const csp = [
    "default-src 'none'",
    // Inline only: the document is served from this manager, and a pane that
    // could load a remote script would make the net allow-list decorative.
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    `connect-src ${connectSrc.length === 0 ? "'none'" : connectSrc.join(" ")}`,
    "frame-ancestors 'self'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  return { csp, connectSrc };
}

/**
 * May this plugin observe / render for this harness?
 *
 * The gate is its FILESYSTEM read permission over the harness directory: a
 * plugin that may not read a harness's files has no business being handed
 * its trace events or drawing a tab on it. `isFsAllowed` is
 * `plugin-loader`'s, so "no `fs` section" means no — fail-closed.
 */
export function pluginSeesHarness(
  permissions: PluginPermissions | undefined,
  harnessDir: string,
): boolean {
  return (
    isFsAllowed(permissions, "read", harnessDir) ||
    isFsAllowed(permissions, "read", `${harnessDir}/`) ||
    isFsAllowed(permissions, "read", join(harnessDir, "crewhaus.yaml"))
  );
}

/** May this plugin's pane reach `url`? Thin cover over the loader's own
 *  evaluator, kept here so the route layer never re-derives the rule. */
export function pluginMayFetch(permissions: PluginPermissions | undefined, url: string): boolean {
  return isNetAllowed(permissions, url);
}

/** Plugins permitted to observe one harness's trace events. */
export function traceObservers(
  plugins: readonly PluginRow[],
  harnessDir: string,
): readonly string[] {
  return plugins
    .filter((p) => p.extensionPoints.some((e) => e.point === "onTraceEvent" && e.wired))
    .filter((p) => pluginSeesHarness({ fs: p.permissions.fs }, harnessDir))
    .map((p) => p.name);
}

/** Panes available on one harness's tab strip. */
export function panesForHarness(
  plugins: readonly PluginRow[],
  harnessDir: string,
): ReadonlyArray<{
  readonly plugin: string;
  readonly pane: PluginPaneDecl;
  readonly sandbox: string;
}> {
  const out: Array<{ plugin: string; pane: PluginPaneDecl; sandbox: string }> = [];
  for (const plugin of plugins) {
    if (!pluginSeesHarness({ fs: plugin.permissions.fs }, harnessDir)) continue;
    for (const pane of plugin.panes) {
      out.push({ plugin: plugin.name, pane, sandbox: PANE_SANDBOX });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery — manifests only, never `import()`
// ---------------------------------------------------------------------------

/** Cap on a pane document (it is inlined into a JSON payload). */
export const MAX_PANE_BYTES = 256 * 1024;

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * Read `~/.crewhaus/plugins/*` into the inventory. Tolerant throughout: a
 * directory with no manifest, an unparseable manifest, or a manifest missing
 * `name`/`version` yields a row carrying its PROBLEM rather than vanishing,
 * because a plugin an operator installed and cannot see is a support ticket.
 */
export function readPluginInventory(pluginsDir: string): PluginInventory {
  const plugins: PluginRow[] = [];
  let names: string[] = [];
  try {
    names = existsSync(pluginsDir) ? readdirSync(pluginsDir).sort() : [];
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!SAFE_SEGMENT_RE.test(name)) continue;
    const dir = resolveInside(pluginsDir, [name]);
    if (dir === undefined) continue;
    const manifestPath = resolveInside(pluginsDir, [name, "plugin.json"]);
    const problems: string[] = [];
    let manifest: (PluginManifest & { panes?: unknown }) | undefined;
    if (manifestPath === undefined || !existsSync(manifestPath)) {
      problems.push("no plugin.json in the plugin directory");
    } else {
      const parsed = readJson(manifestPath);
      if (typeof parsed !== "object" || parsed === null) {
        problems.push("plugin.json is not a JSON object");
      } else {
        manifest = parsed as PluginManifest & { panes?: unknown };
        if (typeof manifest.name !== "string" || manifest.name === "") {
          problems.push("plugin.json has no name");
        }
        if (typeof manifest.version !== "string" || manifest.version === "") {
          problems.push("plugin.json has no version");
        }
      }
    }
    const permissions = manifest?.permissions;
    plugins.push({
      name: typeof manifest?.name === "string" && manifest.name !== "" ? manifest.name : name,
      version: typeof manifest?.version === "string" ? manifest.version : "unknown",
      description: typeof manifest?.description === "string" ? manifest.description : null,
      dir,
      panes: readPaneDecls(manifest),
      extensionPoints: classifyExtensionPoints(manifest),
      permissions: {
        fs: asStringArray(permissions?.fs),
        net: asStringArray(permissions?.net),
      },
      problems,
    });
  }
  return {
    pluginsDir,
    plugins,
    wired: [...WIRED_EXTENSION_POINTS],
    deferred: DEFERRED_EXTENSION_POINTS,
  };
}

export type PaneDocument = {
  readonly plugin: string;
  readonly paneId: string;
  readonly title: string;
  /** The document source, to be handed to an iframe `srcdoc`. NOT trusted:
   *  it is contained by the sandbox and the CSP, never by inspection. */
  readonly doc: string;
  readonly sandbox: string;
  readonly csp: string;
  readonly truncated: boolean;
};

/**
 * Read one pane document out of a plugin directory. Containment is per FILE
 * (the manifest names it, and a name can be a symlink), the read is capped,
 * and the policy travels WITH the document so a client cannot render it
 * without the sandbox and the CSP that make it safe.
 */
export function readPaneDocument(plugin: PluginRow, paneId: string): PaneDocument | undefined {
  const pane = plugin.panes.find((p) => p.id === paneId);
  if (pane === undefined) return undefined;
  const path = resolveInside(plugin.dir, [pane.file]);
  if (path === undefined || !existsSync(path)) return undefined;
  let doc: string;
  try {
    doc = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const truncated = doc.length > MAX_PANE_BYTES;
  const { csp } = panePolicy({ fs: plugin.permissions.fs, net: plugin.permissions.net });
  return {
    plugin: plugin.name,
    paneId,
    title: pane.title,
    doc: truncated ? doc.slice(0, MAX_PANE_BYTES) : doc,
    sandbox: PANE_SANDBOX,
    csp,
    truncated,
  };
}

/** Default plugins directory (`~/.crewhaus/plugins`), matching
 *  `plugin-loader`'s `defaultPluginPaths`. */
export function defaultPluginsDir(homeDir: string): string {
  return join(homeDir, ".crewhaus", "plugins");
}
