/**
 * A8 — vision-model OCR wiring for `multimodal.imageOcrThenGrade`.
 *
 * The grader-multimodal pack's `imageOcrThenGrade` requires a
 * caller-supplied `OcrFn`; until now no bundled wiring existed, so the
 * registry name was a wiring-explaining thrower. This module builds an
 * `OcrFn` from ONE multimodal provider call — no invented ML model: the
 * image rides a canonical `image` content block (all four bundled adapters
 * translate it) to a vision-capable model named by the graders.yaml entry's
 * `opts.model` or the {@link EVAL_VISION_MODEL_ENV} env var, resolved at
 * FIRST grade exactly like the `semantic.similarity` embedder.
 *
 * The transcription prompt is fixed and the temperature pinned to 0
 * (NEW-HUNT-2 discipline — an OCR step is a measurement, not a creative
 * task). The model's reply is treated as the transcribed text and handed
 * to the pack's named text grader; it is DATA to that grader, never
 * instructions.
 *
 * `multimodal.audioTranscriptMatch` deliberately gets NO sibling here: the
 * canonical adapter content blocks carry text and images only — there is no
 * audio input path through any bundled adapter, so a `CREWHAUS_EVAL_STT_MODEL`
 * hook would be fake wiring. STT stays plugin/programmatic-supplied until
 * the adapter surface grows audio blocks (recorded as a campaign deferral).
 */
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { GraderError } from "@crewhaus/eval-grader";
import type { OcrFn } from "@crewhaus/grader-multimodal";

/** Env var naming the vision model spec for `multimodal.imageOcrThenGrade`
 *  (mirrors `CREWHAUS_EVAL_EMBEDDER`). */
export const EVAL_VISION_MODEL_ENV = "CREWHAUS_EVAL_VISION_MODEL";

/** Magic-byte sniff for the media type providers require alongside base64
 *  image data. Conservative: unknown bytes default to PNG (the most common
 *  eval-artifact format) rather than failing the call on a sniff miss. */
export function sniffImageMediaType(bytes: Uint8Array): string {
  const at = (i: number): number => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  )
    return "image/webp";
  return "image/png";
}

/**
 * Build the vision-backed {@link OcrFn}. `modelSpec` is any model-router
 * spec naming a vision-capable model; `adapter` injects a pre-built
 * ProviderAdapter (tests / programmatic callers), matching every other
 * judge-family entrypoint.
 *
 * Input contract (the pack's `OcrFn` shape): `Uint8Array` = raw image
 * bytes; `string` = already-base64-encoded image data (media type sniffed
 * from the decoded prefix).
 */
export function visionOcr(modelSpec: string, adapter?: ProviderAdapter): OcrFn {
  return async (image, lang) => {
    const [{ collectFinalMessage }, { resolveModel }] = await Promise.all([
      import("@crewhaus/adapter-anthropic"),
      import("@crewhaus/model-router"),
    ]);
    const bytes = typeof image === "string" ? Uint8Array.from(Buffer.from(image, "base64")) : image;
    if (bytes.length === 0) {
      throw new GraderError("visionOcr: empty image payload — nothing to transcribe");
    }
    const data = typeof image === "string" ? image : Buffer.from(image).toString("base64");
    const mediaType = sniffImageMediaType(bytes);
    const resolution = adapter ? { adapter, modelId: modelSpec } : await resolveModel(modelSpec);
    const final = await collectFinalMessage(
      resolution.adapter.stream({
        model: resolution.modelId,
        system: [
          {
            type: "text",
            text:
              "You are an OCR engine. Transcribe ALL text visible in the supplied image, in " +
              "natural reading order. Output ONLY the transcribed text — no commentary, no " +
              "markdown fences, no description of the image. If the image contains no text, " +
              "output nothing.",
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data } },
              {
                type: "text",
                text: `Transcribe the text in this image${lang !== undefined ? ` (language hint: ${lang})` : ""}.`,
              },
            ],
          },
        ],
        maxTokens: 4096,
        temperature: 0,
      }),
    );
    return final.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  };
}
