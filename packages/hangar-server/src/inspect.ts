/**
 * M3 · INSPECT — the raw browsers that make "inspect ALL captured data"
 * literally true, plus the `settings.json` editor.
 *
 * ---------------------------------------------------------------------------
 * THE READ ALLOWLIST — and the things it must never reach
 * ---------------------------------------------------------------------------
 * `.crewhaus/` is browsable EXCEPT:
 *   - `secrets/`        — the secrets backend's material,
 *   - the raw audit files — served only as rendered records through the
 *     audit-log verify/read API (`security-ops.ts`),
 *   - `.env` (and any `.env.*`) — presence booleans only, via `creds-ops.ts`.
 *   - `run/logs/`       — the RAW child capture. The credential scrubber sits
 *     on the supervisor's read path, not on the file, so a generic text
 *     browser over that directory would serve in cleartext exactly what the
 *     run console masks. The run routes stay the only way in.
 * Those exclusions are enforced HERE, in the store allowlist and in the
 * generic raw browser, not in the UI.
 *
 * The named stores this module browses ({@link INSPECT_STORE_NOTE}):
 *   scope-audit    `.crewhaus/scope-audit/baseline.json` (lint's output)
 *   prompt-cache   `prompt-cache/<spec>.json` — the cache-rotation record
 *   logs           `.crewhaus/logs/` — NOT `.crewhaus/run/logs/<runId>.log`,
 *                  which is raw by construction and is served only through
 *                  the supervisor's scrubbed paths (`runs.ts`)
 *   skills         `.crewhaus/skills/` incl. the auto-discovered FAQ skill
 *   commands       `.crewhaus/commands/`
 *   preferences    `.crewhaus/preferences/`
 *   settings       `.crewhaus/settings.json` — permission rules + hooks
 *   knowledge      `.crewhaus/knowledge.json` — share opt-in state
 *   identity       `.crewhaus/identity.json` — the Ed25519 fingerprint that
 *                  stamps every trace envelope (display the fingerprint; the
 *                  key material in that file is reported as PRESENCE only and
 *                  is never serialized)
 *   meta           `.crewhaus/meta.json` — schema versions, migration stamps
 *   environments   `.crewhaus/environments.json`
 *
 * Every read is per-file realpath-contained (a listed NAME can be a symlink
 * out of the tree), capped, torn-line tolerant, and masked. A missing store
 * is an empty state, never a 500 — absence is not an error.
 *
 * The generic raw browser is the fallback that makes the claim honest: it
 * takes a harness-relative `?path=`, resolves it with the same containment
 * check, refuses the exclusions above, and serves text capped and
 * masked. It is READ-ONLY. There is no generic write.
 *
 * ---------------------------------------------------------------------------
 * THREE MASKING LAYERS, BECAUSE ONE IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * The dispatcher runs `maskDeep` over whatever a handler returns, which is
 * KEY-based: it redacts a value stored under a credential-naming key. That
 * covers a parsed document and misses a document served as TEXT — and this
 * module's whole job is serving documents. So:
 *
 *   - a file that parses as JSON (or JSONL, line by line) is served as a
 *     PARSED, masked document, which is why `identity.json`'s `privateKey`
 *     and an approval's `headers` disappear at all;
 *   - anything genuinely prose is served through the harness's own env
 *     SCRUBBER first — the same one the run console reads history through, so
 *     a credential this manager holds the value of becomes its NAME whatever
 *     it looks like;
 *   - and then through {@link maskRawText}: value-shape masking plus a PEM
 *     private-key block redactor, because a key block carries no key-ish
 *     context word and the generic shape masker walks straight past it.
 *
 * `identity.json` never rides any of those paths verbatim: it is projected to
 * the fingerprint plus PRESENCE booleans for the key material, so the private
 * key cannot leave this process even if a masker regresses.
 */
import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_TEXT_BYTES } from "./constants";
import { HttpError } from "./http";
import { readTextCapped } from "./jsonl";
import type { M3Context, M3Handler } from "./m3";
import { requireTypedConfirm } from "./m3";
import { maskDeep, maskText } from "./mask";
import { spawnEnvScrubber } from "./runs";

/** The closed set of named stores the inspector browses. Anything outside it
 *  falls to the generic raw browser (which applies the same exclusions). */
export const INSPECT_STORES = [
  "scope-audit",
  "prompt-cache",
  "logs",
  "skills",
  "commands",
  "preferences",
  "settings",
  "knowledge",
  "identity",
  "meta",
  "environments",
] as const;

export type InspectStore = (typeof INSPECT_STORES)[number];

export function isInspectStore(value: string): value is InspectStore {
  return (INSPECT_STORES as readonly string[]).includes(value);
}

/** Referenced by the module docblock so the store list has one home. */
export const INSPECT_STORE_NOTE =
  "secrets/, raw audit files, .env and the raw run captures are excluded from every inspect route";

