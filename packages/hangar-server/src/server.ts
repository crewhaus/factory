/**
 * `startHangarServer` — the M1 manager server: one `Bun.serve` on loopback,
 * READ-ONLY over harness state, with registry CRUD (manager state) as the
 * only write surface. No process spawning, no WebSocket — later milestones.
 *
 * Safety model enforced here:
 *   - AUTH: every `/api` route requires `Authorization: Bearer <token>`
 *     (constant-time compare). `/healthz` and the static UI shell (which
 *     carries no harness data and must load before the browser has stored
 *     the fragment token) are the only unauthenticated surfaces. No cookies
 *     anywhere ⇒ no CSRF surface. `noAuth` disables the check with a logged
 *     warning, for trusted localhost dev only.
 *   - PATH SAFETY: `:id` params must match their format regexes before any
 *     filesystem work, and every harness-relative read realpath-contains
 *     inside that harness's registered dir (the registry is the allowlist).
 *     Arbitrary absolute dirs enter ONLY via `POST /api/harnesses` bodies.
 *   - READS NEVER MUTATE: session browsing is raw dir scans + tolerant
 *     JSONL parsing (never `SessionStore.list()`, whose TTL eviction
 *     deletes transcripts); memory views are fold-only.
 *   - CREDENTIALS NEVER RENDER: env routes return KEY presence booleans;
 *     spec/transcript routes pass the spec-patch maskers.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readRunIndex } from "@crewhaus/eval-report";
import {
  type BuildInventoryDeps,
  buildHarnessHealth,
  buildHarnessInventory,
  discoverHarnesses,
  readSpecHeader,
} from "@crewhaus/harness-inventory";
import {
  HARNESS_ID_RE,
  type HangarHarnessEntry,
  type HangarRegistry,
  openHangarRegistry,
} from "@crewhaus/harness-registry";
import { runPreflight } from "@crewhaus/preflight";
import { type TokenSetup, ensureToken, isAuthorized } from "./auth";
import {
  DEFAULT_HANGAR_PORT,
  HANGAR_SERVER_VERSION,
  PROTOCOL_V,
  SAFE_SEGMENT_RE,
} from "./constants";
import { foldHarnessCosts } from "./costs";
import { mergedSpawnEnv } from "./env-file";
import { evalHealth, evalRunView, evalSampleView, evalsView, isRunId } from "./evals";
import { maskDeep } from "./mask";
import {
  dreamView,
  factsView,
  isMemoryArea,
  stateView,
  watchmeView,
  wikiArticle,
  wikiView,
} from "./memory";
import { type HarnessRollup, openRollupCache } from "./rollups";
import {
  isSessionId,
  listSessions,
  readTranscript,
  readTranscriptRaw,
  resolveSessionRoot,
} from "./sessions";
import { capabilityBadges, specView } from "./spec-view";

export type StaticAsset = {
  readonly body: string | Uint8Array;
  readonly contentType: string;
};

export type HangarServerOptions = {
  /** TCP port; default {@link DEFAULT_HANGAR_PORT}; 0 = OS-assigned. */
  readonly port?: number;
  /** Bind host; default `127.0.0.1` (loopback-only is the M1 posture). */
  readonly hostname?: string;
  /** Hangar root (token + rollup cache); default `~/.crewhaus/hangar`. */
  readonly root?: string;
  /** Registry root passed to `openHangarRegistry` (the DIRECTORY holding
   *  `harnesses.json`); default `CREWHAUS_REGISTRY_ROOT` or `~/.crewhaus`. */
  readonly registryRoot?: string;
  /** Explicit bearer token; otherwise loaded/minted at `<root>/token`. */
  readonly token?: string;
  /** Disable auth entirely (logged warning; trusted localhost dev only). */
  readonly noAuth?: boolean;
  /** Prebuilt UI assets served at `/` and exact asset paths. Absent → a
   *  minimal built-in index page listing the API routes. */
  readonly assets?: Readonly<Record<string, StaticAsset>>;
  /** Base environment; defaults to `process.env`. Harness `.env` files are
   *  layered ON TOP of this for preflight/env-presence evaluation. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Clock (epoch ms); injected so tests are deterministic. */
  readonly now?: () => number;
  /** Warning sink; defaults to `console.warn`. */
  readonly onWarn?: (message: string) => void;
  /** Version string for `/api/version`; default the package version. */
  readonly version?: string;
};

