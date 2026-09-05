/**
 * Provider-credential checks, extracted from the CLI's doctor so any manager
 * (the CLI, a supervisor, a fleet UI) can run them against an injected
 * environment. Two layers live here:
 *
 *   1. The doctor-compatible core — `selectedProvider`,
 *      `buildCredentialChecks`, `providerCredentialsSatisfied`,
 *      `providerEnvStubs`, `modelCredentialGroups` — behaviour- and
 *      message-preserving with the CLI originals, returning the shared
 *      label/pass/warn/reason check shape.
 *   2. The preflight credentials matrix — `collectSpecModels` +
 *      `modelCredentialItems` — which walks the UNION of every model a spec
 *      can route to (agent.model, model_fallbacks, model_tiers,
 *      model_pool.candidates, the evaluation judge model, the budget
 *      degrade model), maps each through the model-router grammar, and
 *      classifies per-provider requirements as blocking (a required key is
 *      unset), warn, or info (ambient-credential providers: Bedrock's SDK
 *      default chain, Vertex ADC, local endpoints).
 *
 * All functions take `env` explicitly — no `process.env` reads.
 */

import { parseModelString } from "@crewhaus/model-router";
import { parseSpec } from "@crewhaus/spec";
import { type PreflightCheck, type PreflightEnv, type PreflightItem, isEnvSet } from "./types";

/** Doctor-level provider id: the router's four providers plus "local"
 *  (`local/<m>@<url>` parses to openai WITH a baseUrl — credential-free). */
export type CredentialProviderId = "anthropic" | "openai" | "gemini" | "bedrock" | "local";

/** Doctor-compatible credential check (label/pass/warn/reason). */
export type CredentialCheck = PreflightCheck;

/**
 * Anthropic credential mode, mirroring the adapter's `resolveAuth`
 * precedence contract: ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY > none,
 * with `sk-ant-oat*` auth tokens treated as OAuth (Claude subscription
 * routing) and everything else as an API key. Duplicated here (10 lines)
 * so the preflight package does not load a provider SDK just to answer
 * "is a key set" — keep in lockstep with `@crewhaus/adapter-anthropic`.
 */
export function anthropicAuthMode(env: PreflightEnv): "oauth" | "api-key" | "none" {
  const authToken = env["ANTHROPIC_AUTH_TOKEN"];
  if (authToken !== undefined && authToken !== "") {
    return authToken.startsWith("sk-ant-oat") ? "oauth" : "api-key";
  }
  const apiKey = env["ANTHROPIC_API_KEY"];
  if (apiKey !== undefined && apiKey !== "") return "api-key";
  return "none";
}

/**
 * Tolerantly extract `agent.model` from a crewhaus.yaml text. Returns
 * undefined when the spec doesn't parse or carries no agent.model (e.g.
 * workflow shapes with per-step models) — callers then fall back to the
 * legacy Anthropic-first behaviour.
 *
 * 0.6.0 §4.3 — the seventh reference-resolution case, OUTSIDE the compiler:
 * this reads spec text, and its result feeds `selectedProvider`, which
 * picks the provider whose credentials `crewhaus doctor` and the `run`
 * preflight demand. A `$profile` reference is resolved against the same
 * spec's `models:` block before it is returned; left alone, `$fast` would
 * reach `parseModelString`, throw, and give every spec that adopts the
 * registry a wrong credential verdict. The tolerant contract is kept:
 * `undefined` on anything that cannot be resolved (an unknown profile, a
 * profile whose own model is a compile-time sentinel).
 */
export function extractSpecModel(yamlText: string): string | undefined {
  try {
    const spec = parseSpec(yamlText) as unknown as {
      agent?: { model?: unknown };
      models?: Record<string, { model?: unknown }>;
    };
    const m = resolveProfileRef(spec.agent?.model, spec.models);
    return typeof m === "string" && m.length > 0 && !isModelSentinel(m) ? m : undefined;
  } catch {
    return undefined;
  }
}

/** The compile-time sentinels a slot may carry instead of a grammar string. */
function isModelSentinel(value: string): boolean {
  return value === "cheapest" || value === "strongest";
}

/**
 * Follow a `$<profile>` reference to the profile's model string; a non-ref
 * passes through; an unresolvable ref yields `undefined` (tolerant).
 */