/** Cap on directory entries listed for one store (a runaway `logs/` must not
 *  make a fleet console paint unbounded). */
export const MAX_INSPECT_ENTRIES = 500;

/** Cap on bytes read from any single inspected document. */
export const MAX_INSPECT_BYTES = MAX_TEXT_BYTES;

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

type StoreDef = {
  readonly kind: "dir" | "file";
  /** Harness-relative segments. Every read still goes through `ctx.contain`. */
  readonly segments: readonly string[];
  /** One line an operator can read without knowing the codebase. */
  readonly what: string;
  /** The CLI verb that CREATES this store, or null when nothing writes it. */
  readonly verb: string | null;
};

const STORE_DEFS: Readonly<Record<InspectStore, StoreDef>> = {
  "scope-audit": {
    kind: "dir",
    segments: [".crewhaus", "scope-audit"],
    what: "lint's scope-audit baseline and its dated drift snapshots",
    verb: "crewhaus lint --scope-audit --json --baseline",
  },
  "prompt-cache": {
    kind: "dir",
    segments: [".crewhaus", "prompt-cache"],
    what: "per-spec prompt-cache rotation records, so cache prefixes survive a restart",
    verb: null,
  },
  logs: {
    kind: "dir",
    segments: [".crewhaus", "logs"],
    what: "logs written by generated schedule units (cron/launchd/systemd), one file per job label",
    verb: "crewhaus schedule generate",
  },
  skills: {
    kind: "dir",
    segments: [".crewhaus", "skills"],
    what: "harness-local skills, one directory per skill (including the auto-discovered FAQ skill)",
    verb: "crewhaus feedback faq --distill",
  },
  commands: {
    kind: "dir",
    segments: [".crewhaus", "commands"],
    what: "harness-local slash commands, one markdown file per command",
    verb: null,
  },
  preferences: {
    kind: "dir",
    segments: [".crewhaus", "preferences"],
    what: "learned per-rater preferences, injected into the agent's turn",
    verb: "crewhaus distill --preferences",
  },
  settings: {
    kind: "file",
    segments: [".crewhaus", "settings.json"],
    what: "permission rules and hooks — the human-owned configuration this console can edit",
    verb: "crewhaus permissions suggest",
  },
  knowledge: {
    kind: "file",
    segments: [".crewhaus", "knowledge.json"],
    what: "the share opt-in marker that lets this harness participate in knowledge sync",
    verb: "crewhaus knowledge sync",
  },
  identity: {
    kind: "file",
    segments: [".crewhaus", "identity.json"],
    what: "the Ed25519 agent identity whose fingerprint stamps every trace envelope and audit record",
    verb: "crewhaus run",
  },
  meta: {
    kind: "file",
    segments: [".crewhaus", "meta.json"],
    what: "store schema versions and migration stamps",
    verb: "crewhaus memory migrate",
  },
  environments: {
    kind: "file",
    segments: [".crewhaus", "environments.json"],
    what: "which deployment environments are protected by the approval-quorum gate",
    verb: null,
  },
};

/** One deliberately unreachable subtree, and where its data IS available. */
export type InspectExclusion = {
  readonly path: string;
  readonly reason: string;
  readonly where: string;
};

/**
 * The exclusions, as DATA — the console renders them so their absence reads
 * as a policy rather than as a gap in the browser.
 *
 * This list is the security boundary together with {@link STORE_DEFS}: a new
 * store becomes browsable by being added to the allowlist deliberately, never
 * by matching a glob.
 *
 * The fourth entry is the one an operator would not predict, and it is not
 * optional: `.crewhaus/run/logs/` holds the RAW child capture. The scrubber
 * that knows this harness's credential VALUES sits on the supervisor's read
 * paths, not on the file, so serving that directory through a generic text
 * browser would hand out in cleartext exactly what the run console masks.
 * The run routes stay the only way to read it.
 */
export const INSPECT_EXCLUSIONS: readonly InspectExclusion[] = [
  {
    path: ".crewhaus/secrets/",
    reason: "the secrets backend's material — credential VALUES never leave this process",
    where: "Credentials → presence, health and rotation",
  },
  {
    path: ".crewhaus/audit/",
    reason:
      "the raw hash-chained audit files — serving them raw would bypass the chain verification that makes them evidence",
    where: "Security → the audit chain, as verified records",
  },
  {
    path: ".env, .env.*",
    reason: "credential values; only KEY presence is ever reported",
    where: "Credentials → the env matrix",
  },
  {
    path: ".crewhaus/run/logs/",
    reason:
      "the raw captured output of supervised runs — unscrubbed by construction, because the credential scrubber sits on the read path rather than on the file",
    where: "Runs → the run console, which scrubs on the way out",
  },
];

/**
 * Which exclusion a harness-relative path trips, or null when it trips none.
 *
 * Deliberately broader than the literal paths above: ANY segment named
 * `secrets` is refused, wherever it sits, and any name that starts `.env`.
 * Over-refusing a browser is recoverable; under-refusing it is not.
 */
