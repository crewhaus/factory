/**
 * v0.3.0 Goal 3 — the Thredz side of the composition root (design §4.3/§4.4,
 * PR 16). One authenticated channel (the already-connected McpHost client for
 * the synthesized `thredz` server), one error-mapping choke point
 * ({@link classifyThredzFailure}), one tool vocabulary (the bare-name aliases
 * `registerMcpToolAliases` puts on the catalog).
 *
 * ## What flips, what stays local (§4.3, resolved decision 5)
 *
 *   - The WIKI backend flips: the ten `wiki_*`/`log_knowledge_gap` tools plus
 *     the `goal_*`/`task_*` vocabulary route to the thredz-mcp server under
 *     their bare names; the local `tool-wiki` twins are NOT registered (the
 *     alias path collision-guards this). The local wiki store on disk is
 *     untouched — removing `thredz:` reverts to files (§5).
 *   - GOALS stay local AND mirror: continuity goal writes go to the local
 *     store first (authoritative — the `<current_plan>` tail renders from
 *     it), then best-effort to Thredz `goal_write`/`goal_update`. Spec scope
 *     ONLY (§14.5: a per-conversation goal would burn the free plan's 3-goal
 *     quota immediately).
 *   - Focus + ledger + dream state + facts stay local always.
 *
 * ## Failure semantics (§4.4): degrade, never halt
 *
 * A lapsed Thredz subscription must never kill a local-first harness. Boot
 * failure (`npx` offline, server crash) degrades to the local backend with a
 * warning; per-call mirror failures skip-and-warn with a classified line
 * (`thredz_quota` on the free plan's 3-goal cap — never a crash); the local
 * write has ALWAYS already succeeded by the time a mirror runs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContinuityStore } from "@crewhaus/continuity-store";
import type { McpHost } from "@crewhaus/mcp-host";
import { createPiiRedactor } from "@crewhaus/pii-redactor";
import type { ToolCatalog } from "@crewhaus/tool-catalog";
import { type McpToolFlags, registerMcpToolAliases } from "@crewhaus/tool-mcp";
import { THREDZ_WIKI_TOOL_NAMES } from "@crewhaus/tool-wiki";

/** The synthesized MCP server's name (compiler `THREDZ_MCP_SERVER_NAME`
 *  twin — kept literal here so the runtime package stays IR/compiler-free). */
export const THREDZ_SERVER_NAME = "thredz";

/**
 * The goals/tasks vocabulary thredz-mcp v0.2.0 advertises (server.ts TOOLS)
 * — the durable cross-session plan surface (§4.3). Pinned like
 * `THREDZ_WIKI_TOOL_NAMES`; a drifted name would silently fork the skill
 * vocabulary between backends.
 */
export const THREDZ_GOAL_TOOL_NAMES = [
  "goal_list",
  "goal_get",
  "goal_write",
  "goal_update",
  "task_list",
  "task_complete",
] as const;

/** 0.5.0 — the two space-management tools. Remote-ONLY on purpose: a space is
 *  a Thredz account boundary with no local twin, so these are deliberately not
 *  in `THREDZ_WIKI_TOOL_NAMES` (the local/remote parity list that
 *  `backend-conformance` asserts `createWikiTools` matches exactly). Against a
 *  pre-0.3.0 server they simply come back in `registerMcpToolAliases`'
 *  `missing` list and `connectThredz` warns — never a hard failure. */
export const THREDZ_SPACE_TOOL_NAMES: readonly string[] = ["wiki_space_list", "wiki_space_create"];

/** Every bare name the Thredz backend aliases onto the catalog (§4.3): the
 *  ten wiki-vocabulary tools + the six goal/task tools + the two space tools.
 *  Messaging tools are deliberately NOT exposed — the memory knob never widens
 *  the outward surface beyond the memory vocabulary. */
export const THREDZ_ALIAS_TOOL_NAMES: readonly string[] = [
  ...THREDZ_WIKI_TOOL_NAMES,
  ...THREDZ_GOAL_TOOL_NAMES,
  ...THREDZ_SPACE_TOOL_NAMES,
];

