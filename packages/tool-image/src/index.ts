import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolResultContent } from "@crewhaus/tool-catalog";
import { z } from "zod";

/**
 * Section 14 — `ReadImage(path)`. Loads an image from the workspace and
 * returns an Anthropic `image` content block (base64) so the model can
 * actually see the image, not a base64 string of it.
 *
 * Defenses:
 *   - Path resolved against `process.cwd()` and rejected if it escapes,
 *     lexically or via an in-root symlink whose real target lies outside
 *     (CWE-59). Mirrors `tool-fs`'s `resolveSafe` — duplicated (here and
 *     in `tool-document-ingest`) rather than extracted to a shared util;
 *     keep the copies in sync.
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

/**
 * True when the NAME exists, whether or not it leads anywhere.
 *
 * `existsSync` follows symlinks, so it answers false for a link whose target
 * is missing — and a missing target is exactly the case that matters here: a
 * dangling link is still a door. Probing with `lstat` keeps that name in the
 * part of the path that gets RESOLVED rather than in the "does not exist
 * yet" tail that is appended to the root verbatim. `ReadImage` only ever
 * opens read-only, so today the consequence of getting this wrong is a
 * mis-scoped read rather than a file created outside the workspace — but the
 * check is the package's boundary, and the next tool added here may write.
 */
function nameExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `target` would actually land, with every symlink on the way already
 * followed — including one whose own target does not exist yet.
 *
 * `realpathSync` gives up with ENOENT on a dangling link, which would leave
 * that link unresolved and let it stand in for a plain missing file. So the
 * deepest ancestor that exists as a NAME is resolved, a dangling one is
 * followed a hop by hand, and the components that do not exist are appended.
 * The result is the path an `open` would reach, which is the only path worth
 * checking containment against.
 */
function resolveLocation(target: string, depth = 0): string {
  if (depth > 40) throw new Error(`symlink chain at "${target}" is too long to resolve`);
  let probe = target;
  const tail: string[] = [];
  while (!nameExists(probe)) {
    tail.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break; // reached the filesystem root
    probe = parent;
  }
  let probeReal: string;
  try {
    probeReal = realpathSync(probe);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // The name is there but `realpath` cannot finish it: a symlink with a
    // missing target. `readlinkSync` throws EINVAL on anything else, which
    // fails closed. A relative target resolves against the link's directory.
    // Recursing (rather than returning the raw target) is what resolves an
    // absolute target such as /var/folders/... to its real /private/var/...
    // form, so a legitimate in-workspace dangling link is not wrongly refused.
    const link = readlinkSync(probe);
    // A RELATIVE target resolves against the directory that actually CONTAINS
    // the link, which is not the link's lexical parent when that parent is
    // itself reached through a symlink. `<root>/dirlink/x -> ../y` with
    // `dirlink` pointing out of the root really lands at `<elsewhere>/y`, but
    // measured from the lexical parent it reads as `<root>/y` — an in-root
    // path the caller's path does not lead to. So the parent is made real
    // first. An absolute target ignores the base.
    const base = realpathSync(path.dirname(probe));
    probeReal = resolveLocation(path.resolve(base, link), depth + 1);
  }
  return tail.length > 0 ? path.join(probeReal, ...tail) : probeReal;
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
  //    the REAL path. The leaf may not exist (the file-not-found error comes
  //    after containment so escaping paths never leak existence info), so
  //    resolve the deepest ancestor that EXISTS AS A NAME and re-append the
  //    missing tail. "Exists as a name" rather than "exists": a dangling
  //    symlink is still followed by the kernel, so it is resolved here too
  //    rather than treated as a plain missing leaf that gets re-appended to
  //    the root and waved through.
  //    Fails closed if realpath errors for any reason other than the walk.
  let real: string;
  try {
    const rootReal = realpathSync(rootResolved);
    real = resolveLocation(abs);
    if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
      throw new ToolPermissionError(toolName, rel);
    }
  } catch (err) {
    if (err instanceof ToolPermissionError) throw err;
    throw new ToolPermissionError(toolName, rel);
  }
  // Return the validated REAL path; the read site opens it with O_NOFOLLOW so a
  // leaf swapped to a symlink after this check (TOCTOU/CWE-367) is rejected.
  return real;
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
    const abs = resolveSafe("ReadImage", input.path);
    // Open with O_NOFOLLOW so a leaf swapped to a symlink after the containment
    // check (TOCTOU/CWE-367) is rejected rather than followed out of the root.
    let fd: number;
    try {
      fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new ToolPermissionError("ReadImage", input.path, "file not found");
      }
      if (code === "ELOOP") {
        throw new ToolPermissionError("ReadImage", input.path, "path is a symlink");
      }
      throw err;
    }
    let buf: Uint8Array;
    try {
      const size = fstatSync(fd).size;
      if (size > MAX_IMAGE_BYTES) {
        throw new ToolPermissionError(
          "ReadImage",
          input.path,
          `image is ${size} bytes — exceeds the ${MAX_IMAGE_BYTES}-byte cap`,
        );
      }
      const b = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        const n = readSync(fd, b, offset, size - offset, offset);
        if (n === 0) break;
        offset += n;
      }
      buf = b.subarray(0, offset);
    } finally {
      closeSync(fd);
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