export function exclusionFor(segments: readonly string[]): InspectExclusion | null {
  for (const raw of segments) {
    const segment = raw.toLowerCase();
    if (segment === "secrets") return INSPECT_EXCLUSIONS[0] as InspectExclusion;
    if (segment === ".env" || segment.startsWith(".env.")) {
      return INSPECT_EXCLUSIONS[2] as InspectExclusion;
    }
  }
  if (segments[0] !== ".crewhaus") return null;
  if (segments[1] === "audit") return INSPECT_EXCLUSIONS[1] as InspectExclusion;
  if (segments[1] === "run" && segments[2] === "logs") {
    return INSPECT_EXCLUSIONS[3] as InspectExclusion;
  }
  return null;
}

/** True when a harness-relative path is one of the exclusions. */
export function isExcludedPath(segments: readonly string[]): boolean {
  return exclusionFor(segments) !== null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A PEM private-key block. Value-shape masking cannot see one — the base64
 *  body carries no key-ish context word — so it is redacted explicitly. */
const PEM_PRIVATE_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/** Mask one raw document served as TEXT: the shared value-shape masker plus
 *  the PEM redactor above. */
export function maskRawText(text: string): string {
  return maskText(text).replace(PEM_PRIVATE_BLOCK_RE, "[redacted private key block]");
}

/**
 * The scrubber the run console reads history through: the harness `.env`
 * chain UNDER the manager's own environment.
 *
 * Shape masking alone catches credentials that LOOK like credentials; this
 * catches the ones this manager actually holds the value of, whatever they
 * look like, and replaces them with their NAME. Every raw document served by
 * this module goes through it, so a scheduled-job log under `.crewhaus/logs/`
 * is protected to the same standard as a supervised run's captured output.
 */
function scrubberFor(ctx: M3Context): (text: string) => string {
  const dir = ctx.harnessDir;
  if (dir === null) return (text) => text;
  try {
    return spawnEnvScrubber(dir, ctx.env);
  } catch {
    // A scrubber that cannot be built must not take the read down; the shape
    // masker still runs on everything below it.
    return (text) => text;
  }
}

export type InspectFileBody = {
  /** Parsed + masked, when the file is JSON (an object) or JSONL (an array). */
  readonly document: unknown | null;
  /** Masked text, when it is not (or could not be parsed). */
  readonly text: string | null;
  /** Why `document` is null on a `.json` file. */
  readonly parseError: string | null;
  readonly bytes: number;
  readonly truncated: boolean;
};

/**
 * Read one already-contained file.
 *
 * STRUCTURE FIRST, TEXT AS THE FALLBACK. `maskDeep` is key-based, so a
 * document served as a parsed tree gets credential-NAMED values redacted
 * wholesale; the same document served as text gets only shape masking, which
 * cannot see `"privateKey": "<base64>"`. So JSON parses, JSONL parses
 * line-by-line (torn lines skipped, never fatal), and only what is genuinely
 * prose falls through to `maskRawText` — with the harness's env `scrub`
 * applied first, so a credential VALUE this manager knows is replaced by its
 * NAME exactly as the run console does it.
 *
 * Never throws: an unreadable file reads empty.
 */
function readBody(path: string, scrub: (text: string) => string): InspectFileBody {
  const { text, truncated } = readTextCapped(path, MAX_INSPECT_BYTES);
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.trim() === "") {
    return { document: null, text: "", parseError: null, bytes, truncated };
  }
  const asText = (parseError: string | null): InspectFileBody => ({
    document: null,
    text: maskRawText(scrub(text)),
    parseError,
    bytes,
    truncated,
  });
  // A truncated read cannot parse whole — serve what we have as text and say
  // so, rather than reporting a syntax error the file does not have.
  if (truncated) return asText(null);

  if (path.endsWith(".jsonl")) {
    const rows: unknown[] = [];
    let torn = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        rows.push(maskDeep(JSON.parse(line)));
      } catch {
        torn += 1; // one torn line must never hide the rest of the file
      }
    }
    if (rows.length > 0) {
      return {
        document: rows,
        text: null,
        parseError: torn === 0 ? null : `${torn} torn line(s) skipped`,
        bytes,
        truncated,
      };
    }
    return asText(null);
  }
  try {
    return {
      document: maskDeep(JSON.parse(text)),
      text: null,
      parseError: null,
      bytes,
      truncated,
    };
  } catch (err) {
    return asText(
      path.endsWith(".json") ? (err instanceof Error ? err.message : String(err)) : null,
    );
  }
}

export type InspectEntryRow = {
  readonly name: string;
  readonly kind: "file" | "dir" | "other";
  readonly bytes: number | null;
  readonly modifiedAt: string | null;
  /** Set when the name could not be read as a contained path — a listed name
   *  can be a symlink out of the harness, and that is a FACT to show, not a
   *  row to drop silently. */
  readonly note: string | null;
};

