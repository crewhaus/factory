/**
 * v0.3.0 Goal 3 (design §4.4) — `crewhaus doctor --probe`'s Thredz check: a
 * live `wiki_stats` round-trip through the SAME synthesized (or
 * user-declared) `mcp_servers.thredz` config the run path boots, so what
 * passes here is exactly what a run will do. One cheap read call — no
 * writes, no quota consumption.
 *
 * Failures classify through the wiring layer's one error-mapping choke
 * point (`classifyThredzFailure`): a disabled key reports `thredz_billing`,
 * a plan cap `thredz_quota`, a missing THREDZ_API_KEY a `config` failure
 * naming the variable, and a server that won't boot `mcp_boot` — doctor's ✗
 * line names the fix class instead of dumping a raw MCP error.
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Target extraction is pure; the prober takes an injected `call` seam so
 * tests drive it without spawning a real server.
 */
import { lower } from "@crewhaus/compiler";
import {
  McpHost,
  type UnresolvedMcpServerConfig,
  resolveMcpServerConfig,
} from "@crewhaus/mcp-host";
import { classifyThredzFailure } from "@crewhaus/memory-service";
import { parseSpec } from "@crewhaus/spec";
import type { DoctorCredentialCheck } from "./doctor-checks";

/**
 * Extract the thredz MCP server config from a spec text, or undefined when
 * the spec has no `thredz:` block (or does not parse/lower — doctor's other
 * checks own spec validity; the probe never doubles up on those errors).
 */
export function thredzProbeTarget(specText: string): UnresolvedMcpServerConfig | undefined {
  try {
    const ir = lower(parseSpec(specText)) as {
      thredz?: unknown;
      mcp_servers?: Readonly<Record<string, UnresolvedMcpServerConfig>>;
    };
    if (ir.thredz === undefined) return undefined;
    return ir.mcp_servers?.["thredz"];
  } catch {
    return undefined;
  }
}

export type ThredzProbeResult = {
  readonly pass: boolean;
  /** Human-readable outcome ("wiki_stats ok (89ms)" / "thredz_billing — …"). */
  readonly detail: string;
  /** The classified failure (thredz_* | config | mcp_boot) on a miss. */
  readonly failureClass?: string;
};

export type ThredzProbeDeps = {
  /** Env consulted for the config's secret refs. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected clock for deterministic durations in tests. */
  readonly now?: () => number;
  /**
   * Injected call seam (tests): given the RESOLVED config, return the
   * `wiki_stats` result. Production spawns the configured server through
   * McpHost — the same transport the run path uses.
   */
  readonly call?: (config: {
    transport: string;
  }) => Promise<{ content: string; isError: boolean }>;
};

/** First line, capped — doctor rows stay one line. */
function firstLine(text: string, cap = 160): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

/** Run the live `wiki_stats` round-trip against the configured server. */
export async function probeThredz(
  config: UnresolvedMcpServerConfig,
  deps: ThredzProbeDeps = {},
): Promise<ThredzProbeResult> {
  const now = deps.now ?? ((): number => performance.now());
  const startMs = now();

  // Secret resolution first: a missing THREDZ_API_KEY is a `config` failure
  // that NAMES the variable (the §4.4 boot contract), not a server error.
  let resolved: ReturnType<typeof resolveMcpServerConfig>;
  try {
    resolved = resolveMcpServerConfig(config, {
      name: "thredz",
      ...(deps.env !== undefined ? { env: deps.env } : {}),
    });
  } catch (err) {
    return { pass: false, failureClass: "config", detail: `config — ${(err as Error).message}` };
  }

  let result: { content: string; isError: boolean };
  const host = new McpHost();
  try {
    if (deps.call !== undefined) {
      result = await deps.call(resolved);
    } else {
      const client = host.addServer("thredz", resolved);
      await client.connect();
      result = await client.callTool("wiki_stats", {});
    }
  } catch (err) {
    return {
      pass: false,
      failureClass: "mcp_boot",
      detail: `mcp_boot — ${firstLine((err as Error).message)}`,
    };
  } finally {
    await host.disconnectAll();
  }

  if (result.isError) {
    const failureClass = classifyThredzFailure(result.content);
    return { pass: false, failureClass, detail: `${failureClass} — ${firstLine(result.content)}` };
  }
  return { pass: true, detail: `wiki_stats ok (${Math.round(now() - startMs)}ms)` };
}

/** Fold the probe result into doctor's ✓/✗ check shape. */
export function thredzProbeToCheck(result: ThredzProbeResult): DoctorCredentialCheck {
  return result.pass
    ? { label: `live probe: thredz (wiki_stats) — ${result.detail}`, pass: true }
    : { label: "live probe: thredz (wiki_stats)", pass: false, reason: result.detail };
}
