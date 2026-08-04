/**
 * M3 · MEMORY — facts, recall, continuity, learning, knowledge sync, and the
 * memory schema migration.
 *
 * Owned by the Memory implementer together with `wiki-ops.ts` and
 * `watchme-ops.ts`; the shared readers at the top of this module are what
 * those two import. `memory.ts` (M1) stays the READ side for the five
 * allowlisted area views and is not edited here.
 *
 * ---------------------------------------------------------------------------
 * THE ONE INVARIANT: NO HARD DELETE, ANYWHERE
 * ---------------------------------------------------------------------------
 * The memory fabric is append-only with tombstones. Hangar ships no
 * affordance that unlinks a memory file, truncates a JSONL, or removes a
 * fact line:
 *
 *   forget a fact      → append a `superseded` tombstone with the operator's
 *                        RECORDED REASON. Confirm-gated (a dialog).
 *   expire a fact      → the store's own TTL sweep; the manager renders the
 *                        countdown, it does not shortcut it.
 *   clear continuity   → move to `trash/<ts>/`, restorable by timestamp.
 *                        Never `rm`.
 *   compact / sweep    → mirrors the CLI posture exactly, dry-run first, and
 *                        still writes tombstones rather than dropping lines.
 *                        `MemoryStore.compact()` is the one call in the store
 *                        that REWRITES the file, so this module never makes
 *                        it: sweep appends `expired` tombstones and stops.
 *
 * Reads fold tombstones (live / superseded / expired) and never rewrite the
 * file they folded. The stores take their advisory locks at SAVE, never
 * across user think-time — an editor open in a browser tab is think-time, so
 * no route here holds a lock between requests.
 *
 * Provenance is the point of the facts browser: every fact carries its
 * `sessionId` and evidence `toolUseId`s, and both come back as ids the
 * console turns into links into the session viewer. That join is what makes
 * a memory auditable.
 *
 * ---------------------------------------------------------------------------
 * TWO ON-DISK LAYOUTS, ONE READER
 * ---------------------------------------------------------------------------
 * `continuity-store` and `wiki-store` nest their state under the SPEC name
 * (`state/<spec>/`, `wiki/<spec>/`) — that is what a live harness has. Older
 * trees (and this server's own fixtures) carry the FLAT shape `state/…`,
 * `wiki/…`, which the M1 read side renders. Every reader here resolves the
 * spec-scoped directory first and falls back to the flat one, so a harness
 * from either era browses instead of reading as empty. Writes always go
 * through the store, i.e. always into the spec-scoped layout.
 *
 * FREE TEXT IS MASKED HERE, not only by the dispatcher: fact bodies, focus
 * prose, plan steps, goals and handoffs are paragraphs, and `maskDeep`'s
 * key-based redaction cannot see into a paragraph.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type FrozenProof,
  type PlanRecord,
  createContinuityStore,
  listTrash,
  parseTrashTimestamp,
  restoreFromTrash,
} from "@crewhaus/continuity-store";
import { readSpecHeader } from "@crewhaus/harness-inventory";
import { createMemoryStore } from "@crewhaus/memory-store";
import { MAX_MEMORY_ITEMS, MAX_TEXT_BYTES, SAFE_SEGMENT_RE } from "./constants";
import { HttpError } from "./http";
import { readJsonlCapped, readTextCapped } from "./jsonl";
import type { M3Context, M3Handler } from "./m3";
import { isDryRun, requireBoolean, requireString, requireTypedConfirm } from "./m3";
import { maskDeep, maskText } from "./mask";
import { resolveInside } from "./safety";
import { readSpecYaml } from "./schedulers";

// ---------------------------------------------------------------------------
// shared helpers (wiki-ops.ts and watchme-ops.ts import these)
// ---------------------------------------------------------------------------

/**
 * The baseline every M3 read answers with. A memory screen's normal state is
 * EMPTY — a harness with no wiki, no watchme, no continuity — so absence has
 * to carry its own explanation and the verb that would create the data.
 */
export type M3ReadBase = {
  readonly present: boolean;
  readonly note: string | null;
  readonly verb: string | null;
};

export function readBase(present: boolean, note: string | null, verb: string | null): M3ReadBase {
  return { present, note, verb };
}

/** The harness dir, narrowed. Every route in this area is per-harness. */
export function harnessDirOf(ctx: M3Context): string {
  if (ctx.harnessDir === null) throw new HttpError(400, "not a per-harness route");
  return ctx.harnessDir;
}

/**
 * `ctx.contain` with the escape folded into `undefined` instead of a 400.
 * Listing a directory yields NAMES, and a name can be a symlink out of the
 * harness — a planted symlink must SKIP that one file, not fail the whole
 * screen. Call it per file, never once per directory.
 */
export function containedPath(ctx: M3Context, segments: readonly string[]): string | undefined {
  try {
    return ctx.contain(segments);
  } catch {
    return undefined;
  }
}

/** Directory listing that treats an absent/unreadable dir as empty. */
export function listDirSafe(dir: string | undefined): string[] {
  if (dir === undefined) return [];
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Names of the sub-directories of `dir` (sorted, unsafe names dropped). */
export function listSubdirs(dir: string | undefined): string[] {
  if (dir === undefined) return [];
  const out: string[] = [];
  for (const name of listDirSafe(dir)) {
    if (!SAFE_SEGMENT_RE.test(name)) continue;
    try {
      if (statSync(join(dir, name)).isDirectory()) out.push(name);
    } catch {
      // vanished between listing and stat — skip it
    }
  }
  return out;
}

export function readJsonSafe(path: string | undefined): unknown {
  if (path === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Capped, masked text for one already-contained file. */
export function readProse(path: string | undefined): { text: string; truncated: boolean } | null {
  if (path === undefined || !existsSync(path)) return null;
  const { text, truncated } = readTextCapped(path, MAX_TEXT_BYTES);
  return { text: maskText(text), truncated };
}

/** A store refusal, masked — the message can quote the document it refused. */
export function describeFailure(err: unknown): string {
  return maskText(err instanceof Error ? err.message : String(err));
}

/** The shape both `memory-store` and `wiki-store` accept as a spec name. */
const STORE_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** True when a spec name may be handed to a store constructor. */
export function isStoreName(name: string): boolean {
  return STORE_NAME_RE.test(name) && !/^\.+$/.test(name);
}

/**
 * This harness's spec name — the key the memory/wiki/continuity stores scope
 * their files under. The live spec wins over the registry's cached row (the
 * spec is what the stores actually read); the directory basename is the last
 * resort so a spec-less harness still browses.
 */
export function harnessSpecName(ctx: M3Context): string {
  const dir = harnessDirOf(ctx);
  const header = readSpecHeader(readSpecYaml(dir));
  if (typeof header.name === "string" && header.name !== "") return header.name;
  const cached = ctx.entry?.specName;
  if (typeof cached === "string" && cached !== "") return cached;
  return basename(dir);
}

/**
 * Resolve a store directory that may sit under the spec name or flat.
 * Returns the contained path plus which layout answered, or `undefined` when
 * neither exists (the caller renders the empty state).
 */
export function resolveStoreDir(
  ctx: M3Context,
  area: string,
  specName: string,
  probe: readonly string[],
): { dir: string; layout: "spec-scoped" | "flat" } | undefined {
  if (isStoreName(specName) && SAFE_SEGMENT_RE.test(specName)) {
    const scoped = containedPath(ctx, [".crewhaus", area, specName]);
    if (scoped !== undefined && probe.some((p) => existsSync(join(scoped, p)))) {
      return { dir: scoped, layout: "spec-scoped" };
    }
  }
  const flat = containedPath(ctx, [".crewhaus", area]);
  if (flat !== undefined && probe.some((p) => existsSync(join(flat, p)))) {
    return { dir: flat, layout: "flat" };
  }
  return undefined;
}

// ---- lenient spec scanning -------------------------------------------------
// A fleet console must render a spec one schema version ahead of (or behind)
// this manager, so every spec read here is a BLOCK SCAN over the text, never
// a zod parse: a spec that fails validation still has a readable `learning:`
// block, and refusing to draw the panel over an unrelated key would be the
// manager inventing a fault the harness does not have.

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) n += 1;
  return n;
}

function blockUnder(lines: readonly string[], key: string, atIndent: number): string[] | undefined {
  const header = new RegExp(`^\\s{${atIndent}}${key}\\s*:\\s*(?:#.*)?$`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!header.test(lines[i] ?? "")) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      if (next.trim() === "" || next.trim().startsWith("#")) continue;
      if (indentOf(next) <= atIndent) break;
      body.push(next);
    }
    return body;
  }
  return undefined;
}

