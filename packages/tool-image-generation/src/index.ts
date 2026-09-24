/**
 * Catalog R3 — tool-image-generation. M4.1 of the heavy-hitter plan.
 *
 * Exposes an `ImageGenerate(prompt, size?, style?)` tool that calls a
 * remote image-generation API. Today supports OpenAI's image-generation
 * endpoint (DALL-E 3 family); Replicate / Flux / SD are stubs that the
 * future provider router fills in.
 *
 * Why a remote API rather than a local model: this is a runtime layer,
 * not an inference layer. Local image generation requires GPU + 5-20GB
 * model weights — not realistic to ship by default. Operators who want
 * a self-hosted backend point `provider: "replicate"` at a custom
 * endpoint (Replicate, Together, or their own hosted Flux/SD).
 *
 * Returns: a URL string (when the provider returns one) or a base64
 * data URI (DALL-E with response_format=b64_json). The model can
 * include the URL in its reply; vision-capable models can see the
 * image inline on subsequent turns via WebFetch.
 *
 * Pillar 3: this tool is non-destructive (`destructive: false`) — it
 * doesn't write to the user's host filesystem; it issues a remote HTTP
 * request. Tool output is classified post-execution by runtime-core's
 * `tool` origin classifier (the generated image URL is host-untrusted).
 */
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

export type ImageGenerationProvider = "openai" | "replicate" | "mock";

export type ImageGenerationConfig = {
  /** Which provider to route to. Defaults to "openai" when OPENAI_API_KEY is set. */
  readonly provider?: ImageGenerationProvider;
  /** Provider-specific model id. Defaults: openai → "dall-e-3", replicate → "stability-ai/sdxl". */
  readonly model?: string;
  /**
   * Override the OpenAI base URL (for a proxy or Azure OpenAI). OPENAI_API_KEY
   * goes wherever this points, so anything but `https://api.openai.com` must
   * also be approved by the operator outside the spec — see
   * {@link resolveOpenAIBaseUrl}.
   */
  readonly openaiBaseUrl?: string;
  /** Override fetch implementation for tests. */
  readonly fetch?: typeof globalThis.fetch;
};

const inputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("What to generate. Be specific; vague prompts produce vague images."),
  size: z
    .enum(["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"])
    .optional()
    .describe("Output dimensions. Defaults to 1024x1024."),
  style: z.enum(["vivid", "natural"]).optional().describe("DALL-E 3 style. Defaults to vivid."),
  responseFormat: z
    .enum(["url", "b64_json"])
    .optional()
    .describe(
      "How to return the image. Default 'url'; b64_json is useful for offline / no-CDN deployments.",
    ),
});

export class ImageGenerationError extends CrewhausError {
  override readonly name = "ImageGenerationError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

let registeredConfig: ImageGenerationConfig | undefined;

/**
 * Section-14 style config registration. The compiled bundle calls
 * `registerImageGenerationConfig({ provider, model, ... })` at boot;
 * the tool's execute() reads from registeredConfig at call time so
 * env-driven defaults work without re-registering.
 */
export function registerImageGenerationConfig(config: ImageGenerationConfig): void {
  if (config.fetch !== undefined && typeof config.fetch !== "function") {
    throw new ImageGenerationError(
      "tool_config.imageGenerate.fetch is not a setting a spec can write. Remove it.",
    );
  }
  // Checked here as well as on every call, so a spec that points the key
  // somewhere the operator did not approve fails at boot, where someone is
  // looking, and not at the first image.
  if (config.openaiBaseUrl !== undefined) resolveOpenAIBaseUrl(config, processEnv());
  registeredConfig = config;
}

/** The environment, or nothing where there is no `process` (a Worker without Node compat). */
function processEnv(): Readonly<Record<string, string | undefined>> {
  return typeof process === "undefined" ? {} : process.env;
}

const OPENAI_ORIGIN = "https://api.openai.com";
const OPENAI_DEFAULT_BASE_URL = `${OPENAI_ORIGIN}/v1`;

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Where OPENAI_API_KEY may be sent, and the only place it is sent.
 *
 * The base URL is `openaiBaseUrl` from the tool's config, else
 * `https://api.openai.com/v1`. A spec can come from a template or a pull
 * request, so it cannot choose where the key goes on its own:
 *
 *  - any origin but `https://api.openai.com` needs the operator's approval:
 *    `OPENAI_BASE_URL` in the environment naming the same origin;
 *  - plain http is refused, except on loopback (a local proxy) with that
 *    same approval — the key would otherwise cross the network unencrypted;
 *  - a URL with `user:password@` in it is refused.
 */
export function resolveOpenAIBaseUrl(
  cfg: ImageGenerationConfig,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const operator = env["OPENAI_BASE_URL"];
  const raw = cfg.openaiBaseUrl ?? OPENAI_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImageGenerationError(
      `the OpenAI base URL "${raw}" is not an absolute URL. Write it as https://host/v1.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ImageGenerationError(
      `the OpenAI base URL for ${url.protocol}//${url.host} carries user:password@. Remove it; the key is sent from OPENAI_API_KEY.`,
    );
  }
  let approved = false;
  if (operator !== undefined && operator !== "") {
    try {
      approved = new URL(operator).origin === url.origin;
    } catch {
      approved = false;
    }
  }
  const approve = `set OPENAI_BASE_URL=${url.origin}${url.pathname.replace(/\/+$/, "")} in the environment the harness starts in`;
  if (url.protocol === "http:") {
    if (!isLoopbackHost(url.hostname) || !approved) {
      throw new ImageGenerationError(
        `the OpenAI base URL ${url.origin} is plain http, which would send OPENAI_API_KEY unencrypted. Use https. A proxy on loopback is allowed when the operator approves it: ${approve}.`,
      );
    }
  } else if (url.protocol !== "https:") {
    throw new ImageGenerationError(
      `the OpenAI base URL ${url.origin} is not https. Write it as https://host/v1.`,
    );
  } else if (url.origin !== OPENAI_ORIGIN && !approved) {
    throw new ImageGenerationError(
      `tool_config.imageGenerate.openaiBaseUrl would send OPENAI_API_KEY to ${url.origin}. A spec cannot choose where the key goes; to approve this endpoint, ${approve}.`,
    );
  }
  return raw.replace(/\/+$/, "");
}

