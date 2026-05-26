import { type TargetShape, isTargetShape } from "@crewhaus/docker-images";
import { CrewhausError } from "@crewhaus/errors";

/**
 * Section 44 — `@crewhaus/cloud-adapter-render`
 *
 * One-click deploy adapter for [Render](https://render.com). Three surfaces:
 *
 *   - `renderBlueprintFor({target, serviceName, imageTag, …})` —
 *     emits a deterministic `render.yaml` Infrastructure-as-Code blueprint
 *     that points Render at the §32 docker-images Dockerfile for the
 *     given target shape. Render reads this at the repo root.
 *
 *   - `renderDockerfileFor({target, …})` — wraps the §32 docker-images
 *     Dockerfile with a Render-tuned final stage: listens on `$PORT`
 *     (Render injects this), no fixed EXPOSE, healthcheck honors
 *     RENDER's hosted load-balancer probe.
 *
 *   - `deployToRender({apiKey, blueprintYaml, …})` — POSTs the blueprint
 *     against the Render Deploy API. Live API calls are gated on the
 *     `RENDER_API_KEY` env (or explicit `apiKey`) plus an injectable
 *     `fetchImpl` test seam.
 *
 * SECURITY (T8 credential-leak guard): the API key never appears in
 * adapter logs / errors / deploy records. Every error path runs through
 * `scrubApiKey()` before surfacing to the caller — same approach as the
 * §37 `exporter-datadog` `scrubApiKey` helper.
 *
 * Targets: daemon-shape bundles (channel, managed, batch, voice, browser).
 * CLI/workflow/eval shapes are one-shot and don't fit Render's
 * always-on service model — passing them throws `RenderAdapterError`.
 */

