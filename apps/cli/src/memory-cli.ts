/**
 * 0.3.0 memory release (design §3.4) — the `crewhaus memory` verb cluster's
 * pure/IO helpers plus the `crewhaus migrate memories` data migration. Kept
 * thin + separately testable, mirroring `sessions-index.ts` / `lessons.ts`
 * (the entry file runs an argv switch on import, so logic lives here).
 *
 * The migration rides the existing migration-engine machinery: memory
 * entries are versioned by their `schemaVersion` field (absent = v1), the
 * engine walks the registered 1→2 chain per entry line, and the runner-side
 * conventions (dry-run plan first, idempotent re-runs) are preserved.
 * `.crewhaus/meta.json` records the store-level schema version so future
 * migrations and doctors can see at a glance what has been backfilled.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { MEMORY_SCHEMA_VERSION, type MemoryListItem, isMemoryEntry } from "@crewhaus/memory-store";
import { type Migration, MigrationEngine } from "@crewhaus/migration-engine";

export class MemoryCliError extends CrewhausError {
  override readonly name = "MemoryCliError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/** The memories root, relative to a harness cwd. */
export const MEMORIES_SUBDIR = join(".crewhaus", "memories");

/** Spec names that have a memory file under `memoriesDir`, sorted. */
export function listMemorySpecs(memoriesDir: string): string[] {
  if (!existsSync(memoriesDir)) return [];
  return readdirSync(memoriesDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => basename(f, ".jsonl"))
    .sort();
}

/**
 * Resolve which spec's store a single-target verb (`show`/`forget`) operates
 * on: an explicit `--spec` wins; otherwise a lone memory file is unambiguous;
 * anything else is an error naming the candidates.
 */
export function resolveMemorySpec(memoriesDir: string, specFlag?: string): string {
  const specs = listMemorySpecs(memoriesDir);
  if (specFlag !== undefined) {
    if (!specs.includes(specFlag)) {
      throw new MemoryCliError(
        `no memory file for spec "${specFlag}" under ${memoriesDir}${
          specs.length > 0 ? ` (have: ${specs.join(", ")})` : ""
        }`,
      );
    }
    return specFlag;
  }
  if (specs.length === 0) {
    throw new MemoryCliError(`no memory files under ${memoriesDir}`);
  }
  if (specs.length === 1) return specs[0] as string;
  throw new MemoryCliError(
    `multiple memory files under ${memoriesDir} — pick one with --spec <name> (have: ${specs.join(", ")})`,
  );
}

