import { createHash } from "node:crypto";
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { McpError } from "@crewhaus/errors";
import type { McpClient, McpHost, McpServerConfig, McpToolDefinition } from "@crewhaus/mcp-host";
import { nextBackoffMs } from "@crewhaus/mcp-host";
import { type RunContext, tagContent } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolCatalog, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";

/**
 * Wrap an MCP server's remote tools as `RegisteredTool` entries on the
 * shared catalog. Catalog R4 (`tool-mcp`).
 *
 * Naming: each remote tool is registered as `<serverName>__<toolName>` so
 * tools from different servers can never collide. Server names are user-
 * controlled YAML keys (already deduped at the spec layer); remote tool
 * names are server-controlled and validated here.
 *
 * Schema: MCP tools' authoritative schema is JSON Schema. We keep that
 * verbatim on `RegisteredTool.jsonSchema` (forwarded to the model by
 * `runtime-core`) and use `z.unknown()` as the local validator slot, so
 * the validator path passes everything through and the MCP server itself
 * is the source of truth for argument validation.
 */

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export type McpToolFlags = {
  readonly concurrencySafe?: boolean;
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  /** Pillar 3 intent gate — set for remote tools whose local twins are
   *  justification-gated (e.g. the Thredz backend's `wiki_write`), so the
   *  backend flip never silently drops the gate. Default false. */
  readonly requireJustification?: boolean;
};

export type RegisterMcpServerOptions = {
  /** Default flags applied to every tool from this server. */
  readonly defaults?: McpToolFlags;
  /**
   * Per-tool flag overrides keyed by remote tool name (NOT the namespaced
   * `<server>__<tool>` form). Wins over `defaults`.
   */
  readonly perTool?: Readonly<Record<string, McpToolFlags>>;
  /** Logger callback fired once per registered tool. Useful for boot banners. */
  readonly onRegister?: (info: { fullName: string; remoteName: string }) => void;
};

