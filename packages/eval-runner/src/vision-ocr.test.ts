/**
 * A8 — vision-model OCR: media-type sniffing, request shape (image block +
 * pinned temperature 0 + OCR-only instruction), and text extraction, all
 * driven by a synthetic ProviderAdapter (no network, no credentials).
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { sniffImageMediaType, visionOcr } from "./vision-ocr";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

/** Synthetic vision model: replies with fixed text and captures the request. */
function makeTextStub(text: string, seen: { req?: ProviderRequest } = {}): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream(req) {
      seen.req = req;
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start" };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn" };
        yield { kind: "message_stop" };
      })();
    },
  };
}

describe("sniffImageMediaType", () => {
  test("recognizes png / jpeg / gif / webp and defaults unknown bytes to png", () => {
    expect(sniffImageMediaType(PNG)).toBe("image/png");
    expect(sniffImageMediaType(JPEG)).toBe("image/jpeg");
    expect(sniffImageMediaType(GIF)).toBe("image/gif");
    expect(sniffImageMediaType(WEBP)).toBe("image/webp");
    expect(sniffImageMediaType(Uint8Array.from([1, 2, 3, 4]))).toBe("image/png");
  });
});

describe("visionOcr (A8)", () => {
  test("sends ONE image block + language hint at temperature 0 and returns the reply text", async () => {
    const seen: { req?: ProviderRequest } = {};
    const ocr = visionOcr("stub-vision", makeTextStub("HELLO WORLD", seen));
    const text = await ocr(JPEG, "en");
    expect(text).toBe("HELLO WORLD");
    const req = seen.req as ProviderRequest;
    expect(req.model).toBe("stub-vision");
    expect(req.temperature).toBe(0);
    const userMsg = req.messages.find((m) => m.role === "user");
    const blocks = userMsg?.content as ReadonlyArray<{
      type: string;
      source?: { media_type?: string; data?: string };
    }>;
    const image = blocks.find((b) => b.type === "image");
    expect(image?.source?.media_type).toBe("image/jpeg");
    expect(image?.source?.data).toBe(Buffer.from(JPEG).toString("base64"));
    const textBlock = blocks.find((b) => b.type === "text") as { text?: string } | undefined;
    expect(textBlock?.text).toContain("language hint: en");
    // The system prompt confines the model to transcription.
    expect(req.system.map((b) => b.text).join("\n")).toContain("OCR engine");
  });

  test("accepts already-base64 string input, sniffing the decoded prefix", async () => {
    const seen: { req?: ProviderRequest } = {};
    const b64 = Buffer.from(PNG).toString("base64");
    const ocr = visionOcr("stub-vision", makeTextStub("png text", seen));
    expect(await ocr(b64)).toBe("png text");
    const blocks = (seen.req as ProviderRequest).messages[0]?.content as ReadonlyArray<{
      type: string;
      source?: { media_type?: string; data?: string };
    }>;
    const image = blocks.find((b) => b.type === "image");
    expect(image?.source?.media_type).toBe("image/png");
    expect(image?.source?.data).toBe(b64);
  });

  test("empty payload is a loud GraderError, never a model call", async () => {
    const ocr = visionOcr("stub-vision", makeTextStub("unreachable"));
    expect(ocr(Uint8Array.from([]))).rejects.toThrow(/empty image payload/);
  });
});