/** Compact human age: "3m", "7h", "12d". Injectable clock for tests. */
export function humanAge(createdAtIso: string, nowMs: number): string {
  const created = Date.parse(createdAtIso);
  if (Number.isNaN(created)) return "?";
  const deltaMs = Math.max(0, nowMs - created);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const TEXT_PREVIEW_LEN = 72;

function previewText(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > TEXT_PREVIEW_LEN ? `${oneLine.slice(0, TEXT_PREVIEW_LEN - 1)}…` : oneLine;
}

/**
 * Render one `memory list` row: id / age / status flag / provenance flag /
 * tags / text preview. Deterministic given `nowMs`.
 */
export function renderMemoryListRow(item: MemoryListItem, nowMs: number): string {
  const { entry, status } = item;
  const age = humanAge(entry.createdAt, nowMs).padStart(4);
  const statusCol = (status === "live" ? "" : status).padEnd(10);
  const provCol = (entry.provenance !== undefined ? "prov" : "").padEnd(4);
  const tagsCol = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
  return `  ${entry.id}  ${age}  ${statusCol}  ${provCol}  ${previewText(entry.text)}${tagsCol}`;
}

/** Render the `memory list` block for one spec's items. */
export function renderMemoryList(
  specName: string,
  items: ReadonlyArray<MemoryListItem>,
  nowMs: number,
): string[] {
  const live = items.filter((i) => i.status === "live").length;
  const superseded = items.filter((i) => i.status === "superseded").length;
  const expired = items.filter((i) => i.status === "expired").length;
  const lines = [
    `[memory] ${specName} — ${live} live, ${superseded} superseded, ${expired} expired`,
  ];
  for (const item of items) lines.push(renderMemoryListRow(item, nowMs));
  return lines;
}

/** Render `memory show <id>`: the full entry plus its lifecycle status. */
export function renderMemoryShow(item: MemoryListItem): string[] {
  const { entry, status } = item;
  const lines = [
    `id:            ${entry.id}`,
    `status:        ${status}`,
    `created:       ${entry.createdAt}`,
    `schemaVersion: ${entry.schemaVersion ?? "1 (implicit)"}`,
    `tags:          ${entry.tags.length > 0 ? entry.tags.join(", ") : "(none)"}`,
  ];
  if (entry.expiresAt !== undefined) {
    lines.push(`expires:       ${new Date(entry.expiresAt).toISOString()}`);
  }
  if (entry.supersededBy !== undefined) {
    lines.push(`supersededBy:  ${entry.supersededBy}`);
  }
  if (entry.provenance !== undefined) {
    const p = entry.provenance;
    const bits: string[] = [];
    if (p.sessionId !== undefined) bits.push(`session ${p.sessionId}`);
    if (p.evidence !== undefined && p.evidence.length > 0) {
      bits.push(`evidence ${p.evidence.join(", ")}`);
    }
    lines.push(`provenance:    ${bits.length > 0 ? bits.join(" · ") : "(empty)"}`);
  }
  lines.push(`text:          ${entry.text}`);
  return lines;
}

// -------- crewhaus migrate memories --------

const SESSION_TAG_RE = /^sess_[0-9a-f]{16}$/;

/**
 * Backfill target for v1 auto-capture entries: they tag the sessionId today
 * (`["auto-capture", "<sess_…>"]`), which is exactly the provenance the v2
 * schema makes first-class.
 */
export function deriveAutoCaptureSessionId(tags: ReadonlyArray<string>): string | undefined {
  if (!tags.includes("auto-capture")) return undefined;
  return tags.find((t) => SESSION_TAG_RE.test(t));
}

/**
 * The memory-entry 1 → 2 step, registered on a `MigrationEngine` so the
 * chain-walk (and any future 2 → 3 step) reuses Section-28 machinery. The
 * `version` key is a walk-time shim the file migrator injects from
 * `schemaVersion` (absent = 1) and strips before serialising.
 */
export const MEMORY_ENTRY_1_TO_2: Migration = Object.freeze({
  from: 1,
  to: 2,
  up(entry) {
    const tags = Array.isArray(entry["tags"])
      ? (entry["tags"] as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const sessionId = deriveAutoCaptureSessionId(tags);
    const backfill =
      entry["provenance"] === undefined && sessionId !== undefined
        ? { provenance: { sessionId } }
        : {};
    return { ...entry, ...backfill, version: 2, schemaVersion: 2 };
  },
  down(entry) {
    const { schemaVersion: _sv, provenance: _p, expiresAt: _e, supersededBy: _sb, ...rest } = entry;
    return { ...rest, version: 1 };
  },
});

/** An engine with the memory-entry chain registered. */
export function createMemoryMigrationEngine(): MigrationEngine {
  const engine = new MigrationEngine();
  engine.register(MEMORY_ENTRY_1_TO_2);
  return engine;
}

export type MigrateMemoriesFileReport = {
  readonly specName: string;
  /** v1 entry lines rewritten to v2. */
  readonly migrated: number;
  /** Entry lines already at (or beyond) the target version. */
  readonly skipped: number;
  /** Non-entry lines (tombstones/unknown/malformed) preserved verbatim. */
  readonly passthrough: number;
};

export type MigrateMemoriesReport = {
  readonly files: ReadonlyArray<MigrateMemoriesFileReport>;
  readonly migrated: number;
  readonly skipped: number;
  readonly dryRun: boolean;
  /** Absolute path of the stamped meta file (absent on dry runs). */
  readonly metaPath?: string;
};

/**
 * Migrate every `.crewhaus/memories/*.jsonl` under `rootDir` to the current
 * entry schema. Idempotent: entries already at `schemaVersion >= 2` are
 * skipped, so a re-run migrates 0 and rewrites nothing. Non-entry lines
 * (tombstones, future line kinds, malformed junk) pass through VERBATIM —
 * this migration never destroys data. Writes are atomic (tmp + rename).
 * With `dryRun` no file is touched and no meta is stamped.
 */
export function migrateMemories(
  rootDir: string,
  opts: { dryRun?: boolean; now?: () => Date } = {},
): MigrateMemoriesReport {
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? (() => new Date());
  const memoriesDir = join(rootDir, MEMORIES_SUBDIR);
  const engine = createMemoryMigrationEngine();
  const files: MigrateMemoriesFileReport[] = [];
  let totalMigrated = 0;
  let totalSkipped = 0;

  for (const specName of listMemorySpecs(memoriesDir)) {
    const filePath = join(memoriesDir, `${specName}.jsonl`);
    const raw = readFileSync(filePath, "utf-8");
    const outLines: string[] = [];
    let migrated = 0;
    let skipped = 0;
    let passthrough = 0;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        outLines.push(line); // malformed junk passes through untouched
        passthrough += 1;
        continue;
      }
      if (!isMemoryEntry(parsed)) {
        outLines.push(line); // tombstones + future line kinds, verbatim
        passthrough += 1;
        continue;
      }
      const fromVersion = parsed.schemaVersion ?? 1;
      if (fromVersion >= MEMORY_SCHEMA_VERSION) {
        outLines.push(line);
        skipped += 1;
        continue;
      }
      const { version: _shim, ...migratedEntry } = engine.migrate(
        { ...(parsed as Record<string, unknown>), version: fromVersion },
        MEMORY_SCHEMA_VERSION,
      );
      outLines.push(JSON.stringify(migratedEntry));
      migrated += 1;
    }
    files.push({ specName, migrated, skipped, passthrough });
    totalMigrated += migrated;
    totalSkipped += skipped;
    if (!dryRun && migrated > 0) {
      const tmpPath = `${filePath}.tmp`;
      writeFileSync(tmpPath, outLines.length > 0 ? `${outLines.join("\n")}\n` : "", {
        mode: 0o600,
      });
      renameSync(tmpPath, filePath);
    }
  }

  // Dry runs write nothing; a harness with no memory files has nothing to
  // stamp either (new stores write v2 natively).
  if (dryRun || files.length === 0) {
    return { files, migrated: totalMigrated, skipped: totalSkipped, dryRun };
  }
  const metaPath = stampMemoriesMeta(rootDir, now);
  return { files, migrated: totalMigrated, skipped: totalSkipped, dryRun, metaPath };
}