/**
 * Per-alias tool flags — mirrors of the LOCAL twins' flags in
 * `@crewhaus/tool-wiki` / the goal tools' intent, so the backend flip never
 * relaxes a permission posture: `wiki_write`/`wiki_set_signals` keep their
 * Pillar 3 justification gate, `log_knowledge_gap` stays the un-gated honest
 * path, reads stay readOnly.
 */
export const THREDZ_ALIAS_TOOL_FLAGS: Readonly<Record<string, McpToolFlags>> = {
  wiki_recall: { readOnly: true },
  wiki_semantic_search: { readOnly: true },
  wiki_search: { readOnly: true },
  wiki_get: { readOnly: true },
  wiki_write: { destructive: true, requireJustification: true },
  wiki_list: { readOnly: true },
  wiki_related: { readOnly: true },
  wiki_set_signals: { destructive: true, requireJustification: true },
  wiki_stats: { readOnly: true },
  // Creating a space consumes plan quota and can 402/409, so it carries the
  // same justification gate as a durable write; listing is a plain read.
  wiki_space_list: { readOnly: true },
  wiki_space_create: { destructive: true, requireJustification: true },
  log_knowledge_gap: { destructive: true },
  goal_list: { readOnly: true },
  goal_get: { readOnly: true },
  goal_write: { destructive: true },
  goal_update: { destructive: true },
  task_list: { readOnly: true },
  task_complete: { destructive: true },
};

/** Structural mirror of mcp-host's `McpCallResult`. */
export type ThredzCallResult = { readonly content: string; readonly isError: boolean };

/** The one authenticated channel (§4.3) — structurally `McpClient`, injected
 *  so tests drive the wiring with an in-process fake honoring the same
 *  contract. */
export type ThredzClient = {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<ThredzCallResult>;
};

/** A live Thredz connection, as produced by {@link connectThredz} and
 *  consumed by `wireMemory` (`deps.thredz`). */
export type ThredzConnection = { readonly client: ThredzClient };

// ---------------------------------------------------------------------------
// §4.4 — the one error-mapping choke point
// ---------------------------------------------------------------------------

/**
 * The Thredz failure classes (§4.4/§8.2). Unlike the provider classes in
 * recovery-engine's `BUILTIN_FAILURE_CLASSES` these are NEVER terminal —
 * Thredz codes degrade the memory backend, they never kill the run — so they
 * live here at the wiring layer's choke point, not in the halt table.
 */
export type ThredzFailureClass =
  | "thredz_auth"
  | "thredz_billing"
  | "thredz_quota"
  | "thredz_conflict"
  | "thredz_rate_limit"
  | "thredz_unavailable";

/**
 * Map a thredz-mcp error text onto a failure class. thredz-mcp v0.2.0's
 * `present()` renders every failure as `<label> failed (HTTP <status>)[ —
 * <remediation>]:\n<raw body>` — we key on the STATUS (and the body's
 * machine `code` field where the API sends one), not the remediation prose,
 * so wording changes upstream cannot reclassify a failure:
 *   - 401 / 403                     → thredz_auth (bad or missing key)
 *   - 403 + "disabled"              → thredz_billing (lapsed subscription)
 *   - 402 (code quota_exceeded /
 *     upgrade_required)             → thredz_quota (plan caps, e.g. 3 goals
 *                                     on the free tier)
 *   - 409 (stale_article_version,
 *     ambiguous_article_slug,
 *     individual_space_exists)      → thredz_conflict (the CALLER can fix this
 *                                     by retrying differently — it is not an
 *                                     outage, and calling it one sent every
 *                                     spaces conflict down the "backend is
 *                                     down, degrade to files" path)
 *   - 429                           → thredz_rate_limit
 *   - HTTP 0 + missing-key text     → thredz_auth (the server's pre-flight)
 *   - anything else (network, …)    → thredz_unavailable
 *
 * ORDER MATTERS: `space_quota_exceeded` is a 402 and must classify as quota,
 * so the 402 test stays ahead of the 409 test.
 */