function resolveProfileRef(
  value: unknown,
  models: Record<string, { model?: unknown }> | undefined,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (!value.startsWith("$")) return value;
  const resolved = models?.[value.slice(1)]?.model;
  return typeof resolved === "string" && resolved.length > 0 ? resolved : undefined;
}

/**
 * Map a model string to the doctor-level provider whose credentials the
 * run will need. Returns undefined for unparseable strings.
 */
export function selectedProvider(model: string): CredentialProviderId | undefined {
  try {
    const parsed = parseModelString(model);
    if (parsed.providerId === "openai" && parsed.baseUrl !== undefined) return "local";
    return parsed.providerId;
  } catch {
    return undefined;
  }
}

type EnvStatus = { readonly satisfied: boolean; readonly detail: string };

function anthropicStatus(env: PreflightEnv): EnvStatus {
  const mode = anthropicAuthMode(env);
  return mode !== "none"
    ? { satisfied: true, detail: `${mode} credentials found` }
    : {
        satisfied: false,
        detail: "set ANTHROPIC_AUTH_TOKEN (Claude subscription) or ANTHROPIC_API_KEY",
      };
}

function openaiStatus(env: PreflightEnv): EnvStatus {
  if (isEnvSet(env, "OPENAI_API_KEY")) return { satisfied: true, detail: "OPENAI_API_KEY set" };
  if (isEnvSet(env, "OPENAI_BASE_URL")) {
    return { satisfied: true, detail: "OPENAI_BASE_URL set (OpenAI-compatible endpoint)" };
  }
  return {
    satisfied: false,
    detail: "set OPENAI_API_KEY (or OPENAI_BASE_URL for an OpenAI-compatible endpoint)",
  };
}

function geminiStatus(env: PreflightEnv): EnvStatus {
  if (isEnvSet(env, "GEMINI_API_KEY")) return { satisfied: true, detail: "GEMINI_API_KEY set" };
  if (isEnvSet(env, "GOOGLE_API_KEY")) return { satisfied: true, detail: "GOOGLE_API_KEY set" };
  if (isEnvSet(env, "GOOGLE_GENAI_USE_VERTEXAI") || isEnvSet(env, "GOOGLE_CLOUD_PROJECT")) {
    return {
      satisfied: true,
      detail: "Vertex AI env set (GOOGLE_GENAI_USE_VERTEXAI/GOOGLE_CLOUD_PROJECT)",
    };
  }
  return {
    satisfied: false,
    detail:
      "set GEMINI_API_KEY (or GOOGLE_API_KEY; Vertex users set GOOGLE_GENAI_USE_VERTEXAI + GOOGLE_CLOUD_PROJECT)",
  };
}

const BEDROCK_ENV_NAMES = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_REGION",
] as const;

function bedrockStatus(env: PreflightEnv): EnvStatus {
  const found = BEDROCK_ENV_NAMES.filter((n) => isEnvSet(env, n));
  return found.length > 0
    ? { satisfied: true, detail: `${found.join(", ")} set` }
    : {
        satisfied: false,
        detail:
          "no AWS env vars visible (AWS_BEARER_TOKEN_BEDROCK/AWS_ACCESS_KEY_ID/AWS_PROFILE/AWS_REGION) — the SDK default credential chain (IRSA, instance profile, ~/.aws) may still apply",
      };
}

function statusFor(provider: CredentialProviderId, env: PreflightEnv): EnvStatus {
  switch (provider) {
    case "anthropic":
      return anthropicStatus(env);
    case "openai":
      return openaiStatus(env);
    case "gemini":
      return geminiStatus(env);
    case "bedrock":
      return bedrockStatus(env);
    case "local":
      return {
        satisfied: true,
        detail: "local endpoint baked into the model string — no credentials needed",
      };
  }
}

/**
 * True when the provider `model` routes to has visibly satisfied
 * credentials (shares `statusFor` with the doctor checks, so the two never
 * disagree). Unparseable model strings return false. The bedrock check is
 * env-visible only (the AWS SDK's default chain may still work); callers
 * that can degrade prefer the safe offline mode in that ambiguity.
 */
export function providerCredentialsSatisfied(model: string, env: PreflightEnv): boolean {
  const provider = selectedProvider(model);
  if (provider === undefined) return false;
  return statusFor(provider, env).satisfied;
}