/**
 * Record the memories schema version in `.crewhaus/meta.json` (created when
 * absent; other top-level keys are preserved). Returns the meta path.
 */
export function stampMemoriesMeta(rootDir: string, now: () => Date = () => new Date()): string {
  const crewhausDir = join(rootDir, ".crewhaus");
  const metaPath = join(crewhausDir, "meta.json");
  let meta: Record<string, unknown> = {};
  if (existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(readFileSync(metaPath, "utf-8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // Unreadable meta — rebuild it rather than fail the migration.
    }
  }
  meta["memories"] = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    migratedAt: now().toISOString(),
  };
  mkdirSync(crewhausDir, { recursive: true });
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  return metaPath;
}

/** Render the `migrate memories` report, one line per file + a summary. */
export function formatMigrateMemoriesReport(report: MigrateMemoriesReport): string[] {
  const lines: string[] = [];
  for (const f of report.files) {
    lines.push(
      `  ${f.specName}: ${f.migrated} migrated, ${f.skipped} already v${MEMORY_SCHEMA_VERSION}, ${f.passthrough} passthrough line(s)`,
    );
  }
  const dryNote = report.dryRun ? " (dry-run — nothing written)" : "";
  lines.push(
    `[migrate] memories: ${report.migrated} entry(ies) migrated across ${report.files.length} file(s)${dryNote}`,
  );
  if (report.metaPath !== undefined) {
    lines.push(
      `[migrate] stamped ${report.metaPath} (memories.schemaVersion ${MEMORY_SCHEMA_VERSION})`,
    );
  }
  return lines;
}