export type HangarServer = {
  readonly url: string;
  readonly port: number;
  readonly hostname: string;
  readonly hangarRoot: string;
  readonly registryPath: string;
  /** Undefined when `noAuth` is set. */
  readonly token?: string;
  /** Where the minted token lives; undefined when supplied via options. */
  readonly tokenPath?: string;
  readonly noAuth: boolean;
  stop(): Promise<void>;
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(data)}\n`, {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function errResponse(status: number, message: string): Response {
  const headers: Record<string, string> = status === 401 ? { "www-authenticate": "Bearer" } : {};
  return json({ error: message }, status, headers);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : undefined;

/** Start the manager server. Synchronous — `Bun.serve` binds immediately. */
export function startHangarServer(opts: HangarServerOptions = {}): HangarServer {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const onWarn = opts.onWarn ?? ((m: string) => console.warn(m));
  const hangarRoot =
    opts.root !== undefined ? resolve(opts.root) : join(homedir(), ".crewhaus", "hangar");
  const noAuth = opts.noAuth === true;
  let tokenSetup: TokenSetup | undefined;
  if (noAuth) {
    onWarn(
      "hangar-server: AUTH DISABLED (noAuth) — every local process can read this fleet's state",
    );
  } else {
    tokenSetup = ensureToken(hangarRoot, opts.token);
  }

  const registry: HangarRegistry = openHangarRegistry({
    ...(opts.registryRoot !== undefined ? { root: opts.registryRoot } : {}),
    env,
    now,
    onWarn,
  });
  const cache = openRollupCache(hangarRoot);
  const version = opts.version ?? HANGAR_SERVER_VERSION;
  const hostname = opts.hostname ?? "127.0.0.1";

  // ---- shared lookups -----------------------------------------------------

  const entryOr404 = (id: string): HangarHarnessEntry => {
    if (!HARNESS_ID_RE.test(id)) throw new HttpError(400, "invalid harness id");
    const entry = registry.get(id);
    if (entry === undefined) throw new HttpError(404, "no such harness");
    return entry;
  };

  const liveDirOr404 = (entry: HangarHarnessEntry): string => {
    if (entry.missingSince !== null || !existsSync(entry.dir)) {
      throw new HttpError(404, "harness dir missing — relocate or remove the entry");
    }
    return entry.dir;
  };

  const readHeaderSafe = (dir: string): { name?: string; target?: string; model?: string } => {
    try {
      return readSpecHeader(readFileSync(join(dir, "crewhaus.yaml"), "utf8"));
    } catch {
      return {};
    }
  };

  const inventoryDeps: BuildInventoryDeps = {
    readManifest: (specName, registryRoot) => {
      if (!SAFE_SEGMENT_RE.test(specName)) return Promise.resolve(undefined);
      try {
        const parsed: unknown = JSON.parse(
          readFileSync(join(registryRoot, specName, "manifest.json"), "utf8"),
        );
        if (isRecord(parsed) && Array.isArray(parsed["versions"]) && isRecord(parsed["pins"])) {
          return Promise.resolve(parsed as { versions: string[]; pins: Record<string, string> });
        }
      } catch {
        // unregistered spec — absence, not error
      }
      return Promise.resolve(undefined);
    },
    readEvalIndex: (evalsDir) => {
      try {
        return readRunIndex(evalsDir);
      } catch {
        return [];
      }
    },
  };

  // ---- route bodies -------------------------------------------------------

  const harnessRows = (hydrate: boolean): unknown => {
    const rows = registry.list().map((entry) => {
      const missing = entry.missingSince !== null;
      const header = missing ? {} : readHeaderSafe(entry.dir);
      let rollup: HarnessRollup | null = null;
      let rollupStaleCachedAt: string | undefined;
      if (!missing) {
        if (hydrate) {
          rollup = cache.get(entry.id, entry.dir, now());
        } else {
          const peeked = cache.peek(entry.id, entry.dir);
          rollup = peeked.rollup;
          rollupStaleCachedAt = peeked.staleCachedAt;
        }
      }
      return {
        id: entry.id,
        dir: entry.dir,
        specName: header.name ?? entry.specName,
        target: header.target ?? entry.target,
        model: header.model ?? null,
        origin: entry.origin,
        groups: entry.groups,
        tags: entry.tags,
        pinned: entry.pinned,
        notes: entry.notes,
        kind: entry.kind,
        registeredAt: entry.registeredAt,
        lastSeen: entry.lastSeen,
        missingSince: entry.missingSince,
        rollup,
        ...(rollupStaleCachedAt !== undefined ? { rollupStaleCachedAt } : {}),
      };
    });
    return { harnesses: rows };
  };

  const detailView = async (entry: HangarHarnessEntry): Promise<unknown> => {
    if (entry.missingSince !== null || !existsSync(entry.dir)) {
      return { entry, missing: true };
    }
    const dir = entry.dir;
    const inventory = await buildHarnessInventory(
      { dir, specPath: join(dir, "crewhaus.yaml") },
      inventoryDeps,
    );
    const health = await buildHarnessHealth(inventory, (evalsDir, specName) =>
      evalHealth(evalsDir, specName),
    );
    const merged = mergedSpawnEnv(env, dir);
    const report = await runPreflight({ harnessDir: dir, env: merged.env });
    const counts = { blocking: 0, warn: 0, info: 0 };
    for (const item of report.items) counts[item.level] += 1;
    let yamlText = "";
    try {
      yamlText = readFileSync(join(dir, "crewhaus.yaml"), "utf8");
    } catch {
      yamlText = "";
    }
    return {
      entry,
      missing: false,
      inventory,
      health,
      preflight: { ok: report.ok, ...counts },
      badges: capabilityBadges(yamlText),
      envFiles: merged.envFiles,
      rollup: cache.get(entry.id, dir, now()),
    };
  };

  const scanAll = (): unknown => {
    const errors: string[] = [];
    let roots = 0;
    let discovered = 0;
    let added = 0;
    let refreshed = 0;
    for (const scanRoot of registry.listScanRoots()) {
      roots += 1;
      let found: ReturnType<typeof discoverHarnesses>;
      try {
        found = discoverHarnesses(scanRoot.dir);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      for (const h of found) {
        discovered += 1;
        const header = readHeaderSafe(h.dir);
        const existing = registry.get(h.dir);
        registry.upsert({
          dir: h.dir,
          ...(header.name !== undefined ? { specName: header.name } : {}),
          ...(header.target !== undefined ? { target: header.target } : {}),
          origin: "scan",
          originDetail: "scan",
        });
        if (existing === undefined) added += 1;
        else refreshed += 1;
      }
      registry.updateScanRoot(scanRoot.dir, { lastScanAt: new Date(now()).toISOString() });
    }
    return { roots, discovered, added, refreshed, errors };
  };

  const fleetCosts = (): unknown => {
    const rows: unknown[] = [];
    let totalUsdMicros = 0;
    let spend7dUsdMicros = 0;
    let calls = 0;
    for (const entry of registry.list()) {
      if (entry.missingSince !== null) continue;
      const rollup = cache.get(entry.id, entry.dir, now());
      const costs = rollup.costBreakdown;
      totalUsdMicros += costs.totalUsdMicros;
      spend7dUsdMicros += costs.spend7dUsdMicros;
      calls += costs.calls;
      rows.push({ id: entry.id, specName: entry.specName, costs });
    }
    return { harnesses: rows, fleet: { totalUsdMicros, spend7dUsdMicros, calls } };
  };

  // ---- dispatch -----------------------------------------------------------

  const readBody = async (req: Request): Promise<Record<string, unknown>> => {
    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    if (!isRecord(parsed)) throw new HttpError(400, "body must be a JSON object");
    return parsed;
  };

  const requireAbsoluteDir = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.length === 0) {
      throw new HttpError(400, `missing "${field}"`);
    }
    if (!isAbsolute(value)) throw new HttpError(400, `"${field}" must be an absolute path`);
    return resolve(value);
  };

  const handleHarnessSub = async (
    req: Request,
    url: URL,
    entry: HangarHarnessEntry,
    rest: readonly string[],
  ): Promise<Response> => {
    const method = req.method;
    const [head, ...tail] = rest;

    if (head === "relocate" && method === "POST" && tail.length === 0) {
      const body = await readBody(req);
      const newDir = requireAbsoluteDir(body["newDir"], "newDir");
      if (!existsSync(newDir) || !statSync(newDir).isDirectory()) {
        throw new HttpError(400, "newDir does not exist");
      }
      try {
        return json({ entry: registry.relocate(entry.id, newDir) });
      } catch (err) {
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    }

    if (method === "PUT" && tail.length === 0) {
      const body = await readBody(req);
      if (head === "groups") {
        const groups = asStringArray(body["groups"]);
        if (groups === undefined) throw new HttpError(400, 'missing "groups" string array');
        return json({ entry: registry.setGroups(entry.id, groups) });
      }
      if (head === "tags") {
        const tags = asStringArray(body["tags"]);
        if (tags === undefined) throw new HttpError(400, 'missing "tags" string array');
        return json({ entry: registry.setTags(entry.id, tags) });
      }
      if (head === "pin") {
        if (typeof body["pinned"] !== "boolean")
          throw new HttpError(400, 'missing "pinned" boolean');
        return json({ entry: registry.setPinned(entry.id, body["pinned"]) });
      }
      if (head === "notes") {
        if (typeof body["notes"] !== "string") throw new HttpError(400, 'missing "notes" string');
        return json({ entry: registry.setNotes(entry.id, body["notes"]) });
      }
      throw new HttpError(404, "not found");
    }

    if (method !== "GET") throw new HttpError(405, "method not allowed");

    if (head === "spec" && tail.length === 0) {
      return json(specView(liveDirOr404(entry), env));
    }
    if (head === "preflight" && tail.length === 0) {
      const dir = liveDirOr404(entry);
      const merged = mergedSpawnEnv(env, dir);
      const report = await runPreflight({ harnessDir: dir, env: merged.env });
      // maskDeep: a preflight lint may quote a literal it found in the spec
      // (e.g. the pasted-credential MCP lint) — mask before serializing.
      return json(maskDeep({ report, envFiles: merged.envFiles }));
    }
    if (head === "sessions" && tail.length === 0) {
      return json(listSessions(liveDirOr404(entry), now()));
    }
    if (head === "sessions" && tail.length === 1) {
      const sess = tail[0] as string;
      if (!isSessionId(sess)) throw new HttpError(400, "invalid session id");
      const dir = liveDirOr404(entry);
      const rootInfo = resolveSessionRoot(dir);
      if (url.searchParams.get("raw") !== null) {
        const raw = readTranscriptRaw(rootInfo.root, sess);
        if (raw === undefined) throw new HttpError(404, "no transcript recorded yet");
        return json(raw);
      }
      const view = readTranscript(rootInfo.root, sess);
      if (view !== undefined) return json(view);
      // Fall through to the durable index for evicted sessions.
      try {
        const indexPath = join(rootInfo.root, "..", "sessions-index", `${sess}.json`);
        const summary: unknown = JSON.parse(readFileSync(indexPath, "utf8"));
        return json({ id: sess, evicted: true, summary });
      } catch {
        throw new HttpError(404, "no session recorded yet");
      }
    }
    if (head === "evals" && tail.length === 0) {
      return json(evalsView(liveDirOr404(entry)));
    }
    if (head === "evals" && tail.length >= 1 && tail.length <= 2) {
      const runId = tail[0] as string;
      if (!isRunId(runId)) throw new HttpError(400, "invalid run id");
      const dir = liveDirOr404(entry);
      if (tail.length === 1) {
        const view = evalRunView(dir, runId);
        if (view === undefined) throw new HttpError(404, "no such eval run");
        // maskDeep: eval artifacts embed agent transcripts — mask token
        // shapes before serializing (defense in depth).
        return json(maskDeep(view));
      }
      const sampleId = tail[1] as string;
      if (!SAFE_SEGMENT_RE.test(sampleId)) throw new HttpError(400, "invalid sample id");
      const view = evalSampleView(dir, runId, sampleId);
      if (view === undefined) throw new HttpError(404, "no such sample");
      return json(maskDeep(view));
    }
    if (head === "memory" && tail.length >= 1 && tail.length <= 2) {
      const area = tail[0] as string;
      const dir = liveDirOr404(entry);
      if (tail.length === 2) {
        if (area !== "wiki") throw new HttpError(404, "not found");
        const article = wikiArticle(dir, tail[1] as string);
        if (article === undefined) throw new HttpError(404, "no such article");
        return json(article);
      }
      if (!isMemoryArea(area)) throw new HttpError(404, "not found");
      switch (area) {
        case "facts":
          return json(factsView(dir, now()));
        case "wiki":
          return json(wikiView(dir));
        case "state":
          return json(stateView(dir));
        case "dream":
          return json(dreamView(dir));
        case "watchme":
          return json(watchmeView(dir));
      }
    }
    if (head === "costs" && tail.length === 0) {
      return json({ id: entry.id, costs: foldHarnessCosts(liveDirOr404(entry), now()) });
    }
    throw new HttpError(404, "not found");
  };

  const api = async (req: Request, url: URL, segs: readonly string[]): Promise<Response> => {
    const method = req.method;
    const [head, ...rest] = segs;

    if (head === "version" && rest.length === 0 && method === "GET") {
      return json({ hangar: version, protocolV: PROTOCOL_V });
    }

    if (head === "harnesses" && rest.length === 0) {
      if (method === "GET") {
        return json(harnessRows(url.searchParams.get("hydrate") !== null));
      }
      if (method === "POST") {
        const body = await readBody(req);
        const dir = requireAbsoluteDir(body["dir"], "dir");
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          throw new HttpError(400, "dir does not exist");
        }
        const warnings: string[] = [];
        const specPath = join(dir, "crewhaus.yaml");
        let header: { name?: string; target?: string } = {};
        if (!existsSync(specPath)) {
          warnings.push("no crewhaus.yaml in dir — registered anyway (spec unreadable)");
        } else {
          header = readHeaderSafe(dir);
          if (header.name === undefined && header.target === undefined) {
            warnings.push("crewhaus.yaml present but no name/target could be read");
          }
        }
        const entry = registry.upsert({
          dir,
          ...(header.name !== undefined ? { specName: header.name } : {}),
          ...(header.target !== undefined ? { target: header.target } : {}),
          origin: "manual",
          originDetail: "api",
        });
        return json({ entry, warnings }, 201);
      }
      throw new HttpError(405, "method not allowed");
    }

    if (head === "registry" && rest[0] === "groups" && rest.length === 1) {
      if (method === "GET") return json({ groups: registry.listGroups() });
      if (method === "POST") {
        const body = await readBody(req);
        const name = body["name"];
        if (typeof name !== "string" || name.length === 0) {
          throw new HttpError(400, 'missing "name"');
        }
        const color = typeof body["color"] === "string" ? body["color"] : undefined;
        return json(
          { group: registry.addGroup({ name, ...(color !== undefined ? { color } : {}) }) },
          201,
        );
      }
      if (method === "PUT") {
        const body = await readBody(req);
        const order = asStringArray(body["order"]);
        if (order !== undefined) return json({ groups: registry.reorderGroups(order) });
        const name = body["name"];
        if (typeof name !== "string" || name.length === 0) {
          throw new HttpError(400, 'missing "name" (or "order" array)');
        }
        const rename = typeof body["rename"] === "string" ? body["rename"] : undefined;
        const color = typeof body["color"] === "string" ? body["color"] : undefined;
        try {
          const group = registry.updateGroup(name, {
            ...(rename !== undefined ? { name: rename } : {}),
            ...(color !== undefined ? { color } : {}),
          });
          if (group === undefined) throw new HttpError(404, "no such group");
          return json({ group });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(409, err instanceof Error ? err.message : String(err));
        }
      }
      if (method === "DELETE") {
        const body = await readBody(req);
        const name = body["name"];
        if (typeof name !== "string" || name.length === 0) {
          throw new HttpError(400, 'missing "name"');
        }
        return json({ removed: registry.removeGroup(name) });
      }
      throw new HttpError(405, "method not allowed");
    }

    if (head === "registry" && rest[0] === "scan-roots" && rest.length === 1) {
      if (method === "GET") return json({ scanRoots: registry.listScanRoots() });
      if (method === "POST") {
        const body = await readBody(req);
        const dir = requireAbsoluteDir(body["dir"], "dir");
        const fields = {
          dir,
          ...(typeof body["depth"] === "number" ? { depth: body["depth"] } : {}),
          ...(typeof body["auto"] === "boolean" ? { auto: body["auto"] } : {}),
          ...(typeof body["rescanIntervalMin"] === "number"
            ? { rescanIntervalMin: body["rescanIntervalMin"] }
            : {}),
        };
        return json({ scanRoot: registry.addScanRoot(fields) }, 201);
      }
      if (method === "DELETE") {
        const body = await readBody(req);
        const dir = requireAbsoluteDir(body["dir"], "dir");
        return json({ removed: registry.removeScanRoot(dir) });
      }
      throw new HttpError(405, "method not allowed");
    }

    if (head === "scan" && rest.length === 0) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      return json(scanAll());
    }

    if (head === "costs" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return json(fleetCosts());
    }

    if (head === "h" && rest.length >= 1) {
      const entry = entryOr404(rest[0] as string);
      if (rest.length === 1) {
        if (method === "GET") return json(await detailView(entry));
        if (method === "DELETE") return json({ removed: registry.remove(entry.id) });
        throw new HttpError(405, "method not allowed");
      }
      return handleHarnessSub(req, url, entry, rest.slice(1));
    }

    throw new HttpError(404, "not found");
  };

  // ---- static shell -------------------------------------------------------

  const builtinIndex = (): Response => {
    const routes = [
      "GET  /healthz",
      "GET  /api/version",
      "GET  /api/harnesses[?hydrate=1]   POST /api/harnesses {dir}",
      "GET|POST|PUT|DELETE /api/registry/groups",
      "GET|POST|DELETE /api/registry/scan-roots",
      "POST /api/scan",
      "GET  /api/costs",
      "GET|DELETE /api/h/:id    POST /api/h/:id/relocate",
      "PUT  /api/h/:id/{groups,tags,pin,notes}",
      "GET  /api/h/:id/{spec,preflight,costs}",
      "GET  /api/h/:id/sessions[/:sess[?raw=1]]",
      "GET  /api/h/:id/evals[/:runId[/:sampleId]]",
      "GET  /api/h/:id/memory/{facts,wiki[/:slug],state,dream,watchme}",
    ];
    const items = routes.map((r) => `<li><code>${r}</code></li>`).join("\n");
    const html = `<!doctype html><meta charset="utf-8"><title>Hangar</title><h1>Hangar manager API (M1)</h1><p>No UI assets embedded in this build. Every <code>/api</code> route requires <code>Authorization: Bearer &lt;token&gt;</code>.</p><ul>${items}</ul>`;
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  };

  const serveStatic = (req: Request, pathname: string): Response => {
    if (req.method !== "GET") return errResponse(405, "method not allowed");
    const assets = opts.assets;
    if (assets !== undefined) {
      const asset = assets[pathname] ?? (pathname === "/" ? assets["/index.html"] : undefined);
      if (asset !== undefined) {
        return new Response(asset.body, {
          headers: {
            "content-type": asset.contentType,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
    }
    if (pathname === "/") return builtinIndex();
    return errResponse(404, "not found");
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;
    if (pathname === "/healthz") return json({ ok: true });

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      if (!noAuth) {
        if (tokenSetup === undefined || !isAuthorized(req, tokenSetup.token)) {
          return errResponse(401, "missing or invalid bearer token");
        }
      }
      let segs: string[];
      try {
        segs = pathname
          .split("/")
          .filter((s) => s !== "")
          .map((s) => decodeURIComponent(s));
      } catch {
        return errResponse(400, "malformed path encoding");
      }
      try {
        return await api(req, url, segs.slice(1));
      } catch (err) {
        if (err instanceof HttpError) return errResponse(err.status, err.message);
        onWarn(
          `hangar-server: unhandled route error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return errResponse(500, "internal error");
      }
    }

    return serveStatic(req, pathname);
  };

  const server = Bun.serve({
    port: opts.port ?? DEFAULT_HANGAR_PORT,
    hostname,
    development: false,
    fetch: handle,
  });

  const boundPort = server.port ?? 0;
  return {
    url: `http://${hostname}:${boundPort}`,
    port: boundPort,
    hostname,
    hangarRoot,
    registryPath: registry.path,
    ...(tokenSetup !== undefined ? { token: tokenSetup.token } : {}),
    ...(tokenSetup?.tokenPath !== undefined ? { tokenPath: tokenSetup.tokenPath } : {}),
    noAuth,
    stop: async () => {
      await server.stop(true);
    },
  };
}
