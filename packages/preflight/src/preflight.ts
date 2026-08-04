/**
 * The composition root: `runPreflight` runs every area against one
 * injected environment and returns the typed report a manager renders
 * before spawning a harness process.
 *
 * Area order (and therefore item order): spec → credentials → channels →
 * mcp → ports → bundle → durability.
 *
 * Classification stances, chosen to match what the spawn would actually do:
 *
 *   - EVERY `parseSpecIssues` diagnostic is blocking. `parseSpec` (and so
 *     the compiler) throws on all of them — YAML syntax, schema failures,
 *     and cross-field invariants alike — so a spec with any issue cannot
 *     compile, and "warn and spawn anyway" would just relocate the failure
 *     into a stack trace. Softer, non-fatal signals arrive as INJECTED
 *     compile warnings (`compileWarnings`), which map to warn: the caller
 *     may run the compiler and pass its accepted-but-unwired-key warnings
 *     through; this package deliberately does not depend on the compiler.
 *   - Missing channel secrets and missing model credentials are blocking
 *     (the compiled daemon's own startup checks exit 2 on the same sets).
 *   - Ambient-credential providers (bedrock, vertex, local) are info.
 *   - Bundle staleness and durability findings are warn.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSpec, parseSpecIssues } from "@crewhaus/spec";
import {
  type FreshnessComparator,
  bundleFreshnessItem,
  compareBundleFreshnessByMtime,
} from "./bundle";
import { channelItems, lowerSpecChannels } from "./channels";
import { collectSpecModels, hasLiveProviderCredentials, modelCredentialItems } from "./credentials";
import { durabilityItems } from "./durability";
import { type McpServersSpec, mcpDryRunItems } from "./mcp";
import { type PortChecker, type PortRequest, checkPortFree, portItems } from "./ports";
import {
  type PreflightEnv,
  type PreflightItem,
  type PreflightReport,
  buildReport,
  isEnvSet,
} from "./types";

export type RunPreflightOptions = {
  /** Harness root (the directory holding crewhaus.yaml). Optional when
   *  `specYaml` is supplied directly; without it the bundle-freshness area
   *  is skipped. */
  readonly harnessDir?: string;
  /** The environment every check runs against — pass the MERGED env the
   *  spawn would receive (harness `.env` chain under the manager env), not
   *  necessarily `process.env`. */
  readonly env: PreflightEnv;
  /** Spec text; defaults to reading `<harnessDir>/crewhaus.yaml`. */
  readonly specYaml?: string;
  /** Compiler warnings the caller collected (this package does not run the
   *  compiler itself) — surfaced as warn items in the spec area. */
  readonly compileWarnings?: readonly string[];
  /** Extra ports to check (e.g. the allocator's chosen PORT and control
   *  port) beyond what the spec/env declare. */
  readonly ports?: readonly PortRequest[];
  /** Freshness comparator; defaults to the approximate mtime heuristic.
   *  Swap in a spec-hash comparator once bundle manifests record one. */
  readonly freshness?: FreshnessComparator;
  /** Port checker; defaults to a real bind probe. Injectable for tests and
   *  for managers with their own port ledger. */
  readonly checkPort?: PortChecker;
};

type LooseSpec = Record<string, unknown>;

function tolerantParse(specYaml: string): LooseSpec | undefined {
  try {
    return parseSpec(specYaml) as unknown as LooseSpec;
  } catch {
    return undefined;
  }
}

function specAreaItems(
  specYaml: string | undefined,
  readError: string | undefined,
  compileWarnings: readonly string[],
): PreflightItem[] {
  const items: PreflightItem[] = [];
  if (readError !== undefined) {
    items.push({
      id: "spec.missing",
      area: "spec",
      level: "blocking",
      message: readError,
      remediation: "run preflight from a harness root containing crewhaus.yaml",
    });
  } else if (specYaml !== undefined) {
    const issues = parseSpecIssues(specYaml);
    issues.forEach((issue, i) => {
      const at = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      items.push({
        id: `spec.issue.${i}`,
        area: "spec",
        level: "blocking",
        message: `spec does not compile${at}: ${issue.message}`,
      });
    });
    if (issues.length === 0) {
      items.push({
        id: "spec.ok",
        area: "spec",
        level: "info",
        message: "crewhaus.yaml parses cleanly",
      });
    }
  }
  compileWarnings.forEach((warning, i) => {
    items.push({
      id: `spec.compile-warning.${i}`,
      area: "spec",
      level: "warn",
      message: `compiler warning: ${warning}`,
    });
  });
  return items;
}

