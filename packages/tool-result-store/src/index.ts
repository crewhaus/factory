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
 *   - Preview: first 100 lines + `[truncated, full output at <fullPath>]`
 *
 * Idempotent writes: the file is created with `flag: "wx"` (write-
 * exclusive). If a previous run already wrote the same `(runId,
 * toolUseId)` pair we treat that as success and reuse the existing file.
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
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { RuntimeError } from "@crewhaus/errors";
import { assertSamePath, currentTenantContext, requireTenant } from "@crewhaus/tenancy";
import type { ToolExecuteResult } from "@crewhaus/tool-catalog";
import type { ToolResult } from "@crewhaus/tool-executor";

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
  readonly rootDir?: string;
};

export type StoredResult = {
  readonly previewContent: ToolExecuteResult;
  readonly fullPath: string | null;
  readonly persisted: boolean;
};

export const DEFAULT_THRESHOLD_BYTES = 10240;
export const DEFAULT_PREVIEW_LINES = 100;
export const DEFAULT_ROOT_DIR = ".crewhaus/tool-results";

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

  const fullPath = join(rootDir, opts.runId, `${opts.toolUseId}.txt`);
  fence(resolve(fullPath));
  await mkdir(dirname(fullPath), { recursive: true });
  try {
    await writeFile(fullPath, result.content, { flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
    // Another run already persisted this exact (runId, toolUseId) — treat
    // as success. The body is identical because tool_use_id is unique.
  }

  const lines = result.content.split("\n");
  const head = lines.slice(0, previewLines).join("\n");
  const previewContent = `${head}\n[truncated, full output at ${fullPath}]`;

  return { previewContent, fullPath, persisted: true };
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
  const root = resolve(rootDir);
  if (!abs.startsWith(`${root}${sep}`)) {
    throw new RuntimeError("tool-result-store: resolved path escapes rootDir");
  }
  fence(abs);
  return abs;
}
