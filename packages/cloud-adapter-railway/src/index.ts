import { type TargetShape, isTargetShape } from "@crewhaus/docker-images";
import { CrewhausError } from "@crewhaus/errors";

/**
 * Section 44 — `@crewhaus/cloud-adapter-railway`
 *
 * One-click deploy adapter for [Railway](https://railway.com). Three surfaces:
 *
 *   - `railwayConfigFor({target, …})` — emits a deterministic
 *     `railway.json` config: builder = DOCKERFILE, healthcheckPath
 *     for web shapes, restart policy. Railway reads this at repo root.
 *
 *   - `railwayDockerfileFor({target, baseImage})` — wraps the §32
 *     docker-images base with a Railway-tuned final stage. Railway
 *     injects `$PORT` at runtime; web shapes EXPOSE 8080 for clarity.
 *
 *   - `deployToRailway({apiToken, …})` — sends a GraphQL `serviceCreate`
 *     mutation against `https://backboard.railway.com/graphql/v2`.
 *     Live calls gated on `RAILWAY_API_TOKEN` env (or explicit
 *     `apiToken`) plus injectable `fetchImpl` test seam.
 *
 * SECURITY (T8 credential-leak guard): `scrubApiToken()` runs every
 * error path. Same approach as `cloud-adapter-render` / `-flyio`.
 *
 * Targets: daemon shapes (channel, managed, batch, voice, browser).
 */

export class RailwayAdapterError extends CrewhausError {
  override readonly name = "RailwayAdapterError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export const RAILWAY_TARGET_SHAPES = [
  "channel",
  "managed",
  "batch",
  "voice",
  "browser",
] as const satisfies readonly TargetShape[];

export type RailwayTargetShape = (typeof RAILWAY_TARGET_SHAPES)[number];

export function isRailwayTargetShape(value: unknown): value is RailwayTargetShape {
  return typeof value === "string" && (RAILWAY_TARGET_SHAPES as readonly string[]).includes(value);
}

export type RailwayRestartPolicy = "NEVER" | "ON_FAILURE" | "ALWAYS";

const SERVICE_TYPE_FOR_TARGET: Readonly<Record<RailwayTargetShape, "web" | "worker">> = {
  channel: "web",
  managed: "web",
  voice: "web",
  browser: "web",
  batch: "worker",
};

const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function assertRailwayTarget(target: TargetShape): asserts target is RailwayTargetShape {
  if (!isRailwayTargetShape(target)) {
    throw new RailwayAdapterError(
      `target shape "${target}" is not supported by Railway. Supported daemon shapes: ${RAILWAY_TARGET_SHAPES.join(", ")}.`,
    );
  }
}

function assertServiceName(name: string): void {
  if (!SERVICE_NAME_PATTERN.test(name)) {
    throw new RailwayAdapterError(
      `service name "${name}" is invalid. Must be lowercase alphanumerics + hyphens, 1-63 chars, no leading/trailing hyphen.`,
    );
  }
}

export type RailwayConfigOptions = {
  readonly target: TargetShape;
  readonly dockerfilePath?: string;
  readonly healthcheckPath?: string;
  readonly healthcheckTimeoutSec?: number;
  readonly restartPolicy?: RailwayRestartPolicy;
  readonly restartPolicyMaxRetries?: number;
};

/**
 * Stable JSON for the railway.json file. Keys are emitted in a fixed
 * order so two equivalent inputs produce byte-identical output.
 */