/**
 * List a directory store's entries.
 *
 * CONTAINMENT IS PER FILE. `readdirSync` yields NAMES; each one is re-resolved
 * through `ctx.contain` before it is stat'd, because a name inside a contained
 * directory can still be a symlink pointing out of the harness.
 */
function listEntries(
  ctx: M3Context,
  base: readonly string[],
): { rows: InspectEntryRow[]; truncated: boolean } {
  let names: string[];
  try {
    const dir = ctx.contain(base);
    names = readdirSync(dir).sort();
  } catch {
    return { rows: [], truncated: false };
  }
  const rows: InspectEntryRow[] = [];
  const truncated = names.length > MAX_INSPECT_ENTRIES;
  for (const name of names.slice(0, MAX_INSPECT_ENTRIES)) {
    let resolved: string;
    try {
      resolved = ctx.contain([...base, name]);
    } catch {
      rows.push({
        name,
        kind: "other",
        bytes: null,
        modifiedAt: null,
        note: "this name resolves outside the harness directory and is not readable from here",
      });
      continue;
    }
    try {
      const stat = statSync(resolved);
      rows.push({
        name,
        kind: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
        bytes: stat.isFile() ? stat.size : null,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        note: null,
      });
    } catch {
      rows.push({
        name,
        kind: "other",
        bytes: null,
        modifiedAt: null,
        note: "unreadable",
      });
    }
  }
  return { rows, truncated };
}

