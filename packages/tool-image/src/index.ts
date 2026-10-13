import { closeSync } from "node:fs";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolResultContent } from "@crewhaus/tool-catalog";
import { openForReadFd, resolveContained } from "@crewhaus/tool-safety/fs";
import { readOpenedFileSync } from "@crewhaus/tool-safety/streams";
import { z } from "zod";

/**
 * Section 14 — `ReadImage(path)`. Loads an image from the workspace and
 * returns an Anthropic `image` content block (base64) so the model can
 * actually see the image, not a base64 string of it.
 *
 * Defenses:
 *   - Path resolved against `process.cwd()` and rejected if it escapes,
 *     lexically or via an in-root symlink whose real target lies outside
 *     (CWE-59). Where the path lands is tool-safety's `resolveContained`
 *     (component by component, dangling links followed), and the read is
 *     its `openForReadFd`: a FIFO, socket or device is refused before it
 *     is opened, and the open descriptor must be inside the workspace.
 *   - Magic-byte validation on the first 12 bytes — rejects extension
 *     spoofing (e.g. `evil.png` whose actual content is a PDF).
 *   - 5 MB per-image cap.
 *
 * Deferred (Section 14.5 / 15): a 20-images-per-turn cap. Today there is
 * no per-turn state shared between tools and runtime — `ToolExecuteContext`
 * exposes `signal` + opaque `bridge` only. When `RunContext.turnMetrics`
 * lands we will gate further calls on `imageCount >= 20`.
 *
 * Layer R4. Pairs with the `target-cli` codegen contract — `BUILTIN_TOOL_MAP`
 * has `readImage: { package: "@crewhaus/tool-image", export: "readImage" }`.
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class ToolPermissionError extends CrewhausError {
  override readonly name = "ToolPermissionError";
  readonly toolName: string;
  readonly path: string;
  constructor(toolName: string, attemptedPath: string, reason?: string) {
    super(
      "tool",
      `tool "${toolName}" rejected path "${attemptedPath}"${reason ? `: ${reason}` : ": resolved location escapes the workspace root"}`,
    );
    this.toolName = toolName;
    this.path = attemptedPath;
  }
}

function resolveSafe(toolName: string, rel: string, root: string = process.cwd()): string {
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, rel);
  // 1) Lexical containment — fast path; rejects `..` and absolute escapes.
  //    The trailing `path.sep` avoids the `/root` vs `/root-sibling` pitfall.
  if (abs !== rootResolved && !abs.startsWith(`${rootResolved}${path.sep}`)) {
    throw new ToolPermissionError(toolName, rel);
  }
  // 2) Symlink-aware containment (CWE-59). The lexical check above is fooled
  //    by an in-root symlink that points outside the workspace, so re-check
  //    where the path PHYSICALLY lands. The leaf may not exist (the
  //    file-not-found error comes after containment so escaping paths never
  //    leak existence info). tool-safety walks it one component at a time,
  //    as the kernel does, following dangling links too; the copy that lived
  //    here folded a dangling link's target as text (C068). Fails closed.
  const resolved = resolveContained(rootResolved, abs);
  if (!resolved.ok) throw new ToolPermissionError(toolName, rel);
  return resolved.real;
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * Sniff the first 12 bytes for a known image magic-byte signature. Returns
 * the canonical media type or `null` for anything else. Tools using this
 * MUST treat `null` as a hard reject — never trust the file extension.
 */
export function detectMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length < 4) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: 47 49 46 38 (GIF87a / GIF89a)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

const readImageSchema = z.object({ path: z.string().min(1) });

export const readImage: RegisteredTool = buildTool({
  name: "ReadImage",
  description:
    "Read an image file (PNG, JPEG, GIF, or WebP) from the workspace and return it as a base64 image block the model can see. Path is resolved relative to the project root; escaping the root is rejected. Per-image limit: 5 MB.",
  inputSchema: readImageSchema,
  readOnly: true,
  // 0.6.0 §5.1 — the result is an image block the model must be able to SEE:
  // a pool candidate without vision never gets this tool advertised (the
  // plan table's capability filter), and `compile --strict` checks the same
  // requirement offline against the capability table.
  requiresModelFeatures: { vision: true },
  // Not concurrency-safe today: see deferred per-turn image counter above —
  // when that lands, parallel calls would race on the counter. Mark serial
  // until the runtime exposes a shared turn store.
  execute: async (input): Promise<string | ToolResultContent> => {
    resolveSafe("ReadImage", input.path);
    // tool-safety's contained open: a FIFO, socket or device is refused
    // BEFORE it is opened (a blocking open of a FIFO froze the event loop
    // until a writer appeared, and no timeout or abort reaches it: C074), a
    // leaf or directory swapped for a link out of the workspace after the
    // check above is refused on the descriptor, and the size is read from
    // the descriptor before a byte is.
    const opened = openForReadFd(process.cwd(), input.path);
    if (!opened.ok) {
      if (opened.code === "escapes-root") throw new ToolPermissionError("ReadImage", input.path);
      if (opened.code === "not-found") {
        throw new ToolPermissionError("ReadImage", input.path, "file not found");
      }
      if (opened.code === "is-symlink") {
        throw new ToolPermissionError("ReadImage", input.path, "path is a symlink");
      }
      throw new ToolPermissionError("ReadImage", input.path, opened.reason);
    }
    let buf: Uint8Array;
    try {
      const size = opened.stats.size;
      if (size > MAX_IMAGE_BYTES) {
        throw new ToolPermissionError(
          "ReadImage",
          input.path,
          `image is ${size} bytes — exceeds the ${MAX_IMAGE_BYTES}-byte cap`,
        );
      }
      const r = readOpenedFileSync(
        { ok: true, fd: opened.fd, stats: opened.stats },
        { maxBytes: MAX_IMAGE_BYTES },
      );
      if (!r.ok)
        throw new ToolPermissionError("ReadImage", input.path, "the file could not be read");
      if (r.truncated) {
        throw new ToolPermissionError(
          "ReadImage",
          input.path,
          `image grew past the ${MAX_IMAGE_BYTES}-byte cap while it was read`,
        );
      }
      buf = r.bytes;
    } finally {
      closeSync(opened.fd);
    }
    const mediaType = detectMediaType(buf);
    if (mediaType === null) {
      throw new ToolPermissionError(
        "ReadImage",
        input.path,
        "unrecognized image format (only PNG, JPEG, GIF, WebP supported)",
      );
    }
    const data = Buffer.from(buf).toString("base64");
    return [
      {
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      },
    ];
  },
});