export function railwayConfigFor(opts: RailwayConfigOptions): string {
  if (!isTargetShape(opts.target)) {
    throw new RailwayAdapterError(`unknown target shape "${opts.target}"`);
  }
  assertRailwayTarget(opts.target);
  const isWeb = SERVICE_TYPE_FOR_TARGET[opts.target] === "web";

  const build = {
    builder: "DOCKERFILE",
    dockerfilePath: opts.dockerfilePath ?? "Dockerfile.railway",
  };
  const deploy: Record<string, unknown> = {
    restartPolicyType: opts.restartPolicy ?? "ON_FAILURE",
    restartPolicyMaxRetries: opts.restartPolicyMaxRetries ?? 10,
  };
  if (isWeb) {
    deploy["healthcheckPath"] = opts.healthcheckPath ?? "/healthz";
    deploy["healthcheckTimeout"] = opts.healthcheckTimeoutSec ?? 300;
  }
  const config = {
    $schema: "https://railway.app/railway.schema.json",
    build,
    deploy,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export type RailwayDockerfileOptions = {
  readonly target: TargetShape;
  readonly baseImage: string;
};

export function railwayDockerfileFor(opts: RailwayDockerfileOptions): string {
  if (!isTargetShape(opts.target)) {
    throw new RailwayAdapterError(`unknown target shape "${opts.target}"`);
  }
  assertRailwayTarget(opts.target);
  const isWeb = SERVICE_TYPE_FOR_TARGET[opts.target] === "web";
  const lines = [
    `# Railway-tuned wrapper around ${opts.baseImage}`,
    `FROM ${opts.baseImage}`,
    "ENV PORT=8080",
  ];
  if (isWeb) {
    lines.push("EXPOSE 8080");
  }
  return `${lines.join("\n")}\n`;
}

export type RailwayDeployRecord = {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly projectId: string;
};

export type DeployToRailwayOptions = {
  readonly projectId: string;
  readonly serviceName: string;
  readonly apiToken?: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
};

export const RAILWAY_DEFAULT_API_BASE = "https://backboard.railway.com/graphql/v2";

const SERVICE_CREATE_MUTATION = `
mutation serviceCreate($input: ServiceCreateInput!) {
  serviceCreate(input: $input) {
    id
    name
  }
}
`.trim();

function resolveApiToken(provided: string | undefined): string {
  const token = provided ?? process.env["RAILWAY_API_TOKEN"];
  if (token === undefined || token.length === 0) {
    throw new RailwayAdapterError(
      "RAILWAY_API_TOKEN is required. Pass `apiToken` explicitly or set the env var.",
    );
  }
  return token;
}

export function scrubApiToken(message: string, apiToken: string | undefined): string {
  if (apiToken === undefined || apiToken.length < 8) return message;
  return message.split(apiToken).join("[REDACTED:RAILWAY_API_TOKEN]");
}

/**
 * Issue a `serviceCreate` GraphQL mutation against the Railway public
 * API. Returns the created service id. All errors run through
 * `scrubApiToken()` before surfacing.
 */
export async function deployToRailway(opts: DeployToRailwayOptions): Promise<RailwayDeployRecord> {
  assertServiceName(opts.serviceName);
  const apiToken = resolveApiToken(opts.apiToken);
  const url = opts.apiBaseUrl ?? RAILWAY_DEFAULT_API_BASE;
  const fetchFn = opts.fetchImpl ?? fetch;

  const body = JSON.stringify({
    query: SERVICE_CREATE_MUTATION,
    variables: {
      input: { projectId: opts.projectId, name: opts.serviceName },
    },
  });

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RailwayAdapterError(
      `Railway GraphQL request failed: ${scrubApiToken(msg, apiToken)}`,
      err,
    );
  }

  const text = await response.text();
  const scrubbed = scrubApiToken(text, apiToken);
  if (!response.ok) {
    throw new RailwayAdapterError(
      `Railway GraphQL returned ${response.status} ${response.statusText}: ${scrubbed}`,
    );
  }
  let parsed: {
    data?: { serviceCreate?: { id?: string; name?: string } };
    errors?: ReadonlyArray<{ message?: string }>;
  };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RailwayAdapterError(`Railway GraphQL returned non-JSON body: ${scrubbed}`, err);
  }
  if (parsed.errors && parsed.errors.length > 0) {
    const firstErr = parsed.errors[0]?.message ?? "(no message)";
    throw new RailwayAdapterError(
      `Railway GraphQL responded with errors: ${scrubApiToken(firstErr, apiToken)}`,
    );
  }
  const created = parsed.data?.serviceCreate;
  if (!created?.id) {
    throw new RailwayAdapterError(`Railway GraphQL response missing serviceCreate.id: ${scrubbed}`);
  }
  return {
    serviceId: created.id,
    serviceName: created.name ?? opts.serviceName,
    projectId: opts.projectId,
  };
}
