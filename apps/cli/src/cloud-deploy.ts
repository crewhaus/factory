/**
 * Loop contract 0.4 (Batch F, item 5) — `crewhaus deploy <fly|render|railway|
 * heroku> <spec>`. The engine-free half: the provider registry, the
 * supported-shape + token gates, and the app-name / output-dir / summary
 * helpers. The CLI handler (`runCloudDeploy` in index.ts) dynamic-imports the
 * matching `@crewhaus/cloud-adapter-*` engine (lazy boot, mirroring
 * `crewhaus cloud`) and drives the manifest scaffolding + the token-gated live
 * deploy; this module stays pure so it is unit-testable without importing any
 * engine.
 */

/** The four PaaS providers the CLI can scaffold + deploy to. */
export type CloudDeployProviderName = "fly" | "render" | "railway" | "heroku";

export type CloudDeployProvider = {
  readonly name: CloudDeployProviderName;
  /** Human label for summary lines. */
  readonly label: string;
  /**
   * The env var carrying the provider API credential. The LIVE deploy
   * (`--live`) is gated on it: absent → the command scaffolds the deploy
   * manifests and stops, naming this var. The adapters resolve the same var
   * internally, so the CLI gate and the engine gate agree.
   */
  readonly tokenEnv: string;
  /** The workspace package the handler dynamic-imports for this provider. */
  readonly importPath: string;
};

/**
 * The provider registry. `importPath` is a string literal so the handler's
 * `await import(provider.importPath)` stays a static specifier bundlers can see
 * — every value here is a real workspace dependency of `apps/cli`.
 */
export const CLOUD_DEPLOY_PROVIDERS: Readonly<
  Record<CloudDeployProviderName, CloudDeployProvider>
> = {
  fly: {
    name: "fly",
    label: "Fly.io",
    tokenEnv: "FLY_API_TOKEN",
    importPath: "@crewhaus/cloud-adapter-flyio",
  },
  render: {
    name: "render",
    label: "Render",
    tokenEnv: "RENDER_API_KEY",
    importPath: "@crewhaus/cloud-adapter-render",
  },
  railway: {
    name: "railway",
    label: "Railway",
    tokenEnv: "RAILWAY_API_TOKEN",
    importPath: "@crewhaus/cloud-adapter-railway",
  },
  heroku: {
    name: "heroku",
    label: "Heroku",
    tokenEnv: "HEROKU_API_KEY",
    importPath: "@crewhaus/cloud-adapter-heroku",
  },
};

export const CLOUD_DEPLOY_PROVIDER_NAMES = Object.keys(
  CLOUD_DEPLOY_PROVIDERS,
) as ReadonlyArray<CloudDeployProviderName>;

export function isCloudDeployProvider(name: string): name is CloudDeployProviderName {
  return Object.hasOwn(CLOUD_DEPLOY_PROVIDERS, name);
}

/**
 * The daemon target shapes every one of the four adapters accepts (they share
 * one set — a long-running server or worker the PaaS keeps alive). The
 * single-shot / build-only shapes (cli, workflow, graph, crew, research,
 * pipeline, eval, chain, onchain*) have nothing to keep running, so they are
 * rejected up front with a clear message rather than deep inside an engine.
 */
export const CLOUD_DEPLOY_TARGET_SHAPES = [
  "channel",
  "managed",
  "batch",
  "voice",
  "browser",
] as const;

export type CloudDeployTargetShape = (typeof CLOUD_DEPLOY_TARGET_SHAPES)[number];

export function isCloudDeployTargetShape(target: string): target is CloudDeployTargetShape {
  return (CLOUD_DEPLOY_TARGET_SHAPES as readonly string[]).includes(target);
}

/** True when the provider's credential env var is set to a non-empty value. */
export function cloudDeployTokenPresent(
  provider: CloudDeployProvider,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[provider.tokenEnv];
  return typeof value === "string" && value.length > 0;
}

/**
 * Sanitize a spec name (or an explicit override) into a provider-safe app name:
 * lowercase alphanumerics + single hyphens, no leading/trailing hyphen, 1–30
 * chars. Conservative enough to satisfy every adapter's own validator (Fly's is
 * the strictest — `^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$`). Falls back to
 * `"crewhaus-app"` when the input sanitizes to empty.
 */
export function resolveCloudDeployAppName(specName: string, override?: string): string {
  const raw = typeof override === "string" && override.length > 0 ? override : specName;
  let slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) slug = "crewhaus-app";
  if (slug.length > 30) {
    slug = slug.slice(0, 30).replace(/-+$/g, "");
    if (slug.length === 0) slug = "crewhaus-app";
  }
  return slug;
}

/**
 * The default base image the generated Dockerfile wraps when no `--image` is
 * given: the published per-shape CrewHaus image (the `crewhaus build-image`
 * convention), tagged `latest`.
 */
export function defaultCloudDeployBaseImage(target: string): string {
  return `crewhaus/${target}:latest`;
}

/** Human next-steps block printed after a scaffold (never on a live deploy). */
export function formatCloudDeployNextSteps(opts: {
  readonly provider: CloudDeployProvider;
  readonly outDir: string;
  readonly tokenPresent: boolean;
  readonly files: ReadonlyArray<string>;
}): string {
  const lines: string[] = [];
  lines.push(`scaffolded ${opts.provider.label} deploy manifests → ${opts.outDir}`);
  for (const f of opts.files) lines.push(`  wrote ${f}`);
  if (opts.tokenPresent) {
    lines.push(
      `${opts.provider.tokenEnv} is set — re-run with --live to deploy to ${opts.provider.label}.`,
    );
  } else {
    lines.push(
      `set ${opts.provider.tokenEnv} and re-run with --live to deploy to ${opts.provider.label}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
