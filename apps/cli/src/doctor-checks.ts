import { resolveAuth } from "@crewhaus/adapter-anthropic";
import { lower } from "@crewhaus/compiler";
import type { IrChannels } from "@crewhaus/ir";
import { parseModelString } from "@crewhaus/model-router";
import { parseSpec } from "@crewhaus/spec";
import { CHANNEL_PLATFORMS, platformSecretRefs } from "./channel-provision";

/**
 * Model-aware credential checks for `crewhaus doctor`, factored out of the
 * entry file `index.ts` (which runs a top-level argv switch and so cannot be
 * imported by a test without executing the CLI). Side-effect-free and
 * directly unit-testable, mirroring `scope-audit.ts` / `justification-gate.ts`.
 *
 * The old doctor checked ONLY Anthropic credentials and exited 1 when they
 * were absent — for every spec, including openai/gemini/bedrock/local ones
 * that never touch Anthropic. The fix: parse the cwd spec's `agent.model`
 * with the model-router grammar and check the matching provider's env,
 * reporting the others informationally instead of failing on them.
 */

/** Doctor-level provider id: the router's four providers plus "local"
 *  (`local/<m>@<url>` parses to openai WITH a baseUrl — credential-free). */
export type DoctorProviderId = "anthropic" | "openai" | "gemini" | "bedrock" | "local";

export type DoctorCredentialCheck = {
  readonly label: string;
  readonly pass: boolean;
  /** warn+pass renders as "~" — informational, never fails doctor. */
  readonly warn?: boolean;
  readonly reason?: string;
};

function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return typeof v === "string" && v !== "";
}

/**
 * Tolerantly extract `agent.model` from a crewhaus.yaml text. Returns
 * undefined when the spec doesn't parse or carries no agent.model (e.g.
 * workflow shapes with per-step models) — the caller then falls back to
 * the legacy Anthropic-first behaviour.
 */