const PROVIDER_LABEL: Record<CredentialProviderId, string> = {
  anthropic: "Anthropic credentials",
  openai: "OpenAI credentials",
  gemini: "Gemini credentials",
  bedrock: "Bedrock (AWS) credentials",
  local: "Local endpoint",
};

/**
 * The canonical env var(s) a `--fix` flow stubs into `.env` for a provider
 * whose credential check is failing. One representative name per provider
 * (the first the status check reads); bedrock/local need no stub (bedrock
 * uses the SDK default chain; local bakes the URL into the model string),
 * so they map to []. Kept next to the status tables so the stub set can't
 * drift from what the checks actually probe.
 */
const PROVIDER_ENV_STUBS: Record<CredentialProviderId, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  bedrock: [],
  local: [],
};

/** Env var names a fix flow should stub for a selected provider. */
export function providerEnvStubs(provider: CredentialProviderId): readonly string[] {
  return PROVIDER_ENV_STUBS[provider];
}

/** Providers whose env check is INFORMATIONAL even when selected: the AWS
 *  SDK's default credential chain is authoritative for bedrock (env vars are
 *  only one of its sources), and local/ endpoints need no credentials. */
const INFORMATIONAL_WHEN_SELECTED: ReadonlySet<CredentialProviderId> = new Set([
  "bedrock",
  "local",
]);

/** Non-selected providers whose env is set get an informational line so the
 *  operator sees what else is configured. */
const ALL_PROVIDERS: readonly CredentialProviderId[] = ["anthropic", "openai", "gemini", "bedrock"];

/**
 * Build the credential section of a doctor-style report.
 *
 * With a parseable spec model: the matching provider gets a real pass/fail
 * check (informational for bedrock/local), and any OTHER provider with env
 * visibly set gets a "~" informational line. Without one (no spec file, or
 * no agent.model): legacy Anthropic-first behaviour, EXCEPT that a missing
 * Anthropic credential downgrades to informational when another provider's
 * env is clearly set (the operator is plainly not on Anthropic).
 */
export function buildCredentialChecks(
  specModel: string | undefined,
  env: PreflightEnv,
): CredentialCheck[] {
  const provider = specModel !== undefined ? selectedProvider(specModel) : undefined;
  const checks: CredentialCheck[] = [];

  if (provider !== undefined && specModel !== undefined) {
    const status = statusFor(provider, env);
    const informational = INFORMATIONAL_WHEN_SELECTED.has(provider);
    checks.push({
      label: `${PROVIDER_LABEL[provider]} (model ${specModel})`,
      pass: informational ? true : status.satisfied,
      ...(informational && !status.satisfied ? { warn: true } : {}),
      ...(status.satisfied && !informational ? {} : { reason: status.detail }),
    });
    for (const other of ALL_PROVIDERS) {
      if (other === provider) continue;
      const otherStatus = statusFor(other, env);
      if (otherStatus.satisfied) {
        checks.push({
          label: `${PROVIDER_LABEL[other]} (not required for this spec)`,
          pass: true,
          warn: true,
          reason: otherStatus.detail,
        });
      }
    }
    return checks;
  }

  // No spec model — legacy Anthropic-first behaviour with one softening:
  // when Anthropic creds are absent but another provider's env is clearly
  // set, report informationally instead of hard-failing.
  const anthropic = anthropicStatus(env);
  if (anthropic.satisfied) {
    checks.push({ label: "Anthropic credentials", pass: true });
    return checks;
  }
  const others = ALL_PROVIDERS.filter((p) => p !== "anthropic").filter(
    (p) => statusFor(p, env).satisfied,
  );
  if (others.length > 0) {
    checks.push({
      label: "Anthropic credentials",
      pass: true,
      warn: true,
      reason: `not set, but ${others.map((p) => PROVIDER_LABEL[p]).join(" + ")} detected — claude-* models will not run until ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY is set`,
    });
    return checks;
  }
  checks.push({ label: "Anthropic credentials", pass: false, reason: anthropic.detail });
  return checks;
}

/**
 * The provider-credential EITHER-OR groups a compiled channel daemon gates
 * its boot on — a mirror of the channel emitter's `providerEnvGroups`,
 * which derives them from `agent.model` at emit time. At least one name per
 * group must be set or the daemon exits 2 before it ever serves a webhook.
 *
 * bedrock (the AWS SDK's default credential chain is authoritative), local
 * endpoints (URL baked into the model string), and model strings outside
 * the router grammar contribute NO group — exactly like the emitter.
 */
