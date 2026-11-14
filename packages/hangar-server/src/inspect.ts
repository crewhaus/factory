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
 *   - `run/gateway-jwt-secret` — a managed daemon's generated signing secret.
 *     A bare value carries no key for a masker to read, so it is refused whole.
 *   - the rest of Home's run credentials and decision records under `run/`:
 *     the control and MCP tokens, the decision log's keys and inputs, who may
 *     approve, and link requests;
 *   - every path an area module declares (`rawExclusions` in control-contract).
 * Those exclusions are enforced HERE, in the store allowlist and in the
 * generic raw browser, not in the UI — matched CASE-FOLDED, because the
 * default filesystem on darwin and Windows resolves `.crewhaus/AUDIT` to the
 * real directory, and matched again on the path a request RESOLVES to, so a
 * link inside the harness to an excluded file is refused and hidden exactly
 * like the file. See {@link exclusionFor}.
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
 *   - EVERY read — parsed or prose — goes through the harness's own env
 *     SCRUBBER, the same one the run console reads history through, so a
 *     credential this manager holds the value of becomes its NAME whatever it
 *     looks like. It sat on the prose branch alone once, which made the two
 *     branches disagree about the same credential;
 *   - and then through {@link maskRawText}: KEY-AWARE line masking (the key
 *     read off the line, so text gets the redaction a tree gets), value-shape
 *     masking, plus a PEM private-key block redactor, because a key block
 *     carries no key-ish context word and the generic shape masker walks
 *     straight past it.
 *
 * `identity.json` never rides any of those paths verbatim: it is projected to
 * the fingerprint plus PRESENCE booleans for the key material, so the private
 * key cannot leave this process even if a masker regresses.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { AREA_MODULES } from "@crewhaus/control-contract";
import { MAX_TEXT_BYTES } from "./constants";
import { HttpError } from "./http";
import { readTextCapped } from "./jsonl";
import { replacePrivateKeyBlocks } from "./linear-mask";
import type { M3Context, M3Handler } from "./m3";
import { requirePermission, requireTypedConfirm } from "./m3";
import { type TextScrubber, maskDeep, maskKeyedText } from "./mask";
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
  "secrets, raw audit files, .env files, raw run output, and Home's run credentials and decision records never appear in any inspect route";

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
    what: "the scope-audit baseline and dated drift snapshots `crewhaus doctor --philosophy-alignment` writes",
    verb: "crewhaus doctor --philosophy-alignment --json",
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
    verb: "crewhaus faq distill",
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
    verb: "crewhaus lessons update",
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
    verb: "crewhaus run crewhaus.yaml",
  },
  meta: {
    kind: "file",
    segments: [".crewhaus", "meta.json"],
    what: "store schema versions and migration stamps",
    verb: "crewhaus migrate memories",
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
  {
    path: ".crewhaus/run/gateway-jwt-secret",
    reason:
      "a managed daemon's generated signing secret — a bare value, with no key for a masker to read",
    where: "the file itself, on the daemon's machine, or set CREWHAUS_GATEWAY_JWT_SECRET",
  },
  {
    path: ".crewhaus/sessions/approvals.d/keys/",
    reason:
      "the key the decision log's digests are made with — a bare value, and with it a digest of a tool input or a user name could be tested by guessing",
    where: "nowhere: it never leaves the session root",
  },
  {
    path: ".crewhaus/run/control-token",
    reason: "the daemon's control token — a bare value, with no key for a masker to read",
    where: "Runs → the control panel, which uses it without showing it",
  },
  {
    path: ".crewhaus/run/mcp-token",
    reason: "the token a channel bundle's MCP door takes — a bare value",
    where: "the file itself, on the daemon's machine",
  },
  {
    path: ".crewhaus/run/control/keys/",
    reason:
      "the key Home's command and decision digests are made with — with it a digest could be tested by guessing",
    where: "nowhere: it never leaves the harness",
  },
  {
    path: ".crewhaus/run/control/inputs/",
    reason:
      "the inputs decisions were asked about, kept whole for the decision they wait on, and a queued run's input, kept whole until the process that runs it reads it",
    where: "Approvals → each request, shown to whoever may decide it",
  },
  {
    path: ".crewhaus/run/control/approvers.json",
    reason: "who may approve on this harness, by person",
    where: "Access → members and roles",
  },
  {
    path: ".crewhaus/run/control/link-requests.jsonl",
    reason: "requests to link an outside identity to a person",
    where: "Access → links",
  },
];

