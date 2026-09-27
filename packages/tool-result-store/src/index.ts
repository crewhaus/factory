/**
 * Catalog R3 `tool-result-store` — persist large tool outputs to disk
 * and return a preview the model can re-read via the `Read` tool. This
 * keeps wide messages out of the conversation context (cheaper, faster)
 * while preserving full output for any later look-up.
 *
 * Default policy:
 *   - Threshold: 10240 bytes (10 KB) of UTF-8.
 *   - Storage path: `<rootDir>/<runId>/<toolUseId>.txt`
 *     (rootDir defaults to `.crewhaus/tool-results` under cwd).
 *   - Preview: the first 100 lines, cut to at most `previewBytes` bytes
 *     (default: the threshold) on a character boundary, then
 *     `[truncated, full output at <fullPath>]`. The byte cap matters for
 *     the common case of one long line — a JSON-encoded result — which the
 *     line limit alone passed through whole.
 *   - Parts: the rest of the output is also saved as
 *     `<toolUseId>.part-<k>.txt` files, each small enough to come back
 *     whole from one `Read`, each naming the next, and the preview names
 *     part 2. Without them the rest of a one-line result was out of reach:
 *     `Read` has no offset, and a `Read` of the full file is itself cut to
 *     the same preview. At most {@link MAX_PARTS} parts; past them the rest
 *     is only in the full file, and the last part says so.
 *
 * Exclusive writes: the file is created new (`O_EXCL`, via
 * `@crewhaus/tool-safety/fs` `createExclusive`), so nothing is ever written
 * through a link or over an existing file, and the directory it lands in
 * must physically be inside `rootDir`. A `tool_use_id` is NOT unique within
 * a run: providers that send no id get one synthesised per response
 * (Gemini's `gemini_<name>_<n>`, an OpenAI-compatible server's
 * `call_<n>`), so two calls can share one. When the name is taken, the file
 * there is compared with this result: the same bytes (a retried call) reuse
 * it; anything else — different output, a link, a FIFO — moves on to
 * `<toolUseId>.<n>.txt`, and the preview's pointer names the file actually
 * written. A result that cannot be saved at all still reaches the model as
 * a preview, marked as cut short with the reason, instead of ending the run.
 *
 * Path traversal: `runId` and `toolUseId` are joined under `rootDir`
 * after rejecting any value containing path separators or `..` to
 * prevent a tool-result from escaping its run directory.
 *
 * Reference: `claude-code/utils/toolResultStorage.ts` — uses
 * `<persisted-output>` XML wrappers, a per-tool size budget, and a
 * GrowthBook flag to override per tool. We collapse to a single global
 * threshold and a plain-text marker.
 */
import { closeSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { RuntimeError } from "@crewhaus/errors";
import { assertSamePath, currentTenantContext, requireTenant } from "@crewhaus/tenancy";
import type { ToolExecuteResult } from "@crewhaus/tool-catalog";
import type { ToolResult } from "@crewhaus/tool-executor";
import { createExclusive, openForRead, openForReadSync } from "@crewhaus/tool-safety/fs";

// When a tenant context is active, fail closed on a resolved storage path that
// escapes the tenant's toolResultRoot (CWE-1230). Outside a tenant scope (the
// common CLI case) this is a no-op so non-tenant behaviour is unchanged.
function fence(absPath: string): void {
  if (currentTenantContext() !== undefined) {
    assertSamePath(absPath, requireTenant().toolResultRoot);
  }
}

export type StoreOptions = {
  readonly runId: string;
  readonly toolUseId: string;
  readonly thresholdBytes?: number;
  readonly previewLines?: number;
  /**
   * The most UTF-8 bytes of the result the preview carries, before the
   * marker. Defaults to `thresholdBytes`, so a persisted result's preview is
   * never larger than a result small enough to go through whole.
   */
  readonly previewBytes?: number;
  readonly rootDir?: string;
};

export type StoredResult = {
  readonly previewContent: ToolExecuteResult;
  readonly fullPath: string | null;
  readonly persisted: boolean;
  /**
   * The full output was already on disk at `fullPath`, byte for byte (a
   * retried call), and nothing was written this time.
   */
  readonly reused?: boolean;
  /**
   * The result was over the threshold but could not be saved; the preview
   * says so and `fullPath` is null. Why, naming the path tried.
   */
  readonly unsaved?: string;
  /**
   * Where the rest of the output was saved in parts (part 2 onwards), each
   * small enough for one `Read`; the preview names the first of them.
   */
  readonly partPaths?: ReadonlyArray<string>;
};

export const DEFAULT_THRESHOLD_BYTES = 10240;
export const DEFAULT_PREVIEW_LINES = 100;
export const DEFAULT_ROOT_DIR = ".crewhaus/tool-results";

/**
 * How many names (`<id>.txt`, then `<id>.2.txt` …) one result tries before
 * it is reported unsaved. Each taken name costs one bounded compare-read.
 */
export const MAX_NAME_ATTEMPTS = 1000;

/** The most parts (the preview is part 1) a result is saved in for paging. */
export const MAX_PARTS = 64;

/** No parts are written when the threshold leaves less than this for each. */
const MIN_PART_BYTES = 1024;

/**
 * If `result.content` is at or under threshold, return it unchanged.
 * Otherwise persist the full text under `<rootDir>/<runId>/<toolUseId>.txt`
 * and return `{ previewContent, fullPath, persisted: true }`. Errors
 * (`isError: true`) follow the same path so large stack traces are
 * captured.
 */
export async function storeAndPreview(
  result: ToolResult,
  opts: StoreOptions,
): Promise<StoredResult> {
  const thresholdBytes = opts.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  const previewLines = opts.previewLines ?? DEFAULT_PREVIEW_LINES;
  const previewBytes = opts.previewBytes ?? thresholdBytes;
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;

  // Section 14 — non-string content (image content arrays) bypasses
  // persistence entirely. The blocks are forwarded as-is to the model so
  // it can see the image; size capping happens inside the producing tool
  // (e.g. tool-image enforces a 5 MB per-image limit on disk).
  if (typeof result.content !== "string") {
    return { previewContent: result.content, fullPath: null, persisted: false };
  }

  const byteLength = Buffer.byteLength(result.content, "utf8");
  if (byteLength <= thresholdBytes) {
    return { previewContent: result.content, fullPath: null, persisted: false };
  }

  rejectUnsafeSegment("runId", opts.runId);
  rejectUnsafeSegment("toolUseId", opts.toolUseId);

  const head = previewHead(result.content, previewLines, previewBytes);
  fence(resolve(join(rootDir, opts.runId, `${opts.toolUseId}.txt`)));
  const saved = await saveExclusive(rootDir, opts.runId, opts.toolUseId, result.content);
  if (!saved.ok) {
    return {
      previewContent: `${head}\n[truncated; the full output could not be saved: ${saved.reason}]`,
      fullPath: null,
      persisted: false,
      unsaved: saved.reason,
    };
  }
  const parts = saveParts(
    rootDir,
    opts.runId,
    saved.fullPath,
    result.content,
    head,
    thresholdBytes,
  );
  const partLine =
    parts.kind === "saved"
      ? `\n[part 1 of ${parts.count}; Read ${parts.next} for part 2]`
      : parts.kind === "failed"
        ? `\n[the rest could not also be saved in parts to Read one at a time: ${parts.reason}]`
        : "";
  const previewContent = `${head}${partLine}\n[truncated, full output at ${saved.fullPath}]`;
  return {
    previewContent,
    fullPath: saved.fullPath,
    persisted: true,
    ...(saved.reused ? { reused: true } : {}),
    ...(parts.kind === "saved" ? { partPaths: parts.paths } : {}),
  };
}

type Parts =
  | { readonly kind: "none" }
  | {
      readonly kind: "saved";
      readonly count: number;
      readonly next: string;
      readonly paths: ReadonlyArray<string>;
    }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Save what the preview left out as parts 2…n beside the full output
 * (`<name>.part-<k>.txt`), each at most `thresholdBytes` with its marker so
 * one `Read` returns it whole. A part is cut on a character boundary, at a
 * newline when one falls in its second half. Each part's marker names the
 * next; the last says it is the end, or that the rest is only in the full
 * output when {@link MAX_PARTS} ran out. Written exclusively like the full
 * output: a part already there with the same bytes (a retried call) is
 * reused, anything else stops the parts.
 */
function saveParts(
  rootDir: string,
  runId: string,
  fullPath: string,
  content: string,
  head: string,
  thresholdBytes: number,
): Parts {
  const bytes = Buffer.from(content, "utf8");
  const start = Buffer.byteLength(head, "utf8");
  if (start >= bytes.length) return { kind: "none" };
  // Room for the marker: two paths and the words around them.
  const partBytes = Math.floor(thresholdBytes) - (2 * Buffer.byteLength(fullPath, "utf8") + 160);
  if (!(partBytes >= MIN_PART_BYTES)) return { kind: "none" };
  const slices: Array<[number, number]> = [];
  let at = start;
  while (at < bytes.length && slices.length < MAX_PARTS - 1) {
    let end = Math.min(at + partBytes, bytes.length);
    if (end < bytes.length) {
      const newline = bytes.lastIndexOf(0x0a, end - 1);
      if (newline >= at + partBytes / 2) end = newline + 1;
      else while (end > at && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    }
    if (end <= at) break;
    slices.push([at, end]);
    at = end;
  }
  const remaining = bytes.length - at;
  const stem = basename(fullPath).replace(/\.txt$/, "");
  const count = slices.length + 1;
  const nameOf = (k: number) => `${stem}.part-${k}.txt`;
  const pathOf = (k: number) => join(rootDir, runId, nameOf(k));
  const paths: string[] = [];
  for (let i = 0; i < slices.length; i++) {
    const k = i + 2;
    const [from, to] = slices[i] as [number, number];
    const marker =
      k < count
        ? `[part ${k} of ${count}; Read ${pathOf(k + 1)} for part ${k + 1}; full output at ${fullPath}]`
        : remaining > 0
          ? `[part ${k} of ${count}, the last part saved; the remaining ${remaining} bytes are only in the full output at ${fullPath}]`
          : `[part ${k} of ${count}, the end of the output; full output at ${fullPath}]`;
    const part = Buffer.concat([bytes.subarray(from, to), Buffer.from(`\n${marker}`, "utf8")]);
    const written = writeOrReuse(rootDir, `${runId}/${nameOf(k)}`, pathOf(k), part);
    if (!written.ok) return { kind: "failed", reason: written.reason };
    paths.push(pathOf(k));
  }
  return { kind: "saved", count, next: pathOf(2), paths };
}

/** Create `rel` under `rootDir` holding `bytes`, or accept it when it already holds them. */
function writeOrReuse(
  rootDir: string,
  rel: string,
  shownPath: string,
  bytes: Buffer,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  fence(resolve(shownPath));
  const created = createExclusive(rootDir, rel, { createParents: true });
  if (created.ok) {
    try {
      let off = 0;
      while (off < bytes.length) off += writeSync(created.fd, bytes, off, bytes.length - off);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `${shownPath} could not be written (${(err as Error).message})` };
    } finally {
      closeSync(created.fd);
    }
  }
  if (created.code !== "exists") return { ok: false, reason: created.reason };
  const existing = openForReadSync(rootDir, rel, {
    maxBytes: bytes.length,
    followLeafSymlink: false,
  });
  return existing.ok && !existing.truncated && Buffer.from(existing.bytes).equals(bytes)
    ? { ok: true }
    : { ok: false, reason: `${shownPath} is taken by other content` };
}

type Saved =
  | { readonly ok: true; readonly fullPath: string; readonly reused: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Write `content` to a NEW file under `<rootDir>/<runId>/`, first as
 * `<toolUseId>.txt`, then `<toolUseId>.<n>.txt` while the name is taken by
 * anything that is not these exact bytes. Never writes through a link, over
 * an existing file, or outside `rootDir`.
 */
async function saveExclusive(
  rootDir: string,
  runId: string,
  toolUseId: string,
  content: string,
): Promise<Saved> {
  const bytes = Buffer.from(content, "utf8");
  try {
    // The root is the runtime's own directory, never a model-named path.
    await mkdir(rootDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `${rootDir} could not be created (${(err as Error).message})` };
  }
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
    const name = n === 1 ? `${toolUseId}.txt` : `${toolUseId}.${n}.txt`;
    const rel = `${runId}/${name}`;
    const fullPath = join(rootDir, runId, name);
    fence(resolve(fullPath));
    const created = createExclusive(rootDir, rel, { createParents: true });
    if (created.ok) {
      try {
        let off = 0;
        while (off < bytes.length) off += writeSync(created.fd, bytes, off, bytes.length - off);
      } catch (err) {
        return {
          ok: false,
          reason: `${fullPath} could not be written (${(err as Error).message})`,
        };
      } finally {
        closeSync(created.fd);
      }
      return { ok: true, fullPath, reused: false };
    }
    // A link or a special file at the name is not this result: try the next
    // name, without opening it. Any other refusal (the run directory linked
    // out of the root, no permission) would refuse every name alike.
    if (created.code === "is-symlink" || created.code === "not-regular-file") continue;
    if (created.code !== "exists") return { ok: false, reason: created.reason };
    // A regular file is there. The same bytes are a retried call: reuse
    // them. Anything else is another call's output under a repeated id.
    const existing = await openForRead(rootDir, rel, {
      maxBytes: bytes.length,
      followLeafSymlink: false,
    });
    if (existing.ok && !existing.truncated && Buffer.from(existing.bytes).equals(bytes)) {
      return { ok: true, fullPath, reused: true };
    }
  }
  return {
    ok: false,
    reason: `every name from ${join(rootDir, runId, `${toolUseId}.txt`)} to ${toolUseId}.${MAX_NAME_ATTEMPTS}.txt is taken`,
  };
}

/**
 * The first `maxLines` lines of `content`, cut to at most `maxBytes` UTF-8
 * bytes without splitting a character (flag-truth-6#4). Only the first
 * `maxBytes` code units are ever looked at: every code unit is at least one
 * byte, so nothing past them can fit.
 */
export function previewHead(content: string, maxLines: number, maxBytes: number): string {
  const lines = Math.floor(maxLines);
  const bytes = Math.floor(maxBytes);
  if (!(lines > 0) || !(bytes > 0)) return "";
  const scan = content.length > bytes ? content.slice(0, bytes) : content;
  let end = scan.length;
  let from = 0;
  for (let n = 0; n < lines; n++) {
    const newline = scan.indexOf("\n", from);
    if (newline === -1) break;
    if (n === lines - 1) {
      end = newline;
      break;
    }
    from = newline + 1;
  }
  const head = scan.slice(0, end);
  const encoded = Buffer.from(head, "utf8");
  if (encoded.length <= bytes) return head;
  // Step back over continuation bytes (10xxxxxx) to the start of a character.
  // A surrogate pair the window split in two encodes as a replacement
  // character that starts at or past byte `bytes - 1`, so this drops it too.
  let cut = bytes;
  while (cut > 0 && ((encoded[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return encoded.subarray(0, cut).toString("utf8");
}

function rejectUnsafeSegment(label: string, value: string): void {
  if (
    value === "" ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("..")
  ) {
    throw new RuntimeError(
      `tool-result-store: ${label} "${value}" contains path-traversal characters`,
    );
  }
}

/**
 * Defence-in-depth boundary check: assert that a resolved absolute path lives
 * strictly under `root`. Redundant with `rejectUnsafeSegment` on the normal
 * code path (which already strips separators and `..`), but kept — and exported
 * so it can be exercised directly — so a future caller that resolves a path
 * some other way can't silently escape the storage root.
 */
export function assertUnderRoot(abs: string, root: string): void {
  if (!abs.startsWith(`${root}${sep}`)) {
    throw new RuntimeError("tool-result-store: resolved path escapes rootDir");
  }
}

/**
 * Used by tests to confirm the resolved storage location for a given
 * runId/toolUseId pair. Performs the same traversal rejection as
 * `storeAndPreview()` so callers see the same errors.
 */
export function resolveStoragePath(
  runId: string,
  toolUseId: string,
  rootDir: string = DEFAULT_ROOT_DIR,
): string {
  rejectUnsafeSegment("runId", runId);
  rejectUnsafeSegment("toolUseId", toolUseId);
  const abs = resolve(rootDir, runId, `${toolUseId}.txt`);
  // Sanity: the resolved path must still live under rootDir.
  assertUnderRoot(abs, resolve(rootDir));
  fence(abs);
  return abs;
}