export function modelCredentialGroups(model: string): ReadonlyArray<ReadonlyArray<string>> {
  let parsed: ReturnType<typeof parseModelString>;
  try {
    parsed = parseModelString(model);
  } catch {
    return [];
  }
  switch (parsed.providerId) {
    case "anthropic":
      return [["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]];
    case "openai":
      // local/<m>@<url> parses to openai WITH a baked baseUrl — no creds.
      return parsed.baseUrl !== undefined ? [] : [["OPENAI_API_KEY", "OPENAI_BASE_URL"]];
    case "gemini":
      return [["GEMINI_API_KEY", "GOOGLE_API_KEY"]];
    default:
      return [];
  }
}

/**
 * The daemon's provider-credential gate as doctor-style checks (see
 * {@link modelCredentialGroups}). Returns [] when the model contributes no
 * group, so bedrock/local specs gain no spurious failure.
 */
export function modelCredentialChecks(model: string, env: PreflightEnv): CredentialCheck[] {
  return modelCredentialGroups(model).map((group) => {
    const satisfied = group.some((name) => isEnvSet(env, name));
    const names = group.join(" or ");
    return satisfied
      ? { label: `Agent model credentials (${model}: ${names})`, pass: true }
      : {
          label: `Agent model credentials (${model})`,
          pass: false,
          reason: `none of ${names} is set — the daemon exits at boot before it serves any channel`,
        };
  });
}

// ---------------------------------------------------------------------------
// The preflight credentials matrix — union of every model a spec routes to
// ---------------------------------------------------------------------------

/** One model string found in a spec, with the spec path(s) that declared it. */
export type SpecModelRef = { readonly model: string; readonly sources: readonly string[] };

type LooseRecord = Record<string, unknown>;

function asRecord(v: unknown): LooseRecord | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as LooseRecord) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Collect the union of model strings a parsed spec can route a call to:
 * `agent.model`, every `agent.model_fallbacks` entry, both `model_tiers`
 * tiers, every `model_pool` candidate, the in-loop `evaluation` judge model
 * (`llm_judge` grader) and judge panel, and the `budget.on_exceed.degrade`
 * model. Works on the loosely-typed parsed spec object so a single walker
 * serves every target shape; unknown/absent blocks contribute nothing.
 * Deduped by model string with sources merged.
 *
 * 0.6.0 §4.3 — a `$<profile>` reference at any of those slots is followed
 * to the profile's model (its source keeps the slot path, so the credential
 * item still names where the model came from), and every `models:` profile
 * contributes its own model under `models.<name>`. An unresolvable ref
 * contributes nothing (the spec layer owns that error).
 */
export function collectSpecModels(spec: unknown): SpecModelRef[] {
  const found = new Map<string, string[]>();
  const root = asRecord(spec);
  if (root === undefined) return [];
  const registry = asRecord(root["models"]) ?? {};
  const add = (model: unknown, source: string): void => {
    const raw = asString(model);
    if (raw === undefined) return;
    const m = raw.startsWith("$") ? asString(asRecord(registry[raw.slice(1)])?.["model"]) : raw;
    if (m === undefined) return;
    const sources = found.get(m);
    if (sources === undefined) found.set(m, [source]);
    else if (!sources.includes(source)) sources.push(source);
  };
  for (const [name, profile] of Object.entries(registry)) {
    add(asRecord(profile)?.["model"], `models.${name}`);
  }

  const agent = asRecord(root["agent"]);
  if (agent !== undefined) {
    add(agent["model"], "agent.model");
    const fallbacks = agent["model_fallbacks"];
    if (Array.isArray(fallbacks)) {
      fallbacks.forEach((m, i) => add(m, `agent.model_fallbacks[${i}]`));
    }
    const tiers = asRecord(agent["model_tiers"]);
    if (tiers !== undefined) {
      add(tiers["fast"], "agent.model_tiers.fast");
      add(tiers["default"], "agent.model_tiers.default");
    }
    const pool = asRecord(agent["model_pool"]);
    const candidates = pool?.["candidates"];
    if (Array.isArray(candidates)) {
      candidates.forEach((c, i) =>
        add(asRecord(c)?.["model"], `agent.model_pool.candidates[${i}]`),
      );
    }
  }

  const evaluation = asRecord(root["evaluation"]);
  const grader = asRecord(evaluation?.["grader"]);
  if (grader !== undefined && grader["type"] === "llm_judge") {
    add(grader["model"], "evaluation.grader.model");
    const judges = grader["judges"];
    if (Array.isArray(judges)) {
      judges.forEach((m, i) => add(m, `evaluation.grader.judges[${i}]`));
    }
  }

  const budget = asRecord(root["budget"]);
  const onExceed = asRecord(budget?.["on_exceed"]);
  if (onExceed !== undefined && onExceed["action"] === "degrade") {
    add(onExceed["model"], "budget.on_exceed.model");
  }

  return [...found.entries()].map(([model, sources]) => ({ model, sources }));
}