export function classifyThredzFailure(text: string): ThredzFailureClass {
  const statusMatch = /\(HTTP (\d+)\)/.exec(text);
  const status = statusMatch?.[1] !== undefined ? Number.parseInt(statusMatch[1], 10) : undefined;
  const codeMatch = /"code"\s*:\s*"([a-z_]+)"/.exec(text);
  const code = codeMatch?.[1];
  if (status === 402 || code === "quota_exceeded" || code === "upgrade_required") {
    return "thredz_quota";
  }
  if (status === 403 && /disabled/i.test(text)) return "thredz_billing";
  if (status === 401 || status === 403) return "thredz_auth";
  if (
    status === 409 ||
    code === "stale_article_version" ||
    code === "ambiguous_article_slug" ||
    code === "individual_space_exists"
  ) {
    return "thredz_conflict";
  }
  if (status === 429) return "thredz_rate_limit";
  if (/THREDZ_API_KEY is not set/.test(text)) return "thredz_auth";
  return "thredz_unavailable";
}

/** First line of an error text, capped — warning lines stay one line. */
function firstLine(text: string, cap = 200): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

// ---------------------------------------------------------------------------
// boot — alias registration + optional agent handle (§4.1 `agents`)
// ---------------------------------------------------------------------------

export type ConnectThredzOptions = {
  /** Register this addressable handle at boot (idempotent get-or-create
   *  `agent_register`, the §2.8 session-resumption anchor). */
  readonly agentName?: string;
  /** Status-line sink for `[thredz] …` boot lines. */
  readonly log?: (line: string) => void;
};

/**
 * Boot the Thredz backend over an `McpHost` that already carries the
 * `thredz` server config: connect, register the wiki+goals vocabulary as
 * bare-name aliases on the catalog, and (optionally) register the agent
 * handle. Returns the connection `wireMemory` consumes as `deps.thredz`, or
 * **null on boot failure** — the §4.4 degrade: the caller passes the null
 * through and `wireMemory` falls back to the local backend with a warning,
 * never a crash. Call BEFORE `wireMemory` so the alias collision guard sees
 * an empty vocabulary slot.
 */
export async function connectThredz(
  host: McpHost,
  catalog: ToolCatalog,
  opts: ConnectThredzOptions = {},
): Promise<ThredzConnection | null> {
  let registration: Awaited<ReturnType<typeof registerMcpToolAliases>>;
  try {
    registration = await registerMcpToolAliases(
      host,
      THREDZ_SERVER_NAME,
      catalog,
      THREDZ_ALIAS_TOOL_NAMES,
      {
        perTool: THREDZ_ALIAS_TOOL_FLAGS,
        onRegister: ({ fullName }) => opts.log?.(`[thredz] registered ${fullName}\n`),
      },
    );
  } catch (err) {
    // §4.4 — a boot failure (npx offline, server crash, bad command) is the
    // mcp_boot class and DEGRADES: the harness keeps running on local files.
    opts.log?.(
      `[thredz] boot failed (mcp_boot): ${firstLine((err as Error).message)} — degraded to the local backend for this run; local stores under .crewhaus/ stay authoritative\n`,
    );
    return null;
  }
  if (registration.missing.length > 0) {
    opts.log?.(
      `[thredz] server does not advertise ${registration.missing.join(", ")} — vendored/older server? The wired contract is thredz-mcp v0.2.0\n`,
    );
  }
  const client = host.getClient(THREDZ_SERVER_NAME);
  if (opts.agentName !== undefined) {
    try {
      const res = await client.callTool("agent_register", { name: opts.agentName });
      if (res.isError) {
        opts.log?.(
          `[thredz] agent_register "${opts.agentName}" failed (${classifyThredzFailure(res.content)}) — continuing without a registered handle\n`,
        );
      } else {
        opts.log?.(`[thredz] agent handle registered: ${opts.agentName}\n`);
      }
    } catch (err) {
      opts.log?.(
        `[thredz] agent_register "${opts.agentName}" failed (thredz_unavailable): ${firstLine((err as Error).message)} — continuing without a registered handle\n`,
      );
    }
  }
  return { client };
}

