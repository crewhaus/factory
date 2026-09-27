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
 * Bounds (0.7.1): the call ends when the turn's signal aborts (Ctrl-C,
 * `turn_timeout_ms`, `deadline_ms`), when `tool_config.imageGenerate.timeoutMs`
 * passes (default three minutes, request and body together), or when the
 * body passes `maxResponseBytes` (default 32 MiB, refused rather than
 * buffered); an error body is read only as far as its message shows.
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
   * Override the OpenAI base URL, for an OpenAI-compatible proxy (not Azure
   * OpenAI, whose path, `api-version` query and `api-key` header differ). OPENAI_API_KEY
   * goes wherever this points, so anything but `https://api.openai.com` must
   * also be approved by the operator outside the spec — see
   * {@link resolveOpenAIBaseUrl}.
   */
  readonly openaiBaseUrl?: string;
  /**
   * How long one generation may take, request and response together, in
   * milliseconds. Default 180000 (three minutes): a high-quality image can
   * take close to two. Past it the call fails with "timed out".
   */
  readonly timeoutMs?: number;
  /**
   * The most response body read, in bytes. Default 33554432 (32 MiB; a
   * 1792x1024 PNG as base64 is a few MB). A larger body is refused, not
   * buffered.
   */
  readonly maxResponseBytes?: number;
  /** Override fetch implementation for tests. */
  readonly fetch?: typeof globalThis.fetch;
};

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** An error body is shown only up to 500 characters, so only this much is read. */
const ERROR_BODY_BYTES = 4096;

/**
 * The longest `timeoutMs` a timer can hold: a delay past 2^31-1 ms (about
 * 24.8 days) overflows, and the runtime fires it after 1 ms instead.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Read `timeoutMs` / `maxResponseBytes` from a config block: a positive whole
 * number (a `timeoutMs` no longer than {@link MAX_TIMEOUT_MS}), else the
 * default. Anything else is refused with the key named, so a typo never
 * silently becomes "no limit" — nor, for a timeout too long for a timer, a
 * call that gives up after 1 ms and reports it timed out.
 */
function positiveLimit(
  cfg: ImageGenerationConfig,
  key: "timeoutMs" | "maxResponseBytes",
  fallback: number,
): number {
  const value: unknown = cfg[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ImageGenerationError(
      `tool_config.imageGenerate.${key} must be a positive whole number${
        key === "timeoutMs" ? " of milliseconds" : " of bytes"
      }. Remove it for the default (${fallback}).`,
    );
  }
  if (key === "timeoutMs" && value > MAX_TIMEOUT_MS) {
    throw new ImageGenerationError(
      `tool_config.imageGenerate.timeoutMs is ${value} ms, longer than a timer can wait (${MAX_TIMEOUT_MS} ms, about 24 days). Use a smaller value, or remove it for the default (${fallback}).`,
    );
  }
  return value;
}

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
  positiveLimit(config, "timeoutMs", DEFAULT_TIMEOUT_MS);
  positiveLimit(config, "maxResponseBytes", DEFAULT_MAX_RESPONSE_BYTES);
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
    // Not quoted: text that does not parse cannot be told apart from a
    // credential in it (a query, a userinfo, a password holding "/").
    throw new ImageGenerationError(
      "tool_config.imageGenerate.openaiBaseUrl is not an absolute URL (it is not quoted here, since a URL can carry a credential). Write it as https://host/v1.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ImageGenerationError(
      `the OpenAI base URL for ${url.protocol}//${url.host} carries user:password@. Remove it; the key is sent from OPENAI_API_KEY.`,
    );
  }
  // `${base}/images/generations` is appended as text, so a query or fragment
  // in the base would swallow the path (and a query can carry a credential):
  // refused, and not echoed.
  if (url.search !== "" || url.hash !== "") {
    throw new ImageGenerationError(
      `the OpenAI base URL for ${url.protocol}//${url.host} has a query or fragment. Write it as https://host/v1, with nothing after the path.`,
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
      return await generateOpenAI(input, cfg, responseFormat, ctx?.signal);
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

// ---------------------------------------------------------------------------
// Bounded request. This package ships in the cf-worker bundles, which cannot
// take @crewhaus/tool-safety (Bun-only), so the bound is written here with
// what workerd has too: AbortController, setTimeout and a stream reader.
// ---------------------------------------------------------------------------

const pinnedSignals = new WeakSet<AbortSignal>();
const noop = (): void => undefined;

/**
 * Call `fn` once when `signal` aborts; returns the unsubscribe. Never leaves
 * the caller's signal without a listener: on Bun, removing the last listener
 * from an `AbortSignal.timeout()` signal cancels its timer for good (the rule
 * tool-safety's `onAbort` follows), which would disarm the caller's deadline.
 */
function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (signal === undefined) return noop;
  if (!pinnedSignals.has(signal)) {
    pinnedSignals.add(signal);
    signal.addEventListener("abort", noop, { once: true });
  }
  signal.addEventListener("abort", fn, { once: true });
  return () => signal.removeEventListener("abort", fn);
}

/** A promise that rejects with `signal.reason` once `signal` aborts (our own
 *  controller's signal, so its listener may come and go freely). */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(signal.reason);
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(noop);
  return aborted;
}