/** The lines strictly inside a nested block path (`memory` → `dream`). */
export function specBlock(yamlText: string, path: readonly string[]): string[] | undefined {
  let current = yamlText.split("\n");
  let indent = 0;
  for (const key of path) {
    const body = blockUnder(current, key, indent);
    if (body === undefined) return undefined;
    indent = indentOf(body[0] ?? "  ");
    current = body;
  }
  return current;
}

/** True when `<key>:` appears at column 0 — presence, even for a flow map. */
export function specDeclares(yamlText: string, key: string): boolean {
  return new RegExp(`^${key}\\s*:`, "m").test(yamlText);
}

/** The scalar for `key:` inside a block. Quotes stripped, `# comment` dropped. */
export function specScalar(block: readonly string[], key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`);
  for (const line of block) {
    const m = line.match(re);
    if (m === null) continue;
    let value = (m[1] ?? "").trim();
    if (value === "" || value.startsWith("#")) continue;
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : undefined;
    if (quote !== undefined && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    return value;
  }
  return undefined;
}

/** `key:` followed by `- item` lines, as a string list. */
export function specList(block: readonly string[], key: string): string[] {
  const at = block.findIndex((l) => new RegExp(`^\\s*${key}\\s*:\\s*(?:#.*)?$`).test(l));
  if (at === -1) return [];
  const baseIndent = indentOf(block[at] ?? "");
  const out: string[] = [];
  for (let i = at + 1; i < block.length; i += 1) {
    const line = block[i] ?? "";
    if (line.trim() === "") continue;
    if (indentOf(line) <= baseIndent && !line.trim().startsWith("-")) break;
    const item = line.trim();
    if (!item.startsWith("- ")) break;
    out.push(
      item
        .slice(2)
        .trim()
        .replace(/^["']|["']$/g, ""),
    );
  }
  return out;
}

/** A boolean spec scalar with an explicit default (an absent key is not false). */
export function specBool(
  block: readonly string[] | undefined,
  key: string,
  fallback: boolean,
): boolean {
  if (block === undefined) return fallback;
  const raw = specScalar(block, key);
  if (raw === undefined) return fallback;
  return raw === "true";
}

/** The shared duration grammar (`30m`, `24h`, `1d`) → ms, or null. */
export function parseDurationMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = value.trim().match(/^(\d+)(ms|s|m|h|d)$/);
  if (m === null) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return n * 86_400_000;
  }
}

/**
 * A minimal line diff, rendered unified-ish. The wiki version viewer and the
 * spec-edit interstitials in this area both use it, so a change reads the
 * same everywhere in the fabric. Capped — a diff of two 8 MiB documents is
 * not a screen anyone reads.
 */
export function lineDiff(before: string, after: string, maxLines = 400): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  if (removed.length === 0 && added.length === 0) return "";
  const out: string[] = [`@@ -${head + 1},${removed.length} +${head + 1},${added.length} @@`];
  for (const line of removed.slice(0, maxLines)) out.push(`-${line}`);
  if (removed.length > maxLines) out.push(`… ${removed.length - maxLines} more removed lines`);
  for (const line of added.slice(0, maxLines)) out.push(`+${line}`);
  if (added.length > maxLines) out.push(`… ${added.length - maxLines} more added lines`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// facts — memories/<spec>.jsonl, folded
// ---------------------------------------------------------------------------

type RawFactLine = {
  id?: unknown;
  text?: unknown;
  tags?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
  supersededBy?: unknown;
  schemaVersion?: unknown;
  provenance?: unknown;
  tombstone?: unknown;
  target?: unknown;
  at?: unknown;
  reason?: unknown;
};

export type FactProvenance = {
  readonly sessionId: string | null;
  /** Tool runs that prove the fact — deep links into the session viewer. */
  readonly evidence: readonly string[];
};

export type FactRow = {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly ageMs: number | null;
  readonly status: "live" | "superseded" | "expired";
  readonly expiresAt: string | null;
  /** Negative once the TTL has passed and no sweep has run yet. */
  readonly expiresInMs: number | null;
  readonly supersededBy: string | null;
  readonly supersedeReason: string | null;
  readonly supersededAt: string | null;
  readonly provenance: FactProvenance | null;
  readonly schemaVersion: number | null;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

function provenanceOf(value: unknown): FactProvenance | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as { sessionId?: unknown; evidence?: unknown };
  const sessionId = typeof p.sessionId === "string" ? p.sessionId : null;
  const evidence = strings(p.evidence);
  if (sessionId === null && evidence.length === 0) return null;
  return { sessionId, evidence };
}

export type FoldedFacts = {
  readonly items: readonly FactRow[];
  readonly counts: {
    readonly live: number;
    readonly superseded: number;
    readonly expired: number;
    readonly total: number;
  };
  readonly truncated: boolean;
  readonly torn: number;
};

/** Fold one `memories/<spec>.jsonl`: entries + append-only tombstones. */
export function foldFacts(path: string, nowMs: number): FoldedFacts {
  const read = readJsonlCapped(path);
  const supersedes = new Map<string, { at: string | null; reason: string | null; by: string }>();
  const expired = new Set<string>();
  for (const obj of read.objects) {
    const line = obj as RawFactLine;
    if (typeof line.target !== "string") continue;
    if (line.tombstone === "superseded") {
      supersedes.set(line.target, {
        at: typeof line.at === "string" ? line.at : null,
        reason: typeof line.reason === "string" ? maskText(line.reason) : null,
        by: typeof line.supersededBy === "string" ? line.supersededBy : "",
      });
    } else if (line.tombstone === "expired") {
      expired.add(line.target);
    }
  }

  const items: FactRow[] = [];
  const counts = { live: 0, superseded: 0, expired: 0, total: 0 };
  for (const obj of read.objects) {
    const line = obj as RawFactLine;
    if (line.tombstone !== undefined) continue;
    if (typeof line.id !== "string" || typeof line.text !== "string") continue;
    const tomb = supersedes.get(line.id);
    const expiresAt = typeof line.expiresAt === "number" ? line.expiresAt : null;
    let status: FactRow["status"] = "live";
    if (tomb !== undefined || typeof line.supersededBy === "string") status = "superseded";
    else if (expired.has(line.id) || (expiresAt !== null && expiresAt <= nowMs)) status = "expired";
    counts[status] += 1;
    counts.total += 1;
    if (items.length >= MAX_MEMORY_ITEMS) continue;
    const createdAt = typeof line.createdAt === "string" ? line.createdAt : "";
    const createdMs = createdAt === "" ? Number.NaN : Date.parse(createdAt);
    items.push({
      id: line.id,
      // Agent-authored prose that can quote a credential it saw in a tool
      // result — masked like every other served document.
      text: maskText(line.text),
      tags: strings(line.tags).map((t) => maskText(t)),
      createdAt,
      ageMs: Number.isNaN(createdMs) ? null : nowMs - createdMs,
      status,
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      expiresInMs: expiresAt === null ? null : expiresAt - nowMs,
      supersededBy:
        typeof line.supersededBy === "string"
          ? line.supersededBy
          : tomb !== undefined && tomb.by !== ""
            ? tomb.by
            : null,
      supersedeReason: tomb?.reason ?? null,
      supersededAt: tomb?.at ?? null,
      provenance: provenanceOf(line.provenance),
      schemaVersion: typeof line.schemaVersion === "number" ? line.schemaVersion : null,
    });
  }
  return {
    items,
    counts,
    truncated: read.truncated || counts.total > items.length,
    torn: read.tornCount,
  };
}

/** Every `memories/*.jsonl` stem in the harness (the file picker's options). */
function factStems(ctx: M3Context): string[] {
  const dir = containedPath(ctx, [".crewhaus", "memories"]);
  return listDirSafe(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => n.slice(0, -".jsonl".length))
    .filter((stem) => SAFE_SEGMENT_RE.test(stem));
}

/**
 * `GET /api/h/:id/memory/facts/:spec` — one `memories/<spec>.jsonl`, folded.
 *
 * Beyond the M1 summary: TTL expiry countdowns, `supersededBy` chains with
 * the recorded reason, and provenance (`sessionId` + evidence `toolUseId`s)
 * for the session deep links. Capped and torn-line tolerant like every other
 * JSONL reader here.
 */
export const memoryFacts: M3Handler = (ctx) => {
  const spec = ctx.params["spec"] ?? "";
  const path = containedPath(ctx, [".crewhaus", "memories", `${spec}.jsonl`]);
  const stems = factStems(ctx);
  if (path === undefined || !existsSync(path)) {
    return {
      ...readBase(
        false,
        stems.length === 0
          ? "no fact store yet — nothing has been remembered in this harness"
          : `no memories/${spec}.jsonl — this harness stores facts under: ${stems.join(", ")}`,
        "crewhaus memory remember",
      ),
      specName: spec,
      specs: stems,
      counts: { live: 0, superseded: 0, expired: 0, total: 0 },
      items: [],
      truncated: false,
      torn: 0,
    };
  }
  const folded = foldFacts(path, ctx.now());
  return {
    ...readBase(
      folded.counts.total > 0,
      folded.counts.total === 0
        ? "the fact store exists but holds no entries yet"
        : folded.truncated
          ? "long store — the first entries only; the counts are floors, not lies"
          : null,
      "crewhaus memory remember",
    ),
    specName: spec,
    specs: stems,
    counts: folded.counts,
    items: folded.items,
    truncated: folded.truncated,
    torn: folded.torn,
  };
};

const FACT_ID_RE = /^mem_[0-9a-f]{16}$/;

/** The fact store for one `memories/<spec>.jsonl`, containment-checked. */
function factStore(ctx: M3Context, spec: string): ReturnType<typeof createMemoryStore> {
  if (!isStoreName(spec)) throw new HttpError(400, "invalid memory store name");
  // Contain the FILE the store will write, not just its directory.
  if (containedPath(ctx, [".crewhaus", "memories", `${spec}.jsonl`]) === undefined) {
    throw new HttpError(400, "path escapes the harness directory");
  }
  return createMemoryStore({
    specName: spec,
    rootDir: join(harnessDirOf(ctx), ".crewhaus", "memories"),
    now: () => new Date(ctx.now()),
  });
}

/**
 * `POST /api/h/:id/memory/facts/:spec/forget` — supersede a fact.
 *
 * Body: `{ factId, reason, confirm: true }`. Writes a `superseded` tombstone
 * through the memory store with `reason` recorded. NEVER removes the
 * original line — the fold is what makes it disappear from the live view.
 *
 * `factId` must be an id. The store ALSO accepts free text (it then forgets
 * every BM25 match), and a console that forgot an unbounded set of facts
 * from one typo would be exactly the surprise this surface exists to
 * prevent — so text-matching forget stays a CLI-only affordance.
 */
export const memoryForget: M3Handler = async (ctx) => {
  const spec = ctx.params["spec"] ?? "";
  const factId = requireString(ctx.body, "factId");
  const reason = requireString(ctx.body, "reason");
  if (requireBoolean(ctx.body, "confirm") !== true) {
    throw new HttpError(409, 'forgetting a fact needs "confirm": true');
  }
  if (!FACT_ID_RE.test(factId)) {
    throw new HttpError(400, '"factId" must be a fact id (mem_<16 hex>)');
  }
  const store = factStore(ctx, spec);
  let forgotten: ReadonlyArray<{ id: string; text: string }>;
  try {
    forgotten = (await store.forget(factId, { reason })).map((e) => ({
      id: e.id,
      text: maskText(e.text),
    }));
  } catch (err) {
    return { ok: false, code: "forget_refused", message: describeFailure(err), forgotten: [] };
  }
  return {
    ok: true,
    specName: spec,
    factId,
    reason: maskText(reason),
    forgotten,
    note:
      forgotten.length === 0
        ? "no live fact with that id — nothing was tombstoned (a re-run is a no-op)"
        : "a supersede tombstone was appended; the original line is still on disk and still auditable",
  };
};

/**
 * `POST /api/h/:id/memory/facts/:spec/sweep` — the expiry pass.
 *
 * Body: `{ dryRun }` — and `dryRun` DEFAULTS TO TRUE. Mirrors the CLI verb's
 * posture: show the plan, then run it as a second gesture. The real run
 * appends `expired` tombstones (idempotent); it never compacts, because
 * compaction is the one call that rewrites the file.
 */
export const memorySweep: M3Handler = async (ctx) => {
  const spec = ctx.params["spec"] ?? "";
  const dryRun = isDryRun(ctx.body);
  const path = containedPath(ctx, [".crewhaus", "memories", `${spec}.jsonl`]);
  const nowMs = ctx.now();
  const folded: FoldedFacts =
    path === undefined || !existsSync(path)
      ? {
          items: [],
          counts: { live: 0, superseded: 0, expired: 0, total: 0 },
          truncated: false,
          torn: 0,
        }
      : foldFacts(path, nowMs);
  const plan = folded.items
    .filter((i) => i.status === "expired" && i.supersededBy === null && i.expiresAt !== null)
    .map((i) => ({ id: i.id, text: i.text, expiresAt: i.expiresAt }));
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      specName: spec,
      plan,
      swept: 0,
      live: folded.counts.live,
      note:
        plan.length === 0
          ? "nothing is past its TTL — a real sweep would append no tombstones"
          : `${plan.length} fact(s) past TTL would be tombstoned as expired (never deleted)`,
    };
  }
  const store = factStore(ctx, spec);
  try {
    const result = await store.sweep(nowMs);
    return {
      ok: true,
      dryRun: false,
      specName: spec,
      plan,
      swept: result.swept,
      live: result.live,
      note: "expired facts were tombstoned; every original line is still on disk",
    };
  } catch (err) {
    return { ok: false, code: "sweep_refused", message: describeFailure(err), plan };
  }
};