/** `statSync` that answers undefined instead of throwing. */
function statOr(path: string): { isDir: boolean; bytes: number; modifiedAt: string } | undefined {
  try {
    const stat = statSync(path);
    return {
      isDir: stat.isDirectory(),
      bytes: stat.isFile() ? stat.size : 0,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    return undefined;
  }
}

/** The contained path for a store, or undefined when it escapes (a planted
 *  symlink) — never a throw, because the index folds every store. */
function storePath(ctx: M3Context, store: InspectStore): string | undefined {
  try {
    return ctx.contain(STORE_DEFS[store].segments);
  } catch {
    return undefined;
  }
}

const relPath = (segments: readonly string[]): string => segments.join("/");

// ---------------------------------------------------------------------------
// GET /api/h/:id/inspect — the store index
// ---------------------------------------------------------------------------

export type InspectStoreSummary = {
  readonly store: InspectStore;
  readonly kind: "dir" | "file";
  readonly path: string;
  readonly present: boolean;
  /** Entry count for a directory store; null for a file store or an absence. */
  readonly entries: number | null;
  readonly bytes: number | null;
  readonly modifiedAt: string | null;
  readonly what: string;
  readonly verb: string | null;
  readonly note: string | null;
};

/**
 * `GET /api/h/:id/inspect` — the store index.
 *
 * Which of {@link INSPECT_STORES} exist in this harness, their entry counts
 * and sizes, and an explicit note for the three excluded subtrees so their
 * absence reads as a POLICY, not as a gap.
 *
 * `unmodelled` is the other half of that honesty: anything sitting in
 * `.crewhaus/` that this manager version has no rich view for is NAMED, with
 * the raw browser offered — "we have not modelled this yet" rather than
 * pretending the directory is empty.
 */
export const inspectIndex: M3Handler = (ctx) => {
  const stores: InspectStoreSummary[] = [];
  for (const store of INSPECT_STORES) {
    const def = STORE_DEFS[store];
    const path = storePath(ctx, store);
    const stat = path === undefined ? undefined : statOr(path);
    if (stat === undefined) {
      stores.push({
        store,
        kind: def.kind,
        path: relPath(def.segments),
        present: false,
        entries: null,
        bytes: null,
        modifiedAt: null,
        what: def.what,
        verb: def.verb,
        note: `nothing at ${relPath(def.segments)} yet`,
      });
      continue;
    }
    const listed = def.kind === "dir" ? listEntries(ctx, def.segments) : undefined;
    stores.push({
      store,
      kind: def.kind,
      path: relPath(def.segments),
      present: true,
      entries: listed === undefined ? null : listed.rows.length,
      bytes: def.kind === "file" ? stat.bytes : null,
      modifiedAt: stat.modifiedAt,
      what: def.what,
      verb: def.verb,
      note:
        listed !== undefined && listed.rows.length === 0
          ? "the directory exists but holds nothing yet"
          : null,
    });
  }

  // Everything directly under `.crewhaus/` that is neither a modelled store
  // nor an exclusion. These are the stores other tabs own (sessions, evals,
  // memories, run/…) plus anything a newer CLI started writing.
  const modelled = new Set<string>();
  for (const store of INSPECT_STORES) {
    const segments = STORE_DEFS[store].segments;
    if (segments[0] === ".crewhaus" && segments.length === 2) modelled.add(segments[1] as string);
  }
  const unmodelled: string[] = [];
  for (const row of listEntries(ctx, [".crewhaus"]).rows) {
    if (modelled.has(row.name)) continue;
    if (isExcludedPath([".crewhaus", row.name])) continue;
    unmodelled.push(row.name);
  }

  const anyPresent = stores.some((s) => s.present);
  return {
    present: anyPresent,
    note: anyPresent
      ? null
      : "this harness has written none of the inspectable stores yet — they appear the first time the agent runs",
    verb: anyPresent ? null : "crewhaus run crewhaus.yaml",
    root: ".crewhaus",
    stores,
    excluded: INSPECT_EXCLUSIONS,
    unmodelled,
    unmodelledNote:
      unmodelled.length === 0
        ? null
        : "these exist but have no rich view here yet — open them with the raw browser",
  };
};

// ---------------------------------------------------------------------------
// GET /api/h/:id/inspect/:store
// ---------------------------------------------------------------------------

/** Project `identity.json` to the fingerprint plus PRESENCE booleans. The
 *  key material never leaves this process, masker or no masker. */
function identityProjection(document: unknown): Record<string, unknown> {
  const doc =
    typeof document === "object" && document !== null ? (document as Record<string, unknown>) : {};
  const fingerprint = typeof doc["agentId"] === "string" ? doc["agentId"] : null;
  return {
    fingerprint,
    fingerprintShort: fingerprint === null ? null : `sha256:${fingerprint.slice(0, 16)}…`,
    algorithm: typeof doc["algorithm"] === "string" ? doc["algorithm"] : null,
    createdAt: typeof doc["createdAt"] === "string" ? doc["createdAt"] : null,
    schemaVersion: typeof doc["schemaVersion"] === "number" ? doc["schemaVersion"] : null,
    publicKeyPresent: typeof doc["publicKey"] === "string" && doc["publicKey"] !== "",
    privateKeyPresent: typeof doc["privateKey"] === "string" && doc["privateKey"] !== "",
  };
}

/** Permission rules + hooks, counted and named — what the settings screen
 *  shows above the raw document. */
function settingsSummary(document: unknown): Record<string, unknown> {
  const doc =
    typeof document === "object" && document !== null ? (document as Record<string, unknown>) : {};
  const permissions = doc["permissions"];
  const hooksRaw = doc["hooks"];
  const hooks = Array.isArray(hooksRaw) ? hooksRaw : [];
  const ruleCount = (key: string): number => {
    if (typeof permissions !== "object" || permissions === null) return 0;
    const list = (permissions as Record<string, unknown>)[key];
    return Array.isArray(list) ? list.length : 0;
  };
  return {
    permissionRules: {
      allow: ruleCount("allow"),
      deny: ruleCount("deny"),
      ask: ruleCount("ask"),
    },
    hooks: hooks.map((entry) => {
      const hook =
        typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
      return {
        event: typeof hook["event"] === "string" ? hook["event"] : null,
        matcher: typeof hook["matcher"] === "string" ? hook["matcher"] : null,
        // The command is a shell string an operator wrote; masked like any
        // other free text, because a hook command is a classic place to paste
        // a token.
        command: typeof hook["command"] === "string" ? maskRawText(hook["command"]) : null,
      };
    }),
    otherKeys: Object.keys(doc).filter((k) => k !== "permissions" && k !== "hooks"),
  };
}

/**
 * `GET /api/h/:id/inspect/:store` — one named store's entries.
 *
 * `:store` must be in {@link INSPECT_STORES} (404 otherwise). Directory
 * stores list entries; single-file stores (settings/knowledge/identity/meta/
 * environments) return the parsed document, masked.
 */
export const inspectStore: M3Handler = (ctx) => {
  const store = requireStore(ctx);
  const def = STORE_DEFS[store];
  const path = storePath(ctx, store);
  const stat = path === undefined ? undefined : statOr(path);
  const base = {
    store,
    kind: def.kind,
    path: relPath(def.segments),
    what: def.what,
  };
  if (path === undefined || stat === undefined) {
    return {
      present: false,
      note: `nothing at ${relPath(def.segments)} yet — ${def.what}`,
      verb: def.verb,
      ...base,
      entries: [],
      truncated: false,
      document: null,
      text: null,
      parseError: null,
      bytes: null,
      modifiedAt: null,
      summary: null,
    };
  }
  if (def.kind === "dir") {
    const { rows, truncated } = listEntries(ctx, def.segments);
    return {
      present: true,
      note: rows.length === 0 ? "the directory exists but holds nothing yet" : null,
      verb: rows.length === 0 ? def.verb : null,
      ...base,
      entries: rows,
      truncated,
      document: null,
      text: null,
      parseError: null,
      bytes: null,
      modifiedAt: stat.modifiedAt,
      summary: null,
    };
  }
  const body = readBody(path, scrubberFor(ctx));
  return {
    present: true,
    note: body.parseError === null ? null : `this file did not parse: ${body.parseError}`,
    verb: null,
    ...base,
    entries: [],
    truncated: body.truncated,
    // identity.json is PROJECTED, never echoed: the file holds the private
    // key, and presence is all a console ever needs of it.
    document: store === "identity" ? identityProjection(body.document) : body.document,
    text: store === "identity" ? null : body.text,
    parseError: body.parseError,
    bytes: body.bytes,
    modifiedAt: stat.modifiedAt,
    summary: store === "settings" ? settingsSummary(body.document) : null,
  };
};

/** The `:store` param, validated against the allowlist. */
function requireStore(ctx: M3Context): InspectStore {
  const store = ctx.params["store"] ?? "";
  if (!isInspectStore(store)) {
    throw new HttpError(
      404,
      `no inspectable store "${store}" — the browsable set is ${INSPECT_STORES.join(", ")} (${INSPECT_STORE_NOTE})`,
    );
  }
  return store;
}

// ---------------------------------------------------------------------------
// GET /api/h/:id/inspect/:store/:name
// ---------------------------------------------------------------------------

/** `GET /api/h/:id/inspect/:store/:name` — one entry inside a directory
 *  store, containment-checked per file and capped. */
export const inspectEntry: M3Handler = (ctx) => {
  const store = requireStore(ctx);
  const def = STORE_DEFS[store];
  const name = ctx.params["name"] as string;
  const base = { store, name, kind: "file", path: relPath([...def.segments, name]) };
  if (def.kind === "file") {
    // A single-file store has no entries. That is a FACT about the store, not
    // a missing resource — answer it rather than 404, so the console can say
    // where the document actually is.
    return {
      present: false,
      note: `${store} is a single-file store — read it at ${relPath(def.segments)}`,
      verb: null,
      ...base,
      files: [],
      document: null,
      text: null,
      parseError: null,
      bytes: null,
      modifiedAt: null,
      truncated: false,
    };
  }
  let path: string;
  try {
    path = ctx.contain([...def.segments, name]);
  } catch {
    return {
      present: false,
      note: `"${name}" resolves outside the harness directory and is not readable from here`,
      verb: null,
      ...base,
      files: [],
      document: null,
      text: null,
      parseError: null,
      bytes: null,
      modifiedAt: null,
      truncated: false,
    };
  }
  const stat = statOr(path);
  if (stat === undefined) {
    return {
      present: false,
      note: `no "${name}" in ${relPath(def.segments)}`,
      verb: def.verb,
      ...base,
      files: [],
      document: null,
      text: null,
      parseError: null,
      bytes: null,
      modifiedAt: null,
      truncated: false,
    };
  }
  if (stat.isDir) {
    // Skills are a directory per skill. Show the file list plus the SKILL.md
    // body, which is the whole point of opening one; anything deeper is the
    // raw browser's job.
    const { rows, truncated } = listEntries(ctx, [...def.segments, name]);
    const skillFile = rows.find((r) => r.name === "SKILL.md" && r.kind === "file");
    let body: InspectFileBody | undefined;
    if (skillFile !== undefined) {
      try {
        body = readBody(ctx.contain([...def.segments, name, skillFile.name]), scrubberFor(ctx));
      } catch {
        body = undefined;
      }
    }
    return {
      present: true,
      note:
        skillFile === undefined
          ? "no SKILL.md here — open the individual files with the raw browser"
          : null,
      verb: null,
      ...base,
      kind: "dir",
      files: rows,
      document: null,
      text: body?.text ?? null,
      parseError: null,
      bytes: null,
      modifiedAt: stat.modifiedAt,
      truncated: truncated || body?.truncated === true,
    };
  }
  const body = readBody(path, scrubberFor(ctx));
  return {
    present: true,
    note: body.parseError === null ? null : `this file did not parse: ${body.parseError}`,
    verb: null,
    ...base,
    files: [],
    document: body.document,
    text: body.text,
    parseError: body.parseError,
    bytes: body.bytes,
    modifiedAt: stat.modifiedAt,
    truncated: body.truncated,
  };
};

// ---------------------------------------------------------------------------
// GET /api/h/:id/inspect/raw?path=
// ---------------------------------------------------------------------------

/** Split a `?path=` into segments, rejecting the shapes `ctx.contain` would
 *  reject anyway — earlier, and with a message about the path rather than
 *  about containment. */
export function rawPathSegments(raw: string): string[] {
  const segments = raw
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new HttpError(400, '"path" must not contain ".."');
  }
  if (segments.length > 12) throw new HttpError(400, '"path" is too deep');
  return segments;
}