/** One credential requirement derived from a parsed model string. */
type CredentialRequirement = {
  /** Dedup key so N models on one provider produce one item. */
  readonly key: string;
  /** EITHER-OR group of env var names; empty = ambient/credential-free. */
  readonly group: readonly string[];
  /** The var a fix flow stubs (first of the group) — `envVar` on the item. */
  readonly envVar?: string;
  /** Ambient/credential-free providers report info, never blocking. */
  readonly informational: boolean;
  /** Message fragments. */
  readonly what: string;
  readonly missingDetail: string;
  readonly satisfiedDetail: (env: PreflightEnv) => string;
};

function requirementFor(model: string): CredentialRequirement | undefined {
  let parsed: ReturnType<typeof parseModelString>;
  try {
    parsed = parseModelString(model);
  } catch {
    // Outside the router grammar (including compile-time sentinels like the
    // judge's `cheapest`) — the spec-lint stage owns genuinely bad strings.
    return undefined;
  }
  if (parsed.providerId === "anthropic") {
    if (parsed.vertex === true) {
      return {
        key: "vertex-adc",
        group: [],
        informational: true,
        what: "Vertex AI (Application Default Credentials)",
        missingDetail: "",
        satisfiedDetail: () =>
          "vertex/* models authenticate via Application Default Credentials — no env var is required or checked here",
      };
    }
    return {
      key: "anthropic",
      group: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
      envVar: "ANTHROPIC_API_KEY",
      informational: false,
      what: "Anthropic credentials",
      missingDetail: "set ANTHROPIC_AUTH_TOKEN (Claude subscription) or ANTHROPIC_API_KEY",
      satisfiedDetail: (env) => `${anthropicAuthMode(env)} credentials found`,
    };
  }
  if (parsed.providerId === "openai") {
    if (parsed.azure !== undefined) {
      return {
        key: "azure-openai",
        group: [],
        envVar: "AZURE_OPENAI_API_KEY",
        informational: false,
        what: "Azure OpenAI credentials",
        missingDetail:
          "azure/<deployment> model strings require AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY (api version via AZURE_OPENAI_API_VERSION)",
        satisfiedDetail: () => "AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY set",
      };
    }
    if (parsed.apiKeyEnv !== undefined) {
      const hostId = parsed.hostId ?? "host";
      return {
        key: `host:${hostId}`,
        group: [parsed.apiKeyEnv],
        envVar: parsed.apiKeyEnv,
        informational: false,
        what: `${hostId} credentials`,
        missingDetail: `${hostId}/* model strings require ${parsed.apiKeyEnv} to be set`,
        satisfiedDetail: () => `${parsed.apiKeyEnv} set`,
      };
    }
    if (parsed.baseUrl !== undefined) {
      return {
        key: `local:${parsed.baseUrl}`,
        group: [],
        informational: true,
        what: "Local endpoint",
        missingDetail: "",
        satisfiedDetail: () => "local endpoint baked into the model string — no credentials needed",
      };
    }
    return {
      key: "openai",
      group: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
      envVar: "OPENAI_API_KEY",
      informational: false,
      what: "OpenAI credentials",
      missingDetail: "set OPENAI_API_KEY (or OPENAI_BASE_URL for an OpenAI-compatible endpoint)",
      satisfiedDetail: (env) =>
        isEnvSet(env, "OPENAI_API_KEY")
          ? "OPENAI_API_KEY set"
          : "OPENAI_BASE_URL set (OpenAI-compatible endpoint)",
    };
  }
  if (parsed.providerId === "gemini") {
    if (parsed.vertex === true) {
      return {
        key: "vertex-adc",
        group: [],
        informational: true,
        what: "Vertex AI (Application Default Credentials)",
        missingDetail: "",
        satisfiedDetail: () =>
          "vertex/* models authenticate via Application Default Credentials — no env var is required or checked here",
      };
    }
    return {
      key: "gemini",
      group: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      envVar: "GEMINI_API_KEY",
      informational: false,
      what: "Gemini credentials",
      missingDetail:
        "set GEMINI_API_KEY (or GOOGLE_API_KEY; Vertex users set GOOGLE_GENAI_USE_VERTEXAI + GOOGLE_CLOUD_PROJECT)",
      satisfiedDetail: (env) => geminiStatus(env).detail,
    };
  }
  // bedrock — the SDK default credential chain is authoritative; env vars
  // are only one of its sources, so this is informational, never blocking.
  return {
    key: "bedrock",
    group: [],
    informational: true,
    what: "Bedrock (AWS) credentials",
    missingDetail: "",
    satisfiedDetail: (env) => bedrockStatus(env).detail,
  };
}