/**
 * Read at most `maxBytes` of a body, racing every read against `signal`.
 * Returns the text and whether more was there; the stream is cancelled at
 * the cap, so the rest is never buffered. A response with no body stream
 * reads as empty.
 */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;
  if (body === null || body === undefined) return { text: "", truncated: false };
  const reader = body.getReader();
  const aborted = rejectOnAbort(signal);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Stop the producer: past the cap, on an abort, or on a read error.
    if (truncated || signal.aborted) await reader.cancel().catch(noop);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

async function generateOpenAI(
  input: z.infer<typeof inputSchema>,
  cfg: ImageGenerationConfig,
  responseFormat: "url" | "b64_json",
  callerSignal?: AbortSignal,
): Promise<string> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new ImageGenerationError(
      "OPENAI_API_KEY is not set — required for provider=openai. Set the env var or switch to provider=mock for offline testing.",
    );
  }
  const baseUrl = resolveOpenAIBaseUrl(cfg, processEnv());
  const model = cfg.model ?? "dall-e-3";
  // A spec block can only carry a string here; a per-call (model-pool
  // candidate) block used to reach `fetchFn(...)` and crash with "is not a
  // function". Refused like the boot block's.
  if (cfg.fetch !== undefined && typeof cfg.fetch !== "function") {
    throw new ImageGenerationError(
      "tool_config.imageGenerate.fetch is not a setting a spec can write. Remove it.",
    );
  }
  const fetchFn = cfg.fetch ?? globalThis.fetch;
  const timeoutMs = positiveLimit(cfg, "timeoutMs", DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = positiveLimit(cfg, "maxResponseBytes", DEFAULT_MAX_RESPONSE_BYTES);
  const body = JSON.stringify({
    model,
    prompt: input.prompt,
    n: 1,
    size: input.size ?? "1024x1024",
    response_format: responseFormat,
    ...(model === "dall-e-3" ? { style: input.style ?? "vivid" } : {}),
  });
  // One deadline over the request and the body read, and the turn's own
  // signal (Ctrl-C, turn_timeout_ms, deadline_ms) ends the call too.
  const ctrl = new AbortController();
  const timer = setTimeout(
    () =>
      ctrl.abort(
        new ImageGenerationError(`OpenAI image-generation request timed out after ${timeoutMs} ms`),
      ),
    timeoutMs,
  );
  const cancel = (): void =>
    ctrl.abort(new ImageGenerationError("OpenAI image-generation request was cancelled"));
  if (callerSignal?.aborted === true) cancel();
  const unsubscribe = onAbort(callerSignal, cancel);
  let json: { data?: ReadonlyArray<{ url?: string; b64_json?: string }> };
  try {
    // Raced as well as signalled: a fetch that ignores its signal (or is
    // handed one already aborted) still cannot hold the turn.
    const res = await Promise.race([
      fetchFn(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: ctrl.signal,
      }),
      rejectOnAbort(ctrl.signal),
    ]);
    if (!res.ok) {
      const { text } = await readBodyCapped(res, ERROR_BODY_BYTES, ctrl.signal).catch(() => ({
        text: "",
      }));
      const shown = text.length > 500 ? `${text.slice(0, 500)}… (truncated)` : text;
      throw new ImageGenerationError(
        `OpenAI image-generation request failed (${res.status} ${res.statusText}): ${shown}`,
      );
    }
    const read = await readBodyCapped(res, maxResponseBytes, ctrl.signal);
    if (read.truncated) {
      throw new ImageGenerationError(
        `OpenAI image-generation response body exceeded ${maxResponseBytes} bytes (tool_config.imageGenerate.maxResponseBytes); nothing past the cap was read`,
      );
    }
    try {
      json = JSON.parse(read.text) as typeof json;
    } catch {
      throw new ImageGenerationError(
        `OpenAI image-generation response was not JSON (${read.text.length} chars)`,
      );
    }
  } catch (err) {
    // An abort surfaces as whatever the runtime throws; say which one it was.
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof ImageGenerationError) {
      throw ctrl.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
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