export function namespacedToolName(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`;
}

/**
 * Build a single `RegisteredTool` from one remote MCP tool. Exposed so
 * tests (and any future custom-naming caller) can reuse the wiring without
 * going through `registerMcpServer`.
 *
 * `opts.registeredName` overrides the default `<server>__<tool>` catalog
 * name — the bare-name alias path (`registerMcpToolAliases`) uses it so a
 * backend flip (design §4.3) keeps one tool vocabulary. Everything else —
 * `scope: "external"`, `ioCapability: "network"`, the boundary
 * classification + lineage tagging around the remote call — is IDENTICAL
 * for aliases; only the advertised name changes.
 */
export function buildMcpRegisteredTool(
  host: McpHost,
  serverName: string,
  remote: McpToolDefinition,
  flags: {
    concurrencySafe: boolean;
    readOnly: boolean;
    destructive: boolean;
    requireJustification?: boolean;
  },
  opts: { readonly registeredName?: string } = {},
): RegisteredTool {
  if (typeof remote.name !== "string" || remote.name.length === 0) {
    throw new McpError(`mcp server "${serverName}" returned a tool with an empty/missing name`);
  }
  if (!TOOL_NAME_PATTERN.test(remote.name)) {
    throw new McpError(
      `mcp server "${serverName}" returned a tool with an invalid name "${remote.name}" (must match ${TOOL_NAME_PATTERN.source})`,
    );
  }
  const fullName = opts.registeredName ?? namespacedToolName(serverName, remote.name);
  const description = sanitizeDescription(remote.description) ?? `MCP tool ${fullName}`;
  return buildTool({
    name: fullName,
    description,
    // The MCP server validates arguments on its end. Local validator is
    // permissive so non-Zod-representable JSON Schema features round-trip.
    inputSchema: z.unknown(),
    jsonSchema: remote.inputSchema,
    concurrencySafe: flags.concurrencySafe,
    readOnly: flags.readOnly,
    destructive: flags.destructive,
    requireJustification: flags.requireJustification ?? false,
    // Pillar 3 sink-side: every MCP call is an external sink. The MCP
    // protocol gives us no visibility into what the remote server actually
    // does with its arguments — egress-classifier defaults to "external"
    // scope and treats dynamically-registered servers as
    // "external-dynamic" (strict policy) while spec-configured servers are
    // "external-configured".
    scope: "external",
    // FR-002 — declare the io-capability fact: every MCP call leaves the
    // process for a remote server over the network.
    ioCapability: "network",
    execute: async (input, ctx) => {
      const client = host.getClient(serverName);
      const args = (input ?? {}) as Record<string, unknown>;
      const result = await client.callTool(remote.name, args, {
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      // Pillar 3 boundary site — classify the FULL MCP response (not just
      // the truncated preview the §18 post-tool classifier sees later).
      // A polymorphic jailbreak hidden mid-payload would otherwise bypass
      // the runtime-core classifier when storeAndPreview truncates the
      // bytes that contained it. The boundary-classifier's content-hash
      // cache means a repeated MCP call to a healthy server doesn't burn
      // re-classification budget.
      //
      // An ERROR result (`isError`) is just as attacker-controllable and just
      // as injection-capable as a success result, so it flows through the SAME
      // classify+tag path here BEFORE being surfaced — rather than thrown raw,
      // which used to convert the unclassified, untagged attacker string into
      // an error result that reached the model's context bypassing both halves
      // of the fabric.
      const boundary = await classifyBoundary(result.content, { origin: "mcp" });
      let safeContent: string;
      if (boundary.action === "redact" && boundary.redacted !== undefined) {
        // Malicious — substitute the redaction notice. Do NOT tag lineage:
        // the raw attacker text never reaches the model's context, so there
        // is nothing for the egress fabric to track.
        safeContent = boundary.redacted;
      } else {
        safeContent = result.content;
        // Pillar 3 sink-side fabric (invariant #1) — a module that classifies
        // external content MUST also tag it so the egress check sees its
        // provenance. Record the full MCP response under origin "mcp" so the
        // egress classifier attributes any later exfiltration to the precise
        // boundary site (rather than the coarse runtime-core "tool" origin).
        // The RunContext is read from `ctx.runContext` first (#160 follow-up:
        // the runtime now threads it directly on every run) and falls back to
        // the opaque `ctx.bridge.runContext` for back-compat with callers that
        // only wire the bridge. When neither is present this best-effort tag is
        // skipped and the runtime-core post-tool path still tags the preview
        // under the coarse "tool" origin.
        const runContext = resolveRunContext(ctx);
        if (runContext !== undefined) {
          tagContent(runContext, result.content, "mcp");
        }
      }
      // An MCP error result must still surface to the model as a tool error,
      // but only AFTER classification/tagging — never the raw attacker text.
      // tool-executor wraps this McpError into an `is_error` tool result.
      if (result.isError) {
        throw new McpError(safeContent || `mcp tool "${fullName}" returned an error result`);
      }
      return safeContent;
    },
  });
}

/**
 * Connect to a registered server and register every remote tool on the
 * catalog. The host must already have the server added; this function
 * triggers `client.connect()` (idempotent) before listing tools.
 */
export async function registerMcpServer(
  host: McpHost,
  serverName: string,
  catalog: ToolCatalog,
  opts: RegisterMcpServerOptions = {},
): Promise<void> {
  const client = host.getClient(serverName);
  await client.connect();
  const remoteTools = await client.listTools();
  for (const remote of remoteTools) {
    const tool = buildMcpRegisteredTool(host, serverName, remote, resolveFlags(opts, remote.name));
    catalog.register(tool);
    opts.onRegister?.({ fullName: tool.name, remoteName: remote.name });
  }
}

// ---------------------------------------------------------------------------
// Loop contract 0.4 (Batch G, G74) — live tools/list_changed re-diff.
//
// mcp-host now surfaces a server's `notifications/tools/list_changed` via
// `McpClient.onToolsChanged`. This section closes the loop: on a change we
// re-`listTools()`, DIFF it against the last snapshot (stable schema hashing,
// mirroring the `mcp-doctor` drift watch so a mere key reorder is NOT drift),
// and apply the delta to the shared catalog — unregister removed + schema-
// changed tools, (re)register added + schema-changed ones. Steady-state
// registration (`registerMcpServer`) is unchanged; `watchMcpServer` layers the
// subscription on top so the boot path opts in with one call.
// ---------------------------------------------------------------------------

/**
 * A server's advertised tools captured for drift diffing: remote tool name →
 * stable schema hash. Built by {@link snapshotTools}; threaded across
 * `tools/list_changed` reconciles by {@link watchMcpServer}.
 */
export type McpToolSnapshot = ReadonlyMap<string, string>;

/**
 * The delta between two {@link McpToolSnapshot}s. `added`/`removed`/
 * `schemaChanged` hold REMOTE tool names (not the `<server>__` namespaced
 * form); `driftIsEmpty` is the fast steady-state check.
 */
export type McpToolDrift = {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly schemaChanged: readonly string[];
};

export function driftIsEmpty(drift: McpToolDrift): boolean {
  return drift.added.length === 0 && drift.removed.length === 0 && drift.schemaChanged.length === 0;
}

/**
 * Order-insensitive canonical JSON: recursively sort object keys so a server
 * that reorders its schema keys between advertisements hashes identically
 * (that is not drift), while any real member add/remove/retype IS. Mirrors
 * `mcp-doctor`'s `canonicalJson`.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Stable 16-hex-char sha256 of a tool's JSON-schema. Mirrors `mcp-doctor`. */
export function hashToolSchema(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex").slice(0, 16);
}

/** Build a drift snapshot (remote name → schema hash) from a live tool list. */
export function snapshotTools(tools: ReadonlyArray<McpToolDefinition>): McpToolSnapshot {
  const map = new Map<string, string>();
  for (const t of tools) map.set(t.name, hashToolSchema(t.inputSchema));
  return map;
}

/**
 * Diff two snapshots. `added` = in `next` not `prev`; `removed` = in `prev`
 * not `next`; `schemaChanged` = in both, different hash. An absent `prev`
 * (first observation) yields all-added, matching `mcp-doctor`'s baseline rule.
 */
export function diffToolSnapshots(
  prev: McpToolSnapshot | undefined,
  next: McpToolSnapshot,
): McpToolDrift {
  const added: string[] = [];
  const removed: string[] = [];
  const schemaChanged: string[] = [];
  const before = prev ?? new Map<string, string>();
  for (const [name, hash] of next) {
    const prevHash = before.get(name);
    if (prevHash === undefined) added.push(name);
    else if (prevHash !== hash) schemaChanged.push(name);
  }
  for (const name of before.keys()) {
    if (!next.has(name)) removed.push(name);
  }
  return { added, removed, schemaChanged };
}

/** Result of one {@link reconcileMcpServer} pass. */
export type McpReconcileResult = {
  readonly drift: McpToolDrift;
  /** The fresh snapshot — feed it back as `previous` on the next reconcile. */
  readonly snapshot: McpToolSnapshot;
};

/**
 * Re-diff a server's catalog against `previous` and apply the delta to
 * `catalog`. Forces a fresh `tools/list` (bypassing the boot cache), diffs,
 * then: unregisters removed AND schema-changed tools, and (re)registers added
 * AND schema-changed tools with the same wiring as {@link registerMcpServer}
 * (namespaced name, boundary classification, lineage tagging, resolved
 * flags). Returns the drift plus the new snapshot to thread forward. Safe when
 * nothing changed — an empty drift touches the catalog not at all. Used by
 * {@link watchMcpServer}; also callable directly (e.g. a manual re-probe).
 */
export async function reconcileMcpServer(
  host: McpHost,
  serverName: string,
  catalog: ToolCatalog,
  previous: McpToolSnapshot | undefined,
  opts: RegisterMcpServerOptions = {},
): Promise<McpReconcileResult> {
  const client = host.getClient(serverName);
  await client.connect();
  const remoteTools = await client.refreshTools();
  const byName = new Map(remoteTools.map((t) => [t.name, t] as const));
  const snapshot = snapshotTools(remoteTools);
  const drift = diffToolSnapshots(previous, snapshot);

  // Removed + schema-changed leave the catalog first, so a schema-changed
  // tool can be re-registered under its (unchanged) name without tripping the
  // "already registered" guard.
  for (const remoteName of [...drift.removed, ...drift.schemaChanged]) {
    const fullName = namespacedToolName(serverName, remoteName);
    if (catalog.has(fullName)) catalog.unregister(fullName);
  }
  for (const remoteName of [...drift.added, ...drift.schemaChanged]) {
    const remote = byName.get(remoteName);
    if (remote === undefined) continue;
    const tool = buildMcpRegisteredTool(host, serverName, remote, resolveFlags(opts, remoteName));
    catalog.register(tool);
    opts.onRegister?.({ fullName: tool.name, remoteName });
  }
  return { drift, snapshot };
}

/** A handle from {@link watchMcpServer}: `stop()` unsubscribes from the
 *  server's `tools/list_changed` notifications (the registered tools remain). */
export type McpServerWatch = {
  readonly stop: () => void;
};

export type WatchMcpServerOptions = RegisterMcpServerOptions & {
  /** Fired after each reconcile with a NON-empty drift (diagnostics/banners). */
  readonly onDrift?: (info: { server: string; drift: McpToolDrift }) => void;
  /** Sink for a reconcile that throws (a mid-run server hiccup). Default: swallow. */
  readonly onError?: (err: unknown) => void;
};

/**
 * Register a server's tools AND keep the catalog live: subscribe to the
 * client's `tools/list_changed` and reconcile the catalog on each change. The
 * initial pass is a reconcile against an empty snapshot (registers every
 * advertised tool), so this fully replaces a bare {@link registerMcpServer}
 * call for a boot that wants drift tracking. `stop()` unsubscribes.
 *
 * A change notification's handler is synchronous (mcp-host's contract), so the
 * async reconcile is fired-and-forwarded; overlapping notifications are
 * serialised through a single in-flight chain so the snapshot never races.
 */
export async function watchMcpServer(
  host: McpHost,
  serverName: string,
  catalog: ToolCatalog,
  opts: WatchMcpServerOptions = {},
): Promise<McpServerWatch> {
  let snapshot: McpToolSnapshot | undefined;
  // Serialise reconciles: a burst of notifications chains onto the prior
  // pass rather than interleaving snapshot reads/writes.
  let chain: Promise<void> = Promise.resolve();
  const runReconcile = (): Promise<void> => {
    chain = chain.then(async () => {
      try {
        const result = await reconcileMcpServer(host, serverName, catalog, snapshot, opts);
        snapshot = result.snapshot;
        if (!driftIsEmpty(result.drift))
          opts.onDrift?.({ server: serverName, drift: result.drift });
      } catch (err) {
        opts.onError?.(err);
      }
    });
    return chain;
  };

  await runReconcile();
  const client: McpClient = host.getClient(serverName);
  const unsubscribe = client.onToolsChanged(() => {
    void runReconcile();
  });
  return { stop: unsubscribe };
}

// ---------------------------------------------------------------------------
// #406 — optional MCP peers: degrade at boot, retry in the background,
// register on arrival.
// ---------------------------------------------------------------------------

export type OptionalMcpServerOptions = WatchMcpServerOptions & {
  /** Boot/retry banner sink (the daemon's stdout writer). */
  readonly log?: (line: string) => void;
  /** Timer seams so tests drive the retry ladder without sleeping. */
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Backoff schedule; defaults to mcp-host's ladder (1 s → 30 s, jittered). */
  readonly backoffMs?: (attempt: number) => number;
  /** Background retry after a failed first attempt. Defaults to true (the
   *  daemon contract). One-shot surfaces (a cli run, a crew run, a workflow)
   *  pass false: their tool list is frozen for the process, so a peer that
   *  connects mid-run could never reach the model anyway — the honest
   *  behaviour is "absent for this run", not a retry banner mid-turn. */
  readonly retry?: boolean;
  /** Deferred config resolution + `host.addServer`, run INSIDE the
   *  never-throw boundary. An optional peer must not be able to take the
   *  boot down through ANY path — including `resolveMcpServerConfig`
   *  throwing on an unset env var (the dev machine that deliberately omits
   *  the optional peer's key). A config failure warns and gives up
   *  permanently (no retry — env vars do not appear mid-process); a connect
   *  failure follows the retry contract. When absent, the caller already
   *  added the server to the host. */
  readonly config?: () => McpServerConfig;
};

export type OptionalMcpServerHandle = {
  /** Resolves once the FIRST attempt has settled (connected or warned), so a
   *  boot sequence can log deterministically without blocking on eventual
   *  success. Never rejects. */
  readonly firstAttempt: Promise<boolean>;
  /** True once the server has connected and its tools are on the catalog. */
  connected(): boolean;
  /** Cancel the retry ladder and (when connected) stop the live re-diff.
   *  Registered tools stay on the catalog — stopping the WATCH must not
   *  yank tools out from under a running turn. */
  stop(): void;
};

/**
 * Register an OPTIONAL server: one whose absence must not stop the boot.
 *
 * The default contract stays fail-fast — a required peer that cannot connect
 * exits the daemon, because an agent whose instructions assume a tool behaves
 * worse when it silently vanishes than when it refuses to start. This is the
 * spec-opted alternative (`mcp_servers.<name>.required: false`) for the peers
 * where absence is a normal state: the A2A neighbour that boots after us —
 * two daemons that mount each other otherwise cannot both start first, which
 * turns every peer topology into a boot-order problem (and, past the
 * supervisor's restart window, into `crash-looping`).
 *
 * Behaviour:
 *   - with `opts.config`, config resolution + `host.addServer` run inside
 *     the never-throw boundary too: an unset env var WARNS and gives up
 *     permanently instead of taking the boot down (or retrying a failure
 *     that cannot heal);
 *   - the first connect attempt happens immediately; failure WARNS through
 *     `log` (naming the server and that the daemon continues without its
 *     tools) instead of throwing;
 *   - retries follow mcp-host's backoff ladder indefinitely — a peer that
 *     appears an hour later is still picked up, with no restart (unless the
 *     caller passed `retry: false`, the one-shot-surface mode);
 *   - on connect the server's tools register through {@link watchMcpServer},
 *     so the catalog additionally stays reconciled with later
 *     `tools/list_changed` notifications (the first production consumer of
 *     the G74 machinery);
 *   - which SURFACES see late-registered tools is the caller's contract:
 *     shapes that re-read the catalog per message/job (channel with an
 *     optional peer, managed, batch) advertise them on the next turn; a
 *     one-shot crew or a single long cli loop keeps its boot snapshot.
 *
 * Never throws: an optional peer must not be able to take the boot down
 * through this path at all.
 */
export function registerOptionalMcpServer(
  host: McpHost,
  serverName: string,
  catalog: ToolCatalog,
  opts: OptionalMcpServerOptions = {},
): OptionalMcpServerHandle {
  const log = opts.log ?? (() => {});
  const setTimer = opts.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const backoffMs = opts.backoffMs ?? nextBackoffMs;
  const retry = opts.retry !== false;

  let stopped = false;
  let isConnected = false;
  let attempt = 0;
  let timer: unknown = null;
  let watch: McpServerWatch | undefined;
  // Config resolution is deferred into the first run when `opts.config` is
  // given; a throw there is PERMANENT (no retry) — see the option's doc.
  let added = opts.config === undefined;
  let configFailed = false;

  const tryOnce = async (): Promise<boolean> => {
    if (!added && opts.config !== undefined) {
      try {
        host.addServer(serverName, opts.config());
        added = true;
      } catch (err) {
        configFailed = true;
        log(
          `[mcp] optional server "${serverName}" not configured (${firstLineOf(err)}) — continuing without its tools\n`,
        );
        return false;
      }
    }
    const client: McpClient = host.getClient(serverName);
    try {
      await client.connect();
    } catch (err) {
      const rest = retry
        ? "continuing without its tools; retrying in the background"
        : "continuing without its tools for this run";
      log(`[mcp] optional server "${serverName}" unreachable (${firstLineOf(err)}) — ${rest}\n`);
      return false;
    }
    let registered = 0;
    watch = await watchMcpServer(host, serverName, catalog, {
      ...opts,
      onRegister: (info) => {
        registered += 1;
        opts.onRegister?.(info);
      },
      onError: (err) => {
        log(`[mcp] optional server "${serverName}" reconcile failed: ${firstLineOf(err)}\n`);
        opts.onError?.(err);
      },
    });
    isConnected = true;
    log(
      `[mcp] optional server "${serverName}" connected — ${registered} tool(s) registered` +
        `${attempt > 0 ? ` after ${attempt} retr${attempt === 1 ? "y" : "ies"}` : ""}\n`,
    );
    return true;
  };

  const scheduleNext = (): void => {
    if (stopped || !retry || configFailed) return;
    attempt += 1;
    timer = setTimer(() => {
      timer = null;
      void run();
    }, backoffMs(attempt));
  };

  const run = async (): Promise<boolean> => {
    if (stopped) return false;
    const ok = await tryOnce().catch((err) => {
      // getClient on an unregistered name, or a watch failure — still not a
      // reason an OPTIONAL peer may take the boot down.
      log(`[mcp] optional server "${serverName}" failed: ${firstLineOf(err)}\n`);
      return false;
    });
    if (!ok) scheduleNext();
    return ok;
  };

  const firstAttempt = run();

  return {
    firstAttempt: firstAttempt.then(
      (ok) => ok,
      () => false,
    ),
    connected: () => isConnected,
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      watch?.stop();
    },
  };
}

/** The first line of an error's message — boot banners are one line each. */
function firstLineOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0] ?? message;
}

// ---------------------------------------------------------------------------
// Loop contract 0.4 (Batch G, G74) — SkillRef.tools enforcement.
//
// A skill may declare a `tools` allow-list (skills-registry's `SkillRef.tools`,
// historically parsed-but-unenforced). While that skill is ACTIVE, the model
// should see ONLY those tools. This is a pure catalog-narrowing primitive the
// runtime consumes at turn-composition time; keeping it here (next to the MCP
// registration surface) means the same narrowing covers built-ins and remote
// MCP tools alike — the model-facing name (`<server>__<tool>` for MCP) is what
// the allow-list matches.
// ---------------------------------------------------------------------------

/**
 * Narrow a tool list to a skill's `tools` allow-list. When `allow` is
 * `undefined` the skill imposes NO restriction and the list passes through
 * unchanged (an empty array, by contrast, means "no tools"). Matching is by
 * the model-facing `RegisteredTool.name`, so an MCP tool is referenced by its
 * namespaced `<server>__<tool>` name. Pure and allocation-cheap — safe to call
 * per turn.
 */
export function narrowToolsForActiveSkill(
  tools: ReadonlyArray<RegisteredTool>,
  allow: ReadonlyArray<string> | undefined,
): ReadonlyArray<RegisteredTool> {
  if (allow === undefined) return tools;
  const allowed = new Set(allow);
  return tools.filter((t) => allowed.has(t.name));
}

/** Fold `defaults` + `perTool` overrides into one resolved flag set. */
function resolveFlags(
  opts: RegisterMcpServerOptions,
  remoteName: string,
): {
  concurrencySafe: boolean;
  readOnly: boolean;
  destructive: boolean;
  requireJustification: boolean;
} {
  const override = opts.perTool?.[remoteName] ?? {};
  return {
    concurrencySafe: override.concurrencySafe ?? opts.defaults?.concurrencySafe ?? false,
    readOnly: override.readOnly ?? opts.defaults?.readOnly ?? false,
    destructive: override.destructive ?? opts.defaults?.destructive ?? false,
    requireJustification:
      override.requireJustification ?? opts.defaults?.requireJustification ?? false,
  };
}

/** The result of `registerMcpToolAliases`: which bare names landed on the
 *  catalog, and which requested aliases the server did not advertise (the
 *  caller decides whether that is a warning or an error). */
export type McpAliasRegistration = {
  readonly registered: readonly string[];
  readonly missing: readonly string[];
};

/**
 * v0.3.0 Goal 3 (design §4.3) — register a SELECTED set of a server's remote
 * tools under their BARE names (no `<server>__` prefix), so a backend flip
 * keeps the exact tool vocabulary the model already knows (`wiki_recall`,
 * `goal_write`, …) while routing through the MCP client.
 *
 * Collision-guarded: a bare name already on the catalog is a composition bug
 * (e.g. the local twin was registered first) and throws `McpError` naming
 * both sides — never a silent shadow. Aliases ride the SAME
 * `buildMcpRegisteredTool` wiring as namespaced tools: `scope: "external"`,
 * `ioCapability: "network"`, boundary classification + `dataLineage` tagging
 * on every response — the Pillar 3 fabric does not care what a sink is
 * called. Requested aliases the server does not advertise are returned in
 * `missing` rather than thrown, so a caller can degrade with a warning.
 */
export async function registerMcpToolAliases(
  host: McpHost,
  serverName: string,
  catalog: ToolCatalog,
  aliasNames: ReadonlyArray<string>,
  opts: RegisterMcpServerOptions = {},
): Promise<McpAliasRegistration> {
  const client = host.getClient(serverName);
  await client.connect();
  const remoteTools = await client.listTools();
  const wanted = new Set(aliasNames);
  const registered: string[] = [];
  for (const remote of remoteTools) {
    if (!wanted.has(remote.name)) continue;
    if (catalog.has(remote.name)) {
      throw new McpError(
        `mcp server "${serverName}" tool "${remote.name}" cannot be aliased onto its bare name — a tool named "${remote.name}" is already registered on the catalog (the local twin must not be registered when the ${serverName} backend owns the vocabulary)`,
      );
    }
    const tool = buildMcpRegisteredTool(host, serverName, remote, resolveFlags(opts, remote.name), {
      registeredName: remote.name,
    });
    catalog.register(tool);
    registered.push(remote.name);
    opts.onRegister?.({ fullName: tool.name, remoteName: remote.name });
  }
  const advertised = new Set(remoteTools.map((t) => t.name));
  const missing = aliasNames.filter((name) => !advertised.has(name));
  return { registered, missing };
}

/**
 * Resolve the run's `RunContext` for provenance tagging. Prefers the
 * `ctx.runContext` field the runtime now threads on EVERY tool execute
 * (#160 follow-up). Falls back to the opaque runtime bridge's `runContext`
 * (Section 13) — `ToolExecuteContext.bridge` is `unknown` to tool-catalog,
 * so we read its `runContext` field structurally (rather than importing the
 * full `RuntimeBridge` from `agent-context-isolation`, which would invert the
 * dependency arrow). Returns undefined when neither is present, so the
 * boundary tag is best-effort and degrades cleanly.
 */
function resolveRunContext(ctx: ToolExecuteContext | undefined): RunContext | undefined {
  if (ctx?.runContext !== undefined) return ctx.runContext;
  const bridge = ctx?.bridge as { runContext?: RunContext } | undefined;
  return bridge?.runContext;
}

/**
 * Strip C0 control chars and trim whitespace. Anthropic's API tolerates
 * Unicode in descriptions but stripping control chars protects against
 * pathological server output.
 */
function sanitizeDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit C0/DEL strip
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return stripped.length > 0 ? stripped : undefined;
}