export class RenderAdapterError extends CrewhausError {
  override readonly name = "RenderAdapterError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * Render-deployable target shapes. CLI/workflow/eval are one-shot;
 * Render's "web service" / "background worker" primitives are for
 * long-running daemons. This is the canonical list for §44.
 */
export const RENDER_TARGET_SHAPES = [
  "channel",
  "managed",
  "batch",
  "voice",
  "browser",
] as const satisfies readonly TargetShape[];

export type RenderTargetShape = (typeof RENDER_TARGET_SHAPES)[number];

export function isRenderTargetShape(value: unknown): value is RenderTargetShape {
  return typeof value === "string" && (RENDER_TARGET_SHAPES as readonly string[]).includes(value);
}

export const RENDER_REGIONS = ["oregon", "frankfurt", "singapore", "ohio", "virginia"] as const;
export type RenderRegion = (typeof RENDER_REGIONS)[number];

export const RENDER_PLANS = ["starter", "standard", "pro", "pro plus", "pro max"] as const;
export type RenderPlan = (typeof RENDER_PLANS)[number];

export type RenderBlueprintOptions = {
  readonly target: TargetShape;
  /** Render service id; doubles as DNS prefix. Lowercase letters, digits, hyphens. */
  readonly serviceName: string;
  /** Image registry coordinate or `auto` to let Render build from Dockerfile. */
  readonly imageTag?: string;
  readonly region?: RenderRegion;
  readonly plan?: RenderPlan;
  /** Plain-text env vars merged into the blueprint. Secret values must use `envVarsFromGroup`. */
  readonly envVars?: Readonly<Record<string, string>>;
  /** Reference an existing Render env-var-group for shared secrets. */
  readonly envVarsFromGroup?: ReadonlyArray<string>;
  /** Path to the Dockerfile inside the repo. Defaults to `./Dockerfile.render`. */
  readonly dockerfilePath?: string;
};

const SERVICE_TYPE_FOR_TARGET: Readonly<Record<RenderTargetShape, "web" | "worker">> = {
  channel: "web",
  managed: "web",
  voice: "web",
  browser: "web",
  batch: "worker",
};

const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function assertRenderTarget(target: TargetShape): asserts target is RenderTargetShape {
  if (!isRenderTargetShape(target)) {
    throw new RenderAdapterError(
      `target shape "${target}" is not supported by Render. ` +
        `Supported daemon shapes: ${RENDER_TARGET_SHAPES.join(", ")}.`,
    );
  }
}

function assertServiceName(name: string): void {
  if (!SERVICE_NAME_PATTERN.test(name)) {
    throw new RenderAdapterError(
      `service name "${name}" is invalid. Must be lowercase alphanumerics + hyphens, 1-63 chars, no leading/trailing hyphen.`,
    );
  }
}

/**
 * Render-tuned Dockerfile final stage. Wraps the §32 base image with:
 *   - `ENV PORT=10000` default; Render overrides at runtime.
 *   - No fixed `EXPOSE` (Render reads `$PORT`).
 *   - `HEALTHCHECK` curling `localhost:$PORT/healthz` — matches the
 *     gateway-server convention used by `channel-bot` / `managed`.
 *
 * The caller is responsible for ensuring the base image (built by
 * `docker-images.buildImage`) exposes a `/healthz` endpoint. The browser
 * shape ships a stub `/healthz` in `target-browser-driver`; batch shapes
 * don't need one because Render's worker type doesn't health-probe.
 */
export type RenderDockerfileOptions = {
  readonly target: TargetShape;
  /** Base image tag emitted by `docker-images.buildImage` (e.g. `crewhaus/channel:0.1.0`). */
  readonly baseImage: string;
};

export function renderDockerfileFor(opts: RenderDockerfileOptions): string {
  if (!isTargetShape(opts.target)) {
    throw new RenderAdapterError(`unknown target shape "${opts.target}"`);
  }
  assertRenderTarget(opts.target);
  const isWeb = SERVICE_TYPE_FOR_TARGET[opts.target] === "web";
  const lines = [
    `# Render-tuned wrapper around ${opts.baseImage}`,
    `FROM ${opts.baseImage}`,
    "ENV PORT=10000",
  ];
  if (isWeb) {
    lines.push(
      // Use shell form so `$PORT` is expanded against Render's runtime value.
      "HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \\",
      '  CMD curl --silent --fail "http://localhost:$PORT/healthz" || exit 1',
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Render Blueprint spec — minimal subset of the [Render Blueprint schema](https://render.com/docs/blueprint-spec).
 * Emitted YAML is deterministic: stable key order, no trailing whitespace.
 */
export function renderBlueprintFor(opts: RenderBlueprintOptions): string {
  if (!isTargetShape(opts.target)) {
    throw new RenderAdapterError(`unknown target shape "${opts.target}"`);
  }
  assertRenderTarget(opts.target);
  assertServiceName(opts.serviceName);

  const serviceType = SERVICE_TYPE_FOR_TARGET[opts.target];
  const region = opts.region ?? "oregon";
  const plan = opts.plan ?? "starter";
  const dockerfilePath = opts.dockerfilePath ?? "./Dockerfile.render";

  const lines: string[] = [
    "# Generated by @crewhaus/cloud-adapter-render — do not edit by hand",
    "services:",
  ];
  lines.push(`  - type: ${serviceType}`);
  lines.push(`    name: ${opts.serviceName}`);
  lines.push("    runtime: docker");
  lines.push(`    dockerfilePath: ${dockerfilePath}`);
  lines.push(`    region: ${region}`);
  lines.push(`    plan: ${plan}`);
  if (serviceType === "web") {
    lines.push("    healthCheckPath: /healthz");
  }
  if (opts.imageTag !== undefined && opts.imageTag !== "auto") {
    lines.push(`    image: ${opts.imageTag}`);
  }
  if (opts.envVars && Object.keys(opts.envVars).length > 0) {
    lines.push("    envVars:");
    for (const key of Object.keys(opts.envVars).sort()) {
      const value = opts.envVars[key];
      if (value === undefined) continue;
      lines.push(`      - key: ${key}`);
      lines.push(`        value: ${JSON.stringify(value)}`);
    }
  }
  if (opts.envVarsFromGroup && opts.envVarsFromGroup.length > 0) {
    if (!opts.envVars || Object.keys(opts.envVars).length === 0) {
      lines.push("    envVars:");
    }
    for (const group of opts.envVarsFromGroup) {
      lines.push(`      - fromGroup: ${group}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export type RenderDeployRecord = {
  readonly serviceId: string;
  readonly deployId: string;
  readonly url?: string;
  readonly status: string;
};

export type DeployToRenderOptions = {
  readonly blueprintYaml: string;
  readonly serviceName: string;
  /** Render API key. Defaults to `process.env.RENDER_API_KEY`. */
  readonly apiKey?: string;
  /** Default `https://api.render.com/v1`. Override for VCR-style tests. */
  readonly apiBaseUrl?: string;
  /** Owner id (team or user) the service belongs to. */
  readonly ownerId?: string;
  /** Test seam — override fetch. */
  readonly fetchImpl?: typeof fetch;
};

export const RENDER_DEFAULT_API_BASE = "https://api.render.com/v1";

function resolveApiKey(provided: string | undefined): string {
  const key = provided ?? process.env["RENDER_API_KEY"];
  if (key === undefined || key.length === 0) {
    throw new RenderAdapterError(
      "RENDER_API_KEY is required. Pass `apiKey` explicitly or set the env var.",
    );
  }
  return key;
}

/**
 * Scrub the API key out of an arbitrary string. Mirrors the
 * §37 `exporter-datadog` helper. Keys shorter than 8 chars are not
 * scrubbed (would match too aggressively against ordinary text).
 */
export function scrubApiKey(message: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey.length < 8) return message;
  return message.split(apiKey).join("[REDACTED:RENDER_API_KEY]");
}

/**
 * POST the blueprint at Render and return the deploy record. Throws a
 * `RenderAdapterError` whose `.message` is guaranteed scrubbed.
 */
export async function deployToRender(opts: DeployToRenderOptions): Promise<RenderDeployRecord> {
  const apiKey = resolveApiKey(opts.apiKey);
  const baseUrl = opts.apiBaseUrl ?? RENDER_DEFAULT_API_BASE;
  const fetchFn = opts.fetchImpl ?? fetch;
  assertServiceName(opts.serviceName);

  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/services`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/yaml",
        Accept: "application/json",
      },
      body: opts.blueprintYaml,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RenderAdapterError(`Render API request failed: ${scrubApiKey(msg, apiKey)}`, err);
  }

  const text = await response.text();
  const scrubbed = scrubApiKey(text, apiKey);
  if (!response.ok) {
    throw new RenderAdapterError(
      `Render API returned ${response.status} ${response.statusText}: ${scrubbed}`,
    );
  }

  let parsed: {
    id?: string;
    service?: { id?: string };
    deploy?: { id?: string; status?: string };
    serviceDetails?: { url?: string };
  };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RenderAdapterError(`Render API returned non-JSON body: ${scrubbed}`, err);
  }

  const serviceId = parsed.service?.id ?? parsed.id;
  if (typeof serviceId !== "string") {
    throw new RenderAdapterError(`Render API response missing service id: ${scrubbed}`);
  }
  return {
    serviceId,
    deployId: parsed.deploy?.id ?? "",
    url: parsed.serviceDetails?.url,
    status: parsed.deploy?.status ?? "pending",
  };
}