export function extractSpecModel(yamlText: string): string | undefined {
  try {
    const spec = parseSpec(yamlText) as unknown as { agent?: { model?: unknown } };
    const m = spec.agent?.model;
    return typeof m === "string" && m.length > 0 ? m : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a model string to the doctor-level provider whose credentials the
 * run will need. Returns undefined for unparseable strings.
 */
export function selectedProvider(model: string): DoctorProviderId | undefined {
  try {
    const parsed = parseModelString(model);
    if (parsed.providerId === "openai" && parsed.baseUrl !== undefined) return "local";
    return parsed.providerId;
  } catch {
    return undefined;
  }
}

type EnvStatus = { readonly satisfied: boolean; readonly detail: string };

function anthropicStatus(env: NodeJS.ProcessEnv): EnvStatus {
  const auth = resolveAuth(env);
  return auth.mode !== "none"
    ? { satisfied: true, detail: `${auth.mode} credentials found` }
    : {
        satisfied: false,
        detail: "set ANTHROPIC_AUTH_TOKEN (Claude subscription) or ANTHROPIC_API_KEY",
      };
}

function openaiStatus(env: NodeJS.ProcessEnv): EnvStatus {
  if (isSet(env, "OPENAI_API_KEY")) return { satisfied: true, detail: "OPENAI_API_KEY set" };
  if (isSet(env, "OPENAI_BASE_URL")) {
    return { satisfied: true, detail: "OPENAI_BASE_URL set (OpenAI-compatible endpoint)" };
  }
  return {
    satisfied: false,
    detail: "set OPENAI_API_KEY (or OPENAI_BASE_URL for an OpenAI-compatible endpoint)",
  };
}

function geminiStatus(env: NodeJS.ProcessEnv): EnvStatus {
  if (isSet(env, "GEMINI_API_KEY")) return { satisfied: true, detail: "GEMINI_API_KEY set" };
  if (isSet(env, "GOOGLE_API_KEY")) return { satisfied: true, detail: "GOOGLE_API_KEY set" };
  if (isSet(env, "GOOGLE_GENAI_USE_VERTEXAI") || isSet(env, "GOOGLE_CLOUD_PROJECT")) {
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

function bedrockStatus(env: NodeJS.ProcessEnv): EnvStatus {
  const found = BEDROCK_ENV_NAMES.filter((n) => isSet(env, n));
  return found.length > 0
    ? { satisfied: true, detail: `${found.join(", ")} set` }
    : {
        satisfied: false,
        detail:
          "no AWS env vars visible (AWS_BEARER_TOKEN_BEDROCK/AWS_ACCESS_KEY_ID/AWS_PROFILE/AWS_REGION) — the SDK default credential chain (IRSA, instance profile, ~/.aws) may still apply",
      };
}

function statusFor(provider: DoctorProviderId, env: NodeJS.ProcessEnv): EnvStatus {
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
 * Item 13 — online/offline mode selection for `crewhaus scaffold-evals`:
 * true when the provider `model` routes to has visibly satisfied credentials
 * (shares `statusFor` with the doctor checks, so the two never disagree).
 * Unparseable model strings return false — the scaffold then stays on its
 * deterministic template path instead of attempting a doomed call. Note the
 * bedrock check is env-visible only (the AWS SDK's default chain may still
 * work); scaffold prefers the safe offline mode in that ambiguity.
 */
export function providerCredentialsSatisfied(model: string, env: NodeJS.ProcessEnv): boolean {
  const provider = selectedProvider(model);
  if (provider === undefined) return false;
  return statusFor(provider, env).satisfied;
}

const PROVIDER_LABEL: Record<DoctorProviderId, string> = {
  anthropic: "Anthropic credentials",
  openai: "OpenAI credentials",
  gemini: "Gemini credentials",
  bedrock: "Bedrock (AWS) credentials",
  local: "Local endpoint",
};

/**
 * Item 40 — the canonical env var(s) `doctor --fix` stubs into `.env` for a
 * provider whose credential check is failing. One representative name per
 * provider (the first the status check reads); bedrock/local need no stub
 * (bedrock uses the SDK default chain; local bakes the URL into the model
 * string), so they map to []. Kept next to the status tables so the stub set
 * can't drift from what the checks actually probe.
 */
const PROVIDER_ENV_STUBS: Record<DoctorProviderId, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  bedrock: [],
  local: [],
};

/** Env var names `doctor --fix` should stub for a selected provider. */
export function providerEnvStubs(provider: DoctorProviderId): readonly string[] {
  return PROVIDER_ENV_STUBS[provider];
}

/** Providers whose env check is INFORMATIONAL even when selected: the AWS
 *  SDK's default credential chain is authoritative for bedrock (env vars are
 *  only one of its sources), and local/ endpoints need no credentials. */
const INFORMATIONAL_WHEN_SELECTED: ReadonlySet<DoctorProviderId> = new Set(["bedrock", "local"]);

/** Non-selected providers whose env is set get an informational line so the
 *  operator sees what else is configured. */
const ALL_PROVIDERS: readonly DoctorProviderId[] = ["anthropic", "openai", "gemini", "bedrock"];

/**
 * Build the credential section of `crewhaus doctor`.
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
  env: NodeJS.ProcessEnv,
): DoctorCredentialCheck[] {
  const provider = specModel !== undefined ? selectedProvider(specModel) : undefined;
  const checks: DoctorCredentialCheck[] = [];

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
 * Item 61 — tolerantly extract the lowered channels block from a
 * crewhaus.yaml text. Returns undefined when the spec doesn't parse/lower or
 * is not a channel target, mirroring {@link extractSpecModel}'s tolerance —
 * doctor must never fail because the cwd spec is a different shape. Lowering
 * (not raw parsing) is deliberate: `lower()` is where `$VAR_NAME` strings
 * become env-refs, so the check shares the compiled daemon's exact env
 * semantics instead of re-implementing the regex.
 */
export function extractChannelIr(yamlText: string): IrChannels | undefined {
  try {
    const ir = lower(parseSpec(yamlText));
    return ir.target === "channel" ? ir.channels : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Item 61 — channel-target doctor checks: one per configured platform
 * (slack/telegram/discord), asserting that every secret env-ref the compiled
 * daemon requires at boot (target-channel-bot's startup check exits 2 on the
 * same set) is actually set. Returns [] for non-channel specs, so the check
 * only appears when the cwd spec is a channel target. Offline by design —
 * live platform probes (granted scopes, webhook state) belong to
 * `crewhaus channel verify`, which the failure reason points at.
 */
export function buildChannelEnvChecks(
  yamlText: string,
  env: NodeJS.ProcessEnv,
): DoctorCredentialCheck[] {
  const channels = extractChannelIr(yamlText);
  if (channels === undefined) return [];
  const checks: DoctorCredentialCheck[] = [];
  for (const platform of CHANNEL_PLATFORMS) {
    const refs = platformSecretRefs(platform, channels);
    if (refs.length === 0) continue;
    const envNames = refs.flatMap((r) => (r.ref.kind === "env" ? [r.ref.name] : []));
    const missing = envNames.filter((name) => !isSet(env, name)).map((name) => `$${name}`);
    const label =
      envNames.length > 0
        ? `${PLATFORM_TITLE[platform]} channel env (${envNames.join(", ")})`
        : `${PLATFORM_TITLE[platform]} channel env (inline literals)`;
    checks.push(
      missing.length === 0
        ? { label, pass: true }
        : {
            label,
            pass: false,
            reason: `unset: ${missing.join(", ")} — the compiled daemon exits at boot without them; run \`crewhaus channel verify\` for live platform probes`,
          },
    );
  }
  return checks;
}

const PLATFORM_TITLE: Record<(typeof CHANNEL_PLATFORMS)[number], string> = {
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
};