function requirementSatisfied(req: CredentialRequirement, env: PreflightEnv): boolean {
  if (req.key === "azure-openai") {
    return isEnvSet(env, "AZURE_OPENAI_ENDPOINT") && isEnvSet(env, "AZURE_OPENAI_API_KEY");
  }
  if (req.key === "gemini") {
    // The doctor accepts Vertex env as a Gemini credential surface too.
    return geminiStatus(env).satisfied;
  }
  return req.group.some((name) => isEnvSet(env, name));
}

/**
 * The credentials matrix: one item per DISTINCT credential requirement
 * across `models`, classified against `env`.
 *
 *   - required group unset  → blocking ("will not boot" — the compiled
 *     daemon's provider gate exits 2, and interactive runs die at the first
 *     model call)
 *   - required group set    → info (the matrix shows what satisfied it)
 *   - ambient providers     → info always (bedrock SDK chain, Vertex ADC,
 *     local endpoints)
 */
export function modelCredentialItems(
  models: readonly SpecModelRef[],
  env: PreflightEnv,
): PreflightItem[] {
  const byKey = new Map<string, { req: CredentialRequirement; models: string[] }>();
  for (const { model } of models) {
    const req = requirementFor(model);
    if (req === undefined) continue;
    const existing = byKey.get(req.key);
    if (existing === undefined) byKey.set(req.key, { req, models: [model] });
    else if (!existing.models.includes(model)) existing.models.push(model);
  }

  const items: PreflightItem[] = [];
  for (const { req, models: modelList } of byKey.values()) {
    const forModels = `model${modelList.length > 1 ? "s" : ""} ${modelList.join(", ")}`;
    if (req.informational) {
      items.push({
        id: `credentials.${req.key}`,
        area: "credentials",
        level: "info",
        message: `${req.what} (${forModels}): ${req.satisfiedDetail(env)}`,
      });
      continue;
    }
    if (requirementSatisfied(req, env)) {
      items.push({
        id: `credentials.${req.key}`,
        area: "credentials",
        level: "info",
        message: `${req.what} (${forModels}): ${req.satisfiedDetail(env)}`,
        ...(req.envVar !== undefined ? { envVar: req.envVar } : {}),
      });
      continue;
    }
    items.push({
      id: `credentials.${req.key}`,
      area: "credentials",
      level: "blocking",
      message: `will not boot: no ${req.what} — ${forModels} (${req.missingDetail})`,
      remediation: req.missingDetail,
      ...(req.envVar !== undefined ? { envVar: req.envVar } : {}),
    });
  }
  return items;
}

/**
 * True when at least one NON-ambient provider requirement across `models`
 * is satisfied by `env` — i.e. real, spendable provider credentials are in
 * play (the durability stage warns when such a harness has no `budget:`
 * cap). Ambient providers (bedrock/vertex/local) never count: their
 * credentials are invisible to the env and local endpoints spend nothing.
 */
export function hasLiveProviderCredentials(
  models: readonly SpecModelRef[],
  env: PreflightEnv,
): boolean {
  for (const { model } of models) {
    const req = requirementFor(model);
    if (req === undefined || req.informational) continue;
    if (requirementSatisfied(req, env)) return true;
  }
  return false;
}