/**
 * `POST /api/h/:id/memory/recall` — the recall playground.
 *
 * Body: `{ query, k?, spec? }`. Runs the store's own `.recall` (the same
 * call the agent makes) and shows EXACTLY what would be recalled, with
 * scores. A POST because the query is free text and free text does not
 * belong in a URL. A read: it touches no counter and no file.
 *
 * The ranking is reported honestly — the manager constructs no embedder, so
 * this is the BM25 half of a hybrid store's answer.
 */
export const memoryRecall: M3Handler = async (ctx) => {
  const query = requireString(ctx.body, "query");
  const rawK = ctx.body["k"];
  const k = typeof rawK === "number" && Number.isFinite(rawK) ? Math.min(50, Math.max(1, rawK)) : 5;
  const rawSpec = ctx.body["spec"];
  const spec = typeof rawSpec === "string" && rawSpec !== "" ? rawSpec : harnessSpecName(ctx);
  if (!isStoreName(spec)) throw new HttpError(400, "invalid memory store name");
  const path = containedPath(ctx, [".crewhaus", "memories", `${spec}.jsonl`]);
  if (path === undefined || !existsSync(path)) {
    return {
      ok: true,
      query: maskText(query),
      k,
      specName: spec,
      ranking: "bm25",
      results: [],
      note: `no memories/${spec}.jsonl yet — recall would return nothing`,
    };
  }
  const store = factStore(ctx, spec);
  try {
    const hits = await store.recall(query, k);
    return {
      ok: true,
      query: maskText(query),
      k,
      specName: spec,
      ranking: "bm25",
      results: hits.map((h) => ({
        id: h.entry.id,
        text: maskText(h.entry.text),
        tags: h.entry.tags.map((t) => maskText(t)),
        score: h.score,
        createdAt: h.entry.createdAt,
        provenance: provenanceOf(h.entry.provenance),
      })),
      note: "BM25 ranking — a spec with memory.embedder set fuses embeddings on top, so the agent's own recall can order these differently",
    };
  } catch (err) {
    return { ok: false, code: "recall_refused", message: describeFailure(err), results: [] };
  }
};

