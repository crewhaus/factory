import { LOCAL_DEFAULT_BASE_URL } from "@crewhaus/model-router";

/**
 * Item 40 — `crewhaus doctor --detect`. The read-only INVENTORY half of the
 * "doctor that detects and fixes" pair (the mutating half is `doctor-fix.ts`).
 *
 * Nothing in the CLI reads a local Ollama/vLLM endpoint, a `.mcp.json`, or a
 * Claude Desktop config today — `doctor` only checks whether the cwd spec's
 * provider env is set. `--detect` builds an inventory of what's ACTUALLY
 * available so `init --interactive` (#39) can prefill model/mcp choices and an
 * operator can see, in one command, which providers/models/servers they can
 * reach without editing a spec first.
 *
 * Side-effect-free and directly unit-testable, mirroring `doctor-checks.ts` /
 * `scope-audit.ts`: every ambient dependency (env, fs reads, the localhost
 * HTTP probe) is an INJECTED seam so tests drive the inventory from fixtures
 * with no real network or filesystem.
 */

/** A reachable model provider inferred purely from visible env vars. */
export type DetectedProvider = {
  readonly id: "anthropic" | "openai" | "gemini" | "bedrock";
  readonly label: string;
  /** The env var(s) that made this provider look reachable. */
  readonly via: readonly string[];
};

/** An MCP server discovered in a `.mcp.json` or Claude Desktop config. */
export type DetectedMcpServer = {
  readonly name: string;
  readonly source: string;
  readonly transport: "stdio" | "sse" | "unknown";
  /** stdio command (best-effort) or sse url, for the operator's eyes. */
  readonly detail?: string;
};

/** A local OpenAI-compatible endpoint (Ollama / vLLM / LM Studio, …). */
export type DetectedLocalEndpoint = {
  readonly baseUrl: string;
  readonly reachable: boolean;
  /** Model ids the endpoint advertises at `/models`, when reachable. */
  readonly models: readonly string[];
  /** Populated when the probe failed — why it is not reachable. */
  readonly error?: string;
};

export type DetectInventory = {
  readonly providers: readonly DetectedProvider[];
  readonly local: DetectedLocalEndpoint;
  readonly mcpServers: readonly DetectedMcpServer[];
};

function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return typeof v === "string" && v !== "";
}

/**
 * Infer which model providers are reachable from visible env vars alone. This
 * shares the credential-name tables with `doctor-checks.ts` but answers a
 * different question: not "does the cwd spec's provider have creds" but "which
 * providers COULD I use right now". Bedrock's default credential chain (IRSA /
 * instance profile / ~/.aws) is not inspected here — only the env surface — so
 * a machine on an instance profile with no AWS env vars reports no bedrock,
 * which is the honest offline answer.
 */
export function detectProviders(env: NodeJS.ProcessEnv): DetectedProvider[] {
  const out: DetectedProvider[] = [];
  const anthropicVia = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"].filter((n) => isSet(env, n));
  if (anthropicVia.length > 0) {
    out.push({ id: "anthropic", label: "Anthropic", via: anthropicVia });
  }
  const openaiVia = ["OPENAI_API_KEY", "OPENAI_BASE_URL"].filter((n) => isSet(env, n));
  if (openaiVia.length > 0) {
    out.push({ id: "openai", label: "OpenAI (or OpenAI-compatible)", via: openaiVia });
  }
  const geminiVia = [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_CLOUD_PROJECT",
  ].filter((n) => isSet(env, n));
  if (geminiVia.length > 0) {
    out.push({ id: "gemini", label: "Gemini", via: geminiVia });
  }
  const bedrockVia = [
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "AWS_REGION",
  ].filter((n) => isSet(env, n));
  if (bedrockVia.length > 0) {
    out.push({ id: "bedrock", label: "Bedrock (AWS)", via: bedrockVia });
  }
  return out;
}

/**
 * The base URL the local probe hits: `OPENAI_BASE_URL` when set (a vLLM /
 * LM Studio endpoint the operator already pointed at), else the router's
 * `LOCAL_DEFAULT_BASE_URL` (`http://localhost:11434/v1`, the Ollama default
 * that `local/<m>@<url>` bakes in when no `@url` is given).
 */
export function localBaseUrl(env: NodeJS.ProcessEnv): string {
  const override = env["OPENAI_BASE_URL"];
  if (typeof override === "string" && override !== "") return override;
  return LOCAL_DEFAULT_BASE_URL;
}

/** Injected HTTP seam so the localhost probe is testable without a network. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Probe an OpenAI-compatible endpoint's `/models` list. Ollama, vLLM, and
 * LM Studio all serve `GET <base>/models` → `{ data: [{ id }, …] }`. Never
 * throws: an unreachable endpoint (connection refused, timeout, non-200,
 * malformed body) yields `{ reachable: false, models: [], error }` so
 * `--detect` degrades to a one-line "not running" note rather than failing.
 */
