/**
 * M3 · SPEC — the spec's write side: the structured editor, trust tiers,
 * version history + pins + diffs, and the `propose` review path.
 *
 * The one rule this module exists to enforce: **a spec is never written by
 * string-templating YAML.** Everything goes through `@crewhaus/spec-patch`
 * `applySpecEdits(yaml, edits, …)`, which is atomic, comment-preserving and
 * re-validating. Two tiers, enforced HERE and not merely in the UI:
 *
 *   auto-tunable — paths inside `OPTIMIZABLE_PATHS` that are NOT also a
 *     `SECURITY_SURFACES` prefix. Apply with `{ restrictToOptimizable:
 *     true }`; the same restriction the optimizer runs under, so the console
 *     can never write what the machine may not. The exclusion is the other
 *     half of that sentence: a surface the optimizer may tune against an
 *     eval is still human-owned when one operator clicks Save.
 *   human-owned — everything else (permissions, the model roster/candidates,
 *     watchme.*, plugins, expose, learning.sources, thredz,
 *     sandbox/tool_config, transaction_policy). These require the
 *     credential-redacted `diffSpecYaml` interstitial plus a typed
 *     confirmation, or — when the harness is git-tracked — they route to
 *     `crewhaus propose` and become a review PR instead of a write.
 *
 * Everything served from here passes the maskers: `diffSpecYaml` output and
 * CHANGELOG bodies quote spec text verbatim, so a pasted credential reaches
 * a diff even when the live spec has been cleaned. `maskSpecYaml` for YAML,
 * `maskText` for prose, `maskDeep` for trees.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF "NO", AND THE STATUS EACH GETS
 * ---------------------------------------------------------------------------
 * A refusal about the REQUEST is an HTTP error: a malformed edit list, a
 * path that is not a path, a human-owned batch with no typed confirmation
 * (409, carrying the redacted preview the interstitial renders).
 *
 * A refusal about the WORLD is a 200 with `{ ok: false, code, reason }` —
 * the same typed-envelope posture the control.v1 proxy already uses. "This
 * spec does not validate, so no edit can be applied", "that version is not
 * in the registry", "the batch changes nothing" are FACTS the editor has to
 * render next to the field the operator is looking at; turning them into
 * error toasts would throw away the only thing the screen is for. Every
 * such envelope names the code, the reason, and the verb that fixes it.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEMA IS LOADED PER HARNESS
 * ---------------------------------------------------------------------------
 * A machine's harnesses span crewhaus versions; that is the normal case.
 * `loadSpecModule` resolves `@crewhaus/spec` from the HARNESS's own
 * `node_modules` (and only when that copy realpath-contains inside the
 * harness), falling back to the manager's bundled copy with a badge that
 * says so. Pinning one schema across a mixed fleet is the defect this
 * avoids — it makes a harness one version ahead look broken. Resolution
 * never installs anything: opening a tab must not dirty a git-clean dir.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readSpecHeader } from "@crewhaus/harness-inventory";
import { parseSpec, parseSpecIssues, specJsonSchema } from "@crewhaus/spec";
import {
  OPTIMIZABLE_PATHS,
  REDACTED_VALUE,
  type SpecDiffEntry,
  type SpecEdit,
  WILDCARD_SEGMENT,
  applySpecEdits,
  diffSpecYaml,
  isCredentialKey,
  isOptimizable,
  specHasPath,
} from "@crewhaus/spec-patch";
import { MAX_TEXT_BYTES, SAFE_SEGMENT_RE } from "./constants";
import { HttpError } from "./http";
import { readTextCapped } from "./jsonl";
import { type M3Context, type M3Handler, jobArg, requireTypedConfirm } from "./m3";
import { maskSpecYaml, maskText } from "./mask";
import { resolveContained } from "./safety";

/** The spec file every harness is anchored on. */
const SPEC_FILE = "crewhaus.yaml";

/** Where the per-spec version registry + CHANGELOG live inside a harness. */
const STATE_DIR = ".crewhaus";
const SPECS_SUBDIR = "specs";

/** Caps: a trust table or an effective-config table is a SCREEN, not a
 *  dump. Both stop long before a pathological spec makes the browser paint
 *  ten thousand rows. */
const MAX_TRUST_ROWS = 600;
const MAX_EFFECTIVE_ROWS = 600;
const MAX_VERSIONS = 100;

// ---------------------------------------------------------------------------
// typed answers
// ---------------------------------------------------------------------------

/** A refusal that is a fact about the harness, not about the request. */
function refusal(
  code: string,
  reason: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ok: false, code, reason, ...extra };
}

/** The three fields every M3 read carries: is there anything to show, why
 *  not when there is not, and the verb that would create it. */