// ---------------------------------------------------------------------------
// wiki recall over the MCP client (§4.3 — the auto-recall fusion seam)
// ---------------------------------------------------------------------------

/** Cap on a fused recall body — recall is a pointer surface (`wiki_get`
 *  fetches the full article). Mirrors the local wireMemory excerpt cap. */
const THREDZ_RECALL_EXCERPT_CHARS = 280;

function thredzExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > THREDZ_RECALL_EXCERPT_CHARS
    ? `${flat.slice(0, THREDZ_RECALL_EXCERPT_CHARS)}…`
    : flat;
}

/**
 * Best-effort parse of `wiki_recall`'s context bundle (GET /wiki/context)
 * into the SAME `[wiki:<slug>] <title> — <excerpt>` line shape the local
 * backend fuses into `<recalled_memory>`, so the recall bundle is
 * backend-invariant. Falls back to one excerpted line when the body is not
 * the recognized JSON shape. The runtime classifies + delimiter-escapes the
 * assembled block downstream (the same path local fact/wiki lines take), so
 * recalled Thredz bodies still cross the boundary classifier before any
 * model call.
 */
export function parseThredzRecallLines(content: string, k: number): readonly string[] {
  const trimmed = content.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [`[thredz:wiki] ${thredzExcerpt(trimmed)}`];
  }
  const items = extractRecallItems(parsed);
  if (items.length === 0) return [`[thredz:wiki] ${thredzExcerpt(trimmed)}`];
  return items.slice(0, k).map((item) => {
    const slug = typeof item.slug === "string" ? item.slug : "unknown";
    const title = typeof item.title === "string" ? item.title : slug;
    const body =
      typeof item.body === "string"
        ? item.body
        : typeof item.summary === "string"
          ? item.summary
          : typeof item.excerpt === "string"
            ? item.excerpt
            : "";
    return `[wiki:${slug}] ${title}${body !== "" ? ` — ${thredzExcerpt(body)}` : ""}`;
  });
}

type RecallItem = {
  slug?: unknown;
  title?: unknown;
  body?: unknown;
  summary?: unknown;
  excerpt?: unknown;
};