/**
 * 0.6.0 §4.4 — the config ONE call runs under: the serving candidate's
 * `tool_config.imageGenerate` block when its profile declares one
 * (`ToolExecuteContext.toolConfig`, REPLACING the registered block for this
 * call exactly as `registerImageGenerationConfig` replaces it at boot), else
 * the process-global registration (else `{}` — env-driven defaults).
 */
export function resolveImageGenerationConfig(override: unknown): ImageGenerationConfig {
  if (typeof override === "object" && override !== null && !Array.isArray(override)) {
    return override as ImageGenerationConfig;
  }
  return registeredConfig ?? {};
}

export const imageGenerate: RegisteredTool = buildTool({
  name: "ImageGenerate",
  operativeArgs: [],
  description:
    "Generate an image from a text prompt via a remote API. Returns a URL or base64 data URI. Use for: visual concepts, mockups, illustrations, social posts. Don't use for: 'edit this existing photo' (different tool needed).",
  inputSchema,
  destructive: false,
  readOnly: false, // not idempotent — each call mints a new image
  // Pillar 3 sink-side: the prompt is sent to a remote provider; lineage
  // exfiltration via prompt smuggling is real.
  scope: "external",
  // FR-002 — declare the io-capability fact (remote image-gen API call).
  ioCapability: "network",
  execute: async (input, ctx) => {
    const cfg = resolveImageGenerationConfig(ctx?.toolConfig);
    const provider = cfg.provider ?? defaultProvider(process.env);
    const responseFormat = input.responseFormat ?? "url";
    if (provider === "openai") {
      return await generateOpenAI(input, cfg, responseFormat);
    }
    if (provider === "mock") {
      return await generateMock(input);
    }
    throw new ImageGenerationError(
      `provider "${provider}" is not yet implemented in tool-image-generation v0`,
    );
  },
});

function defaultProvider(env: NodeJS.ProcessEnv): ImageGenerationProvider {
  if (env["OPENAI_API_KEY"]) return "openai";
  if (env["CREWHAUS_IMAGE_PROVIDER"] === "mock") return "mock";
  return "openai"; // surfaces a clear "missing OPENAI_API_KEY" error at call time
}

async function generateOpenAI(
  input: z.infer<typeof inputSchema>,
  cfg: ImageGenerationConfig,
  responseFormat: "url" | "b64_json",
): Promise<string> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new ImageGenerationError(
      "OPENAI_API_KEY is not set — required for provider=openai. Set the env var or switch to provider=mock for offline testing.",
    );
  }
  const baseUrl = resolveOpenAIBaseUrl(cfg, processEnv());
  const model = cfg.model ?? "dall-e-3";
  const fetchFn = cfg.fetch ?? globalThis.fetch;
  const body = JSON.stringify({
    model,
    prompt: input.prompt,
    n: 1,
    size: input.size ?? "1024x1024",
    response_format: responseFormat,
    ...(model === "dall-e-3" ? { style: input.style ?? "vivid" } : {}),
  });
  const res = await fetchFn(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ImageGenerationError(
      `OpenAI image-generation request failed (${res.status} ${res.statusText}): ${text.slice(0, 500)}`,
    );
  }
  const json = (await res.json()) as {
    data?: ReadonlyArray<{ url?: string; b64_json?: string }>;
  };
  const first = json.data?.[0];
  if (!first) {
    throw new ImageGenerationError("OpenAI response missing data[0] — unexpected format");
  }
  if (responseFormat === "url") {
    if (typeof first.url !== "string") {
      throw new ImageGenerationError("OpenAI response missing data[0].url");
    }
    return `image URL: ${first.url}`;
  }
  if (typeof first.b64_json !== "string") {
    throw new ImageGenerationError("OpenAI response missing data[0].b64_json");
  }
  return `image base64 data: data:image/png;base64,${first.b64_json.slice(0, 80)}…[truncated ${
    first.b64_json.length
  } bytes total]`;
}

async function generateMock(input: z.infer<typeof inputSchema>): Promise<string> {
  // Deterministic stub — useful for tests + offline development.
  return `mock image generated for prompt: "${input.prompt}" (no provider configured; set OPENAI_API_KEY or CREWHAUS_IMAGE_PROVIDER)`;
}