function base(present: boolean, note: string | null, verb: string | null): Record<string, unknown> {
  return { present, note, verb };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// the spec file
// ---------------------------------------------------------------------------

export type SpecFileRead = {
  /** Absolute, contained path — safe to read and to write back through. */
  readonly path: string;
  readonly present: boolean;
  /** Raw text, UNMASKED — masked only on the way out. */
  readonly text: string;
  /** True when the file is past `MAX_TEXT_BYTES` and `text` is only its
   *  HEAD. A view may render a prefix; a write may never round-trip one —
   *  see {@link requireWholeSpec}. */
  readonly truncated: boolean;
  readonly specName: string;
  readonly target: string;
  readonly hash: string;
};

/** sha256 of the exact bytes — the editor's rebase token. */
function hashOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** Read the harness's spec through the dispatcher's containment closure.
 *  Absence is not an error: `present: false` with empty text. */
export function readSpecFile(ctx: M3Context): SpecFileRead {
  const path = ctx.contain([SPEC_FILE]);
  const present = existsSync(path);
  const read = present ? readTextCapped(path, MAX_TEXT_BYTES) : { text: "", truncated: false };
  const header = read.text === "" ? {} : readSpecHeader(read.text);
  return {
    path,
    present,
    text: read.text,
    truncated: read.truncated,
    specName: header.name ?? ctx.entry?.specName ?? "spec",
    target: header.target ?? "unknown",
    hash: hashOf(read.text),
  };
}

/**
 * The refusal a CAPPED read owes every write path.
 *
 * `readSpecFile` reads through `readTextCapped`, so a spec past the cap
 * comes back as a PREFIX of itself. A prefix is a VIEW: rendering one is
 * honest, writing one back is not. `writeSpecFile` renames over the
 * original, so everything past the cap would be deleted — silently, because
 * the surviving head of an over-cap spec usually still parses (the cut lands
 * inside a long block scalar), and because the answer's own diff and `hash`
 * are computed from the damaged text, which re-anchors the editor's rebase
 * token to the damage. Refuse instead, with the verb that can do the job.
 *
 * The same refusal `watchme-ops`' `liveSpec` and the settings writer in
 * `inspect.ts` already make; this is the write path that had missed it.
 */
export function requireWholeSpec(file: SpecFileRead): void {
  if (!file.truncated) return;
  throw new HttpError(
    409,
    `${SPEC_FILE} is larger than this server reads (${MAX_TEXT_BYTES} bytes) — refusing to write back a spec it could not read whole. Edit it with the CLI, then \`crewhaus compile ${SPEC_FILE} -o dist\`.`,
  );
}

/** The mode a spec gets when this manager CREATES the file. It is never
 *  applied to one that already exists — see {@link writeSpecFile}. */
const NEW_SPEC_MODE = 0o644;

/**
 * Write the spec back atomically (temp file in the SAME directory, then
 * rename) so a crashed write can never truncate a harness's spec.
 *
 * The rename replaces the INODE, which means the temp file's mode BECOMES
 * the spec's mode. Writing a hardcoded one would silently chmod a file the
 * operator owns — a deliberately narrowed `crewhaus.yaml` would come back
 * world-readable after any edit made from the console. So the existing mode
 * is carried across the rename, and the default applies only when there is
 * no file to carry one from. Exported because a spec file must be replaced
 * the same way wherever it is replaced.
 */
export function writeSpecFile(path: string, text: string): void {
  let mode = NEW_SPEC_MODE;
  try {
    mode = statSync(path).mode & 0o7777;
  } catch {
    // Nothing there to preserve — the default is the only answer there is.
  }
  const tmp = `${path}.hangar-tmp`;
  writeFileSync(tmp, text, { mode });
  // `writeFileSync`'s mode is masked by the process umask at CREATE time, so
  // it is a request rather than a guarantee; the chmod is what makes the
  // preserved mode exact.
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// per-harness spec module (the mixed-version fleet)
// ---------------------------------------------------------------------------

export type SpecIssueRow = {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
  readonly code?: string;
};

export type SpecModule = {
  readonly parseSpec: (yamlText: string) => unknown;
  readonly parseSpecIssues: (yamlText: string) => ReadonlyArray<SpecIssueRow>;
  readonly specJsonSchema: () => Record<string, unknown>;
  /** Which copy answered: the harness's own, or the manager's bundled one. */
  readonly source: "harness" | "manager";
  /** The resolved copy's version, when its package.json could be read. */
  readonly version: string | null;
  /** Set when the harness copy was tried and could not be used. */
  readonly note: string | null;
};

const MANAGER_MODULE: SpecModule = {
  parseSpec,
  parseSpecIssues,
  specJsonSchema,
  source: "manager",
  version: null,
  note: null,
};

/** Memoized per harness dir: resolving + importing on every keystroke would
 *  make the editor feel like a compiler. A reinstall inside a running
 *  manager keeps the version the badge already showed until restart. */
const specModuleCache = new Map<string, SpecModule>();

function harnessPackageVersion(harnessDir: string): string | null {
  const pkg = resolveContained(
    harnessDir,
    join("node_modules", "@crewhaus", "spec", "package.json"),
  );
  if (pkg === undefined || !existsSync(pkg)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the schema this harness is actually built against.
 *
 * Two guards, both mandatory. The resolved entry point must realpath-contain
 * inside the harness (a hoisted copy elsewhere on the machine is somebody
 * else's code, not this harness's), and every failure degrades to the
 * manager's own copy with a note rather than throwing — a spec tab that 500s
 * because a harness has no `node_modules` would be worse than a badge.
 */
export async function loadSpecModule(harnessDir: string): Promise<SpecModule> {
  const cached = specModuleCache.get(harnessDir);
  if (cached !== undefined) return cached;
  let resolved: SpecModule = MANAGER_MODULE;
  try {
    const entry = Bun.resolveSync("@crewhaus/spec", harnessDir);
    if (resolveContained(harnessDir, entry) === undefined) {
      resolved = {
        ...MANAGER_MODULE,
        note: "this harness resolves @crewhaus/spec outside its own directory — validated with the manager's copy instead",
      };
    } else {
      const mod = (await import(entry)) as Partial<SpecModule>;
      if (
        typeof mod.parseSpec === "function" &&
        typeof mod.parseSpecIssues === "function" &&
        typeof mod.specJsonSchema === "function"
      ) {
        resolved = {
          parseSpec: mod.parseSpec,
          parseSpecIssues: mod.parseSpecIssues,
          specJsonSchema: mod.specJsonSchema,
          source: "harness",
          version: harnessPackageVersion(harnessDir),
          note: null,
        };
      } else {
        resolved = {
          ...MANAGER_MODULE,
          note: "this harness's @crewhaus/spec exports no schema surface this manager understands — validated with the manager's copy",
        };
      }
    }
  } catch {
    resolved = {
      ...MANAGER_MODULE,
      note: "this harness has no installed @crewhaus/spec — validated with the manager's copy",
    };
  }
  specModuleCache.set(harnessDir, resolved);
  return resolved;
}

/** Diagnostics, as the plain rows the editor anchors to a field. */
function issuesOf(mod: SpecModule, yamlText: string): Array<Record<string, unknown>> {
  if (yamlText === "") return [];
  try {
    return mod.parseSpecIssues(yamlText).map((issue) => ({
      path: issue.path.map((p) => String(p)),
      message: maskText(issue.message),
      code: issue.code ?? null,
    }));
  } catch (err) {
    return [{ path: [], message: maskText(errText(err)), code: "parser_failed" }];
  }
}

// ---------------------------------------------------------------------------
// trust tiers
// ---------------------------------------------------------------------------

export type SpecTrustTier = "auto-tunable" | "human-owned";

export type SpecTrustRow = {
  readonly path: string;
  readonly segments: readonly string[];
  readonly tier: SpecTrustTier;
  /** True for the surfaces that additionally demand the interstitial. */
  readonly securitySurface: boolean;
  readonly reason: string;
};

/**
 * The human-owned SECURITY surfaces: fields whose blast radius is a
 * permission, a spend, a credential path or a trust boundary rather than an
 * answer's quality. Editing one is legitimate — it just never happens by
 * accident, so these are the paths that demand the redacted diff plus a
 * typed confirmation (or `crewhaus propose`).
 *
 * Everything outside both this table and `OPTIMIZABLE_PATHS` is still
 * human-owned; it simply needs the confirmation without the interstitial.
 */
export const SECURITY_SURFACES: ReadonlyArray<{
  /** Segments matched from the ROOT of the path (`anywhere` widens this). */
  readonly prefix: readonly string[];
  readonly reason: string;
  /**
   * 0.6.0 — match the segments as a contiguous run ANYWHERE in the path
   * (with `"*"` = any one segment), so one row covers a block that hangs
   * off several hosts: `model_pool.rules` on `agent`, `steps[i]`, `nodes.x`,
   * `roles.r` and every `sub_agents.<n>` alike.
   */
  readonly anywhere?: true;
}> = [
  {
    prefix: ["permissions"],
    reason:
      "permissions decide what the agent may do — a widened rule is a security change, not a quality one",
  },
  {
    prefix: ["agent", "model"],
    reason:
      "the model roster is never auto-patched: a swap moves cost, latency and behaviour at once",
  },
  {
    prefix: ["agent", "model_pool"],
    reason: "the candidate pool decides which models may serve traffic",
  },
  {
    prefix: ["agent", "model_fallbacks"],
    reason: "the failover chain decides which provider answers when the first one is down",
  },
  {
    prefix: ["agent", "model_tiers"],
    reason: "tier routing decides which model a turn is spent on",
  },
  {
    prefix: ["watchme"],
    reason:
      "watch-me is a consent + data-plane posture; the observer is never tuned by the loop it observes",
  },
  { prefix: ["plugins"], reason: "plugins load third-party code into the agent at boot" },
  {
    prefix: ["expose"],
    reason: "expose publishes this bundle as an MCP server other clients can call",
  },
  {
    prefix: ["learning", "sources"],
    reason: "learning sources decide what text is ingested into the agent's knowledge",
  },
  { prefix: ["thredz"], reason: "thredz crosses the harness boundary to a hosted wiki" },
  {
    prefix: ["sandbox"],
    reason: "the sandbox is the isolation boundary code execution runs inside",
  },
  { prefix: ["tool_config"], reason: "tool config decides what the agent's tools may reach" },
  {
    prefix: ["transaction_policy"],
    reason: "the transaction policy gates on-chain writes and approvals",
  },
  {
    prefix: ["mcp_servers"],
    reason:
      "an MCP server is third-party code plus its credentials — write it through the connectors tab",
  },
  { prefix: ["hooks"], reason: "hooks run commands on the machine at lifecycle points" },
  { prefix: ["security"], reason: "the security block is the harness's own defence configuration" },
  { prefix: ["wallets"], reason: "wallets hold funds" },
  { prefix: ["chains"], reason: "chain bindings decide which network is written to" },
  { prefix: ["contracts"], reason: "contract bindings decide which addresses are called" },
  // ---- 0.6.0 (design §8.3, §10.3) — the hybrid-model surfaces. The
  // optimizer may tune a handful of DIALS inside these blocks (a profile's
  // `max_tokens`, `rules[*].enabled`, `strategy.shadow.sample_rate`, …), but a
  // console write to any of them takes the typed confirmation: the same block
  // carries the roster, the rule targets, the judge identity and the floor.
  {
    prefix: ["models"],
    reason:
      "a model profile declares identity, tools, permissions and spend for every slot that references it — the roster is never edited by accident",
  },
  {
    prefix: ["model_pool", "rules"],
    anywhere: true,
    reason: "routing rules decide which turns leave the cheap lane and which arm serves them",
  },
  {
    prefix: ["model_pool", "strategy"],
    anywhere: true,
    reason:
      "the hybrid strategy names the draft, escalation, guide, shadow and committee arms and registers the Escalate / Consult tools",
  },
  {
    prefix: ["model_pool", "reward"],
    anywhere: true,
    reason:
      "the reward block bounds what the learned policy may exploit (quality source, priors, the floor) — never tuned by the loop it bounds",
  },
  {
    prefix: ["sub_agents", WILDCARD_SEGMENT, "allowed_profiles"],
    anywhere: true,
    reason:
      "the profile allowlist is what a model-filled Task profile argument is validated against — a roster decision for the child",
  },
];

/** `prefix` matches the path from segment `start` (`"*"` = any one segment). */
function matchesFrom(prefix: readonly string[], path: readonly string[], start: number): boolean {
  if (path.length < start + prefix.length) return false;
  return prefix.every((seg, i) => seg === WILDCARD_SEGMENT || path[start + i] === seg);
}

function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return matchesFrom(prefix, path, 0);
}

/** A security-surface row matches a path root-anchored, or anywhere when the row says so. */
function surfaceMatches(
  surface: (typeof SECURITY_SURFACES)[number],
  path: readonly string[],
): boolean {
  if (surface.anywhere !== true) return isPrefix(surface.prefix, path);
  for (let start = 0; start + surface.prefix.length <= path.length; start++) {
    if (matchesFrom(surface.prefix, path, start)) return true;
  }
  return false;
}

function optimizableFor(target: string): ReadonlyArray<readonly string[]> {
  const table = OPTIMIZABLE_PATHS as Readonly<Record<string, ReadonlyArray<readonly string[]>>>;
  return table[target] ?? [];
}

/** Auto-tunable ⇔ `applySpecEdits(…, { restrictToOptimizable: true })` would
 *  accept it. Delegates to spec-patch's own `isOptimizable` — the ONE matcher
 *  the optimizer runs under (exact match, the wildcard segment, the
 *  structural `model_pool` / `judge` / `sub_agents` / `temperature` rule,
 *  then prefix) — so the badge and the server's refusal can never disagree.
 *  A hand-rolled prefix copy here once said "auto-tunable" for
 *  `steps[0].model_pool.candidates`, which the write then rejected. */
export function isAutoTunable(target: string, path: readonly string[]): boolean {
  if (!(target in OPTIMIZABLE_PATHS)) return false;
  return isOptimizable(target as keyof typeof OPTIMIZABLE_PATHS, path);
}

/**
 * Classify one path for the badge AND for the write gate.
 *
 * `SECURITY_SURFACES` is consulted BEFORE `OPTIMIZABLE_PATHS`, and the order
 * is the whole point: a security surface stays human-owned even when the
 * optimizer may tune it. The two tables answer different questions. The
 * optimizer writes `transaction_policy`, `chains`, `security.justification`
 * and the `agent.model_pool` policy knobs only as the outcome of an eval
 * that scored the change; the console writes them because one operator
 * clicked once. Testing `isAutoTunable` first made those `SECURITY_SURFACES`
 * rows unreachable for exactly the paths they were written to gate — the
 * on-chain value ceiling could be raised, and pre-broadcast simulation
 * switched off, with no interstitial and no typed confirmation at all.
 */
export function classifyPath(target: string, segments: readonly string[]): SpecTrustRow {
  const path = segments.join(".");
  const surface = SECURITY_SURFACES.find((s) => surfaceMatches(s, segments));
  if (surface !== undefined) {
    return {
      path,
      segments,
      tier: "human-owned",
      securitySurface: true,
      reason: isAutoTunable(target, segments)
        ? `${surface.reason} — the optimizer may tune it against an eval, but a console write takes the typed confirmation`
        : surface.reason,
    };
  }
  if (isAutoTunable(target, segments)) {
    return {
      path,
      segments,
      tier: "auto-tunable",
      securitySurface: false,
      reason: "listed in OPTIMIZABLE_PATHS — the optimizer may write it, so the console may too",
    };
  }
  const holdsTunable =
    segments.length > 0 && optimizableFor(target).some((entry) => isPrefix(segments, entry));
  return {
    path,
    segments,
    tier: "human-owned",
    securitySurface: false,
    reason: holdsTunable
      ? "this block is human-owned; individual fields inside it are auto-tunable"
      : "not listed in OPTIMIZABLE_PATHS — an author owns this field",
  };
}

// ---------------------------------------------------------------------------
// the lenient path scan
// ---------------------------------------------------------------------------

const KEY_LINE_RE = /^(\s*)([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/;
const BLOCK_SCALAR_RE = /^[|>][-+0-9]*\s*(?:#.*)?$/;

/**
 * Every map path a spec's TEXT declares, dotted, in document order.
 *
 * Deliberately a text scan and not a parse: the trust table has to render
 * for a spec one schema version ahead of this manager, and for one that does
 * not validate at all — which is exactly when an operator needs the editor.
 *
 * Two things it does NOT do, both on purpose. Block scalars (`instructions:
 * |`) are skipped wholesale, so prose that reads `Note: something` never
 * becomes a fake path; and sequence ITEMS are represented by their container
 * path rather than by index, because the console addresses list fields whole.
 */
export function declaredPaths(yamlText: string): string[][] {
  const out: string[][] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  let blockIndent: number | null = null;
  let seqIndent: number | null = null;
  for (const rawLine of yamlText.split("\n")) {
    if (out.length >= MAX_TRUST_ROWS) break;
    const line = rawLine.replace(/\t/g, "  ");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (indent > blockIndent) continue;
      blockIndent = null;
    }
    if (seqIndent !== null) {
      if (indent > seqIndent) continue;
      seqIndent = null;
    }
    if (line.trimStart().startsWith("- ") || line.trim() === "-") {
      // A sequence item and everything under it: the container already has a
      // row, and an index is not a field this editor can address.
      seqIndent = indent;
      continue;
    }
    const m = line.match(KEY_LINE_RE);
    if (m === null) continue;
    const key = m[2] as string;
    const value = (m[3] ?? "").trim();
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) {
      stack.pop();
    }
    stack.push({ indent, key });
    out.push(stack.map((s) => s.key));
    if (BLOCK_SCALAR_RE.test(value)) blockIndent = indent;
  }
  return out;
}

// ---------------------------------------------------------------------------
// effective config — declared vs defaulted
// ---------------------------------------------------------------------------

export type EffectiveRow = {
  readonly path: string;
  readonly value: unknown;
  /** `declared` when the TEXT carries the key; `default` when only the
   *  schema does — the whole point of the viewer. */
  readonly source: "declared" | "default";
};

/**
 * The parsed spec with its zod defaults materialized, each row marked
 * declared or defaulted via `specHasPath`.
 *
 * Echoing raw YAML is the thing this replaces: a spec that never mentions a
 * default-ON block still RUNS it, and an operator reading the file cannot
 * see that. A row whose source is `default` is the answer to "what is this
 * harness actually doing".
 *
 * Credential-carrying paths render `[redacted]`: the value here sits under
 * the key `value`, so the tree masker's key-based layer cannot see it — the
 * redaction has to happen at the point the row is built.
 */
export function effectiveConfig(spec: unknown, yamlText: string): EffectiveRow[] {
  const rows: EffectiveRow[] = [];
  const walk = (node: unknown, segments: string[]): void => {
    if (rows.length >= MAX_EFFECTIVE_ROWS) return;
    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) walk(child, [...segments, key]);
      return;
    }
    if (segments.length === 0) return;
    const redacted = segments.some((seg) => isCredentialKey(seg));
    rows.push({
      path: segments.join("."),
      value: redacted ? REDACTED_VALUE : node,
      source: specHasPath(yamlText, segments) ? "declared" : "default",
    });
  };
  walk(spec, []);
  return rows;
}

// ---------------------------------------------------------------------------
// diffs
// ---------------------------------------------------------------------------

/** Render a structural diff as the text a human reads. `diffSpecYaml` has
 *  already redacted credential values; `maskText` is the second layer for a
 *  token pasted into a field whose name says nothing. */
export function renderDiff(entries: ReadonlyArray<SpecDiffEntry>): string {
  return entries
    .map((entry) => {
      switch (entry.kind) {
        case "added":
          return `+ ${entry.path}: ${entry.after ?? ""}`;
        case "removed":
          return `- ${entry.path}: ${entry.before ?? ""}`;
        case "changed":
          return `~ ${entry.path}: ${entry.before ?? ""} → ${entry.after ?? ""}`;
      }
    })
    .map((line) => maskText(line))
    .join("\n");
}

function diffEntries(before: string, after: string): ReadonlyArray<SpecDiffEntry> {
  if (before === after) return [];
  return diffSpecYaml(before, after);
}

// ---------------------------------------------------------------------------
// edit parsing
// ---------------------------------------------------------------------------

/** One edit as the client sends it: a dotted string or a segment array, plus
 *  a value (absent ⇒ delete the path). */
function parseEdit(raw: unknown, label: string): SpecEdit {
  if (!isPlainObject(raw)) throw new HttpError(400, `${label} must be an object`);
  const rawPath = raw["path"];
  let segments: Array<string | number>;
  if (typeof rawPath === "string") {
    segments = rawPath.split(".").filter((s) => s !== "");
  } else if (Array.isArray(rawPath)) {
    segments = rawPath.map((seg) => {
      if (typeof seg === "string" && seg !== "") return seg;
      if (typeof seg === "number" && Number.isInteger(seg) && seg >= 0) return seg;
      throw new HttpError(400, `${label}: every path segment must be a key or a list index`);
    });
  } else {
    throw new HttpError(400, `${label} needs a "path" (dotted string or segment array)`);
  }
  if (segments.length === 0) throw new HttpError(400, `${label}: "path" is empty`);
  const edit: { path: Array<string | number>; value?: unknown; rationale?: string } = {
    path: segments,
  };
  if ("value" in raw) edit.value = raw["value"];
  const rationale = raw["rationale"];
  if (typeof rationale === "string" && rationale !== "") edit.rationale = rationale;
  return edit as SpecEdit;
}

function parseEdits(body: Readonly<Record<string, unknown>>): SpecEdit[] {
  const raw = body["edits"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, '"edits" must be an array');
  return raw.map((edit, i) => parseEdit(edit, `edit #${i}`));
}

/** Segment array as plain strings — a list index reads as its own segment. */
function segmentsOf(edit: SpecEdit): string[] {
  return edit.path.map((seg) => String(seg));
}

type Split = { readonly auto: SpecTrustRow[]; readonly human: SpecTrustRow[] };

function splitByTier(target: string, edits: readonly SpecEdit[]): Split {
  const auto: SpecTrustRow[] = [];
  const human: SpecTrustRow[] = [];
  for (const edit of edits) {
    const row = classifyPath(target, segmentsOf(edit));
    (row.tier === "auto-tunable" ? auto : human).push(row);
  }
  return { auto, human };
}

// ---------------------------------------------------------------------------
// the write path shared by specEdit / specPatch
// ---------------------------------------------------------------------------

/** Diff a batch WITHOUT writing it. Never throws: a preview that cannot be
 *  produced is itself the thing the interstitial has to say. Shared with the
 *  builders, whose connector writes are spec edits like any other. */
export function previewSpecEdits(
  before: string,
  edits: readonly SpecEdit[],
): { ok: boolean; entries: ReadonlyArray<SpecDiffEntry>; diff: string; error: string | null } {
  if (edits.length === 0) return { ok: true, entries: [], diff: "", error: null };
  try {
    const after = applySpecEdits(before, edits);
    const entries = diffEntries(before, after.yaml);
    return { ok: true, entries, diff: renderDiff(entries), error: null };
  } catch (err) {
    return { ok: false, entries: [], diff: "", error: maskText(errText(err)) };
  }
}

/**
 * Apply a batch. The trust split happens BEFORE the write:
 *
 *   - all-auto-tunable → applied under `restrictToOptimizable`, the same
 *     restriction the optimizer runs under;
 *   - any human-owned path with no typed confirmation → 409 carrying the
 *     redacted preview the interstitial renders, and the name of the route
 *     that turns the same batch into a review PR;
 *   - human-owned WITH the confirmation → applied unrestricted, because the
 *     operator has now said the sentence the machine may not say for them.
 */
async function applyBatch(
  ctx: M3Context,
  edits: readonly SpecEdit[],
  gated = true,
): Promise<Record<string, unknown>> {
  const file = readSpecFile(ctx);
  const mod = await loadSpecModule(ctx.harnessDir as string);
  if (!file.present) {
    return refusal("no_spec", `this harness has no ${SPEC_FILE} to edit`, {
      verb: "crewhaus init",
    });
  }
  // Before ANY of the rest: the read this batch would be applied to, and
  // written back from, has to be the whole document.
  requireWholeSpec(file);
  const expected = ctx.body["expectedHash"];
  if (typeof expected === "string" && expected !== "" && expected !== file.hash) {
    throw new HttpError(
      409,
      "the spec changed on disk since this editor loaded it — re-read it and re-apply",
    );
  }
  const { auto, human } = splitByTier(file.target, edits);
  const confirmed = ctx.body["confirmName"] !== undefined;
  if (gated && human.length > 0 && !confirmed) {
    // The interstitial's data: what would change, and why it is gated.
    const preview = previewSpecEdits(file.text, edits);
    throw new HttpError(
      409,
      `${human.length} of these ${edits.length} edits touch human-owned paths (${human
        .map((row) => row.path)
        .join(
          ", ",
        )}) — send "confirmName": "${file.specName}" to apply them here, or POST the same batch to /spec/propose for review. Preview: ${
        preview.diff === "" ? "no structural change" : preview.diff
      }`,
    );
  }
  if (gated && human.length > 0) requireTypedConfirm(ctx.body, file.specName);

  if (edits.length === 0) {
    // A zero-edit batch is the no-op the editor uses to re-read and rebase.
    // `applySpecEdits` would re-validate the file and throw on a spec that
    // does not parse, which is not an answer to "apply nothing".
    return {
      ok: true,
      applied: 0,
      hash: file.hash,
      specName: file.specName,
      target: file.target,
      tiers: { autoTunable: auto, humanOwned: human },
      entries: [],
      diff: "",
      issues: issuesOf(mod, file.text),
      schemaSource: mod.source,
      note: "nothing to apply — the spec is unchanged",
    };
  }

  let applied: { yaml: string; applied: number };
  try {
    applied = applySpecEdits(
      file.text,
      edits,
      human.length === 0 ? { restrictToOptimizable: true } : {},
    );
  } catch (err) {
    // The batch produced text the schema rejects — often because the spec was
    // already invalid. A fact about the file, rendered beside the field.
    return refusal("edit_rejected", maskText(errText(err)), {
      specName: file.specName,
      target: file.target,
      tiers: { autoTunable: auto, humanOwned: human },
      issues: issuesOf(mod, file.text),
      hash: file.hash,
      verb: "crewhaus compile crewhaus.yaml -o dist",
    });
  }
  const entries = diffEntries(file.text, applied.yaml);
  writeSpecFile(file.path, applied.yaml);
  return {
    ok: true,
    applied: applied.applied,
    hash: hashOf(applied.yaml),
    specName: file.specName,
    target: file.target,
    tiers: { autoTunable: auto, humanOwned: human },
    entries,
    diff: renderDiff(entries),
    issues: issuesOf(mod, applied.yaml),
    yaml: maskSpecYaml(applied.yaml),
    schemaSource: mod.source,
    note: "the new version is registered on the next `crewhaus compile` — the manager never writes the version registry behind the compiler's back",
  };
}

/**
 * Apply + write a batch whose gate the CALLER has already run.
 *
 * The builders' connector writes are ordinary spec edits on a human-owned
 * block, and they run their own dry-run-then-typed-confirm ladder before
 * calling this. Sharing the write means there is exactly one place in the
 * manager where a spec file is replaced.
 */
export async function commitSpecEdits(
  ctx: M3Context,
  edits: readonly SpecEdit[],
): Promise<Record<string, unknown>> {
  return await applyBatch(ctx, edits, false);
}

// ---------------------------------------------------------------------------
// version registry (`.crewhaus/specs/<name>/`)
// ---------------------------------------------------------------------------

/**
 * A spec's display name mapped onto the registry's stricter directory
 * grammar — the same deterministic transform the compiler's
 * auto-registration uses, so the manager looks in the directory the CLI
 * actually wrote ("My Agent" → `My-Agent`).
 */
export function registryDirName(specName: string): string {
  const cleaned = specName.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^\.+/, "");
  const name = cleaned.length > 0 ? cleaned : "spec";
  return SAFE_SEGMENT_RE.test(name) ? name : "spec";
}

type Manifest = {
  readonly versions: readonly string[];
  readonly pins: Readonly<Record<string, string>>;
};

function readManifest(ctx: M3Context, dirName: string): Manifest | null {
  const path = ctx.contain([STATE_DIR, SPECS_SUBDIR, dirName, "manifest.json"]);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readTextCapped(path, MAX_TEXT_BYTES).text) as {
      versions?: unknown;
      pins?: unknown;
    };
    const versions = Array.isArray(parsed.versions)
      ? parsed.versions.filter((v): v is string => typeof v === "string" && SAFE_SEGMENT_RE.test(v))
      : [];
    const pins: Record<string, string> = {};
    if (isPlainObject(parsed.pins)) {
      for (const [env, version] of Object.entries(parsed.pins)) {
        if (typeof version === "string") pins[env] = version;
      }
    }
    return { versions: versions.slice(0, MAX_VERSIONS), pins };
  } catch {
    return null;
  }
}