/** Which modelled store owns this path, when one does. */
function modelledStoreFor(segments: readonly string[]): InspectStore | null {
  for (const store of INSPECT_STORES) {
    const own = STORE_DEFS[store].segments;
    if (own.length > segments.length) continue;
    if (own.every((seg, i) => seg === segments[i])) return store;
  }
  return null;
}

/**
 * `GET /api/h/:id/inspect/raw` — the generic raw browser.
 *
 * `?path=` is harness-relative and resolved through the same containment
 * check as every other read. Refuse `secrets/`, the raw audit files and
 * `.env*`. Directory paths list; file paths return capped, masked text.
 * READ-ONLY — this route has no write twin, deliberately.
 */
export const inspectRaw: M3Handler = (ctx) => {
  const requested = ctx.query.get("path") ?? ".crewhaus";
  const segments = rawPathSegments(requested);
  if (segments.length === 0) {
    throw new HttpError(400, '"path" must name something inside the harness');
  }
  // The allowlist is the security boundary, so the exclusions are enforced
  // here too — a new store becomes browsable by being added deliberately,
  // never by matching a glob.
  const excluded = exclusionFor(segments);
  if (excluded !== null) {
    throw new HttpError(
      403,
      `${relPath(segments)} is excluded from every inspect route: ${excluded.reason}. See ${excluded.where}.`,
    );
  }
  const shown = relPath(segments);
  const modelled = modelledStoreFor(segments);
  const modelledNote =
    modelled === null
      ? "no rich view models this path yet — this is the raw fallback, read-only"
      : `there is a rich view for this: the "${modelled}" store`;

  let path: string;
  try {
    path = ctx.contain(segments);
  } catch {
    return {
      present: false,
      note: `${shown} resolves outside the harness directory and is not readable from here`,
      verb: null,
      path: shown,
      kind: null,
      modelled,
      modelledNote,
      entries: [],
      document: null,
      text: null,
      parseError: null,
      bytes: null,
      modifiedAt: null,
      truncated: false,
    };
  }
  const stat = statOr(path);
  if (stat === undefined) {
    return {
      present: false,
      note: `nothing at ${shown}`,
      verb: null,
      path: shown,
      kind: null,
      modelled,
      modelledNote,
      entries: [],
      document: null,
      text: null,
      parseError: null,
      bytes: null,
      modifiedAt: null,
      truncated: false,
    };
  }
  if (stat.isDir) {
    const { rows, truncated } = listEntries(ctx, segments);
    // Excluded names are dropped from the listing AND named as excluded, so a
    // browser at `.crewhaus/` shows why `secrets/` is not there.
    const visible = rows.filter((r) => !isExcludedPath([...segments, r.name]));
    const hidden = rows.filter((r) => isExcludedPath([...segments, r.name])).map((r) => r.name);
    return {
      present: true,
      note: visible.length === 0 ? "this directory holds nothing readable from here" : null,
      verb: null,
      path: shown,
      kind: "dir",
      modelled,
      modelledNote,
      entries: visible,
      excludedHere: hidden,
      document: null,
      text: null,
      parseError: null,
      bytes: null,
      modifiedAt: stat.modifiedAt,
      truncated,
    };
  }
  const body = readBody(path, scrubberFor(ctx));
  return {
    present: true,
    note: body.parseError === null ? null : `this file did not parse: ${body.parseError}`,
    verb: null,
    path: shown,
    kind: "file",
    modelled,
    modelledNote,
    entries: [],
    document: body.document,
    text: body.text,
    parseError: body.parseError,
    bytes: body.bytes,
    modifiedAt: stat.modifiedAt,
    truncated: body.truncated,
  };
};