/**
 * `POST /api/h/:id/memory/migrate` — `crewhaus migrate memories`.
 *
 * The v1 → v2 fact-store backfill that stamps `.crewhaus/meta.json`. Through
 * the job queue, dry-run first, with the mixed-version fleet sweep rendered
 * from each harness's `meta.json` so an operator can see who is behind. The
 * real run is typed-confirm: it rewrites every fact line in the harness.
 */
export const memoryMigrate: M3Handler = (ctx) => {
  const dryRun = isDryRun(ctx.body);
  const specName = harnessSpecName(ctx);
  if (!dryRun) requireTypedConfirm(ctx.body, specName);
  const job = ctx.submitJob(
    "migrate memories",
    dryRun ? ["migrate", "memories", "--dry-run"] : ["migrate", "memories"],
  );
  return {
    ok: true,
    dryRun,
    job: maskDeep(job),
    fleet: fleetMemorySchemas(ctx),
    note: dryRun
      ? "dry run queued — it reports what the backfill would stamp and changes nothing"
      : "backfill queued; it is idempotent, so a re-run migrates zero entries",
  };
};

/** Every registered harness's memory schema stamp — the mixed-fleet sweep. */
function fleetMemorySchemas(
  ctx: M3Context,
): Array<{ id: string; specName: string; schemaVersion: number | null; behind: boolean }> {
  const rows: Array<{
    id: string;
    specName: string;
    schemaVersion: number | null;
    behind: boolean;
  }> = [];
  for (const h of ctx.harnesses()) {
    // Each harness is contained against its OWN root — the fleet sweep never
    // reads through one harness's directory into another's.
    const meta = readJsonSafe(resolveInside(h.dir, [".crewhaus", "meta.json"]));
    const raw =
      typeof meta === "object" && meta !== null
        ? (meta as Record<string, unknown>)["memorySchemaVersion"]
        : undefined;
    const schemaVersion = typeof raw === "number" ? raw : null;
    rows.push({
      id: h.id,
      specName: h.specName,
      schemaVersion,
      behind: schemaVersion === null || schemaVersion < 2,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// continuity — focus / plans / goals / handoff, plus the trash
// ---------------------------------------------------------------------------

function continuityStoreFor(
  ctx: M3Context,
  specName: string,
): ReturnType<typeof createContinuityStore> {
  const dir = harnessDirOf(ctx);
  return createContinuityStore({
    specName,
    rootDir: join(dir, ".crewhaus", "state"),
    sessionRootDir: join(dir, ".crewhaus", "sessions"),
    now: () => new Date(ctx.now()),
  });
}

function proofRow(p: FrozenProof): Record<string, unknown> {
  return {
    toolUseId: p.toolUseId,
    sessionId: p.sessionId,
    toolName: p.toolName,
    inputHash: p.inputHash,
    // A frozen tool_result excerpt — prose, so it is masked like prose.
    resultDigest: maskText(p.resultDigest),
    verifiedAt: p.verifiedAt,
  };
}

function planRow(plan: PlanRecord): Record<string, unknown> {
  return {
    id: plan.id,
    title: maskText(plan.title),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    steps: plan.steps.map((s) => ({
      index: s.index,
      text: maskText(s.text),
      status: s.status,
      proofs: s.proofs.map(proofRow),
    })),
  };
}

/** The flat-layout fallback: focus/goals/plans read as documents. */
function flatContinuity(
  ctx: M3Context,
  dir: string,
  layout: "spec-scoped" | "flat",
  specName: string,
): {
  focusRaw: { text: string; truncated: boolean } | null;
  goalsRaw: { text: string; truncated: boolean } | null;
  plans: Array<{ file: string; text: string }>;
} {
  const prefix = layout === "flat" ? [".crewhaus", "state"] : [".crewhaus", "state", specName];
  const plans: Array<{ file: string; text: string }> = [];
  const plansDir = join(dir, "plans");
  for (const name of listDirSafe(existsSync(plansDir) ? plansDir : undefined)) {
    if (!name.endsWith(".md") || !SAFE_SEGMENT_RE.test(name)) continue;
    // Per FILE: a plan name listed in the directory can be a symlink out.
    const doc = readProse(containedPath(ctx, [...prefix, "plans", name]));
    if (doc === null) continue;
    plans.push({ file: name, text: doc.text });
  }
  return {
    focusRaw: readProse(containedPath(ctx, [...prefix, "focus.md"])),
    goalsRaw: readProse(containedPath(ctx, [...prefix, "goals.yaml"])),
    plans,
  };
}

/**
 * `GET /api/h/:id/memory/continuity` — the continuity panel.
 *
 * `state/<spec>/`: `focus.md` with the REQ ledger split out, plans with the
 * proof ladder (open → in_progress → claimed → proven) and their evidence
 * `toolUseId`s + `sessionId`s for the session deep links, `goals.yaml`, and
 * `handoff.md`. Read through `@crewhaus/continuity-store` when the store's
 * own layout is on disk; a flat older tree degrades to a document read
 * rather than to an empty panel.
 *
 * A focus.md WITHOUT the `<!-- crewhaus:focus -->` marker is a human's file:
 * the store refuses to parse it (it must never be overwritten), so it comes
 * back as `managed: false` plus its raw text.
 */
export const continuity: M3Handler = async (ctx) => {
  const specName = harnessSpecName(ctx);
  const resolved = resolveStoreDir(ctx, "state", specName, [
    "focus.md",
    "goals.yaml",
    "plans",
    "handoff.md",
  ]);
  const trashDir = containedPath(ctx, [".crewhaus", "trash"]);
  const trashCount = listSubdirs(trashDir).length;
  const verb = "crewhaus run (then /focus, /plan, /goal)";
  if (resolved === undefined) {
    return {
      ...readBase(false, "no continuity state yet for this spec", verb),
      dir: null,
      layout: null,
      specName,
      focus: null,
      plans: [],
      goals: [],
      handoff: null,
      trash: { snapshots: trashCount },
      degraded: null,
    };
  }

  const handoff = readProse(
    containedPath(
      ctx,
      resolved.layout === "flat"
        ? [".crewhaus", "state", "handoff.md"]
        : [".crewhaus", "state", specName, "handoff.md"],
    ),
  );
  let focus: Record<string, unknown> | null = null;
  let plans: Array<Record<string, unknown>> = [];
  let goals: Array<Record<string, unknown>> = [];
  let degraded: string | null = null;

  if (resolved.layout === "spec-scoped" && isStoreName(specName)) {
    try {
      const store = continuityStoreFor(ctx, specName);
      const state = await store.readFocus();
      const raw = readProse(containedPath(ctx, [".crewhaus", "state", specName, "focus.md"]));
      focus =
        state === null
          ? {
              managed: false,
              body: raw?.text ?? "",
              activePlanId: null,
              requirements: [],
              ledgerTruncated: false,
              truncated: raw?.truncated ?? false,
            }
          : {
              managed: true,
              body: maskText(state.body),
              activePlanId: state.activePlanId,
              requirements: state.requirements.map((r) => ({
                id: r.id,
                // The user's words VERBATIM — masked, never paraphrased.
                text: maskText(r.text),
                status: r.status,
                sessionId: r.source.sessionId,
                turn: r.source.turn,
              })),
              ledgerTruncated: state.ledgerTruncated,
              truncated: raw?.truncated ?? false,
            };
      plans = (await store.listPlans()).map(planRow);
      goals = (await store.listGoals()).map((g) => ({
        id: g.id,
        title: maskText(g.title),
        status: g.status,
        target: g.target ?? null,
        current: g.current ?? null,
        unit: g.unit ?? null,
        updatedAt: g.updatedAt,
        proofs: (g.proofs ?? []).map(proofRow),
      }));
    } catch (err) {
      degraded = describeFailure(err);
    }
  }

  if (focus === null) {
    const flat = flatContinuity(ctx, resolved.dir, resolved.layout, specName);
    focus = {
      managed: false,
      body: flat.focusRaw?.text ?? "",
      activePlanId: null,
      requirements: [],
      ledgerTruncated: false,
      truncated: flat.focusRaw?.truncated ?? false,
    };
    plans = flat.plans.map((p) => ({
      id: p.file,
      title: p.file,
      createdAt: null,
      updatedAt: null,
      steps: [],
      text: p.text,
    }));
    goals = [];
    if (degraded === null && resolved.layout === "flat") {
      degraded =
        "this tree predates the spec-scoped layout — focus/plans/goals are rendered as documents, without the proof ladder";
    }
  }

  return {
    ...readBase(true, degraded, verb),
    dir: resolved.dir,
    layout: resolved.layout,
    specName,
    focus,
    plans,
    goals,
    handoff: handoff === null ? null : { text: handoff.text, truncated: handoff.truncated },
    trash: { snapshots: trashCount },
    degraded,
  };
};

/**
 * `GET /api/h/:id/memory/continuity/trash` — the trash browser.
 *
 * `.crewhaus/trash/<ts>/` snapshots. This directory is the reason "clear" is
 * safe; surfacing it is what makes the promise visible. Each snapshot lists
 * the files it holds (paths relative to `.crewhaus`) and whether restoring
 * it would collide with a file that came back since.
 */
export const continuityTrash: M3Handler = async (ctx) => {
  const dir = harnessDirOf(ctx);
  const crewhaus = containedPath(ctx, [".crewhaus"]);
  const verb = "crewhaus run (then /clear — clearing is what fills the trash)";
  if (crewhaus === undefined || !existsSync(join(crewhaus, "trash"))) {
    return {
      ...readBase(false, "nothing has been cleared in this harness yet", verb),
      snapshots: [],
      purgeAfterDays: 7,
    };
  }
  let listed: ReadonlyArray<{ ts: string; files: readonly string[] }>;
  try {
    listed = await listTrash(crewhaus);
  } catch (err) {
    return { ...readBase(false, describeFailure(err), verb), snapshots: [], purgeAfterDays: 7 };
  }
  const nowMs = ctx.now();
  const snapshots = listed
    .map((snap) => {
      const atMs = parseTrashTimestamp(snap.ts);
      // Per FILE: a snapshot entry is a name, and a name can be a symlink.
      const files = snap.files.filter(
        (rel) =>
          resolveInside(dir, [".crewhaus", "trash", snap.ts, ...rel.split("/")]) !== undefined,
      );
      const collides = files.filter((rel) => existsSync(join(crewhaus, rel)));
      return {
        ts: snap.ts,
        at: atMs === null ? null : new Date(atMs).toISOString(),
        ageMs: atMs === null ? null : nowMs - atMs,
        files,
        restorable: collides.length === 0,
        blockedBy: collides,
      };
    })
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return {
    ...readBase(
      snapshots.length > 0,
      snapshots.length === 0 ? "the trash directory exists but holds no snapshots" : null,
      verb,
    ),
    snapshots,
    purgeAfterDays: 7,
  };
};

/**
 * `POST /api/h/:id/memory/continuity/restore` — restore by timestamp.
 *
 * Body: `{ stamp, confirm }`. Restores a trash snapshot through the
 * continuity store (which takes the store lock and refuses to clobber a file
 * that came back since). Restoring over live state is itself confirm-gated.
 *
 * A missing or unparseable stamp is a REPORTED refusal, not a 404: the trash
 * browser is the screen that lists valid stamps, and a restore that raced a
 * purge should say so on the panel it was clicked from.
 */
export const continuityRestore: M3Handler = async (ctx) => {
  const stamp = requireString(ctx.body, "stamp");
  if (requireBoolean(ctx.body, "confirm") !== true) {
    throw new HttpError(409, 'restoring a snapshot needs "confirm": true');
  }
  const crewhaus = containedPath(ctx, [".crewhaus"]);
  if (crewhaus === undefined) throw new HttpError(400, "path escapes the harness directory");
  if (
    !SAFE_SEGMENT_RE.test(stamp) ||
    containedPath(ctx, [".crewhaus", "trash", stamp]) === undefined ||
    !existsSync(join(crewhaus, "trash", stamp))
  ) {
    return {
      ok: false,
      code: "no_such_snapshot",
      stamp,
      restored: [],
      note: "no trash snapshot with that stamp — the trash browser lists the restorable ones",
    };
  }
  const specName = harnessSpecName(ctx);
  try {
    const result = isStoreName(specName)
      ? await continuityStoreFor(ctx, specName).restore(stamp)
      : await restoreFromTrash(stamp, crewhaus);
    return {
      ok: true,
      stamp: result.ts,
      restored: result.restored,
      note: `${result.restored.length} file(s) moved back out of the trash`,
    };
  } catch (err) {
    return { ok: false, code: "restore_refused", stamp, restored: [], note: describeFailure(err) };
  }
};

// ---------------------------------------------------------------------------
// learning — curriculum, exam, study rotation, the knowledge-gap queue
// ---------------------------------------------------------------------------

type ExamRun = {
  runId: string;
  ts: string;
  passRate: number | null;
  meanScore: number | null;
  sampleCount: number | null;
};

/** The newest eval-index row whose dataset matches the exam's dataset. */
function latestExamRun(ctx: M3Context, dataset: string): ExamRun | null {
  const path = containedPath(ctx, [".crewhaus", "evals", "index.jsonl"]);
  if (path === undefined || !existsSync(path)) return null;
  const stem = basename(dataset).replace(/\.jsonl$/, "");
  let best: ExamRun | null = null;
  for (const obj of readJsonlCapped(path).objects) {
    if (typeof obj !== "object" || obj === null) continue;
    const row = obj as Record<string, unknown>;
    const name = typeof row["datasetName"] === "string" ? row["datasetName"] : "";
    // A regression-unioned run (`smoke+regressions@v3`) is still the exam.
    if (name !== stem && !name.startsWith(`${stem}+`)) continue;
    const ts = typeof row["ts"] === "string" ? row["ts"] : "";
    if (best !== null && ts <= best.ts) continue;
    best = {
      runId: typeof row["runId"] === "string" ? row["runId"] : "",
      ts,
      passRate: typeof row["passRate"] === "number" ? row["passRate"] : null,
      meanScore: typeof row["meanScore"] === "number" ? row["meanScore"] : null,
      sampleCount: typeof row["sampleCount"] === "number" ? row["sampleCount"] : null,
    };
  }
  return best;
}

/** Checkbox rungs in an agent-editable curriculum ladder. */
export function curriculumRungs(text: string): Array<{ text: string; done: boolean }> {
  const out: Array<{ text: string; done: boolean }> = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (m === null) continue;
    out.push({ done: (m[1] ?? " ").toLowerCase() === "x", text: maskText((m[2] ?? "").trim()) });
  }
  return out;
}

/** `gap-*` wiki articles (the standalone gap sink, tagged `gaps/`). */
function gapArticles(ctx: M3Context, specName: string): Array<{ slug: string; title: string }> {
  const resolved = resolveStoreDir(ctx, "wiki", specName, ["articles", "index.json"]);
  if (resolved === undefined) return [];
  const index = readJsonSafe(join(resolved.dir, "index.json"));
  const articles =
    typeof index === "object" && index !== null
      ? ((index as Record<string, unknown>)["articles"] ?? index)
      : undefined;
  const out: Array<{ slug: string; title: string }> = [];
  if (typeof articles === "object" && articles !== null && !Array.isArray(articles)) {
    for (const [slug, entry] of Object.entries(articles as Record<string, unknown>)) {
      if (!slug.startsWith("gap-")) continue;
      const title =
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { title?: unknown }).title === "string"
          ? (entry as { title: string }).title
          : slug;
      out.push({ slug, title: maskText(title) });
    }
  }
  for (const name of listDirSafe(join(resolved.dir, "articles"))) {
    if (!name.startsWith("gap-") || !name.endsWith(".md")) continue;
    const slug = name.slice(0, -".md".length);
    if (out.some((a) => a.slug === slug)) continue;
    out.push({ slug, title: slug });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * `GET /api/h/:id/memory/learning` — the learning subsystem panel.
 *
 * For specs with a `learning:` block: curriculum progress, the living
 * `exam{dataset, graders}` result (read from the eval index — the exam RUNS
 * through the eval launcher, not from here), study-rotation state
 * (`study.on_heartbeat` / `on_dream`), and the local knowledge-gap queue.
 *
 * Gaps land in one of two places depending on how the harness is wired:
 * continuity goals titled `[gap] …` when the plan store exists, and
 * `gap-<topic>` wiki articles under the reserved `gaps/` tag otherwise. Both
 * are folded here; the Thredz `knowledge-gap` task tag is NAMED as the
 * hosted twin rather than fetched (that lives on the Thredz surface).
 */
export const learning: M3Handler = async (ctx) => {
  const yamlText = readSpecYaml(harnessDirOf(ctx));
  const block = specBlock(yamlText, ["learning"]);
  const declared = specDeclares(yamlText, "learning");
  const verb = "crewhaus run (then /study and /reflect)";
  if (!declared || block === undefined) {
    return {
      ...readBase(
        false,
        "this spec declares no learning: block — the study/reflect loop is off",
        verb,
      ),
      declared,
      enabled: false,
      domain: null,
      curriculum: null,
      sources: [],
      exam: null,
      study: { onHeartbeat: false, onDream: false },
      gaps: { total: 0, goals: [], articles: [] },
      thredzTag: "knowledge-gap",
    };
  }
  const enabled = specScalar(block, "enabled") !== "false";
  const domain = specScalar(block, "domain") ?? null;
  const curriculumPath = specScalar(block, "curriculum") ?? null;
  const examBlock = specBlock(yamlText, ["learning", "exam"]);
  const studyBlock = specBlock(yamlText, ["learning", "study"]);
  const examDataset = examBlock === undefined ? null : (specScalar(examBlock, "dataset") ?? null);
  const examGraders = examBlock === undefined ? null : (specScalar(examBlock, "graders") ?? null);

  let curriculum: Record<string, unknown> | null = null;
  if (curriculumPath !== null) {
    const doc = readProse(
      containedPath(
        ctx,
        curriculumPath.split("/").filter((s) => s !== ""),
      ),
    );
    const rungs = doc === null ? [] : curriculumRungs(doc.text);
    curriculum = {
      path: curriculumPath,
      present: doc !== null,
      rungs,
      done: rungs.filter((r) => r.done).length,
      total: rungs.length,
      note:
        doc === null
          ? "the spec names a curriculum file that is not on disk yet — the ladder lives in the wiki until it is"
          : null,
    };
  }

  const specName = harnessSpecName(ctx);
  const gapGoals: Array<Record<string, unknown>> = [];
  if (isStoreName(specName)) {
    try {
      for (const g of await continuityStoreFor(ctx, specName).listGoals()) {
        if (!g.title.startsWith("[gap]")) continue;
        gapGoals.push({
          id: g.id,
          title: maskText(g.title),
          status: g.status,
          updatedAt: g.updatedAt,
        });
      }
    } catch {
      // No plan store (or an unreadable one) — the wiki fallback still counts.
    }
  }
  const articles = gapArticles(ctx, specName);

  return {
    ...readBase(
      true,
      enabled ? null : "learning: enabled is false — the loop is declared but off",
      verb,
    ),
    declared: true,
    enabled,
    domain: domain === null ? null : maskText(domain),
    curriculum,
    // Source allowlists are a security surface, never auto-tuned — shown as
    // declared so an operator can see what STUDY is allowed to reach.
    sources: specList(block, "sources").map((s) => maskText(s)),
    exam:
      examDataset === null
        ? null
        : {
            dataset: examDataset,
            graders: examGraders,
            lastRun: latestExamRun(ctx, examDataset),
            note: "the exam runs through the eval launcher; this is its newest recorded run",
          },
    study: {
      onHeartbeat: specBool(studyBlock, "on_heartbeat", true),
      onDream: specBool(studyBlock, "on_dream", true),
    },
    gaps: { total: gapGoals.length + articles.length, goals: gapGoals, articles },
    thredzTag: "knowledge-gap",
  };
};

// ---------------------------------------------------------------------------
// knowledge sync — the .crewhaus-shared fleet store
// ---------------------------------------------------------------------------

type SharedCandidate = { dir: string; source: string; exists: boolean };

/**
 * Where `crewhaus knowledge sync` would put the shared store when run from
 * this harness: `CREWHAUS_SHARED_DIR` (out of the harness's own layered env,
 * the same picture a spawn sees), else `<root>/.crewhaus-shared` with the
 * root defaulting to the process cwd — which for a manager-submitted job IS
 * the harness dir. The workspace sibling is offered too, because that is
 * where a fleet-level store usually lives.
 *
 * This is the one read in the area that leaves the harness tree, so it is
 * deliberately NOT path-driven: no request field reaches it, and everything
 * it returns is masked.
 */
function sharedCandidates(ctx: M3Context): SharedCandidate[] {
  const dir = harnessDirOf(ctx);
  const out: Array<{ dir: string; source: string }> = [];
  const fromEnv = ctx.env["CREWHAUS_SHARED_DIR"];
  if (typeof fromEnv === "string" && fromEnv !== "" && isAbsolute(fromEnv)) {
    out.push({ dir: resolve(fromEnv), source: "CREWHAUS_SHARED_DIR" });
  }
  out.push({ dir: join(dir, ".crewhaus-shared"), source: "harness root" });
  out.push({ dir: join(dirname(dir), ".crewhaus-shared"), source: "workspace sibling" });
  return out.map((c) => ({ ...c, exists: existsSync(c.dir) }));
}

function countFiles(dir: string, suffix: string): number {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(suffix)).length;
  } catch {
    return 0;
  }
}

/**
 * `GET /api/h/:id/memory/knowledge` — knowledge-sync status.
 *
 * The `.crewhaus-shared/` fleet store: the shared artifact counts, the
 * provenance manifest (and how much of it this harness pushed), and the
 * share opt-in state from `.crewhaus/knowledge.json`. Read-only; the verb is
 * below.
 */
export const knowledge: M3Handler = (ctx) => {
  const marker = readJsonSafe(containedPath(ctx, [".crewhaus", "knowledge.json"]));
  const share =
    typeof marker === "object" && marker !== null && (marker as { share?: unknown }).share === true;
  const candidates = sharedCandidates(ctx);
  const chosen = candidates.find((c) => c.exists) ?? candidates[0];
  const dir = harnessDirOf(ctx);
  const verb = "crewhaus knowledge sync";

  const sharedDir = chosen?.dir ?? null;
  const exists = chosen?.exists === true;
  const manifest: Array<Record<string, unknown>> = [];
  let pushedByThisHarness = 0;
  if (exists && sharedDir !== null) {
    for (const obj of readJsonlCapped(join(sharedDir, "manifest.jsonl")).objects) {
      if (typeof obj !== "object" || obj === null) continue;
      const row = maskDeep(obj) as Record<string, unknown>;
      const from = row["harness"] ?? row["from"] ?? row["dir"];
      if (typeof from === "string" && (from === dir || basename(from) === basename(dir))) {
        pushedByThisHarness += 1;
      }
      manifest.push(row);
    }
  }
  return {
    ...readBase(
      exists,
      exists
        ? share
          ? null
          : "this harness has not opted in — a fleet sync skips it until knowledge.json says share: true"
        : "no shared store yet — the first sync creates it",
      verb,
    ),
    share,
    marker: maskDeep(marker ?? null),
    sharedDir,
    sharedDirSource: chosen?.source ?? null,
    candidates,
    counts:
      exists && sharedDir !== null
        ? {
            memories: readJsonlCapped(join(sharedDir, "memories.jsonl")).objects.length,
            graders: countFiles(join(sharedDir, "graders"), ".yaml"),
            prompts: countFiles(join(sharedDir, "prompts"), ".md"),
          }
        : { memories: 0, graders: 0, prompts: 0 },
    pushedByThisHarness,
    manifest: manifest.slice(-50),
  };
};

/** What a push would carry out of this harness, with the maskable rows named. */
function pushPreview(
  ctx: M3Context,
  specName: string,
): { candidates: number; wouldRedact: Array<{ id: string; text: string }> } {
  const path = containedPath(ctx, [".crewhaus", "memories", `${specName}.jsonl`]);
  if (path === undefined || !existsSync(path)) return { candidates: 0, wouldRedact: [] };
  const wouldRedact: Array<{ id: string; text: string }> = [];
  let candidates = 0;
  for (const obj of readJsonlCapped(path).objects) {
    const line = obj as RawFactLine;
    if (line.tombstone !== undefined) continue;
    if (typeof line.id !== "string" || typeof line.text !== "string") continue;
    candidates += 1;
    const masked = maskText(line.text);
    if (masked !== line.text) wouldRedact.push({ id: line.id, text: masked });
  }
  return { candidates, wouldRedact: wouldRedact.slice(0, 50) };
}

/**
 * `POST /api/h/:id/memory/knowledge/sync` — `crewhaus knowledge sync`.
 *
 * Body: `{ direction: "pull" | "push", dryRun }`. Through the job queue, on
 * a CLOSED argv vocabulary (two literal flags — nothing from the body ever
 * reaches the command line).
 *
 * A PUSH redacts on the way out and must show what it redacted BEFORE
 * running — sharing is the one direction that can leak — so the preview
 * lists the live facts whose text changes under the manager's own masker.
 * The CLI's redactor is the authority (it adds PII categories and DROPS
 * anything still credential-shaped); this preview is the honest floor of
 * what it will do. A real push is typed-confirm on top of the dry run.
 */
export const knowledgeSync: M3Handler = (ctx) => {
  const direction = requireString(ctx.body, "direction");
  if (direction !== "pull" && direction !== "push") {
    throw new HttpError(400, '"direction" must be "pull" or "push"');
  }
  const dryRun = isDryRun(ctx.body);
  const specName = harnessSpecName(ctx);
  if (direction === "push" && !dryRun) requireTypedConfirm(ctx.body, specName);

  const argv = ["knowledge", "sync", direction === "pull" ? "--pull" : "--push"];
  if (dryRun) argv.push("--dry-run");
  const job = ctx.submitJob(`knowledge sync ${direction}`, argv);
  return {
    ok: true,
    direction,
    dryRun,
    job: maskDeep(job),
    preview: direction === "push" ? pushPreview(ctx, specName) : null,
    note:
      direction === "push"
        ? "push redacts on the way out; anything still credential-shaped after redaction is dropped, never shared"
        : "pull dedupes by content hash, so re-running brings nothing in twice",
  };
};

// ---------------------------------------------------------------------------
// dream — cadence, outcomes, the overdue badge, the cron scaffold
// ---------------------------------------------------------------------------

/** The cron `crewhaus dream init` picks for a cadence: hourly under a day,
 *  nightly at or over one. Both land off the hour, because every workflow
 *  scheduled at :00 queues behind the runner backlog. */
function dreamCron(everyMs: number | null): string {
  return everyMs !== null && everyMs < 86_400_000 ? "19 * * * *" : "19 4 * * *";
}

function dreamWorkflow(cron: string, everyMs: number | null): string {
  const cadence =
    everyMs !== null && everyMs < 86_400_000
      ? "# Hourly at :19 — the spec's dream cadence is sub-daily; window idempotency dedupes over-fires."
      : "# Nightly at 04:19 UTC (off the hour to dodge cron scheduling backlog).";
  return [
    "# crewhaus-dream.yml — the scheduled consolidation workflow.",
    "#",
    "# `crewhaus dream run` is WINDOW-IDEMPOTENT and run.lock-serialized: this",
    "# cron, a daemon janitor tick and a manual run can never double-fire.",
    "",
    "name: crewhaus-dream",
    "",
    "on:",
    "  schedule:",
    `    ${cadence}`,
    `    - cron: "${cron}"`,
    "  workflow_dispatch: {}",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  dream:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 15",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: oven-sh/setup-bun@v2",
    "      - name: Install the CLI",
    "        run: |",
    "          bun add -g crewhaus",
    '          echo "$HOME/.bun/bin" >> "$GITHUB_PATH"',
    "      - name: Run the consolidation pass",
    "        env:",
    "          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
    "        run: crewhaus dream run crewhaus.yaml",
    "",
  ].join("\n");
}

/**
 * `GET /api/h/:id/memory/dream/scaffold` — the dream panel's offline half.
 *
 * The declared cadence (`memory.dream.every` / `mode` / `budget_usd`), the
 * durable `dream/<spec>/state.json` outcomes, the overdue verdict those two
 * make together, and — PRINT-ONLY — the workflow `dream init` would write,
 * so an operator can paste it or open a PR with it. Nothing here writes a
 * file.
 *
 * Firing a dream is NOT here. It goes through the M2 job queue
 * (`POST /api/h/:id/jobs {kind:"dream-run"}`), which is window-idempotent
 * and `run.lock`-serialized, so it can never double-fire against the
 * daemon's janitor or a CI cron.
 */
export const dreamScaffold: M3Handler = (ctx) => {
  const yamlText = readSpecYaml(harnessDirOf(ctx));
  const block = specBlock(yamlText, ["memory", "dream"]);
  const every = block === undefined ? undefined : specScalar(block, "every");
  const everyMs = parseDurationMs(every);
  const mode = block === undefined ? null : (specScalar(block, "mode") ?? "full");
  const budgetRaw = block === undefined ? undefined : specScalar(block, "budget_usd");
  const budgetUsd = budgetRaw === undefined ? 0 : Number(budgetRaw);
  const budget = Number.isFinite(budgetUsd) ? budgetUsd : 0;
  const nowMs = ctx.now();

  const specs: Array<Record<string, unknown>> = [];
  const dreamDir = containedPath(ctx, [".crewhaus", "dream"]);
  for (const name of listSubdirs(dreamDir)) {
    const state = readJsonSafe(containedPath(ctx, [".crewhaus", "dream", name, "state.json"]));
    if (state === undefined) continue;
    const row = state as Record<string, unknown>;
    const lastRunAt = typeof row["lastRunAt"] === "string" ? row["lastRunAt"] : null;
    const lastMs = lastRunAt === null ? Number.NaN : Date.parse(lastRunAt);
    const dueAt = Number.isNaN(lastMs) || everyMs === null ? null : lastMs + everyMs;
    specs.push({
      specName: name,
      state: maskDeep(state),
      lastRunAt,
      lastOutcome: typeof row["lastOutcome"] === "string" ? maskText(row["lastOutcome"]) : null,
      nextDueAt: dueAt === null ? null : new Date(dueAt).toISOString(),
      overdue: dueAt !== null && dueAt < nowMs,
    });
  }

  const cron = dreamCron(everyMs);
  const declared = every !== undefined;
  return {
    ...readBase(
      declared || specs.length > 0,
      declared
        ? null
        : "this spec declares no memory.dream block — consolidation never runs on a timer",
      "crewhaus dream init crewhaus.yaml",
    ),
    declared,
    cadence: every ?? null,
    everyMs,
    mode,
    budgetUsd: budget,
    // `budget_usd: 0` means deterministic-only regardless of mode: unattended
    // model spend has to be opted into by number.
    modelPhase: budget > 0 && mode !== "deterministic",
    specs,
    overdue: specs.some((s) => s["overdue"] === true),
    cron,
    workflowPath: ".github/workflows/crewhaus-dream.yml",
    workflow: dreamWorkflow(cron, everyMs),
  };
};