/** One archived version's YAML, contained per file. */
function readVersionYaml(ctx: M3Context, dirName: string, version: string): string | null {
  if (!SAFE_SEGMENT_RE.test(version)) return null;
  const path = ctx.contain([STATE_DIR, SPECS_SUBDIR, dirName, `${version}.yaml`]);
  if (!existsSync(path)) return null;
  return readTextCapped(path, MAX_TEXT_BYTES).text;
}

/** Optimizer provenance from a version's write-back header comment: the
 *  `runId`/`mutator`/score fields the optimizer stamps above the document. */
export function provenanceOf(yamlText: string): Record<string, unknown> | null {
  const header = /^#\s*crewhaus:optimize\s+(.*)$/m.test(yamlText)
    ? (yamlText.match(/^#\s*crewhaus:optimize\s+(.*)$/m)?.[1] ?? "")
    : null;
  if (header === null) return null;
  const fields: Record<string, unknown> = {};
  for (const m of header.matchAll(/([A-Za-z][A-Za-z0-9_]*)=("[^"]*"|\S+)/g)) {
    const key = m[1] as string;
    const raw = (m[2] ?? "").replace(/^"|"$/g, "");
    const num = Number(raw);
    fields[key] = raw !== "" && !Number.isNaN(num) ? num : raw;
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

/** Per-tenant pin overlays (`_tenants/<id>/<name>.json`). */
function readTenantOverlays(ctx: M3Context, dirName: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const root = ctx.contain([STATE_DIR, SPECS_SUBDIR, "_tenants"]);
  if (!existsSync(root)) return out;
  let tenants: string[];
  try {
    tenants = readdirSync(root).sort();
  } catch {
    return out;
  }
  for (const tenant of tenants) {
    if (!SAFE_SEGMENT_RE.test(tenant)) continue;
    // Per FILE: a listed tenant dir entry can be a symlink out of the tree.
    const file = ctx.contain([STATE_DIR, SPECS_SUBDIR, "_tenants", tenant, `${dirName}.json`]);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readTextCapped(file, MAX_TEXT_BYTES).text) as unknown;
      out.push({ tenant, pins: isPlainObject(parsed) ? parsed : {}, unreadable: false });
    } catch {
      out.push({ tenant, pins: {}, unreadable: true });
    }
  }
  return out;
}

function changelogText(ctx: M3Context, dirName: string): string | null {
  const path = ctx.contain([STATE_DIR, SPECS_SUBDIR, dirName, "CHANGELOG.md"]);
  if (!existsSync(path)) return null;
  // A changelog quotes spec values verbatim — mask it like any other prose.
  return maskText(readTextCapped(path, MAX_TEXT_BYTES).text);
}

const VERSIONS_VERB = "crewhaus spec put <name> <version> crewhaus.yaml";

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

/**
 * `PUT /api/h/:id/spec` — apply a BATCH of spec edits.
 *
 * Body: `{ edits: SpecEdit[], expectedHash?, confirmName? }`. Answers the
 * re-validated diagnostics and the new content hash so the editor rebases.
 */
export const specEdit: M3Handler = async (ctx) => await applyBatch(ctx, parseEdits(ctx.body));

/**
 * `POST /api/h/:id/spec/patch` — apply ONE `SpecPatch`.
 *
 * The single-edit twin of {@link specEdit} (the form editor's per-field
 * save). Same restriction, same refusal, same re-validation.
 */
export const specPatch: M3Handler = async (ctx) => {
  const raw = ctx.body["edit"] ?? ctx.body["patch"];
  if (raw === undefined) throw new HttpError(400, 'missing "edit"');
  return await applyBatch(ctx, [parseEdit(raw, '"edit"')]);
};

/**
 * `POST /api/h/:id/spec/diff` — PREVIEW a batch without writing it.
 *
 * The interstitial's data source: `diffSpecYaml(before, after)`, masked. A
 * preview must never touch the file — this is the one write-shaped route
 * that is a pure function of its inputs.
 */
export const specDiff: M3Handler = async (ctx) => {
  const edits = parseEdits(ctx.body);
  const file = readSpecFile(ctx);
  const mod = await loadSpecModule(ctx.harnessDir as string);
  const { auto, human } = splitByTier(file.target, edits);
  const preview = previewSpecEdits(file.text, edits);
  return {
    ok: preview.ok,
    ...(preview.ok ? {} : { code: "edit_rejected", reason: preview.error }),
    specName: file.specName,
    target: file.target,
    hash: file.hash,
    /** A preview of a spec read past the cap is a preview of its HEAD; the
     *  write path refuses that batch, so the flag says why in advance. */
    truncated: file.truncated,
    entries: preview.entries,
    diff: preview.diff,
    tiers: { autoTunable: auto, humanOwned: human },
    /** True when this batch may be applied straight from the editor. */
    autoApplicable: human.length === 0 && !file.truncated,
    confirmName: human.length > 0 ? file.specName : null,
    proposeRoute: human.length > 0 ? "specPropose" : null,
    issues: issuesOf(mod, file.text),
  };
};

/**
 * Narrow a whole-union JSON Schema down to one target's shape.
 *
 * Serving the target's definition ALONE would break it: its internal
 * `$ref`s are document-absolute (`#/definitions/cli/properties/name`), so
 * lifting the definition out of the document leaves every one of them
 * dangling. The narrowed document therefore keeps the `definitions`
 * namespace and points at the target with a root `$ref`, carrying along any
 * sibling definition the target actually references.
 */
export function narrowSchema(
  whole: Record<string, unknown>,
  target: string,
): { schema: Record<string, unknown>; narrowed: boolean } {
  const definitions = whole["definitions"];
  if (!isPlainObject(definitions) || !isPlainObject(definitions[target])) {
    return { schema: whole, narrowed: false };
  }
  const kept: Record<string, unknown> = {};
  const queue: string[] = [target];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (name in kept) continue;
    const definition = definitions[name];
    if (!isPlainObject(definition)) continue;
    kept[name] = definition;
    for (const m of JSON.stringify(definition).matchAll(/#\/definitions\/([A-Za-z0-9_-]+)/g)) {
      const referenced = m[1] as string;
      if (!(referenced in kept)) queue.push(referenced);
    }
  }
  return { schema: { $ref: `#/definitions/${target}`, definitions: kept }, narrowed: true };
}

/**
 * `GET /api/h/:id/spec/schema` — the schema the structured editor renders,
 * plus the effective configuration.
 *
 * The schema is loaded from the HARNESS's own `@crewhaus/spec` when it has
 * one, so a mixed-version fleet renders each harness against the schema it
 * was built with; `schemaSource` says which copy answered. `effective` is
 * the parsed spec with zod defaults materialized, each row marked declared
 * or defaulted — echoing raw YAML would hide every default-ON block.
 */
export const specSchema: M3Handler = async (ctx) => {
  const file = readSpecFile(ctx);
  const mod = await loadSpecModule(ctx.harnessDir as string);
  if (!file.present) {
    return {
      ...base(false, `no ${SPEC_FILE} in this harness`, "crewhaus init"),
      specName: file.specName,
      target: null,
      schema: null,
      schemaSource: mod.source,
      schemaVersion: mod.version,
      effective: [],
      effectiveNote: null,
      declaredCount: 0,
      defaultedCount: 0,
      issues: [],
      warnings: [],
      warningsVerb: "crewhaus compile crewhaus.yaml -o dist",
      hash: file.hash,
      truncated: false,
    };
  }
  let schema: Record<string, unknown> | null = null;
  let schemaNote: string | null = mod.note;
  try {
    const narrowed = narrowSchema(mod.specJsonSchema(), file.target);
    schema = narrowed.schema;
    if (!narrowed.narrowed) {
      schemaNote =
        schemaNote ??
        `this schema has no definition for target "${file.target}" — showing the whole spec union`;
    }
  } catch (err) {
    schemaNote = maskText(errText(err));
  }

  let effective: EffectiveRow[] = [];
  let effectiveNote: string | null = null;
  try {
    effective = effectiveConfig(mod.parseSpec(file.text), file.text);
  } catch (err) {
    effectiveNote = `defaults cannot be materialized until the spec validates: ${maskText(
      errText(err),
    )}`;
  }
  const declaredCount = effective.filter((row) => row.source === "declared").length;
  return {
    ...base(true, schemaNote, "crewhaus init"),
    specName: file.specName,
    target: file.target,
    schema,
    schemaSource: mod.source,
    schemaVersion: mod.version,
    effective,
    effectiveNote,
    declaredCount,
    defaultedCount: effective.length - declaredCount,
    issues: issuesOf(mod, file.text),
    /** Compile warnings (accepted-but-unwired keys) come from the compiler,
     *  which this server does not run: naming the verb is the honest answer
     *  until the manager can read a compile report. */
    warnings: [],
    warningsVerb: "crewhaus compile crewhaus.yaml -o dist",
    hash: file.hash,
    /** This VIEW may show the head of an over-cap spec; the write path
     *  refuses it. The flag is what stops the two reading as the same file. */
    truncated: file.truncated,
  };
};

/**
 * `GET /api/h/:id/spec/trust` — the trust-tier map for this spec.
 *
 * Every path the spec TEXT declares, marked auto-tunable (in
 * `OPTIMIZABLE_PATHS`) or human-owned, with the reason. The editor badges
 * fields from this; the server enforces the same table on write, so the two
 * can never disagree.
 */
export const specTrust: M3Handler = (ctx) => {
  const file = readSpecFile(ctx);
  if (!file.present) {
    return {
      ...base(false, `no ${SPEC_FILE} in this harness`, "crewhaus init"),
      specName: file.specName,
      target: null,
      paths: [],
      autoTunableCount: 0,
      humanOwnedCount: 0,
      securitySurfaceCount: 0,
      confirmName: file.specName,
      truncated: false,
    };
  }
  const paths = declaredPaths(file.text).map((segments) => classifyPath(file.target, segments));
  const auto = paths.filter((row) => row.tier === "auto-tunable").length;
  return {
    ...base(
      paths.length > 0,
      paths.length === 0 ? "this spec declares no editable fields" : null,
      "crewhaus init",
    ),
    specName: file.specName,
    target: file.target,
    paths,
    autoTunableCount: auto,
    humanOwnedCount: paths.length - auto,
    securitySurfaceCount: paths.filter((row) => row.securitySurface).length,
    confirmName: file.specName,
    /** True ⇒ these are the paths of the spec's HEAD only, and no edit from
     *  this table will be applied. */
    truncated: file.truncated,
  };
};

/**
 * `GET /api/h/:id/spec/versions` — the version history.
 *
 * Source: `.crewhaus/specs/<name>/manifest.json` (versions, env pins,
 * `_tenants/` overlays) plus the rendered CHANGELOG. Optimizer-authored
 * versions carry their write-back provenance (score before → after) as a
 * badge. Diffs are credential-redacted.
 */
export const specVersions: M3Handler = (ctx) => {
  const file = readSpecFile(ctx);
  const dirName = registryDirName(file.specName);
  const manifest = readManifest(ctx, dirName);
  const changelog = changelogText(ctx, dirName);
  const versions = (manifest?.versions ?? []).map((version) => {
    const yamlText = readVersionYaml(ctx, dirName, version);
    const pinnedEnvs = Object.entries(manifest?.pins ?? {})
      .filter(([, pinned]) => pinned === version)
      .map(([env]) => env)
      .sort();
    return {
      version,
      present: yamlText !== null,
      bytes: yamlText === null ? 0 : yamlText.length,
      pinnedEnvs,
      isCurrent: yamlText !== null && yamlText === file.text,
      provenance: yamlText === null ? null : provenanceOf(yamlText),
    };
  });
  const present = manifest !== null || changelog !== null;
  return {
    ...base(
      present,
      present
        ? null
        : "this harness has no spec version registry yet — compiling registers the first version",
      VERSIONS_VERB,
    ),
    specName: file.specName,
    registryName: dirName,
    dir: `${STATE_DIR}/${SPECS_SUBDIR}/${dirName}`,
    versions,
    pins: manifest?.pins ?? {},
    tenants: readTenantOverlays(ctx, dirName),
    changelog,
    current: { hash: file.hash, bytes: file.text.length, present: file.present },
    confirmName: file.specName,
  };
};

/**
 * `GET /api/h/:id/spec/versions/:version` — one archived version's YAML.
 *
 * Masked with `maskSpecYaml`, never the raw file: an old version is exactly
 * where a credential that has since been cleaned out still lives.
 */
export const specVersion: M3Handler = (ctx) => {
  const file = readSpecFile(ctx);
  const version = ctx.params["version"] as string;
  const dirName = registryDirName(file.specName);
  const yamlText = readVersionYaml(ctx, dirName, version);
  if (yamlText === null) {
    return {
      ...base(
        false,
        `no version "${version}" under ${STATE_DIR}/${SPECS_SUBDIR}/${dirName}`,
        VERSIONS_VERB,
      ),
      version,
      specName: file.specName,
      yaml: null,
      bytes: 0,
      provenance: null,
      isCurrent: false,
    };
  }
  return {
    ...base(true, null, VERSIONS_VERB),
    version,
    specName: file.specName,
    yaml: maskSpecYaml(yamlText),
    bytes: yamlText.length,
    provenance: provenanceOf(yamlText),
    isCurrent: yamlText === file.text,
  };
};

/**
 * `GET /api/h/:id/spec/versions/:version/diff` — that version vs the live
 * spec (or vs `?against=<version>`), through `diffSpecYaml`, masked.
 */
export const specVersionDiff: M3Handler = (ctx) => {
  const file = readSpecFile(ctx);
  const version = ctx.params["version"] as string;
  const dirName = registryDirName(file.specName);
  const left = readVersionYaml(ctx, dirName, version);
  const againstParam = ctx.query.get("against");
  const against = againstParam !== null && againstParam !== "" ? againstParam : "live";
  const right = against === "live" ? file.text : readVersionYaml(ctx, dirName, against);
  if (left === null || right === null || (against === "live" && !file.present)) {
    const missing = left === null ? version : against;
    return {
      ...base(false, `no version "${missing}" to diff against`, VERSIONS_VERB),
      version,
      against,
      entries: [],
      diff: "",
    };
  }
  let entries: ReadonlyArray<SpecDiffEntry> = [];
  let note: string | null = null;
  try {
    entries = diffEntries(left, right);
  } catch (err) {
    note = maskText(errText(err));
  }
  return {
    ...base(
      true,
      note ?? (entries.length === 0 ? "no structural difference" : null),
      VERSIONS_VERB,
    ),
    version,
    against,
    entries,
    diff: renderDiff(entries),
  };
};

// ---------------------------------------------------------------------------
// pins, rollback, propose — all through CLI verbs, never the manifest
// ---------------------------------------------------------------------------

/** `--actor` only when the operator identity is argv-safe; the flag is a
 *  courtesy on the audit record, never worth mangling a command line for. */
function actorFlags(operator: string): string[] {
  try {
    return ["--actor", jobArg("actor", operator)];
  } catch {
    return [];
  }
}

/**
 * The re-pin command line. `deploy rollback <name> <env> <version>` IS the
 * verb that re-pins an environment to a version, and it is the one carrying
 * the protected-env approval gate and the audit record — so both the pin and
 * the rollback route shell it. The manager never writes `manifest.json`.
 */
function pinArgv(specName: string, env: string, version: string, operator: string): string[] {
  return [
    "deploy",
    "rollback",
    jobArg("name", specName),
    jobArg("env", env),
    jobArg("version", version),
    "--require-approval",
    ...actorFlags(operator),
  ];
}

/** `deploy promote <name> <fromEnv> <toEnv>` — copy an env pin forward. */
function promoteArgv(specName: string, from: string, to: string, operator: string): string[] {
  return [
    "deploy",
    "promote",
    jobArg("name", specName),
    jobArg("from", from),
    jobArg("to", to),
    "--require-approval",
    ...actorFlags(operator),
  ];
}

const GATE_NOTE =
  "a protected environment refuses the flip until its approval quorum is met; the decision is audit-logged either way";

type PinRequest = {
  readonly file: SpecFileRead;
  readonly env: string;
  readonly version: string;
  readonly manifest: Manifest | null;
};

function readPinRequest(ctx: M3Context): PinRequest {
  const file = readSpecFile(ctx);
  requireTypedConfirm(ctx.body, file.specName);
  const env = ctx.body["env"];
  const version = ctx.body["version"];
  if (typeof env !== "string" || env === "") throw new HttpError(400, 'missing "env"');
  if (typeof version !== "string" || version === "") throw new HttpError(400, 'missing "version"');
  return {
    file,
    env: jobArg("env", env),
    version: jobArg("version", version),
    manifest: readManifest(ctx, registryDirName(file.specName)),
  };
}

/** The refusal a pin that names an unknown version earns — a first-class
 *  state, and the versions that DO exist are the useful half of it. */
function unknownVersion(req: PinRequest, dirName: string): Record<string, unknown> | null {
  const known = req.manifest?.versions ?? [];
  if (known.includes(req.version)) return null;
  return refusal(
    "unknown_version",
    `${req.file.specName} has no version "${req.version}" in ${STATE_DIR}/${SPECS_SUBDIR}/${dirName}`,
    { known, pins: req.manifest?.pins ?? {}, verb: VERSIONS_VERB },
  );
}

/**
 * `POST /api/h/:id/spec/pin` — pin/promote a version to an environment.
 *
 * Shells the `deploy` verbs rather than writing the manifest directly, so
 * the audit record and the quorum rule are preserved. Body:
 * `{ env, version, from?, confirmName }` — a pin move is typed-confirm.
 * With `from`, the move is an env → env promotion instead of a version pin.
 */
export const specPin: M3Handler = (ctx) => {
  const req = readPinRequest(ctx);
  const dirName = registryDirName(req.file.specName);
  const from = ctx.body["from"];
  if (typeof from === "string" && from !== "") {
    const source = jobArg("from", from);
    const current = req.manifest?.pins[source];
    if (current === undefined) {
      return refusal("unpinned_source", `nothing is pinned to "${source}" to promote from`, {
        pins: req.manifest?.pins ?? {},
        verb: VERSIONS_VERB,
      });
    }
    return {
      ok: true,
      action: "promote",
      from: source,
      // `envName`, not `env`: the outbound tree masker redacts everything
      // under a key named `env`, and a pin that reports "[redacted]" as the
      // environment it moved would be worse than reporting nothing.
      envName: req.env,
      version: current,
      job: ctx.submitJob(
        "spec-promote",
        promoteArgv(req.file.specName, source, req.env, ctx.operator),
      ),
      verb: "crewhaus deploy promote",
      note: GATE_NOTE,
    };
  }
  const unknown = unknownVersion(req, dirName);
  if (unknown !== null) return unknown;
  return {
    ok: true,
    action: "pin",
    envName: req.env,
    version: req.version,
    replaces: req.manifest?.pins[req.env] ?? null,
    job: ctx.submitJob("spec-pin", pinArgv(req.file.specName, req.env, req.version, ctx.operator)),
    verb: "crewhaus deploy rollback",
    note: GATE_NOTE,
  };
};

/**
 * `POST /api/h/:id/spec/rollback` — roll an environment back to a version.
 *
 * Same verb family as {@link specPin} and the same gate. The refusal an
 * active pin produces is a first-class state, not an error toast.
 */
export const specRollback: M3Handler = (ctx) => {
  const req = readPinRequest(ctx);
  const dirName = registryDirName(req.file.specName);
  const unknown = unknownVersion(req, dirName);
  if (unknown !== null) return unknown;
  const current = req.manifest?.pins[req.env] ?? null;
  if (current === req.version) {
    return refusal("already_pinned", `"${req.env}" is already pinned to ${req.version}`, {
      pins: req.manifest?.pins ?? {},
    });
  }
  return {
    ok: true,
    action: "rollback",
    envName: req.env,
    version: req.version,
    replaces: current,
    job: ctx.submitJob(
      "spec-rollback",
      pinArgv(req.file.specName, req.env, req.version, ctx.operator),
    ),
    verb: "crewhaus deploy rollback",
    note: GATE_NOTE,
  };
};

/** Where a proposal's candidate spec is staged — beside the review bundle
 *  the `propose` verb writes, and nowhere else in the harness. */
const PROPOSAL_SUBDIR = "proposals";
const PROPOSAL_FILE = "proposed.yaml";
/** The ONE argv shape this module ever hands the CLI for a proposal. The
 *  directory is derived from the injected clock, never from the body. */
const PROPOSAL_PATH_RE = /^\.crewhaus\/proposals\/hangar-[0-9]{1,20}\/proposed\.yaml$/;

/**
 * `POST /api/h/:id/spec/propose` — the review path for human-owned edits.
 *
 * Runs `crewhaus propose` through the job queue: a git-tracked harness gets
 * a review branch/PR instead of a direct write. This is where every refusal
 * from {@link specEdit} is meant to land, so the refusal names it.
 *
 * `dryRun` defaults TRUE — an omitted flag never opens a PR.
 */
export const specPropose: M3Handler = async (ctx) => {
  const edits = parseEdits(ctx.body);
  const file = readSpecFile(ctx);
  const mod = await loadSpecModule(ctx.harnessDir as string);
  if (!file.present) {
    return refusal("no_spec", `this harness has no ${SPEC_FILE} to propose against`, {
      verb: "crewhaus init",
    });
  }
  // A proposal STAGES a candidate document — `applySpecEdits(file.text, …)`
  // — so a capped read would put a mutilated spec into the review bundle and
  // ask a human to approve it. Same refusal as a direct write.
  requireWholeSpec(file);
  const preview = previewSpecEdits(file.text, edits);
  if (!preview.ok) {
    return refusal("edit_rejected", preview.error ?? "the batch does not apply", {
      issues: issuesOf(mod, file.text),
      verb: "crewhaus compile crewhaus.yaml -o dist",
    });
  }
  if (preview.entries.length === 0) {
    return refusal("no_change", "this batch changes nothing — there is nothing to review", {
      specName: file.specName,
      verb: "crewhaus propose",
    });
  }
  const { auto, human } = splitByTier(file.target, edits);
  const proposed = applySpecEdits(file.text, edits).yaml;
  const stamp = String(ctx.now());
  const rel = `${STATE_DIR}/${PROPOSAL_SUBDIR}/hangar-${stamp}/${PROPOSAL_FILE}`;
  if (!PROPOSAL_PATH_RE.test(rel)) {
    throw new HttpError(500, "refusing to stage a proposal outside the proposals directory");
  }
  const dir = ctx.contain([STATE_DIR, PROPOSAL_SUBDIR, `hangar-${stamp}`]);
  mkdirSync(dir, { recursive: true });
  const target = ctx.contain([STATE_DIR, PROPOSAL_SUBDIR, `hangar-${stamp}`, PROPOSAL_FILE]);
  writeFileSync(target, proposed, { mode: 0o644 });
  const dryRun = ctx.body["dryRun"] !== false;
  const title = ctx.body["title"];
  return {
    ok: true,
    dryRun,
    staged: rel,
    specName: file.specName,
    title: typeof title === "string" ? maskText(title) : null,
    tiers: { autoTunable: auto, humanOwned: human },
    entries: preview.entries,
    diff: preview.diff,
    job: ctx.submitJob("spec-propose", [
      "propose",
      rel,
      "--current",
      SPEC_FILE,
      "--source",
      "manual",
      ...(dryRun ? ["--dry-run"] : []),
    ]),
    verb: "crewhaus propose",
    note: dryRun
      ? 'dry run: the review bundle is assembled and printed, and no branch or PR is opened. Send "dryRun": false to open one.'
      : "the proposal opens a review PR and never auto-merges — the human gate is the PR itself",
  };
};