// ---------------------------------------------------------------------------
// PUT /api/h/:id/inspect/settings — the one write on this surface
// ---------------------------------------------------------------------------

/** One structural complaint about a proposed `settings.json`. */
export type SettingsIssue = {
  readonly path: string;
  readonly message: string;
};

const HOOK_EVENT_HINT =
  "each hooks[] entry needs a non-empty string `event` and a non-empty string `command`";

/**
 * Structural validation of a proposed settings document.
 *
 * Mirrors what the loaders require rather than importing them: the hooks
 * engine THROWS on a malformed `hooks` array (a bad edit does not degrade, it
 * breaks every hook), and the permission engine reads `permissions.{allow,
 * deny,ask}` as string lists. Anything else passes through untouched — this
 * file is human-owned and a manager that rejected keys it had not heard of
 * would be the thing that breaks a newer CLI.
 */
export function validateSettings(value: unknown): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [{ path: "", message: "settings must be a JSON object" }];
  }
  const doc = value as Record<string, unknown>;
  const permissions = doc["permissions"];
  if (permissions !== undefined) {
    if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
      issues.push({ path: "permissions", message: "`permissions` must be an object" });
    } else {
      for (const key of ["allow", "deny", "ask"]) {
        const list = (permissions as Record<string, unknown>)[key];
        if (list === undefined) continue;
        if (!Array.isArray(list) || list.some((r) => typeof r !== "string")) {
          issues.push({
            path: `permissions.${key}`,
            message: `\`permissions.${key}\` must be an array of rule strings`,
          });
        }
      }
    }
  }
  const hooks = doc["hooks"];
  if (hooks !== undefined) {
    if (!Array.isArray(hooks)) {
      issues.push({ path: "hooks", message: "`hooks` must be an array" });
    } else {
      hooks.forEach((entry, index) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          issues.push({ path: `hooks[${index}]`, message: HOOK_EVENT_HINT });
          return;
        }
        const hook = entry as Record<string, unknown>;
        if (typeof hook["event"] !== "string" || hook["event"] === "") {
          issues.push({ path: `hooks[${index}].event`, message: HOOK_EVENT_HINT });
        }
        if (typeof hook["command"] !== "string" || hook["command"] === "") {
          issues.push({ path: `hooks[${index}].command`, message: HOOK_EVENT_HINT });
        }
      });
    }
  }
  return issues;
}