function extractRecallItems(parsed: unknown): RecallItem[] {
  if (Array.isArray(parsed)) return parsed.filter(isRecord) as RecallItem[];
  if (!isRecord(parsed)) return [];
  for (const key of ["results", "articles", "hits", "context"]) {
    const value = parsed[key];
    if (Array.isArray(value)) return value.filter(isRecord) as RecallItem[];
  }
  // A single article object.
  if ("slug" in parsed || "title" in parsed) return [parsed as RecallItem];
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// goal mirror (§4.4 / resolved decision 5 — spec scope only)
// ---------------------------------------------------------------------------

/** The local-id → Thredz-id map file, kept inside the continuity store's own
 *  scoped directory so tenancy/scoping fences apply for free. */
export const THREDZ_GOAL_MAP_FILE = "thredz-goals.json";

export type ThredzGoalMirrorOptions = {
  readonly client: ThredzClient;
  readonly specName: string;
  readonly log?: (line: string) => void;
};

function readGoalMap(path: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeGoalMap(path: string, map: Record<string, string>): void {
  try {
    writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`);
  } catch {
    // Best-effort bookkeeping — a failed map write only costs a future
    // mirror update (skip + warn), never the local goal.
  }
}

/** Pull the created goal's id out of a `goal_write` response body (Thredz
 *  returns the Mongo document — `_id` — or a wrapped `{goal: {...}}`). */
export function extractThredzGoalId(content: string): string | undefined {
  try {
    let parsed: unknown = JSON.parse(content.trim());
    if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0]; // single-element-array quirk
    if (isRecord(parsed)) {
      const doc = isRecord(parsed["goal"]) ? (parsed["goal"] as Record<string, unknown>) : parsed;
      const id = doc["_id"] ?? doc["id"];
      if (typeof id === "string" && id !== "") return id;
    }
  } catch {
    // fall through to the regex
  }
  const m = /"_?id"\s*:\s*"([^"]+)"/.exec(content);
  return m?.[1];
}

/**
 * Wrap a `ContinuityStore` so goal writes mirror to Thredz (§2.2: goals.yaml
 * is "the local mirror of Thredz goals" — the local write is authoritative
 * and ALWAYS lands first; the mirror is best-effort). Failures skip with one
 * classified warning line and never throw; a skipped `goal_write` also skips
 * later `goal_update`s for that goal (no remote id to address). Mirrored
 * titles pass through the PII redactor before leaving the machine — the
 * mirror is a programmatic egress that bypasses the tool-level fabric, so
 * redact-on-write applies here (§4.3).
 */
export function withThredzGoalMirror(
  store: ContinuityStore,
  opts: ThredzGoalMirrorOptions,
): ContinuityStore {
  const mapPath = join(store.dir(), THREDZ_GOAL_MAP_FILE);
  const redactor = createPiiRedactor();
  const warn = (op: string, detail: string): void => {
    const klass = classifyThredzFailure(detail);
    const quotaNote =
      klass === "thredz_quota"
        ? " (plan limit — e.g. 3 goals on the free tier; upgrade or clear unused goals)"
        : "";
    opts.log?.(
      `[thredz] goal mirror ${op} skipped (${klass})${quotaNote} — the local goal is saved; ${firstLine(detail)}\n`,
    );
  };

  return {
    ...store,
    async writeGoal(input) {
      const goal = await store.writeGoal(input);
      try {
        const res = await opts.client.callTool("goal_write", {
          title: (await redactor.redact(goal.title)).text,
          description: `Mirrored from CrewHaus harness "${opts.specName}" (${goal.id})`,
          ...(goal.target !== undefined ? { targetValue: goal.target } : {}),
          ...(goal.current !== undefined ? { currentValue: goal.current } : {}),
          tags: ["crewhaus"],
          // A retried create can't duplicate — the id is stable per local goal.
          idempotencyKey: `crewhaus:${opts.specName}:${goal.id}`,
        });
        if (res.isError) {
          warn("goal_write", res.content);
        } else {
          const remoteId = extractThredzGoalId(res.content);
          if (remoteId !== undefined) {
            writeGoalMap(mapPath, { ...readGoalMap(mapPath), [goal.id]: remoteId });
          }
        }
      } catch (err) {
        warn("goal_write", (err as Error).message);
      }
      return goal;
    },
    async updateGoal(goalId, patch) {
      const goal = await store.updateGoal(goalId, patch);
      const remoteId = readGoalMap(mapPath)[goalId];
      if (remoteId === undefined) {
        // The create mirror was skipped (offline/quota) — nothing to address.
        opts.log?.(
          `[thredz] goal mirror goal_update skipped — ${goalId} has no mirrored Thredz id (its create was not mirrored)\n`,
        );
        return goal;
      }
      const body: Record<string, unknown> = { id: remoteId };
      if (patch.title !== undefined) body["title"] = (await redactor.redact(goal.title)).text;
      if (patch.target !== undefined) body["targetValue"] = goal.target;
      if (patch.current !== undefined) body["currentValue"] = goal.current;
      if (goal.status === "proven") {
        // Thredz goals complete when currentValue reaches targetValue — a
        // proven local goal completes its mirror deterministically.
        body["targetValue"] = goal.target ?? 1;
        body["currentValue"] = goal.target ?? 1;
      }
      if (Object.keys(body).length === 1) return goal; // nothing mirrorable changed
      try {
        const res = await opts.client.callTool("goal_update", body);
        if (res.isError) warn("goal_update", res.content);
      } catch (err) {
        warn("goal_update", (err as Error).message);
      }
      return goal;
    },
  };
}
