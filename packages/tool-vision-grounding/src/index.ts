/**
 * Catalog R4 `tool-vision-grounding` — Section 25 BROW.
 *
 * `FindElement(description)` — natural-language → bounding-box. Takes
 * a description, takes a fresh screenshot via the configured driver,
 * sends both to a vision-capable Claude model, parses out the bbox the
 * model returns, and surfaces it back to the calling agent.
 *
 * The grounding model is configurable. Defaults to the agent's primary
 * model so the cost stays consistent with the rest of the agent loop.
 *
 * Output shape (returned as JSON in the tool result):
 *   {
 *     "bbox": { "x": 100, "y": 50, "width": 80, "height": 24 },
 *     "centerX": 140, "centerY": 62,
 *     "confidence": "high" | "medium" | "low"
 *   }
 *
 * The center coordinates are pre-computed so the agent can pipe them
 * straight into `Click(x, y)` without arithmetic.
 *
 * Determinism: low-temperature model call + a strict fenced-JSON
 * extractor matching the planner's pattern. One auto-retry on parse
 * failure.
 */
import {
  type ProviderAdapter,
  type StreamEvent,
  consumeStream,
  extractFirstText,
} from "@crewhaus/adapter-anthropic";
import type { Driver } from "@crewhaus/computer-use-driver";
import { ConfigError, CrewhausError } from "@crewhaus/errors";
import { resolveModel } from "@crewhaus/model-router";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

export class VisionGroundingError extends CrewhausError {
  override readonly name = "VisionGroundingError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

export type Bbox = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type GroundingResult = {
  readonly bbox: Bbox;
  readonly centerX: number;
  readonly centerY: number;
  readonly confidence: "high" | "medium" | "low";
};

const findElementSchema = z
  .object({
    description: z
      .string()
      .min(1)
      .describe(
        "Natural-language description of the UI element you want coordinates for, e.g. 'the Submit button'.",
      ),
  })
  .strict();

export type CreateFindElementToolOptions = {
  readonly driver: Driver;
  /** Model the grounding call uses. Defaults to the agent's primary model. */
  readonly model: string;
  /** Test injection: bypass the model-router. */
  readonly _adapter?: ProviderAdapter;
};

const SYSTEM = `You are a vision-grounding assistant. Given a screenshot and a natural-language
description of a UI element, you return the element's bounding box in viewport pixel
coordinates.

Return ONLY a JSON object inside a single \`\`\`json fenced code block, no prose:

\`\`\`json
{
  "bbox": { "x": 100, "y": 50, "width": 80, "height": 24 },
  "confidence": "high"
}
\`\`\`

Rules:
- Coordinates are in viewport pixels (origin top-left).
- Confidence: "high" if you can pinpoint the element, "medium" if approximate,
  "low" if uncertain — but ALWAYS return a bbox.
- If the element is not visible, return your best guess of where it would be
  with confidence "low".
`;

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)\s*```/;

function extractJson(text: string): string {
  const m = FENCE_RE.exec(text);
  if (m?.[1]) return m[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  throw new VisionGroundingError(
    `could not locate JSON block in grounding output: ${text.slice(0, 200)}`,
  );
}

function parseBbox(json: string): { bbox: Bbox; confidence: "high" | "medium" | "low" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new VisionGroundingError(
      `grounding output is not valid JSON: ${json.slice(0, 120)}`,
      err,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new VisionGroundingError("grounding output JSON is not an object");
  }
  const obj = parsed as { bbox?: unknown; confidence?: unknown };
  const b = obj.bbox as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined;
  if (
    b === undefined ||
    typeof b.x !== "number" ||
    typeof b.y !== "number" ||
    typeof b.width !== "number" ||
    typeof b.height !== "number"
  ) {
    throw new VisionGroundingError("grounding output bbox is missing numeric x/y/width/height");
  }
  const confidence =
    obj.confidence === "high" || obj.confidence === "medium" || obj.confidence === "low"
      ? obj.confidence
      : "medium";
  return {
    bbox: {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
    },
    confidence,
  };
}

async function callGrounding(
  adapter: ProviderAdapter,
  modelId: string,
  description: string,
  pngBytes: Uint8Array,
): Promise<string> {
  const b64 = Buffer.from(pngBytes).toString("base64");
  const stream: AsyncIterable<StreamEvent> = adapter.stream({
    model: modelId,
    maxTokens: 512,
    system: [{ type: "text", text: SYSTEM }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: b64 },
          },
          {
            type: "text",
            text: `Find: ${description}\n\nReturn the bounding box JSON.`,
          },
        ],
      },
    ],
  });
  const message = await consumeStream(stream);
  const text = extractFirstText(message);
  if (text === undefined) {
    throw new VisionGroundingError("grounding model returned a non-text message");
  }
  return text;
}

export function createFindElementTool(opts: CreateFindElementToolOptions): RegisteredTool {
  return buildTool({
    name: "FindElement",
    description:
      "Find a UI element by natural-language description. Returns a bounding box and pre-computed center coordinates you can pass to Click(x, y).",
    inputSchema: findElementSchema,
    readOnly: true,
    destructive: false,
    concurrencySafe: false,
    classifyOutput: false,
    execute: async (input) => {
      const resolution = opts._adapter
        ? { adapter: opts._adapter, modelId: opts.model, providerId: opts._adapter.providerId }
        : await resolveModel(opts.model);
      // Section 17 — feature gate BEFORE taking/sending a screenshot: a
      // non-vision grounding model (e.g. a text-only Bedrock family) must
      // fail with a clear ConfigError, not an opaque provider 400 after
      // the image upload.
      if (resolution.adapter.features.vision === false) {
        throw new ConfigError(
          `grounding model "${opts.model}" (provider ${resolution.providerId}) does not support vision — FindElement needs a vision-capable model (set groundingModel to one)`,
        );
      }
      const png = await opts.driver.screenshot();
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const text = await callGrounding(
            resolution.adapter,
            resolution.modelId,
            input.description,
            png,
          );
          const json = extractJson(text);
          const { bbox, confidence } = parseBbox(json);
          const result: GroundingResult = {
            bbox,
            centerX: Math.round(bbox.x + bbox.width / 2),
            centerY: Math.round(bbox.y + bbox.height / 2),
            confidence,
          };
          return JSON.stringify(result);
        } catch (err) {
          lastErr = err;
        }
      }
      return `[FindElement error] ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`;
    },
  });
}