/** The row for a path in {@link INSPECT_EXCLUSIONS}, looked up by its path, never by position. */
function exclusionAt(path: string): InspectExclusion {
  const row = INSPECT_EXCLUSIONS.find((r) => r.path === path);
  if (row === undefined) throw new Error(`hangar-server: no inspect exclusion for ${path}`);
  return row;
}

/** The rows matched by name anywhere in a path rather than by where it sits. */
const SECRETS_ROW = exclusionAt(".crewhaus/secrets/");
const ENV_ROW = exclusionAt(".env, .env.*");
const DECISION_KEYS_ROW = exclusionAt(".crewhaus/sessions/approvals.d/keys/");

/** A harness-relative path as lower-cased segments, its trailing slash dropped. */
function segmentsOfPath(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segment.toLowerCase());
}

/**
 * The exclusions area modules declare (`AreaModule.rawExclusions`), composed by the one
 * enforcer: each path, and everything below it, is never served.
 *
 * First consumer: {@link exclusionFor}, over every module control-contract composes.
 */
export function moduleExclusions(
  modules: ReadonlyArray<{ readonly area: string; readonly rawExclusions?: readonly string[] }>,
): InspectExclusion[] {
  return modules.flatMap((module) =>
    (module.rawExclusions ?? []).map((path) => ({
      path,
      reason: `a record the ${module.area} area keeps that holds a secret, content or a person's identifier`,
      where: `the ${module.area} screens, which show it to whoever may read it`,
    })),
  );
}

/** Every exclusion matched by place: the fixed rows, then every module's. */
const PLACED: readonly InspectExclusion[] = [
  ...INSPECT_EXCLUSIONS.filter(
    (row) => row !== SECRETS_ROW && row !== ENV_ROW && row !== DECISION_KEYS_ROW,
  ),
  ...moduleExclusions(AREA_MODULES),
];

/**
 * Which exclusion a harness-relative path trips, or null when it trips none.
 *
 * Deliberately broader than the literal paths above: ANY segment named
 * `secrets` is refused, wherever it sits, and any name that starts `.env`.
 * Over-refusing a browser is recoverable; under-refusing it is not.
 *
 * The decision log's key directory is refused wherever its session root
 * sits (`approvals.d/keys` at any depth), because `CREWHAUS_SESSION_DIR` can
 * move the session root anywhere inside the harness.
 *
 * Every other row is matched by place: the path itself and everything below it. A row
 * under `.crewhaus/` matches under EVERY `.crewhaus` segment in the path, so a harness
 * nested inside this one (`apps/sub/.crewhaus/run/control-token`) has its run, audit and
 * key files refused exactly like this harness's own.
 *
 * CASE-FOLDED, EVERY ONE. The default filesystem on darwin (APFS) and on
 * Windows (NTFS) is case-INSENSITIVE, so the OS resolves `.crewhaus/AUDIT`
 * and `.crewhaus/Run/Logs` to the real directories, and `resolveContained`
 * answers with the caller's casing rather than the realpath — so every row is
 * compared lower-cased, and the resolved path is compared again
 * ({@link resolvedExclusion}).
 *
 * `extra` adds exclusions to the composed ones (a test plants a module's here).
 */
export function exclusionFor(
  segments: readonly string[],
  extra: readonly InspectExclusion[] = [],
): InspectExclusion | null {
  const lower = segments.map((s) => s.toLowerCase());
  for (const [i, segment] of lower.entries()) {
    if (segment === "secrets") return SECRETS_ROW;
    if (segment === ".env" || segment.startsWith(".env.")) return ENV_ROW;
    if (segment === "approvals.d" && lower[i + 1] === "keys") return DECISION_KEYS_ROW;
  }
  const roots = lower.flatMap((segment, i) => (segment === ".crewhaus" ? [i] : []));
  for (const row of [...PLACED, ...extra]) {
    const prefix = segmentsOfPath(row.path);
    if (prefix.length === 0) continue;
    const starts = prefix[0] === ".crewhaus" ? roots : [0];
    for (const at of starts) {
      if (prefix.length > lower.length - at) continue;
      if (prefix.every((segment, i) => segment === lower[at + i])) return row;
    }
  }
  return null;
}

/**
 * The exclusion the path a request RESOLVES to trips: `resolved` (already contained)
 * taken through every link to its real place, made harness-relative with `relative()`,
 * and checked like a requested path. A link inside the harness to an excluded file trips
 * that file's row. Null when it trips none, or when nothing is there.
 *
 * First consumers: every inspect read and listing.
 */