export async function probeLocalEndpoint(
  baseUrl: string,
  fetchImpl: FetchLike,
): Promise<DetectedLocalEndpoint> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      return { baseUrl, reachable: false, models: [], error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models =
      Array.isArray(body?.data) === true
        ? body.data
            .map((m) => m?.id)
            .filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
    return { baseUrl, reachable: true, models };
  } catch (err) {
    return { baseUrl, reachable: false, models: [], error: (err as Error).message };
  }
}

/**
 * Parse an MCP server map out of a `.mcp.json` (Claude Code / crewhaus format:
 * `{ mcpServers: { name: { command | url, … } } }`) or a Claude Desktop config
 * (identical `mcpServers` shape). Tolerant: a malformed file, a missing
 * `mcpServers` key, or a non-object entry contributes nothing rather than
 * throwing — `--detect` must never fail because a config file is junk.
 */
export function parseMcpConfig(text: string, source: string): DetectedMcpServer[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return [];
  }
  if (root === null || typeof root !== "object") return [];
  const servers = (root as { mcpServers?: unknown }).mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return [];
  const out: DetectedMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object") {
      out.push({ name, source, transport: "unknown" });
      continue;
    }
    const cfg = raw as { command?: unknown; url?: unknown; args?: unknown };
    if (typeof cfg.url === "string" && cfg.url !== "") {
      out.push({ name, source, transport: "sse", detail: cfg.url });
    } else if (typeof cfg.command === "string" && cfg.command !== "") {
      const args = Array.isArray(cfg.args) ? cfg.args.filter((a) => typeof a === "string") : [];
      const detail = [cfg.command, ...args].join(" ");
      out.push({ name, source, transport: "stdio", detail });
    } else {
      out.push({ name, source, transport: "unknown" });
    }
  }
  return out;
}

/**
 * Assemble the full inventory. `readConfig(path)` returns the file text or
 * `undefined` when absent/unreadable (injected fs seam); `configPaths` is the
 * ordered list of MCP config locations to inspect (cwd `.mcp.json` first, then
 * the platform Claude Desktop config). Deterministic and pure given its seams.
 */
export async function buildInventory(opts: {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: FetchLike;
  readonly readConfig: (path: string) => string | undefined;
  readonly configPaths: readonly string[];
  /** Skip the localhost probe (e.g. `--detect --no-probe`); default probes. */
  readonly skipProbe?: boolean;
}): Promise<DetectInventory> {
  const providers = detectProviders(opts.env);
  const baseUrl = localBaseUrl(opts.env);
  const local =
    opts.skipProbe === true
      ? { baseUrl, reachable: false, models: [], error: "probe skipped" }
      : await probeLocalEndpoint(baseUrl, opts.fetchImpl);
  const mcpServers: DetectedMcpServer[] = [];
  const seen = new Set<string>();
  for (const path of opts.configPaths) {
    const text = opts.readConfig(path);
    if (text === undefined) continue;
    for (const server of parseMcpConfig(text, path)) {
      // De-dup by (source-independent) name so the same server declared in
      // both .mcp.json and Claude Desktop shows once, first source winning.
      if (seen.has(server.name)) continue;
      seen.add(server.name);
      mcpServers.push(server);
    }
  }
  return { providers, local, mcpServers };
}

/** Render the inventory as the human-readable `--detect` report block. */
export function formatInventory(inv: DetectInventory): string {
  const lines: string[] = [];
  lines.push("inventory (what's reachable right now):");
  lines.push("");
  lines.push("  model providers (from env):");
  if (inv.providers.length === 0) {
    lines.push("    (none — no provider env vars visible)");
  } else {
    for (const p of inv.providers) {
      lines.push(`    ✓ ${p.label} — via ${p.via.join(", ")}`);
    }
  }
  lines.push("");
  lines.push(`  local endpoint (${inv.local.baseUrl}):`);
  if (inv.local.reachable) {
    if (inv.local.models.length === 0) {
      lines.push("    ✓ reachable, but advertises no models");
    } else {
      lines.push(`    ✓ reachable — ${inv.local.models.length} model(s):`);
      for (const m of inv.local.models) lines.push(`        ${m}`);
    }
  } else {
    lines.push(`    ✗ not reachable (${inv.local.error ?? "unknown"})`);
  }
  lines.push("");
  lines.push("  MCP servers (from .mcp.json / Claude Desktop config):");
  if (inv.mcpServers.length === 0) {
    lines.push("    (none found)");
  } else {
    for (const s of inv.mcpServers) {
      const detail = s.detail !== undefined ? ` — ${s.detail}` : "";
      lines.push(`    • ${s.name} [${s.transport}]${detail}  (${s.source})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The platform-specific default Claude Desktop config path. macOS and Windows
 * only — Linux has no official Claude Desktop build, so it returns undefined
 * and the inventory just skips that source.
 */
export function claudeDesktopConfigPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    const home = env["HOME"];
    if (home === undefined || home === "") return undefined;
    return `${home}/Library/Application Support/Claude/claude_desktop_config.json`;
  }
  if (platform === "win32") {
    const appData = env["APPDATA"];
    if (appData === undefined || appData === "") return undefined;
    return `${appData}\\Claude\\claude_desktop_config.json`;
  }
  return undefined;
}