/** A line-level diff of two documents, credential-masked. Small on purpose:
 *  a settings file is tens of lines, and the interstitial only has to show
 *  what moved. */
export function settingsDiff(before: string, after: string): string[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const out: string[] = [];
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i += 1) {
    const a = beforeLines[i];
    const b = afterLines[i];
    if (a === b) continue;
    if (a !== undefined) out.push(`- ${maskRawText(a)}`);
    if (b !== undefined) out.push(`+ ${maskRawText(b)}`);
  }
  return out;
}

/** Serialize the document exactly as it will be written. */
function serializeSettings(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * `PUT /api/h/:id/inspect/settings` — edit `.crewhaus/settings.json`.
 *
 * Permission rules and hooks — the files `tools audit` / `permissions
 * suggest` write. This is HUMAN-OWNED configuration, so it carries the same
 * trust-tier gate the spec's human-owned paths do: a redacted diff
 * interstitial plus a typed confirmation. Write atomically (tmp + rename)
 * and re-validate before replacing; a malformed settings.json changes what
 * the agent is allowed to do.
 *
 * `{ dryRun: true }` returns the interstitial — issues plus the masked diff —
 * and writes nothing. Nothing is auto-tuned here and nothing is merged: the
 * body is the whole next document, so what an operator confirmed is exactly
 * what lands.
 */
export const settingsWrite: M3Handler = (ctx) => {
  const next = ctx.body["settings"];
  if (next === undefined) throw new HttpError(400, 'missing "settings" (the whole next document)');
  const issues = validateSettings(next);

  const def = STORE_DEFS.settings;
  const path = ctx.contain(def.segments);
  const existed = existsSync(path);
  const before = existed ? readTextCapped(path, MAX_INSPECT_BYTES) : { text: "", truncated: false };
  const after = serializeSettings(next);
  const diff = settingsDiff(before.text, after);

  if (ctx.body["dryRun"] === true) {
    return {
      applied: false,
      dryRun: true,
      path: relPath(def.segments),
      existed,
      issues,
      diff,
      confirmName: ctx.entry?.specName ?? null,
      note:
        issues.length > 0
          ? "fix these before confirming — a malformed settings.json changes what the agent is allowed to do"
          : "confirm by re-sending with the harness's spec name in `confirmName`",
    };
  }

  if (issues.length > 0) {
    throw new HttpError(
      400,
      `settings.json would be malformed: ${issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  // Human-owned configuration: the SERVER verifies the typed confirmation.
  requireTypedConfirm(ctx.body, ctx.entry?.specName ?? "");
  if (before.truncated) {
    throw new HttpError(
      409,
      "the existing settings.json is larger than this server reads — refusing to replace a file it could not show you in full",
    );
  }

  // Re-validate the exact BYTES that are about to land, not the object we
  // were handed: a value that does not survive JSON.stringify (a NaN, an
  // undefined) would otherwise be discovered by the agent, at boot.
  let roundTripped: unknown;
  try {
    roundTripped = JSON.parse(after);
  } catch (err) {
    throw new HttpError(
      400,
      `settings did not serialize to valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const roundTripIssues = validateSettings(roundTripped);
  if (roundTripIssues.length > 0) {
    throw new HttpError(
      400,
      `settings.json would be malformed after serialization: ${roundTripIssues
        .map((i) => `${i.path || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  // Atomic: write beside the target, then rename. A crash mid-write leaves
  // the old file intact rather than a half-written permission set.
  const tmp = `${path}.hangar-tmp`;
  try {
    writeFileSync(tmp, after, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The temp file is already gone, or the directory is unwritable — the
      // thrown error below is the operator's signal either way.
    }
    throw new HttpError(
      500,
      `could not write ${relPath(def.segments)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    applied: true,
    dryRun: false,
    path: relPath(def.segments),
    existed,
    issues: [],
    diff,
    bytes: Buffer.byteLength(after, "utf8"),
    at: new Date(ctx.now()).toISOString(),
    by: ctx.operator,
    note: null,
  };
};