function collectPortRequests(
  spec: LooseSpec | undefined,
  env: PreflightEnv,
  extra: readonly PortRequest[],
): PortRequest[] {
  const requests: PortRequest[] = [...extra];
  const gateway = spec?.["gateway"];
  if (typeof gateway === "object" && gateway !== null) {
    const port = (gateway as Record<string, unknown>)["port"];
    if (typeof port === "number" && Number.isInteger(port)) {
      requests.push({ port, source: "spec gateway.port" });
    }
  }
  const envPort = env["PORT"];
  if (envPort !== undefined && /^\d+$/.test(envPort)) {
    requests.push({ port: Number(envPort), source: "env PORT" });
  }
  return requests;
}

/**
 * Run every preflight area and assemble the typed report. Pure with
 * respect to the environment (only the injected `env` is consulted); the
 * filesystem is touched only to read `crewhaus.yaml` (when `specYaml` is
 * not supplied) and to stat the bundle (when `harnessDir` is supplied),
 * and the network is never touched — every check is the offline
 * counterpart of its live cousin.
 */
export async function runPreflight(opts: RunPreflightOptions): Promise<PreflightReport> {
  let specYaml = opts.specYaml;
  let readError: string | undefined;
  if (specYaml === undefined && opts.harnessDir !== undefined) {
    const specPath = join(opts.harnessDir, "crewhaus.yaml");
    try {
      specYaml = readFileSync(specPath, "utf8");
    } catch {
      readError = `crewhaus.yaml not found or unreadable at ${specPath}`;
    }
  } else if (specYaml === undefined) {
    readError = "no spec supplied — pass specYaml or harnessDir";
  }

  const items: PreflightItem[] = [];

  // spec
  items.push(...specAreaItems(specYaml, readError, opts.compileWarnings ?? []));

  const spec = specYaml !== undefined ? tolerantParse(specYaml) : undefined;

  // credentials
  const models = collectSpecModels(spec);
  items.push(...modelCredentialItems(models, opts.env));

  // channels
  if (spec !== undefined && spec["target"] === "channel") {
    items.push(...channelItems(lowerSpecChannels(spec["channels"]), opts.env));
  }

  // mcp
  items.push(...mcpDryRunItems(spec?.["mcp_servers"] as McpServersSpec | undefined, opts.env));

  // ports
  const portRequests = collectPortRequests(spec, opts.env, opts.ports ?? []);
  items.push(...(await portItems(portRequests, opts.checkPort ?? checkPortFree)));

  // bundle
  if (opts.harnessDir !== undefined) {
    const comparator = opts.freshness ?? compareBundleFreshnessByMtime;
    const item = bundleFreshnessItem(await comparator(opts.harnessDir));
    if (item !== undefined) items.push(item);
  }

  // durability
  items.push(
    ...durabilityItems(
      {
        ...(typeof spec?.["target"] === "string" ? { target: spec["target"] as string } : {}),
        hasBudgetBlock: spec?.["budget"] !== undefined,
        liveProviderCredentials: hasLiveProviderCredentials(models, opts.env),
      },
      opts.env,
    ),
  );

  return buildReport(items);
}

/**
 * Convenience wrapper for the common case: preflight the harness at
 * `harnessDir` against the CURRENT process environment. This is the one
 * place in the package that reads `process.env` — every core function
 * takes `env` explicitly.
 */
export function preflightHarness(
  harnessDir: string,
  overrides: Partial<RunPreflightOptions> = {},
): Promise<PreflightReport> {
  return runPreflight({ harnessDir, env: process.env, ...overrides });
}

// Re-exported so composition callers can pre-check env conditions cheaply.
export { isEnvSet };