export function resolvedExclusion(
  harnessDir: string,
  resolved: string,
  extra: readonly InspectExclusion[] = [],
): InspectExclusion | null {
  const segments = realSegments(harnessDir, resolved);
  return segments === undefined ? null : exclusionFor(segments, extra);
}

/**
 * The place `resolved` really is, through every link, as segments relative to the
 * harness's real directory; undefined when nothing is there, or it is the harness itself
 * or outside it.
 */
function realSegments(harnessDir: string, resolved: string): string[] | undefined {
  let real: string;
  let root: string;
  try {
    real = realpathSync(resolved);
    root = realpathSync(harnessDir);
  } catch {
    return undefined;
  }
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return sep === "/" ? rel.split("/") : rel.split(/[\\/]/);
}

/**
 * Whether a harness-relative path names a harness's identity file: `.crewhaus/identity.json`
 * at any depth, case-folded, so a nested harness's counts too.
 *
 * First consumer: {@link identityAnswer}.
 */
export function isIdentityPath(segments: readonly string[]): boolean {
  const n = segments.length;
  return (
    n >= 2 &&
    (segments[n - 1] as string).toLowerCase() === "identity.json" &&
    (segments[n - 2] as string).toLowerCase() === ".crewhaus"
  );
}

/** True when a harness-relative path is one of the exclusions. */
export function isExcludedPath(segments: readonly string[]): boolean {
  return exclusionFor(segments) !== null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Mask one raw document served as TEXT.
 *
 * KEY-AWARE, not merely shape-aware. `maskKeyedText` reads the key off the
 * LINE, so a document that never became a tree still gets the key-based
 * redaction `maskDeep` gives a parsed one — which is what makes the raw
 * browser and the spec view agree about `signingSecret: <inline literal>`
 * instead of one redacting it and the other serving it verbatim. Then the PEM
 * redactor, because a private-key block carries no key-ish context word and
 * the generic shape masker walks straight past it.
 */
export function maskRawText(text: string): string {
  return replacePrivateKeyBlocks(maskKeyedText(text), "[redacted private key block]");
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
function scrubberFor(ctx: M3Context): TextScrubber {
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
 * prose falls through to `maskRawText`.
 *
 * `scrub` RIDES BOTH BRANCHES. It was on the text fallback alone once, which
 * made the two branches disagree about the same credential: an opaque value
 * this manager holds was replaced by its NAME in a `.md` and served verbatim
 * out of a `.json` beside it, because no shape rule can see an opaque value
 * under an innocent key. A parsed document is not a safer document.
 *
 * Never throws: an unreadable file reads empty.
 */
function readBody(path: string, scrub: TextScrubber): InspectFileBody {
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
        rows.push(maskDeep(JSON.parse(line), scrub));
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
      document: maskDeep(JSON.parse(text), scrub),
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
): { rows: InspectEntryRow[]; truncated: boolean; hidden: string[] } {
  let names: string[];
  try {
    const dir = ctx.contain(base);
    names = readdirSync(dir).sort();
  } catch {
    return { rows: [], truncated: false, hidden: [] };
  }
  const rows: InspectEntryRow[] = [];
  const hidden: string[] = [];
  const truncated = names.length > MAX_INSPECT_ENTRIES;
  for (const name of names.slice(0, MAX_INSPECT_ENTRIES)) {
    // An excluded name, or one that resolves to an excluded file, is not listed at all.
    if (exclusionFor([...base, name]) !== null) {
      hidden.push(name);
      continue;
    }
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
    if (ctx.harnessDir !== null && resolvedExclusion(ctx.harnessDir, resolved) !== null) {
      hidden.push(name);
      continue;
    }
    // A name inside another registered harness is that harness's to show.
    if (nestedHarnessOf(ctx, resolved) !== undefined) {
      hidden.push(name);
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
  return { rows, truncated, hidden };
}

/**
 * Refuse a path that is excluded as asked for, or whose resolved place is: 403, naming the
 * reason and where the data IS available, and never the file's content. A path whose real
 * place is inside another harness registered with this Home is refused too: it names that
 * harness only to a caller who may read it.
 */
function refuseExcluded(ctx: M3Context, segments: readonly string[], resolved?: string): void {
  const excluded =
    exclusionFor(segments) ??
    (resolved !== undefined && ctx.harnessDir !== null
      ? resolvedExclusion(ctx.harnessDir, resolved)
      : null);
  if (excluded !== null) {
    throw new HttpError(
      403,
      `${relPath(segments)} is excluded from every inspect route: ${excluded.reason}. See ${excluded.where}.`,
    );
  }
  const nested = resolved === undefined ? undefined : nestedHarnessOf(ctx, resolved);
  if (nested === undefined) return;
  throw new HttpError(
    403,
    nested.visible
      ? `${relPath(segments)} belongs to harness ${nested.id}, which is registered with this Home on its own — open it in that harness's inspector.`
      : `${relPath(segments)} belongs to another harness registered with this Home, and is not served here.`,
  );
}

/** The registered harness inside this one that really holds `resolved`, if any. */
function nestedHarnessOf(
  ctx: M3Context,
  resolved: string,
): { readonly id: string; readonly visible: boolean } | undefined {
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    return undefined;
  }
  return ctx.nestedHarnessAt(real);
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

/**
 * The note for a store whose path RESOLVES OUTSIDE the harness.
 *
 * "Nothing there yet" and "there is something there and this server refuses to
 * follow it" are different facts, and only one of them is an empty state. A
 * store symlinked out of the tree read as ABSENT — so the console offered the
 * CLI verb that CREATES it, over a file that already exists somewhere else.
 * `inspectRaw` already says the true thing; the modelled readers say it in the
 * same words.
 */
const escapedNote = (segments: readonly string[]): string =>
  `${relPath(segments)} resolves outside the harness directory and is not readable from here`;

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
        verb: path === undefined ? null : def.verb,
        note:
          path === undefined
            ? escapedNote(def.segments)
            : `nothing at ${relPath(def.segments)} yet`,
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

/** What a read of the identity file says beside its projection. */
const IDENTITY_NOTE =
  "this is a harness identity file: shown as its fingerprint and whether each key is present, as in the identity store";

/**
 * The answer for a read whose requested path, or the place it really is, is a harness's
 * identity file: its projection, never its text and never a parser's message (either could
 * carry key bytes). The file is read and parsed here, not through `readBody`. A file that
 * does not parse projects to nothing. Undefined when the read is not of an identity file.
 *
 * First consumers: the raw read, a store entry's read and a skill's `SKILL.md`.
 */
function identityAnswer(
  ctx: M3Context,
  segments: readonly string[],
  resolved: string,
): InspectFileBody | undefined {
  const real = ctx.harnessDir === null ? undefined : realSegments(ctx.harnessDir, resolved);
  if (!isIdentityPath(segments) && (real === undefined || !isIdentityPath(real))) {
    return undefined;
  }
  const { text, truncated } = readTextCapped(resolved, MAX_INSPECT_BYTES);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return {
    document: identityProjection(parsed),
    text: null,
    parseError: null,
    bytes: Buffer.byteLength(text, "utf8"),
    truncated,
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
  if (path !== undefined) refuseExcluded(ctx, def.segments, path);
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
      note:
        path === undefined
          ? escapedNote(def.segments)
          : `nothing at ${relPath(def.segments)} yet — ${def.what}`,
      // A refused path is not a store waiting to be created, so it must not
      // advertise the verb that would create one.
      verb: path === undefined ? null : def.verb,
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
  // Another single-file store that leads to an identity file answers its projection too.
  const identity = store === "identity" ? undefined : identityAnswer(ctx, def.segments, path);
  if (identity !== undefined) {
    return {
      present: true,
      note: IDENTITY_NOTE,
      verb: null,
      ...base,
      entries: [],
      truncated: identity.truncated,
      document: identity.document,
      text: null,
      parseError: null,
      bytes: identity.bytes,
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
  refuseExcluded(ctx, [...def.segments, name]);
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
  refuseExcluded(ctx, [...def.segments, name], path);
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
        const skillPath = ctx.contain([...def.segments, name, skillFile.name]);
        refuseExcluded(ctx, [...def.segments, name, skillFile.name], skillPath);
        body =
          identityAnswer(ctx, [...def.segments, name, skillFile.name], skillPath) ??
          readBody(skillPath, scrubberFor(ctx));
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
  const identity = identityAnswer(ctx, [...def.segments, name], path);
  const body = identity ?? readBody(path, scrubberFor(ctx));
  return {
    present: true,
    note:
      identity !== undefined
        ? IDENTITY_NOTE
        : body.parseError === null
          ? null
          : `this file did not parse: ${body.parseError}`,
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
 * check as every other read. Refuse every {@link INSPECT_EXCLUSIONS} row, and every path
 * whose real place is inside another registered harness. Directory paths list; file paths
 * return capped, masked text, except an identity file, which answers its projection.
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
  // The place it resolves to is checked too: a link to an excluded file is that file.
  refuseExcluded(ctx, segments, path);
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
    const { rows: visible, truncated, hidden } = listEntries(ctx, segments);
    // Excluded names, and names that resolve to an excluded file, are dropped from the
    // listing AND named as excluded, so a browser at `.crewhaus/` shows why `secrets/` is
    // not there.
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
  const identity = identityAnswer(ctx, segments, path);
  const body = identity ?? readBody(path, scrubberFor(ctx));
  return {
    present: true,
    note:
      identity !== undefined
        ? IDENTITY_NOTE
        : body.parseError === null
          ? null
          : `this file did not parse: ${body.parseError}`,
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
 * The settings keys that decide what the agent may do, what runs, and which environment
 * files (with the credentials in them) the harness is started with.
 */
const SECURITY_SETTINGS_PATHS: ReadonlyArray<readonly string[]> = [
  ["permissions"],
  ["hooks"],
  ["manager", "hooks"],
  ["manager", "envFiles"],
];

/** Which of {@link SECURITY_SETTINGS_PATHS} differ between two settings documents. */
export function securityKeysChanged(beforeText: string, afterText: string): string[] {
  const parse = (text: string): unknown => {
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text);
    } catch {
      // A document that cannot be read compares as different everywhere.
      return undefined;
    }
  };
  const at = (doc: unknown, path: readonly string[]): unknown => {
    let node = doc;
    for (const key of path) {
      if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
      node = (node as Record<string, unknown>)[key];
    }
    return node;
  };
  const before = parse(beforeText);
  const after = parse(afterText);
  return SECURITY_SETTINGS_PATHS.filter(
    (path) =>
      before === undefined || JSON.stringify(at(before, path)) !== JSON.stringify(at(after, path)),
  ).map((path) => path.join("."));
}

/** Two segment lists name the same place, case-folded. */
const sameSegments = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  a !== undefined &&
  a.length === b.length &&
  a.every((part, i) => part.toLowerCase() === (b[i] as string).toLowerCase());

/**
 * The settings write reads and replaces only this harness's own `.crewhaus/settings.json`:
 * a path an exclusion or another registered harness holds is refused (403), and a link, or
 * a file whose real place is anywhere else, is neither shown nor replaced (409).
 */
function refuseSettingsPlace(ctx: M3Context, segments: readonly string[], path: string): void {
  refuseExcluded(ctx, segments, path);
  const harnessDir = ctx.harnessDir;
  const refuse: () => never = () => {
    throw new HttpError(
      409,
      `${relPath(segments)} is not this harness's own settings file here (it is a link, or it sits somewhere else), so it is neither shown nor replaced — edit it in the harness's own directory`,
    );
  };
  if (harnessDir === null) refuse();
  let link = false;
  try {
    link = lstatSync(path).isSymbolicLink();
  } catch {
    // Nothing is there: the folder that would hold it is checked below.
  }
  if (link) refuse();
  if (existsSync(path)) {
    if (!sameSegments(realSegments(harnessDir, path), segments)) refuse();
    return;
  }
  const parent = dirname(path);
  if (
    existsSync(parent) &&
    !sameSegments(realSegments(harnessDir, parent), segments.slice(0, -1))
  ) {
    refuse();
  }
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
  refuseSettingsPlace(ctx, def.segments, path);
  const existed = existsSync(path);
  const before = existed ? readTextCapped(path, MAX_INSPECT_BYTES) : { text: "", truncated: false };
  const after = serializeSettings(next);
  const diff = settingsDiff(before.text, after);
  // Permission rules, hooks and the environment files decide what the agent may do, what
  // runs and with which credentials: changing any is the security edit permission's,
  // previewed or not.
  const touched = securityKeysChanged(before.text, after);
  if (touched.length > 0) {
    requirePermission(ctx, "h.spec.edit.security", {
      paths: touched,
      message:
        "Only an owner of this harness can change its permission rules, hooks or environment files: they decide what the agent may do, what runs and with which credentials.",
    });
  }

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
    by: ctx.principal,
    note: null,
  };
};
