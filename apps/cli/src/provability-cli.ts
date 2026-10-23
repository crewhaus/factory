/**
 * 0.8.0 (design/0.8.0-provability-release.md §11) — `crewhaus provability
 * show|check|audit|checkers|prune`.
 *
 * Kept in a side-effect-free module (the CLI entry file runs an argv switch on
 * import), mirroring `dream-cli.ts` / `memory-cli.ts`: `index.ts` holds only
 * the dispatch. Every effect that is not a read of the working directory is a
 * seam on {@link ProvabilityCliDeps} — the clock, the two output streams, the
 * tool catalog `checked` replay re-runs pure tools from, and the sandbox the
 * proof checkers' availability probe runs in — so the tests drive every verb
 * in a temp directory with a fixed clock and no container.
 *
 *   - `show`     — one persisted bundle in long form (default: the latest):
 *                  floor, verdict, score, achieved, every claim with its
 *                  status, best rung, bindings, reasons and excerpts, the
 *                  assumptions and the checkers. `--json` prints the bundle
 *                  as persisted — the Hangar `GET /api/runs/:id/proof` twin.
 *   - `check`    — the gate, OFFLINE, over any document: `verifyDocument`,
 *                  the function the in-loop gate, `ProvabilityPreflight` and
 *                  the research report gate call, so a generated report is
 *                  graded exactly as an answer would be. Exit 0 on pass, 1
 *                  otherwise, so CI can gate on it. See {@link CHECK_NOTES}
 *                  for what it does differently from the live gate, and
 *                  {@link EVIDENCE_DIR_LAYOUT} for what it refuses to read.
 *   - `audit`    — a roll-up across persisted bundles and the event log's
 *                  `provability_graded` lines, with the gaming signals design
 *                  §10 says the audit exists to surface.
 *   - `checkers` — every proof checker, probed, with the paragraph that tells
 *                  a model what each one's statement language is.
 *   - `prune`    — bundle housekeeping through the bundle store (bundles carry
 *                  no TTL — they are the audit artifact; this is the one verb
 *                  that deletes them). Proof artifacts are never pruned: a
 *                  bundle that survives cites them.
 *
 * `show`, `audit` and `prune` read the managed shape's bundles too, which a
 * tenant-scoped gate files under the tenants root instead of `.crewhaus/`
 * (see {@link MANAGED_TENANTS_ROOT_DEFAULT}), and the research shape's, one
 * per run beside its report (see {@link researchDirs}). Every text renderer passes what
 * it prints through {@link ttySafe}: bundles hold model prose and fetched
 * page text.
 *
 * Nothing here calls a model: the paraphrase-waiver judge is the gate's one
 * model-backed step, and `check` leaves it out (the bundle then reports the
 * paraphrase misses it would have asked about as unmet).
 */
import {
  type Stats,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { citationDefinitions, classifyDefinition, contentTokens } from "@crewhaus/claim-ledger";
import { lower, provabilityOf } from "@crewhaus/compiler";
import { CrewhausError } from "@crewhaus/errors";
import {
  type GateCatalog,
  catalogReplay,
  proofsDirName,
  wantsProofCheckTools,
} from "@crewhaus/evaluation-service";
import { openEventLog } from "@crewhaus/event-log";
import type { ParsedArgs } from "@crewhaus/infra-utils";
import { DEFAULT_LEAN4_IMAGE, DEFAULT_SMT_IMAGE, KNOWN_CHECKER_IDS } from "@crewhaus/proof-checker";
import {
  type BundleListing,
  type EvidenceIndex,
  type EvidenceRecord,
  NO_SESSION,
  PROVABILITY_LEVELS,
  type ProofArtifact,
  type ProofArtifactStore,
  type ProofBinding,
  type ProofBundle,
  type ProofClaim,
  type ProvabilityConfig,
  type ProvabilityLevel,
  type Rung,
  type UnmetReason,
  buildEvidenceIndex,
  claimReasons,
  createBundleStore,
  createFileArtifactStore,
  doiUrl,
  evidenceFromSessionLog,
  isProvabilityLevel,
  levelRank,
  originKey,
  proofsRoot,
  recordFromCall,
  renderBundleJson,
  renderFooter,
  verifyDocument,
} from "@crewhaus/provability";
import { createSandbox, resolveSandboxBackend, sandboxAvailableFromEnv } from "@crewhaus/sandbox";
import { parseSpec } from "@crewhaus/spec";
import { validateTenantId } from "@crewhaus/tenancy";
import {
  AVAILABILITY_TIMEOUT_MS,
  type CheckerListing,
  type DefaultCheckerDeps,
  buildDefaultCheckers,
  defaultCheckerIds,
  defaultProvabilityConfig,
  listCheckers,
} from "@crewhaus/tool-proof";
import { openForRead } from "@crewhaus/tool-safety/fs";

export class ProvabilityCliError extends CrewhausError {
  override readonly name = "ProvabilityCliError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/** The verbs, in the order the usage lists them. */
export const PROVABILITY_ACTIONS = ["show", "check", "audit", "checkers", "prune"] as const;
export type ProvabilityAction = (typeof PROVABILITY_ACTIONS)[number];

export function isProvabilityAction(value: string): value is ProvabilityAction {
  return (PROVABILITY_ACTIONS as readonly string[]).includes(value);
}

/**
 * Where a managed daemon keeps its tenants when `CREWHAUS_TENANTS_ROOT` is
 * unset — target-managed's emitted `TENANTS_ROOT` default (a test holds the
 * two equal). Every managed turn runs under `withTenant`, so the gate files
 * that turn's bundle under `<tenantsRoot>/<tenant>/proofs/<spec>/`, never
 * `<cwd>/.crewhaus/proofs/` (tool-proof's `defaultProofsRoot`).
 */
export const MANAGED_TENANTS_ROOT_DEFAULT = "/tmp/crewhaus-tenants";

export const PROVABILITY_USAGE =
  "usage: crewhaus provability show [<spec.yaml>] [--session <id>] [--turn N [--pass K]]\n" +
  "                [--tenants-root <dir>] [--json]\n" +
  "       crewhaus provability check <answer.md> --level <rung> [--evidence <dir>] [--session <id>]\n" +
  "                [--spec <spec.yaml>] [--report] [--tenant <id> [--tenants-root <dir>]] [--json]\n" +
  "       crewhaus provability audit [<spec.yaml>] [--since 7d] [--tenants-root <dir>] [--json]\n" +
  "       crewhaus provability checkers [<spec.yaml>] [--json]\n" +
  "       crewhaus provability prune [<spec.yaml>] --older-than 90d [--dry-run] [--tenants-root <dir>]\n" +
  "                [--json]\n" +
  "  The proof bundles the provability gate files under .crewhaus/proofs/<spec>/<session>/ — on\n" +
  "  the managed shape, under <tenants-root>/<tenant>/proofs/<spec>/<session>/ instead; a\n" +
  "  research run's report bundle is .crewhaus/research/<run>/proof.json (--session <run>).\n" +
  "  show      one bundle in long form (default: the latest; --json prints it as persisted).\n" +
  "            A retried turn keeps every pass: --pass K reads its K-th (default: the last)\n" +
  "  check     the gate, offline, over any document: exit 0 on pass, 1 otherwise. Evidence is\n" +
  "            the session's event log (--session), a directory of fetched bodies (--evidence:\n" +
  "            each file is one body; its URL is a sidecar <file>.url or the first line\n" +
  "            `URL: <url>`; a saved WebFetch result that echoes its `[user prompt: …]` needs\n" +
  "            the prompt in <file>.prompt), and workspace files the document cites by path,\n" +
  "            read directly (never the document itself, nor the harness's state: .crewhaus/,\n" +
  "            and the session, tenants and knowledge directories wherever they live).\n" +
  "            Config: --spec's provability block (--level overrides its floor), else the\n" +
  "            defaults at --level. No HEAD request and no waiver judge run offline.\n" +
  "            --report grades a research report.md as its gate did: without the writer's\n" +
  "            trailer (## Citations, ## Provability). --tenant also reads a managed tenant's\n" +
  "            session log and proof artifacts under the tenants root.\n" +
  "  audit     roll-up of bundles and provability_graded lines: achieved rungs, unmet\n" +
  "            reasons, assumption and judge-waiver rates, and gaming signals\n" +
  "  checkers  every proof checker: available or why not, and its statement language\n" +
  "  prune     delete bundles older than --older-than (proof artifacts are kept)\n" +
  "  --tenants-root  also read managed bundles (default: CREWHAUS_TENANTS_ROOT, else\n" +
  "                  /tmp/crewhaus-tenants when the spec's target is managed); on check,\n" +
  "                  where --tenant's session log and proof artifacts are\n" +
  "  Rungs: cited, grounded, checked, proven. Durations: 30m, 12h, 7d, 2w.\n";

/** Which flags each verb reads; any other declared flag on it is refused. */
const FLAGS_BY_ACTION: Readonly<Record<ProvabilityAction, readonly string[]>> = {
  show: ["session", "turn", "pass", "tenants-root", "json"],
  check: ["level", "evidence", "session", "spec", "report", "tenants-root", "tenant", "json"],
  audit: ["since", "tenants-root", "json"],
  checkers: ["json"],
  prune: ["older-than", "dry-run", "tenants-root", "json"],
};

/** Positional arguments each verb takes: [min, max]. */
const POSITIONALS: Readonly<Record<ProvabilityAction, readonly [number, number]>> = {
  show: [0, 1],
  check: [1, 1],
  audit: [0, 1],
  checkers: [0, 1],
  prune: [0, 1],
};

export type ProvabilityCliDeps = {
  /** The harness directory: `.crewhaus/` lives here, and path sources resolve inside it. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  /** stdout. */
  readonly out: (text: string) => void;
  /** stderr — notes that must not mix into `--json` output. */
  readonly err: (text: string) => void;
  /**
   * `check` — the tools `checked` replay re-runs (pure ones only), built on
   * first need: building it imports every tool package. Absent ⇒ no replay,
   * and execution bindings record `replayed: false`.
   */
  readonly loadCatalog?: () => Promise<GateCatalog>;
  /** `checkers` / doctor — whether a container sandbox may be used (default: `CREWHAUS_SANDBOX`). */
  readonly sandboxAvailable?: boolean;
  /** `checkers` / doctor — the sandbox factory (default `@crewhaus/sandbox`'s). */
  readonly createSandbox?: DefaultCheckerDeps["createSandbox"];
  /** `checkers` / doctor — the per-checker availability bound. */
  readonly probeTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// shared: specs, the proofs tree, durations
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^sess_[0-9a-f]{16}$/;
/** A research run's id (citation-tracker's `newRunId`): its report bundle's key. */
const RESEARCH_RUN_RE = /^run_[0-9a-f]{16}$/;
/** Largest research report bundle read back (the bundle store's own cap). */
const MAX_RESEARCH_BUNDLE_BYTES = 16 * 1024 * 1024;
/** Largest document `check` reads, and largest body it reads per evidence file. */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Files an `--evidence` directory may hold, and how deep it is walked. */
const MAX_EVIDENCE_FILES = 1_000;
const MAX_EVIDENCE_DEPTH = 4;
/** Bundles and session logs `audit` reads at most (newest first). */
const MAX_AUDIT_BUNDLES = 5_000;
const MAX_AUDIT_SESSIONS = 2_000;

type SpecView = {
  readonly path: string;
  readonly name: string;
  /** The lowered `target:` (`cli`, `managed`, …), when the IR carries one. */
  readonly target?: string;
  readonly provability?: ProvabilityConfig;
  /** The lowered `tools:` — builtin keys, categories expanded. */
  readonly tools: readonly string[];
  /** The proofs directory the gate files this spec's bundles under. */
  readonly proofsDir: string;
};

function loadSpec(path: string, cwd: string): SpecView {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    throw new ProvabilityCliError(
      `provability: cannot read spec "${path}": ${(err as Error).message}`,
      err,
    );
  }
  const ir = lower(parseSpec(text));
  const name = (ir as { readonly name?: unknown }).name;
  if (typeof name !== "string" || name === "") {
    throw new ProvabilityCliError(`provability: spec "${path}" has no name`);
  }
  const provability = provabilityOf(ir);
  const target = (ir as { readonly target?: unknown }).target;
  return {
    path: abs,
    name,
    ...(typeof target === "string" ? { target } : {}),
    ...(provability !== undefined ? { provability } : {}),
    tools: irToolKeys(ir),
    proofsDir: proofsDirName(name),
  };
}

/** The lowered `tools:` — builtin keys (`proofCheck`), categories already expanded. */
export function irToolKeys(ir: unknown): string[] {
  const tools = (ir as { readonly tools?: unknown }).tools;
  return Array.isArray(tools) ? tools.filter((t): t is string => typeof t === "string") : [];
}

/** `<cwd>/.crewhaus/proofs`. */
function proofsBase(cwd: string): string {
  return join(resolve(cwd), ".crewhaus", "proofs");
}

/** A proofs directory provability's store accepts as a spec name. */
function isSpecDirName(name: string): boolean {
  try {
    proofsRoot(".", name);
    return true;
  } catch {
    return false;
  }
}

function isTenantId(name: string): boolean {
  try {
    validateTenantId(name);
    return true;
  } catch {
    return false;
  }
}

/** True when `path` is a real directory — a link is never one (it is not followed into). */
function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

type SpecDir = {
  readonly name: string;
  readonly root: string;
  /** The managed tenant whose root holds this directory; absent for `<cwd>/.crewhaus/proofs`. */
  readonly tenant?: string;
  /**
   * The research shape's run directory (`<cwd>/.crewhaus/research`), whose
   * bundles are `<runId>/proof.json` — see {@link researchDirs}.
   */
  readonly research?: true;
};

/** The spec directories under one proofs directory, narrowed to `only` when given. */
function specDirsUnder(base: string, only: string | undefined, tenant?: string): SpecDir[] {
  let names: string[];
  try {
    names = readdirSync(base).sort();
  } catch {
    return [];
  }
  return names
    .filter((name) => (only === undefined || name === only) && isSpecDirName(name))
    .filter((name) => isRealDir(join(base, name)))
    .map((name) => ({ name, root: join(base, name), ...(tenant !== undefined ? { tenant } : {}) }));
}

/**
 * The spec directories under `<cwd>/.crewhaus/proofs`: the spec's own when one
 * was named, else every real directory (links are not followed into).
 */
function specDirs(cwd: string, spec: SpecView | undefined): SpecDir[] {
  if (spec !== undefined) return [{ name: spec.proofsDir, root: proofsRoot(cwd, spec.proofsDir) }];
  return specDirsUnder(proofsBase(cwd), undefined);
}

/**
 * Where the managed shape's bundles are read from, and how that was decided.
 * `only` narrows every tenant to one spec directory: the tenants root is
 * shared by every managed harness on the machine, so a harness's verbs read
 * (and `prune` deletes) only its own spec's bundles there whenever the spec
 * is known — named, or the `crewhaus.yaml` in the harness directory.
 */
type TenantsScope = {
  readonly root: string;
  readonly source: "--tenants-root" | "CREWHAUS_TENANTS_ROOT" | "managed default";
  readonly only?: string;
};

/**
 * The tenants root to read, in order: `--tenants-root <dir>`; else
 * `CREWHAUS_TENANTS_ROOT` (the variable a managed daemon reads); else, when
 * the spec (named, or the cwd's) lowers to `target: managed`,
 * {@link MANAGED_TENANTS_ROOT_DEFAULT} — where that daemon files them with the
 * variable unset. Relative values resolve against the harness directory, as
 * the daemon (run from it) resolves them. Undefined: not a managed harness.
 */
function tenantsScope(
  args: ParsedArgs,
  deps: ProvabilityCliDeps,
  spec: SpecView | undefined,
): TenantsScope | undefined {
  const known = spec ?? cwdSpec(deps.cwd);
  const only = known !== undefined ? { only: known.proofsDir } : {};
  const flag = flagString(args, "tenants-root");
  if (flag !== undefined) {
    const root = resolve(deps.cwd, flag);
    let isDir = false;
    try {
      isDir = statSync(root).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new ProvabilityCliError(`--tenants-root ${flag}: no such directory`);
    return { root, source: "--tenants-root", ...only };
  }
  const fromEnv = deps.env["CREWHAUS_TENANTS_ROOT"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { root: resolve(deps.cwd, fromEnv.trim()), source: "CREWHAUS_TENANTS_ROOT", ...only };
  }
  if (known?.target === "managed") {
    return { root: MANAGED_TENANTS_ROOT_DEFAULT, source: "managed default", ...only };
  }
  return undefined;
}

/**
 * `<root>/<tenant>/proofs/<spec>` for every tenant directory under the
 * tenants root. The root itself may be a link (`/tmp` is one on macOS);
 * below it nothing is followed — a tenant, its `proofs` and each spec
 * directory must be real directories, and the bundle store lists sessions and
 * bundle files the same way — so a link planted in the tree reads nothing.
 */
function tenantSpecDirs(scope: TenantsScope): SpecDir[] {
  let tenants: string[];
  try {
    tenants = readdirSync(scope.root).sort();
  } catch {
    return [];
  }
  const out: SpecDir[] = [];
  for (const tenant of tenants) {
    if (!isTenantId(tenant)) continue;
    const proofs = join(scope.root, tenant, "proofs");
    if (!isRealDir(join(scope.root, tenant)) || !isRealDir(proofs)) continue;
    out.push(...specDirsUnder(proofs, scope.only, tenant));
  }
  return out;
}

/** The session-log directory of every tenant under the scope (the audit's graded lines). */
function tenantSessionRoots(scope: TenantsScope): string[] {
  let tenants: string[];
  try {
    tenants = readdirSync(scope.root).sort();
  } catch {
    return [];
  }
  return tenants
    .filter((tenant) => isTenantId(tenant) && isRealDir(join(scope.root, tenant)))
    .map((tenant) => join(scope.root, tenant, "sessions"))
    .filter(isRealDir);
}

/**
 * The research shape's report bundles (design §5.4, §8): its report gate
 * writes one bundle per run as `.crewhaus/research/<runId>/proof.json`,
 * beside the `report.md` it grades — not under `.crewhaus/proofs/`, whose
 * store keys bundles by `sess_` session and has no place for a run. Read when
 * no spec narrows the verb, or when the named spec is a research one. Below
 * the directory nothing is followed: a run directory and its `proof.json`
 * must be real ({@link researchListings}), as everywhere else in the tree.
 */
function researchDirs(cwd: string, spec: SpecView | undefined): SpecDir[] {
  if (spec !== undefined && spec.target !== "research") return [];
  const root = join(resolve(cwd), ".crewhaus", "research");
  return isRealDir(root) ? [{ name: spec?.proofsDir ?? "research", root, research: true }] : [];
}

/** Every spec directory a reader verb reads: the harness's own, its research runs, the tenants'. */
function allSpecDirs(cwd: string, spec: SpecView | undefined, tenants: TenantsScope | undefined) {
  return [
    ...specDirs(cwd, spec),
    ...researchDirs(cwd, spec),
    ...(tenants !== undefined ? tenantSpecDirs(tenants) : []),
  ];
}

/** One research run's bundle per real `run_<16 hex>/proof.json` under `root`; turn 1, pass 1. */
function researchListings(root: string): BundleListing[] {
  let runs: string[];
  try {
    runs = readdirSync(root).sort();
  } catch {
    return [];
  }
  const out: BundleListing[] = [];
  for (const run of runs) {
    if (!RESEARCH_RUN_RE.test(run) || !isRealDir(join(root, run))) continue;
    const path = join(root, run, "proof.json");
    try {
      const stat = lstatSync(path);
      if (stat.isFile())
        out.push({ sessionId: run, turnNumber: 1, pass: 1, path, mtimeMs: stat.mtimeMs });
    } catch {
      // no report gate ran (an ungated run, or one still in flight)
    }
  }
  return out;
}

/**
 * A research run's bundle, read the way the bundle store reads one: contained
 * under the research directory, never through a link, capped, and the same
 * top-level shape (deeper checks are {@link bundleProblem}'s, as for any).
 */
async function readResearchBundle(listing: Listing): Promise<ProofBundle> {
  const rel = `${listing.sessionId}/proof.json`;
  const read = await openForRead(listing.spec.root, rel, {
    maxBytes: MAX_RESEARCH_BUNDLE_BYTES,
    followLeafSymlink: false,
  });
  if (!read.ok) {
    throw new ProvabilityCliError(`provability: refusing to read ${listing.path}: ${read.reason}`);
  }
  if (read.truncated) {
    throw new ProvabilityCliError(
      `provability: ${listing.path} is larger than ${MAX_RESEARCH_BUNDLE_BYTES} bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch (err) {
    throw new ProvabilityCliError(`provability: ${listing.path} is not valid JSON`, err);
  }
  const v = isObject(value) ? value : {};
  if (
    v["version"] !== 1 ||
    typeof v["level"] !== "string" ||
    typeof v["verdict"] !== "string" ||
    !Array.isArray(v["claims"]) ||
    typeof v["bundleHash"] !== "string"
  ) {
    throw new ProvabilityCliError(`provability: ${listing.path} is not a proof bundle`);
  }
  return value as ProofBundle;
}

/** How a tenants scope reads in a header or a note. */
function tenantsWords(scope: TenantsScope): string {
  return `${scope.root} (${scope.source}${scope.only !== undefined ? `, spec ${scope.only} only` : ""})`;
}

type Listing = BundleListing & { readonly spec: SpecDir };

/** Every bundle under `dirs`, newest first. */
async function listings(
  dirs: readonly SpecDir[],
  opts: { readonly allPasses?: boolean } = {},
): Promise<Listing[]> {
  const out: Listing[] = [];
  for (const dir of dirs) {
    const found =
      dir.research === true
        ? researchListings(dir.root)
        : await createBundleStore({ rootDir: dir.root }).list(opts);
    for (const listing of found) {
      out.push({ ...listing, spec: dir });
    }
  }
  return out.sort(
    (a, b) =>
      b.mtimeMs - a.mtimeMs ||
      b.turnNumber - a.turnNumber ||
      b.pass - a.pass ||
      a.sessionId.localeCompare(b.sessionId) ||
      a.spec.name.localeCompare(b.spec.name) ||
      (a.spec.tenant ?? "").localeCompare(b.spec.tenant ?? ""),
  );
}

async function readListing(listing: Listing): Promise<ProofBundle> {
  if (listing.spec.research === true) return readResearchBundle(listing);
  const store = createBundleStore({ rootDir: listing.spec.root });
  // The listing's own pass: a turn a retry graded again keeps every pass.
  const bundle = await store.get(
    listing.sessionId === NO_SESSION ? undefined : listing.sessionId,
    listing.turnNumber,
    listing.pass,
  );
  if (bundle === undefined) {
    throw new ProvabilityCliError(`provability: ${listing.path} vanished while reading`);
  }
  return bundle;
}

/** A path as shown: relative to the harness directory when it lies inside it. */
function shown(path: string, cwd: string): string {
  const rel = relative(resolve(cwd), path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    ? rel.split(sep).join("/")
    : path;
}

const UNIT_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/** `30m` / `12h` / `7d` / `2w` → ms, or undefined when `raw` is not one. */
export function parseDurationMs(raw: string): number | undefined {
  const m = /^(\d{1,6})([mhdw])$/.exec(raw.trim());
  if (m === null) return undefined;
  const n = Number(m[1]);
  return n >= 1 ? n * (UNIT_MS[m[2] as string] as number) : undefined;
}

/** `--since`: a duration back from now, or an ISO date/datetime. */
export function parseSince(raw: string, now: Date): number {
  const ms = parseDurationMs(raw);
  if (ms !== undefined) return now.getTime() - ms;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return at;
  }
  throw new ProvabilityCliError(
    `invalid --since "${raw}" — expected a duration like 7d, 12h or 2w, or an ISO date (2026-10-01)`,
  );
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined || value === false) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new ProvabilityCliError(`--${name} needs a value`);
  }
  return value;
}

/**
 * `--session`: a `sess_<16 hex>` always; for `show`, also `no-session` and a
 * research run's `run_<16 hex>` (the key its report bundle is filed under).
 */
function sessionFlag(args: ParsedArgs, bundleKeys: boolean): string | undefined {
  const session = flagString(args, "session");
  if (session === undefined) return undefined;
  if (
    SESSION_ID_RE.test(session) ||
    (bundleKeys && (session === NO_SESSION || RESEARCH_RUN_RE.test(session)))
  ) {
    return session;
  }
  throw new ProvabilityCliError(
    `invalid --session "${session}" — expected sess_<16 hex>${
      bundleKeys ? `, "${NO_SESSION}" or a research run's run_<16 hex>` : ""
    }`,
  );
}

function levelFlag(args: ParsedArgs): ProvabilityLevel | undefined {
  const level = flagString(args, "level");
  if (level === undefined) return undefined;
  if (!isProvabilityLevel(level)) {
    throw new ProvabilityCliError(
      `invalid --level "${level}" — expected one of ${PROVABILITY_LEVELS.join(", ")}`,
    );
  }
  return level;
}

function percent(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Word-wrap `text` at `width`, every line indented by `indent`. */
function wrap(text: string, indent: string, width = 96): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter((w) => w !== "")) {
      if (line !== "" && indent.length + line.length + 1 + word.length > width) {
        lines.push(`${indent}${line}`);
        line = word;
      } else {
        line = line === "" ? word : `${line} ${word}`;
      }
    }
    if (line !== "") lines.push(`${indent}${line}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// what reaches the terminal
// ---------------------------------------------------------------------------

// C0 controls (ESC, CR, LF included), DEL, C1 controls (the one-byte CSI and
// OSC), and the bidi embeddings/overrides/isolates that reorder what follows.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character neutralization
const TTY_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * One line, safe to print. A text renderer here prints strings that came from
 * a fetched page (an excerpt), the model (claim prose, a statement, a
 * citation label), a bundle file anyone can edit, and file names: a page can
 * carry ESC/OSC/CSI sequences that retitle the terminal, clear it or move the
 * cursor back over the verdict line, and a newline in a claim forges a whole
 * `verdict ✓ pass` line — the attack `security-digest.ts` neutralizes in
 * session content. Line breaks and tabs become a space; every other control
 * becomes U+FFFD, so the tampering stays visible and inert. Every text
 * renderer builds single-line strings and passes each through this last;
 * `--json` prints as persisted (JSON escapes controls itself).
 */
export function ttySafe(text: string): string {
  return text.replace(TTY_UNSAFE, (c) => (c === "\n" || c === "\r" || c === "\t" ? " " : "\uFFFD"));
}

/** Lines → terminal text: each made safe, then joined. */
function ttyText(lines: readonly string[]): string {
  return `${lines.map(ttySafe).join("\n")}\n`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** `field` holds a string when present (absent is fine). */
function optionalString(record: Record<string, unknown>, field: string): boolean {
  return record[field] === undefined || typeof record[field] === "string";
}

const BUNDLE_COUNTS = [
  "score",
  "threshold",
  "claimCount",
  "met",
  "unmet",
  "assumptions",
  "sources",
  "judgeWaived",
  "retryIndex",
] as const;
const BINDING_TEXT = ["reason", "detail", "origin", "sha256", "excerpt", "checker", "statement"];

/** Why one binding is not renderable, or undefined. */
function bindingProblem(binding: unknown, at: string): string | undefined {
  if (!isObject(binding)) return `${at} is not an object`;
  if (typeof binding["ref"] !== "string" || typeof binding["kind"] !== "string") {
    return `${at} has no ref or kind`;
  }
  if (!isRung(binding["rung"])) return `${at}.rung is not a rung`;
  if (typeof binding["ok"] !== "boolean") return `${at}.ok is not a boolean`;
  for (const field of BINDING_TEXT) {
    if (!optionalString(binding, field)) return `${at}.${field} is not a string`;
  }
  for (const field of ["replayed", "judgeWaived"]) {
    if (binding[field] !== undefined && typeof binding[field] !== "boolean") {
      return `${at}.${field} is not a boolean`;
    }
  }
  return undefined;
}

/**
 * Why a bundle the store handed back cannot be rendered or counted, or
 * undefined when it can. The store checks the top-level shape only (version,
 * level, verdict, a `claims` array, a hash); a hand-edited or half-written
 * file passes that with `claims: [null]` or no counts at all — and the long
 * form dereferences every claim and binding while the audit sums every
 * count. Checked once, here, so such a file is reported as unreadable, with
 * where it breaks, instead of a TypeError or a `null` total.
 */
export function bundleProblem(bundle: unknown): string | undefined {
  if (!isObject(bundle)) return "not an object";
  if (!isProvabilityLevel(bundle["level"])) return "level is not a rung";
  if (!isVerdict(bundle["verdict"])) return "verdict is not pass, fail or unverified";
  if (!isRung(bundle["achieved"])) return "achieved is not a rung";
  for (const field of BUNDLE_COUNTS) {
    if (!isFiniteNumber(bundle[field])) return `${field} is not a number`;
  }
  for (const field of ["assumptionsRefused", "spentUsdMicros"]) {
    if (bundle[field] !== undefined && !isFiniteNumber(bundle[field])) {
      return `${field} is not a number`;
    }
  }
  for (const field of ["createdAt", "bundleHash"]) {
    if (typeof bundle[field] !== "string") return `${field} is not a string`;
  }
  for (const field of ["vacuous", "error", "judgeModel"]) {
    if (!optionalString(bundle, field)) return `${field} is not a string`;
  }
  const claims = bundle["claims"];
  if (!Array.isArray(claims)) return "claims is not an array";
  for (const [i, claim] of claims.entries()) {
    const at = `claims[${i}]`;
    if (!isObject(claim)) return `${at} is not an object`;
    if (!Number.isInteger(claim["index"]) || (claim["index"] as number) < 0) {
      return `${at}.index is not a claim index`;
    }
    if (typeof claim["text"] !== "string") return `${at}.text is not a string`;
    if (!(typeof claim["status"] === "string" && Object.hasOwn(STATUS_MARK, claim["status"]))) {
      return `${at}.status is not met, unmet or assumption`;
    }
    if (!isRung(claim["best"])) return `${at}.best is not a rung`;
    if (claim["line"] !== undefined && !isFiniteNumber(claim["line"])) {
      return `${at}.line is not a number`;
    }
    if (!optionalString(claim, "definition")) return `${at}.definition is not a string`;
    const bindings = claim["bindings"];
    if (!Array.isArray(bindings)) return `${at}.bindings is not an array`;
    for (const [j, binding] of bindings.entries()) {
      const problem = bindingProblem(binding, `${at}.bindings[${j}]`);
      if (problem !== undefined) return problem;
    }
  }
  const checkers = bundle["checkers"];
  if (checkers !== undefined) {
    if (!Array.isArray(checkers)) return "checkers is not an array";
    for (const [i, checker] of checkers.entries()) {
      if (
        !isObject(checker) ||
        typeof checker["id"] !== "string" ||
        typeof checker["artifact"] !== "string" ||
        !Array.isArray(checker["axioms"]) ||
        !checker["axioms"].every((a) => typeof a === "string")
      ) {
        return `checkers[${i}] is not {id, artifact, axioms}`;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// the long form (show, check)
// ---------------------------------------------------------------------------

const VERDICT_MARK: Readonly<Record<ProofBundle["verdict"], string>> = {
  pass: "✓ pass",
  fail: "✗ fail",
  unverified: "? unverified",
};

const STATUS_MARK: Readonly<Record<ProofClaim["status"], string>> = {
  met: "✓ met",
  unmet: "✗ unmet",
  assumption: "~ assumption",
};

const reasonWords = (reason: UnmetReason): string => reason.replace(/_/g, " ");

function bindingLines(b: ProofBinding): string[] {
  const allowedAssumption = b.kind === "assumption" && b.reason === undefined;
  const mark = allowedAssumption ? "~" : b.ok ? "✓" : "✗";
  const head = [`${b.ref} ${mark} ${b.kind}`, `rung ${b.rung}`];
  if (b.reason !== undefined) head.push(reasonWords(b.reason));
  if (b.replayed !== undefined) head.push(b.replayed ? "replayed" : "not replayed");
  if (b.judgeWaived === true) head.push("judge-waived");
  const lines = [`     ${head.join(" · ")}`];
  if (b.origin !== undefined) lines.push(`         origin    ${b.origin}`);
  if (b.detail !== undefined) lines.push(`         why       ${b.detail}`);
  if (b.excerpt !== undefined) lines.push(`         excerpt   "${b.excerpt}"`);
  if (b.checker !== undefined) lines.push(`         checker   ${b.checker}`);
  if (b.statement !== undefined) lines.push(`         statement ${b.statement}`);
  if (b.sha256 !== undefined) lines.push(`         digest    ${b.sha256}`);
  return lines;
}

/**
 * The footer's long form: every field a reader needs to check the verdict
 * without the JSON — and the footer line itself last, so the long form and
 * the answer's footer can be matched by eye.
 */
export function renderBundleLong(
  bundle: ProofBundle,
  opts: { readonly title: string | readonly string[]; readonly path?: string },
): string {
  const counted = bundle.claimCount - bundle.assumptions;
  const refused = bundle.assumptionsRefused ?? 0;
  const lines: string[] = typeof opts.title === "string" ? opts.title.split("\n") : [...opts.title];
  lines.push(`  floor       ${bundle.level}`);
  lines.push(
    `  verdict     ${VERDICT_MARK[bundle.verdict]}${
      bundle.verdict === "unverified" && bundle.error !== undefined ? ` — ${bundle.error}` : ""
    }`,
  );
  lines.push(
    `  score       ${bundle.met}/${counted} ${counted === 1 ? "claim" : "claims"} (${percent(
      bundle.score,
    )}, threshold ${percent(bundle.threshold)})${
      bundle.vacuous !== undefined ? ` — vacuous: ${bundle.vacuous}` : ""
    }`,
  );
  lines.push(`  achieved    ${bundle.achieved}`);
  lines.push(`  sources     ${plural(bundle.sources, "distinct origin")}`);
  // Every surface counts a proof's hypotheses as assumptions (design §6.4,
  // §10), as the footer below does.
  const hypotheses = bundle.hypotheses ?? 0;
  lines.push(
    `  assumptions ${bundle.assumptions + hypotheses + refused}${
      refused > 0 || hypotheses > 0
        ? ` (${[
            ...(hypotheses > 0 ? [plural(hypotheses, "proof hypothesis", "proof hypotheses")] : []),
            ...(refused > 0 ? [`${refused} refused`] : []),
          ].join(", ")})`
        : ""
    }`,
  );
  if (bundle.judgeWaived > 0 || bundle.judgeModel !== undefined) {
    lines.push(
      `  judge       ${plural(bundle.judgeWaived, "binding")} waived${
        bundle.judgeModel !== undefined ? ` by ${bundle.judgeModel}` : ""
      }${
        bundle.spentUsdMicros !== undefined
          ? ` ($${(bundle.spentUsdMicros / 1_000_000).toFixed(6)})`
          : ""
      } — an opinion, not a deterministic check`,
    );
  }
  lines.push(`  retry       ${bundle.retryIndex}`);
  lines.push(`  created     ${bundle.createdAt}`);
  lines.push(`  hash        ${bundle.bundleHash}`);

  lines.push("", `claims (${bundle.claims.length})`);
  if (bundle.claims.length === 0) lines.push("  none");
  for (const claim of bundle.claims) {
    const where = claim.line !== undefined ? ` · line ${claim.line}` : "";
    const def = claim.definition !== undefined ? ` · text of definition ${claim.definition}` : "";
    lines.push(
      `  ${claim.index + 1}. ${STATUS_MARK[claim.status]} · best ${claim.best}${where}${def}`,
    );
    lines.push(`     ${claim.text}`);
    if (claim.bindings.length === 0) {
      const reasons = claim.status === "unmet" ? claimReasons(claim) : [];
      lines.push(
        `     ✗ ${reasons.length > 0 ? reasonWords(reasons[0] as UnmetReason) : "no citation"}`,
      );
    }
    for (const b of claim.bindings) lines.push(...bindingLines(b));
  }

  const assumed = bundle.claims.flatMap((claim) =>
    claim.bindings.filter((b) => b.kind === "assumption" && b.origin !== undefined),
  );
  if (assumed.length > 0) {
    lines.push("", "assumptions");
    const seen = new Set<string>();
    for (const b of assumed) {
      const key = `${b.ref} ${b.origin}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(
        `  ${b.ref} ${b.origin as string}${b.reason !== undefined ? ` (${reasonWords(b.reason)})` : ""}`,
      );
    }
  }
  if (bundle.checkers !== undefined && bundle.checkers.length > 0) {
    lines.push("", "checkers");
    for (const checker of bundle.checkers) {
      lines.push(
        `  ${checker.id} — ${checker.artifact} · axioms: ${
          checker.axioms.length === 0 ? "none" : checker.axioms.join(", ")
        }${
          checker.assumptions !== undefined && checker.assumptions.length > 0
            ? ` · assumes: ${checker.assumptions.join("; ")}`
            : ""
        }`,
      );
    }
  }
  lines.push("", renderFooter(bundle, opts.path !== undefined ? { path: opts.path } : {}));
  return ttyText(lines);
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

async function showCommand(args: ParsedArgs, deps: ProvabilityCliDeps): Promise<number> {
  const session = sessionFlag(args, true);
  const turnRaw = flagString(args, "turn");
  let turn: number | undefined;
  if (turnRaw !== undefined) {
    if (!/^\d{1,9}$/.test(turnRaw)) {
      throw new ProvabilityCliError(`invalid --turn "${turnRaw}" — expected a turn number`);
    }
    turn = Number(turnRaw);
  }
  const passRaw = flagString(args, "pass");
  let pass: number | undefined;
  if (passRaw !== undefined) {
    if (turn === undefined) {
      throw new ProvabilityCliError("--pass names a pass of one turn — give --turn too");
    }
    if (!/^\d{1,4}$/.test(passRaw) || Number(passRaw) < 1) {
      throw new ProvabilityCliError(
        `invalid --pass "${passRaw}" — expected a pass number (1, 2, …)`,
      );
    }
    pass = Number(passRaw);
  }
  const specPath = args.positional[0];
  const spec = specPath !== undefined ? loadSpec(specPath, deps.cwd) : undefined;
  const tenants = tenantsScope(args, deps, spec);
  // Each turn's last pass — its standing bundle — unless a pass is named.
  const found = (
    await listings(
      allSpecDirs(deps.cwd, spec, tenants),
      pass !== undefined ? { allPasses: true } : {},
    )
  ).filter(
    (l) =>
      (session === undefined || l.sessionId === session) &&
      (turn === undefined || l.turnNumber === turn) &&
      (pass === undefined || l.pass === pass),
  );
  const pick = found[0];
  if (pick === undefined) {
    const what = [
      session !== undefined ? `session ${session}` : undefined,
      turn !== undefined ? `turn ${turn}` : undefined,
      pass !== undefined ? `pass ${pass}` : undefined,
    ].filter((s) => s !== undefined);
    const where =
      spec !== undefined
        ? shown(proofsRoot(deps.cwd, spec.proofsDir), deps.cwd)
        : ".crewhaus/proofs";
    throw new ProvabilityCliError(
      `provability show: no proof bundle${what.length > 0 ? ` for ${what.join(", ")}` : ""} under ${where}${
        tenants !== undefined ? ` or the tenants root ${tenantsWords(tenants)}` : ""
      } — bundles are written by a harness whose spec declares provability:, one per graded turn${
        tenants === undefined
          ? "; a managed harness files them under its tenants root (--tenants-root <dir>)"
          : ""
      }`,
    );
  }
  const bundle = await readListing(pick);
  if (args.flags["json"] === true) {
    deps.out(`${renderBundleJson(bundle)}\n`);
    return 0;
  }
  const path = shown(pick.path, deps.cwd);
  const problem = bundleProblem(bundle);
  if (problem !== undefined) {
    throw new ProvabilityCliError(
      `provability show: ${ttySafe(path)} is not a readable proof bundle (${ttySafe(problem)}) — --json prints it as stored`,
    );
  }
  deps.out(
    renderBundleLong(bundle, {
      title: [
        `proof bundle · ${path}`,
        pick.spec.research === true
          ? `  run         ${pick.sessionId} · research report`
          : `  session     ${pick.sessionId} · turn ${pick.turnNumber}${
              pick.pass > 1 ? ` · pass ${pick.pass}` : ""
            }${pick.spec.tenant !== undefined ? ` · tenant ${pick.spec.tenant}` : ""}`,
      ],
      path,
    }),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// check — the offline gate
// ---------------------------------------------------------------------------

/**
 * What the offline gate does differently from the live one, said on every
 * run that it applies to (stderr under `--json`):
 *
 *   - `sources.resolve: head` sends no request: offline is offline. URLs are
 *     checked lexically (scheme, host allow/deny, private address space).
 *   - the paraphrase-waiver judge is not called: no model runs here, so a
 *     paraphrase miss it would have been asked about stays unmet.
 *   - `scope: turn` has no "current turn" over a document: every piece of
 *     evidence given counts.
 *   - a workspace file the document cites by path is read from disk as it
 *     is now; the live gate grounds only on what a recorded `Read` returned.
 *   - without `--session`, a `proof:` citation is held to its stored
 *     artifact alone (provability's `trustStoredProofs`, which exists for
 *     exactly this): there is no run log whose `ProofCheck` call the live
 *     gate would also require. With `--session` that call is required.
 */
export const CHECK_NOTES = {
  head: "sources.resolve: head is not applied offline — no request is sent; URLs are checked lexically",
  judge:
    "provability.judge is not called offline — paraphrase misses it would have been asked about stay unmet",
  scope: "scope: turn does not apply offline — all the evidence given counts",
  workspace: (n: number): string =>
    `${plural(n, "workspace file")} cited by path ${n === 1 ? "was" : "were"} read directly from disk, as ${
      n === 1 ? "it is" : "they are"
    } now — the live gate grounds only on what a recorded Read returned`,
  report: (line: number): string =>
    `--report: from line ${line} on is the report writer's trailer (## Citations, then ## Provability) — the writer's text, not the run's claims, so it was not graded`,
  reportHint: (line: number): string =>
    `the document ends in a research report's trailer (## Citations, then ## Provability, from line ${line}): its lines were graded as claims — pass --report to grade only what the report's gate verified`,
  storedProofs:
    "proof: citations were checked against the stored artifacts alone — with no session log (--session) there is no ProofCheck call to hold them to; the live gate requires that call",
  tenantHint: (words: string): string =>
    `a managed harness files each tenant's session logs and proof artifacts under its tenants root, ${words}, which was not read — name the tenant with --tenant <id>`,
} as const;

/**
 * The `--evidence <dir>` layout. Every regular file under the directory
 * (subdirectories up to four deep; dotfiles and links skipped) is ONE fetched
 * body. Its origin — the URL the body is the page of — is, in order:
 *
 *   1. a sidecar beside it, `<file>.url`, whose first non-empty line is an
 *      `http(s)` URL or a `doi:`; else
 *   2. the file's own first line, `URL: <url>` — the line tool-web's WebFetch
 *      result opens with, so a saved WebFetch result works as is.
 *
 * A saved WebFetch result's header (`URL:`, `Status:`, `Content-Type:`, a
 * blank line) is transport, not page, and is taken off whichever names the
 * origin; when a sidecar names one URL and the header another, the file is
 * skipped — the body is the page of the one it was fetched from.
 *
 * WebFetch prepends `[user prompt: <prompt>]` and a blank line when the call
 * carried a prompt. That is the MODEL's text, and the prompt may itself hold
 * `]` and blank lines, so where the echo ends cannot be read off the file:
 * the live gate strips exactly the recorded prompt (provability's
 * `groundingBody`), and offline the prompt must be given the same way — in a
 * sidecar `<file>.prompt` holding it verbatim. Where the echo OPENS is not
 * assumed either: a result saved by hand may carry an extra header line, a
 * blank line or a note above it, so the echo counts wherever it opens near
 * the top (see {@link promptEchoAt}). A body whose top holds the echo and has
 * no `.prompt` (or one the echo does not match, or a second echo after it)
 * is skipped: guessing would let a model write a claim into its prompt and
 * find it "in the source". When the echo is stripped, what preceded it goes
 * too — WebFetch writes the echo before the page, so that is transport.
 *
 * The document being checked is never a body here either — the same file
 * (by inode, so a hard link too) or the same text, header or not.
 *
 * A skipped file cannot ground anything, so a claim citing its page fails
 * `not_fetched` — fail-closed — and the note says why. Sidecars (`.url`,
 * `.prompt`) are never bodies. Each body is indexed as a WebFetch of its URL,
 * re-wrapped in tool-web's header (so the gate reads it exactly as a live
 * result, and a body that itself opens with `URL: …` can never name a second
 * origin), under an id no `tool:` citation can name (it holds a space), so an
 * evidence file is source evidence only.
 */
export const EVIDENCE_DIR_LAYOUT =
  "each file is one fetched body; its URL is a sidecar <file>.url, else the file's first line `URL: <url>`; a `[user prompt: …]` echo needs <file>.prompt";

type EvidenceLoad = { readonly records: EvidenceRecord[]; readonly notes: string[] };

/**
 * `text` — a file read whole, or only its head when `truncated` — is the
 * document's text again (or that head of it): a copy, which cannot ground the
 * document's claims. A head is compared as a prefix, so a copy too large to
 * read whole is still caught.
 *
 * Leading BOMs are dropped from both sides first. A decoder drops only a BOM
 * at byte 0, so a copy saved under a header the save added (`URL:` …) keeps
 * its BOM mid-file and the body cut from under the header opens with U+FEFF;
 * a BOM is an encoding mark, not text, so that body is still the document.
 */
function isDocumentText(text: string, truncated: boolean, documentText: string): boolean {
  const candidate = withoutLeadingBoms(text);
  const document = withoutLeadingBoms(documentText);
  return truncated ? candidate !== "" && document.startsWith(candidate) : candidate === document;
}

const withoutLeadingBoms = (text: string): string => text.replace(/^﻿+/, "");

/**
 * The document `check` grades: its text and its file's identity. Neither
 * evidence source may hand it back as a source — by path, link, hard link or
 * copy — or a report citing itself would ground every sentence it holds and
 * pass the CI gate it exists for.
 */
type CheckedDocument = {
  readonly path: string;
  /** Decoded as openForRead decodes a source (a leading BOM dropped), so a copy compares equal. */
  readonly text: string;
  /**
   * What is graded: `text`, or under `--report` the part of a research
   * report its gate verified ({@link reportTrailerAt}). A copy of either is
   * the document.
   */
  readonly graded: string;
  readonly stat: { readonly dev: number; readonly ino: number };
};

/** `text` (or, `truncated`, its head) is the document again — whole, or the part of it graded. */
function isCopyOfDocument(text: string, truncated: boolean, doc: CheckedDocument): boolean {
  return (
    isDocumentText(text, truncated, doc.text) ||
    (doc.graded !== doc.text && isDocumentText(text, truncated, doc.graded))
  );
}

/** The writer's trailer heading: from here on a gated research report is the writer's text. */
const REPORT_TRAILER = "\n\n## Citations\n";
/** …and the section a GATED report's trailer always ends in, whatever the verdict. */
const REPORT_SECTION = "\n## Provability\n";

/**
 * Where a gated research report's writer trailer opens in `text`, or
 * undefined when `text` does not end in one. The research shape serves
 * `report.md` as the text its gate verified (title, definitions, branches),
 * then `## Citations` (the visible list) and `## Provability` (the verdict
 * table) — the WRITER's lines, not the run's claims, and graded as claims
 * they fail every floor: a passing report re-checked whole fails (design
 * §5.4, §11). The rule is report-writer's `verifiedReportText` (the LAST
 * `## Citations`, with a `## Provability` after it); apps/cli does not depend
 * on report-writer, so `provability-cli.test.ts` holds this copy to the
 * writer's source.
 *
 * Used only under `--report`: any document may END in these two headings, so
 * stripping them unasked would let an answer hide uncited claims under a
 * fake trailer. Without the flag `check` grades the whole file and says the
 * trailer is there.
 */
export function reportTrailerAt(text: string): number | undefined {
  const at = text.lastIndexOf(REPORT_TRAILER);
  if (at === -1 || !text.slice(at).includes(REPORT_SECTION)) return undefined;
  return at;
}

const SELF_GROUNDING = "a document cannot ground its own claims";

/** The origin value an evidence file names: an http(s) URL, or a doi: as its resolver URL. */
function evidenceUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const ref = classifyDefinition(trimmed);
  return ref.kind === "doi" ? doiUrl(ref.doi) : undefined;
}

/** Two origins name the same page (as URLs parse; otherwise as written). */
function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/** The opening of tool-web's WebFetch prompt echo. */
const PROMPT_ECHO = "[user prompt: ";

/** How far past a body's leading header block an echo still counts as opening it. */
const PROMPT_ECHO_WINDOW = 4096;

/** A blank line, or a header-shaped `Name: value` one (a BOM or indent allowed). */
const HEADER_LIKE_LINE = /^[\uFEFF \t]*(?:[A-Za-z][A-Za-z0-9-]*:.*)?\r?$/;

/**
 * Where a `[user prompt: …]` echo opens in `body`, or -1 — looked for rather
 * than assumed at byte 0. It counts anywhere up to {@link PROMPT_ECHO_WINDOW}
 * characters past the body's leading run of blank and `Name: value` lines, so
 * an extra or reordered header line, a blank line or a short note above it
 * does not let the model's prompt read as page. The window starts after that
 * run, not at byte 0, because the `URL:` line in it is the model's to make as
 * long as it likes. Fail-closed by design: a page that itself prints the
 * echo's opening near its top is skipped too, with the same note.
 */
function promptEchoAt(body: string): number {
  let lead = 0;
  while (lead < body.length) {
    const end = body.indexOf("\n", lead);
    if (!HEADER_LIKE_LINE.test(body.slice(lead, end === -1 ? body.length : end))) break;
    lead = end === -1 ? body.length : end + 1;
  }
  const at = body.indexOf(PROMPT_ECHO);
  return at !== -1 && at <= lead + PROMPT_ECHO_WINDOW ? at : -1;
}

/**
 * An evidence file read apart: the URL its first line names (`URL: <url>`),
 * whether that line opens a full WebFetch header (then `Status:` and
 * optionally `Content-Type:`, then a blank line — provability's
 * `webFetchHeader` rule), and the body after whichever it is.
 *
 * Leading BOMs are dropped first: the decoder drops only one, at byte 0, so a
 * file saved with a second one (or re-encoded) would otherwise open with
 * U+FEFF, fail the `URL:` match and be read whole — header and all — as page,
 * and a copy of the document under that header would stop comparing equal.
 */
function readEvidenceFile(raw: string): {
  readonly lineUrl?: string;
  readonly webFetchHeader: boolean;
  readonly body: string;
} {
  const text = withoutLeadingBoms(raw);
  const firstEnd = text.indexOf("\n");
  const first = (firstEnd === -1 ? text : text.slice(0, firstEnd)).replace(/\r$/, "");
  const m = /^URL:\s*(\S+)\s*$/.exec(first);
  if (m === null) return { webFetchHeader: false, body: text };
  const rest = firstEnd === -1 ? "" : text.slice(firstEnd + 1);
  const header = /^Status: \d{3}\r?\n(?:Content-Type:[^\n]*\r?\n)?\r?\n/.exec(rest);
  return header !== null
    ? { lineUrl: m[1] as string, webFetchHeader: true, body: rest.slice(header[0].length) }
    : { lineUrl: m[1] as string, webFetchHeader: false, body: rest };
}

/** True for a sidecar, which describes a body and never is one. */
const isSidecar = (name: string): boolean => name.endsWith(".url") || name.endsWith(".prompt");

async function evidenceDirRecords(
  dir: string,
  cwd: string,
  doc: CheckedDocument,
): Promise<EvidenceLoad> {
  const root = isAbsolute(dir) ? dir : resolve(cwd, dir);
  let rootStat: ReturnType<typeof statSync>;
  try {
    rootStat = statSync(root);
  } catch {
    throw new ProvabilityCliError(`--evidence ${dir}: no such directory`);
  }
  if (!rootStat.isDirectory()) throw new ProvabilityCliError(`--evidence ${dir}: not a directory`);
  const files: Array<{ readonly rel: string; readonly dev: number; readonly ino: number }> = [];
  const walk = (rel: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(join(root, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(join(root, childRel));
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < MAX_EVIDENCE_DEPTH) walk(childRel, depth + 1);
      } else if (stat.isFile() && !isSidecar(name)) {
        files.push({ rel: childRel, dev: stat.dev, ino: stat.ino });
      }
    }
  };
  walk("", 0);
  const notes: string[] = [];
  if (files.length > MAX_EVIDENCE_FILES) {
    notes.push(
      `--evidence: only the first ${MAX_EVIDENCE_FILES} of ${files.length} files were read`,
    );
  }
  const records: EvidenceRecord[] = [];
  const sidecar = async (rel: string) =>
    openForRead(root, rel, { maxBytes: 64 * 1024, followLeafSymlink: false });
  for (const { rel, dev, ino } of files.slice(0, MAX_EVIDENCE_FILES)) {
    const skip = (why: string): void => {
      notes.push(`--evidence: skipped ${rel}: ${why}`);
    };
    if (dev === doc.stat.dev && ino === doc.stat.ino) {
      skip(`it is the document itself — ${SELF_GROUNDING}`);
      continue;
    }
    const read = await openForRead(root, rel, {
      maxBytes: MAX_BODY_BYTES,
      followLeafSymlink: false,
    });
    if (!read.ok) {
      skip(read.reason);
      continue;
    }
    if (read.truncated)
      notes.push(`--evidence: ${rel} is over ${MAX_BODY_BYTES} bytes; its head was read`);
    const file = readEvidenceFile(read.text);
    let url: string | undefined;
    let body = file.body;
    const urlSidecar = await sidecar(`${rel}.url`);
    if (urlSidecar.ok) {
      const line = urlSidecar.text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
      url = evidenceUrl(line);
      if (url === undefined) {
        skip(`its sidecar names "${line.trim().slice(0, 120)}", not an http(s) URL or doi:`);
        continue;
      }
      if (file.webFetchHeader && file.lineUrl !== undefined && !sameUrl(url, file.lineUrl)) {
        skip(
          `its sidecar names ${url} but its WebFetch header names ${file.lineUrl.slice(0, 200)} — the body is the page it was fetched from`,
        );
        continue;
      }
      // A bare `URL:` first line is the origin only without a sidecar; with
      // one, only a full WebFetch header is transport, anything else is page.
      if (!file.webFetchHeader) body = withoutLeadingBoms(read.text);
    } else {
      url = file.lineUrl !== undefined ? evidenceUrl(file.lineUrl) : undefined;
      if (url === undefined) {
        skip(`no ${rel}.url sidecar and no "URL: <url>" first line`);
        continue;
      }
    }
    const echoAt = promptEchoAt(body);
    if (echoAt !== -1) {
      const promptFile = await sidecar(`${rel}.prompt`);
      if (!promptFile.ok) {
        skip(
          `its top holds WebFetch's "[user prompt: …]" echo — the model's own text, whose end cannot be read off the file; save the call's prompt verbatim as ${rel}.prompt`,
        );
        continue;
      }
      // An editor's trailing newline is not part of the prompt; a prompt
      // that really ends in one matches the first spelling.
      const spellings = [promptFile.text, promptFile.text.replace(/\r?\n$/, "")];
      const echo = spellings
        .map((prompt) => `${PROMPT_ECHO}${prompt}]\n\n`)
        .find((candidate) => body.startsWith(candidate, echoAt));
      if (echo === undefined) {
        skip(`its "[user prompt: …]" echo is not the prompt ${rel}.prompt holds`);
        continue;
      }
      body = body.slice(echoAt + echo.length);
      // One sidecar accounts for one echo: a second (a result saved twice)
      // is model text no `.prompt` delimits.
      if (promptEchoAt(body) !== -1) {
        skip(`a second "[user prompt: …]" echo follows the one ${rel}.prompt accounts for`);
        continue;
      }
    }
    // Every way the file can be read apart is compared — whole, after the
    // `URL:` line or header (even where a sidecar makes that line page), and
    // the body that would be indexed — so a copy saved under a header is a
    // copy however the origin was named.
    if (
      [read.text, file.body, body].some((candidate) =>
        isCopyOfDocument(candidate, read.truncated, doc),
      )
    ) {
      skip(`it is a copy of the document — ${SELF_GROUNDING}`);
      continue;
    }
    records.push(
      recordFromCall(
        {
          toolUseId: `offline evidence ${records.length + 1}`,
          toolName: "WebFetch",
          input: { url },
          content: `URL: ${url}\nStatus: 200\n\n${body}`,
          isError: false,
        },
        { workspaceRoot: cwd },
      ),
    );
  }
  return { records, notes };
}

/** The real path of `path`, or undefined when it does not resolve. */
function realOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** `child` is `parent` or lies inside it (both real, absolute). */
function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * A directory the harness keeps its own state in, and the words a refusal
 * says about it. Session logs, bundles, memory and tenants' trees hold the
 * model's own text — an `assistant_message` line is the answer verbatim — so
 * nothing under one is ever evidence.
 */
type StateRoot = { readonly dir: string; readonly why: string };

const DOT_CREWHAUS_WHY =
  "session logs, bundles and state under .crewhaus/ hold the model's own text";

/**
 * The variables that move part of a harness's state out of `.crewhaus/`, and
 * what each moved part holds. The four data-root overrides are
 * harness-supervisor's `OVERRIDE_ENV_KEYS` (a test holds this table to that
 * list, so a fifth override cannot be added without being refused here);
 * `CREWHAUS_TENANTS_ROOT` is where a managed daemon files every tenant's
 * sessions, proofs and memory — Hangar's proofs route reads it inside the
 * harness directory, so it can lie in the workspace too.
 */
export const RELOCATED_STATE_ROOTS: Readonly<Record<string, string>> = {
  CREWHAUS_SESSION_DIR: "the session logs (CREWHAUS_SESSION_DIR) hold the model's own text",
  CREWHAUS_DATASETS_DIR:
    "the datasets (CREWHAUS_DATASETS_DIR) hold captured runs — the model's own text",
  CREWHAUS_WATCHME_ROOT: "the watch-me store (CREWHAUS_WATCHME_ROOT) is the harness's own state",
  CREWHAUS_SHARED_DIR:
    "the shared knowledge store (CREWHAUS_SHARED_DIR) holds memories harnesses wrote",
  CREWHAUS_TENANTS_ROOT:
    "the managed tenants root (CREWHAUS_TENANTS_ROOT) holds each tenant's session logs, bundles and state — the model's own text",
};

/**
 * Every state root a cited path must not lie under (design §11: the offline
 * gate grounds on sources, never on what the model said): `.crewhaus/`;
 * wherever the environment relocates a part of it (relative values resolve
 * against the harness directory, as the runtime run from it resolves them);
 * the fleet knowledge store's default `.crewhaus-shared/`; and the managed
 * daemon's default tenants root — always, not only for a managed spec, since
 * any managed daemon on the machine files there and a harness directory that
 * contains it is reading that daemon's tenants. `extra` adds the roots the
 * command line named (`--tenants-root`). First match names the root.
 */
function stateRoots(deps: ProvabilityCliDeps, extra: readonly StateRoot[] = []): StateRoot[] {
  const cwd = resolve(deps.cwd);
  const roots: StateRoot[] = [{ dir: join(cwd, ".crewhaus"), why: DOT_CREWHAUS_WHY }, ...extra];
  for (const [name, why] of Object.entries(RELOCATED_STATE_ROOTS)) {
    const value = deps.env[name];
    if (value === undefined || value.trim() === "") continue;
    // Readers differ on trimming (the event log takes the value as is, the
    // tenants scope trims it): both spellings are refused.
    roots.push({ dir: resolve(cwd, value), why }, { dir: resolve(cwd, value.trim()), why });
  }
  roots.push(
    {
      dir: join(cwd, ".crewhaus-shared"),
      why: "the shared knowledge store under .crewhaus-shared/ holds memories harnesses wrote",
    },
    {
      dir: MANAGED_TENANTS_ROOT_DEFAULT,
      why: `the managed tenants root (${MANAGED_TENANTS_ROOT_DEFAULT}, a managed daemon's default) holds each tenant's session logs, bundles and state — the model's own text`,
    },
  );
  const seen = new Set<string>();
  const out: StateRoot[] = [];
  for (const root of roots) {
    const dir = realOf(root.dir) ?? resolve(root.dir);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push({ dir, why: root.why });
  }
  return out;
}

/**
 * Workspace files the document cites by path, read DIRECTLY — offline, there
 * is no run whose `Read` calls the index could come from, so the file as it is
 * on disk now stands in for the body a `Read` would have returned. Contained:
 * a path that leaves the workspace (a link included) is not read, and the
 * verifier then reports it as the gate would.
 *
 * Never read, so a citation of one fails `not_fetched` (fail-closed):
 *
 *   - the document itself — by path, through a link, as a hard link, or as a
 *     byte-identical copy. A report citing itself would otherwise ground
 *     every sentence it contains, and pass the CI gate it exists for.
 *   - anything under a {@link stateRoots} directory: `.crewhaus/`, the
 *     session-log directory, a managed tenants root, the knowledge store —
 *     session logs, bundles, state and memory hold the model's own words (an
 *     `assistant_message` line is the answer verbatim).
 */
async function workspaceFileRecords(
  doc: CheckedDocument,
  opts: { readonly cwd: string; readonly stateRoots: readonly StateRoot[] },
): Promise<EvidenceLoad> {
  const { cwd } = opts;
  const records: EvidenceRecord[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const source of citationDefinitions(doc.graded).values()) {
    const ref = classifyDefinition(source);
    if (ref.kind !== "path") continue;
    const rel = originKey(ref, { workspaceRoot: cwd });
    if (rel === undefined || seen.has(rel)) continue;
    seen.add(rel);
    const abs = resolve(cwd, rel);
    const real = realOf(abs) ?? abs;
    const state =
      rel.split("/")[0] === ".crewhaus"
        ? DOT_CREWHAUS_WHY
        : opts.stateRoots.find((root) => within(root.dir, real))?.why;
    if (state !== undefined) {
      notes.push(`${rel} is not read: ${state}`);
      continue;
    }
    let same = false;
    try {
      const stat = statSync(abs);
      same = stat.dev === doc.stat.dev && stat.ino === doc.stat.ino;
    } catch {
      same = false; // missing: the verifier says so
    }
    if (same) {
      notes.push(`${rel} is the document itself — ${SELF_GROUNDING}`);
      continue;
    }
    const read = await openForRead(cwd, rel, { maxBytes: MAX_BODY_BYTES });
    if (!read.ok) continue; // the verifier says why (missing, outside the workspace)
    if (isCopyOfDocument(read.text, read.truncated, doc)) {
      notes.push(`${rel} is a copy of the document — ${SELF_GROUNDING}`);
      continue;
    }
    if (read.truncated) notes.push(`${rel} is over ${MAX_BODY_BYTES} bytes; its head was read`);
    records.push(
      recordFromCall(
        {
          toolUseId: `offline read ${records.length + 1}`,
          toolName: "Read",
          input: { path: rel },
          content: read.text,
          isError: false,
        },
        { workspaceRoot: cwd },
      ),
    );
  }
  return { records, notes };
}

/** Where session logs live: `CREWHAUS_SESSION_DIR`, else `<cwd>/.crewhaus/sessions`. */
function sessionRoot(deps: ProvabilityCliDeps): string {
  const fromEnv = deps.env["CREWHAUS_SESSION_DIR"];
  return resolve(
    deps.cwd,
    fromEnv !== undefined && fromEnv !== "" ? fromEnv : ".crewhaus/sessions",
  );
}

/** Read-only proof artifacts across several proofs roots: the first that has an id answers. */
function artifactsAcross(roots: readonly string[]): ProofArtifactStore {
  const stores = roots.map((rootDir) => createFileArtifactStore({ rootDir }));
  return {
    async get(id: string): Promise<ProofArtifact | undefined> {
      for (const store of stores) {
        const found = await store.get(id);
        if (found !== undefined) return found;
      }
      return undefined;
    },
    async put(): Promise<void> {
      throw new ProvabilityCliError("provability check never writes a proof artifact");
    },
    async list(): Promise<ReadonlyArray<ProofArtifact>> {
      const all: ProofArtifact[] = [];
      for (const store of stores) all.push(...(await store.list()));
      return all;
    },
  };
}

/** The text(s) the evidence holds for a call — what catalogReplay compares a spilled replay against. */
function loggedResults(
  evidence: EvidenceIndex,
): (toolName: string, input: unknown) => ReadonlyArray<string> {
  return (toolName, input) => {
    let key: string | undefined;
    try {
      key = JSON.stringify(input);
    } catch {
      key = undefined;
    }
    const found: string[] = [];
    for (const record of evidence.all()) {
      if (record.toolName !== toolName || record.isError) continue;
      let same = record.input === input;
      if (!same && key !== undefined) {
        try {
          same = JSON.stringify(record.input) === key;
        } catch {
          same = false;
        }
      }
      if (same) found.push(record.content);
    }
    return found;
  };
}

/**
 * The managed tenant `check` reads evidence for (`--tenant <id>`), and the
 * tenants root it lies under. A managed turn runs under its request's tenant:
 * the daemon logs the session under `<root>/<tenant>/sessions/` and
 * `ProofCheck` files its artifacts under `<root>/<tenant>/proofs/<spec>/`
 * (tool-proof's `defaultProofsRoot`), never `.crewhaus/` — so without the
 * tenant a managed answer's `tool:` and `proof:` citations cannot be found
 * offline. ONE tenant, named: an answer is that tenant's, and another
 * tenant's evidence must not ground it. The root resolves as `show` and
 * `audit` resolve it ({@link tenantsScope}); the tenant must be a tenant id
 * and a real directory under it (a link is not followed).
 */
type CheckTenant = { readonly id: string; readonly dir: string; readonly scope: TenantsScope };

function checkTenant(
  args: ParsedArgs,
  deps: ProvabilityCliDeps,
  spec: SpecView | undefined,
): { readonly tenant?: CheckTenant; readonly scope?: TenantsScope } {
  const id = flagString(args, "tenant");
  const scope = tenantsScope(args, deps, spec);
  if (id === undefined) {
    if (flagString(args, "tenants-root") !== undefined) {
      throw new ProvabilityCliError(
        "provability check: --tenants-root needs --tenant <id> — an answer is one tenant's, and only that tenant's evidence may ground it",
      );
    }
    return scope !== undefined ? { scope } : {};
  }
  if (!isTenantId(id)) {
    throw new ProvabilityCliError(
      `invalid --tenant "${id}" — expected a tenant id (letters, digits, - and _, at most 64)`,
    );
  }
  if (scope === undefined) {
    throw new ProvabilityCliError(
      `provability check: --tenant ${id} needs a tenants root — --tenants-root <dir>, CREWHAUS_TENANTS_ROOT, or a --spec whose target is managed`,
    );
  }
  const dir = join(scope.root, id);
  if (!isRealDir(dir)) {
    throw new ProvabilityCliError(
      `provability check: no tenant ${id} under the tenants root ${tenantsWords(scope)}`,
    );
  }
  return { tenant: { id, dir, scope }, scope };
}

async function checkCommand(args: ParsedArgs, deps: ProvabilityCliDeps): Promise<number> {
  const docPath = args.positional[0] as string;
  const absDoc = isAbsolute(docPath) ? docPath : resolve(deps.cwd, docPath);
  let docStat: Stats;
  try {
    docStat = statSync(absDoc);
    if (!docStat.isFile()) throw new Error("not a regular file");
  } catch (err) {
    throw new ProvabilityCliError(
      `provability check: cannot read "${docPath}": ${(err as Error).message}`,
      err,
    );
  }
  if (docStat.size > MAX_DOCUMENT_BYTES) {
    throw new ProvabilityCliError(
      `provability check: "${docPath}" is over ${MAX_DOCUMENT_BYTES} bytes`,
    );
  }
  // Decoded exactly as openForRead decodes the evidence and workspace files
  // it is compared against (one WHATWG TextDecoder, which drops a leading
  // BOM): `readFileSync(…, "utf8")` keeps U+FEFF, so a byte-identical copy of
  // a BOM-prefixed document would stop comparing equal and ground every claim
  // in it. A BOM is an encoding mark, not text, so it is not graded either.
  const text = new TextDecoder().decode(readFileSync(absDoc));
  const notes: string[] = [];
  // A research report's writer trailer, graded only when not --report (see
  // reportTrailerAt). Line numbers are the file's: the graded text is a prefix.
  const trailerAt = reportTrailerAt(text);
  const trailerLine = trailerAt !== undefined ? text.slice(0, trailerAt + 2).split("\n").length : 0;
  let graded = text;
  if (args.flags["report"] === true) {
    if (trailerAt === undefined) {
      throw new ProvabilityCliError(
        `provability check --report: "${docPath}" does not end in a gated research report's trailer (## Citations, then ## Provability) — check it without --report`,
      );
    }
    graded = `${text.slice(0, trailerAt)}\n`;
    notes.push(CHECK_NOTES.report(trailerLine));
  } else if (trailerAt !== undefined) {
    notes.push(CHECK_NOTES.reportHint(trailerLine));
  }
  const doc: CheckedDocument = {
    path: absDoc,
    text,
    graded,
    stat: { dev: docStat.dev, ino: docStat.ino },
  };

  const level = levelFlag(args);
  const specPath = flagString(args, "spec");
  const spec = specPath !== undefined ? loadSpec(specPath, deps.cwd) : undefined;
  const { tenant, scope: tenants } = checkTenant(args, deps, spec);
  let config: ProvabilityConfig;
  let configSource: string;
  if (spec?.provability !== undefined) {
    config = level !== undefined ? { ...spec.provability, level } : spec.provability;
    configSource = `${shown(spec.path, deps.cwd)}'s provability block${level !== undefined ? ` at --level ${level}` : ""}`;
  } else if (level !== undefined) {
    config = { ...defaultProvabilityConfig(), level };
    configSource = `the defaults at --level ${level}${spec !== undefined ? ` (${shown(spec.path, deps.cwd)} declares no provability block)` : ""}`;
  } else {
    throw new ProvabilityCliError(
      spec !== undefined
        ? `provability check: ${shown(spec.path, deps.cwd)} declares no provability block — pass --level <rung>`
        : "provability check: --level <rung> is required (or --spec <spec.yaml> with a provability block)",
    );
  }

  if (config.sources.resolve === "head") {
    config = { ...config, sources: { ...config.sources, resolve: "off" } };
    notes.push(CHECK_NOTES.head);
  }
  if (config.judge !== undefined) notes.push(CHECK_NOTES.judge);
  if (config.scope === "turn") notes.push(CHECK_NOTES.scope);
  const cites = (kind: string): boolean =>
    [...citationDefinitions(graded).values()].some((s) => classifyDefinition(s).kind === kind);
  if (tenant === undefined && tenants !== undefined && (cites("proof") || cites("tool"))) {
    notes.push(CHECK_NOTES.tenantHint(tenantsWords(tenants)));
  }

  const records: EvidenceRecord[] = [];
  const summary: string[] = [];
  const session = sessionFlag(args, false);
  if (session !== undefined) {
    // The tenant's logs first: a managed session is logged under its tenant.
    const tenantSessions = tenant !== undefined ? join(tenant.dir, "sessions") : undefined;
    const roots = [
      ...(tenantSessions !== undefined && isRealDir(tenantSessions) ? [tenantSessions] : []),
      sessionRoot(deps),
    ];
    const rootDir = roots.find((root) => existsSync(join(root, `${session}.jsonl`)));
    if (rootDir === undefined) {
      throw new ProvabilityCliError(
        `provability check: no event log for ${session} under ${roots.map((r) => shown(r, deps.cwd)).join(" or ")}${
          tenant === undefined && tenants !== undefined
            ? ` — a managed harness logs each tenant's sessions under ${tenantsWords(tenants)}/<tenant>/sessions: name the tenant with --tenant <id>`
            : ""
        }`,
      );
    }
    const fromLog = await evidenceFromSessionLog({
      sessionId: session,
      rootDir,
      workspaceRoot: deps.cwd,
      onUnreadable: (info) =>
        notes.push(`the log of ${info.sessionId} could not be read to its end: ${info.message}`),
    });
    records.push(...fromLog);
    summary.push(
      `${plural(fromLog.length, "tool call")} from ${session}${rootDir === tenantSessions ? ` (tenant ${tenant?.id})` : ""}`,
    );
  }
  const evidenceDir = flagString(args, "evidence");
  if (evidenceDir !== undefined) {
    const loaded = await evidenceDirRecords(evidenceDir, deps.cwd, doc);
    records.push(...loaded.records);
    notes.push(...loaded.notes);
    summary.push(
      `${plural(loaded.records.length, "fetched body", "fetched bodies")} from ${evidenceDir}`,
    );
  }
  // A tenants root named on the command line is state like any other: a
  // path citation into it is never read as a source.
  const named =
    tenants?.source === "--tenants-root"
      ? [
          {
            dir: realOf(tenants.root) ?? tenants.root,
            why: "the managed tenants root (--tenants-root) holds each tenant's session logs, bundles and state — the model's own text",
          },
        ]
      : [];
  const files = await workspaceFileRecords(doc, {
    cwd: deps.cwd,
    stateRoots: stateRoots(deps, named),
  });
  records.push(...files.records);
  notes.push(...files.notes);
  if (files.records.length > 0) {
    summary.push(`${plural(files.records.length, "workspace file")} read directly`);
    notes.push(CHECK_NOTES.workspace(files.records.length));
  }
  const evidence = buildEvidenceIndex(records);

  // Proof artifacts: the harness's own proofs tree, then the tenant's.
  const artifactRoots = [
    ...(spec !== undefined
      ? [proofsRoot(deps.cwd, spec.proofsDir)]
      : specDirs(deps.cwd, undefined).map((d) => d.root)),
    ...(tenant !== undefined && isRealDir(join(tenant.dir, "proofs"))
      ? specDirsUnder(join(tenant.dir, "proofs"), tenant.scope.only, tenant.id).map((d) => d.root)
      : []),
  ];
  if (tenant !== undefined) {
    summary.push(`tenant ${tenant.id} under ${tenantsWords(tenant.scope)}`);
  }
  const wantsReplay =
    config.execution.replay &&
    levelRank(config.level) >= levelRank("checked") &&
    deps.loadCatalog !== undefined &&
    cites("tool");
  const replay = wantsReplay
    ? catalogReplay(await (deps.loadCatalog as () => Promise<GateCatalog>)(), {
        logged: loggedResults(evidence),
      })
    : undefined;

  // No run log at hand: a stored artifact is all there is to hold a proof:
  // citation to (CHECK_NOTES.storedProofs).
  const trustStoredProofs = session === undefined;
  if (trustStoredProofs && cites("proof")) notes.push(CHECK_NOTES.storedProofs);
  const bundle = await verifyDocument(graded, {
    config,
    evidence,
    workspaceRoot: deps.cwd,
    artifacts: artifactsAcross(artifactRoots),
    ...(trustStoredProofs ? { trustStoredProofs } : {}),
    ...(replay !== undefined ? { replay: replay.replay, isPureTool: replay.isPureTool } : {}),
    now: deps.now,
  });

  if (args.flags["json"] === true) {
    for (const note of notes) deps.err(`note: ${ttySafe(note)}\n`);
    deps.out(`${renderBundleJson(bundle)}\n`);
  } else {
    const head = [
      `offline check · ${shown(absDoc, deps.cwd)}`,
      `  config      ${configSource}`,
      `  evidence    ${summary.length > 0 ? summary.join(" · ") : "none (only the citations themselves can be checked)"}`,
      ...notes.map((note) => `  note        ${note}`),
    ];
    deps.out(renderBundleLong(bundle, { title: head }));
  }
  return bundle.verdict === "pass" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

/** One origin bound (ok) to at least this many claims in one answer is looked at. */
export const SHARED_EVIDENCE_MIN_CLAIMS = 4;
/** …and flagged when those claims' mean pairwise content-token overlap is below this. */
export const UNRELATED_OVERLAP = 0.2;
/** A formal statement whose content tokens overlap the prose this much is a restatement. */
export const RESTATED_SIMILARITY = 0.8;

type RungCounts = Record<Rung, number>;

const emptyRungs = (): RungCounts => ({ none: 0, cited: 0, grounded: 0, checked: 0, proven: 0 });

export type ProvabilityAudit = {
  readonly version: 1;
  readonly generatedAt: string;
  /** ISO lower bound, when `--since` was given. */
  readonly since?: string;
  /** The spec the audit was narrowed to, when one was named. */
  readonly spec?: string;
  /** The managed tenants root also read, when there was one. */
  readonly tenantsRoot?: string;
  readonly bundles: {
    /** Bundles read: every pass of every turn (a retried turn keeps each). */
    readonly count: number;
    /** The graded turns those bundles are passes of. (0.8.0 additive, fix pass.) */
    readonly turns: number;
    /** Bundles that exist but could not be read (malformed, refused). */
    readonly unreadable: number;
    readonly truncated: boolean;
    readonly verdicts: Record<ProofBundle["verdict"], number>;
    readonly achieved: RungCounts;
    readonly floors: Record<ProvabilityLevel, number>;
  };
  readonly claims: {
    readonly total: number;
    readonly met: number;
    readonly unmet: number;
    readonly assumptions: number;
    readonly assumptionsRefused: number;
  };
  readonly unmetReasons: ReadonlyArray<{ readonly reason: UnmetReason; readonly count: number }>;
  /** Declared assumptions (accepted + refused) / claims; null with no claims. */
  readonly assumptionRate: number | null;
  readonly judgeWaivers: {
    readonly bindings: number;
    /** Source bindings that met their rung — what a waiver could have flipped. */
    readonly okSourceBindings: number;
    readonly rate: number | null;
    readonly bundles: number;
  };
  /** The event log's `provability_graded` lines: one per gate pass, retries included. */
  readonly passes: {
    readonly count: number;
    readonly sessions: number;
    readonly verdicts: Record<ProofBundle["verdict"], number>;
    readonly achieved: RungCounts;
    readonly retries: number;
    readonly escalations: number;
    readonly judgeCostUsdMicros: number;
  };
  readonly gaming: {
    readonly sharedEvidence: ReadonlyArray<{
      readonly bundle: string;
      readonly origin: string;
      readonly kind: ProofBinding["kind"];
      readonly claims: number;
      readonly overlap: number;
    }>;
    readonly replayMismatches: ReadonlyArray<{
      readonly bundle: string;
      readonly ref: string;
      readonly origin?: string;
      readonly claim: string;
    }>;
    readonly restatedProofs: ReadonlyArray<{
      readonly bundle: string;
      readonly artifact: string;
      readonly similarity: number;
      readonly claim: string;
    }>;
  };
};

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const clipText = (text: string, max = 160): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * The three gaming signals over one bundle (design §10, §11). Each is a
 * pointer for a human to look at, not a verdict — a long policy page can
 * honestly ground six unrelated claims — which is why the audit lists them
 * and never fails on them.
 */
function gamingSignals(
  bundle: ProofBundle,
  where: string,
  into: {
    -readonly [K in keyof ProvabilityAudit["gaming"]]: Array<ProvabilityAudit["gaming"][K][number]>;
  },
): void {
  const groups = new Map<
    string,
    { kind: ProofBinding["kind"]; origin: string; claims: Set<number> }
  >();
  for (const claim of bundle.claims) {
    for (const b of claim.bindings) {
      if (b.kind === "assumption") continue;
      if (b.ok) {
        const origin = b.origin ?? b.ref;
        const key = `${b.kind} ${origin}`;
        const group = groups.get(key) ?? { kind: b.kind, origin, claims: new Set<number>() };
        group.claims.add(claim.index);
        groups.set(key, group);
      }
      if (b.reason === "replay_mismatch") {
        into.replayMismatches.push({
          bundle: where,
          ref: b.ref,
          ...(b.origin !== undefined ? { origin: b.origin } : {}),
          claim: clipText(claim.text),
        });
      }
      if (b.kind === "formal" && b.statement !== undefined && b.ok) {
        const similarity = jaccard(contentTokens(b.statement), contentTokens(claim.text));
        if (similarity >= RESTATED_SIMILARITY) {
          into.restatedProofs.push({
            bundle: where,
            artifact: b.origin ?? b.ref,
            similarity: round3(similarity),
            claim: clipText(claim.text),
          });
        }
      }
    }
  }
  const textOf = new Map(bundle.claims.map((c) => [c.index, contentTokens(c.text)]));
  for (const group of groups.values()) {
    if (group.claims.size < SHARED_EVIDENCE_MIN_CLAIMS) continue;
    const sets = [...group.claims].map((i) => textOf.get(i) ?? new Set<string>());
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        sum += jaccard(sets[i] as Set<string>, sets[j] as Set<string>);
        pairs += 1;
      }
    }
    const overlap = pairs === 0 ? 1 : sum / pairs;
    if (overlap < UNRELATED_OVERLAP) {
      into.sharedEvidence.push({
        bundle: where,
        origin: group.origin,
        kind: group.kind,
        claims: group.claims.size,
        overlap: round3(overlap),
      });
    }
  }
}

type GradedLine = {
  readonly sessionId: string;
  readonly verdict?: unknown;
  readonly achieved?: unknown;
  readonly retryIndex?: unknown;
  readonly escalatedTo?: unknown;
  readonly bundlePath?: unknown;
  readonly judgeCostUsdMicros?: unknown;
};

/** Every `provability_graded` payload in the session logs under `root`, newer than `sinceMs`. */
async function gradedLines(
  root: string,
  sinceMs: number | undefined,
  notes: string[],
): Promise<GradedLine[]> {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const logs = names
    .map((name) => /^(sess_[0-9a-f]{16})\.jsonl$/.exec(name)?.[1])
    .filter((id): id is string => id !== undefined)
    .map((id) => {
      try {
        return { id, mtimeMs: lstatSync(join(root, `${id}.jsonl`)).mtimeMs };
      } catch {
        return { id, mtimeMs: -1 };
      }
    })
    .filter((log) => log.mtimeMs >= 0 && (sinceMs === undefined || log.mtimeMs >= sinceMs))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (logs.length > MAX_AUDIT_SESSIONS) {
    notes.push(
      `only the ${MAX_AUDIT_SESSIONS} most recent of ${logs.length} session logs were read`,
    );
  }
  const out: GradedLine[] = [];
  for (const { id } of logs.slice(0, MAX_AUDIT_SESSIONS)) {
    const log = await openEventLog(id, { rootDir: root });
    try {
      for await (const event of log.read(sinceMs !== undefined ? { since: sinceMs } : {})) {
        if (event.kind !== "provability_graded") continue;
        if (typeof event.payload !== "object" || event.payload === null) continue;
        out.push({ ...(event.payload as Record<string, unknown>), sessionId: id });
      }
    } catch (err) {
      notes.push(`the log of ${id} could not be read to its end: ${(err as Error).message}`);
    } finally {
      await log.close();
    }
  }
  return out;
}

const isRung = (value: unknown): value is Rung => value === "none" || isProvabilityLevel(value);
const isVerdict = (value: unknown): value is ProofBundle["verdict"] =>
  value === "pass" || value === "fail" || value === "unverified";

/** The audit over `cwd`'s proofs tree and session logs — and a tenants root's (exported for tests). */
export async function buildAudit(opts: {
  readonly cwd: string;
  readonly sessionRootDir: string;
  readonly now: Date;
  readonly sinceMs?: number;
  readonly spec?: SpecView;
  readonly tenants?: TenantsScope;
}): Promise<{ readonly audit: ProvabilityAudit; readonly notes: string[] }> {
  const notes: string[] = [];
  const dirs = allSpecDirs(opts.cwd, opts.spec, opts.tenants);
  // Every pass: a retried turn keeps the failing pass a retry fixed, and
  // that bundle is what the audit exists to surface (design §5.3, §10).
  const all = (await listings(dirs, { allPasses: true })).filter(
    (l) => opts.sinceMs === undefined || l.mtimeMs >= opts.sinceMs,
  );
  const truncated = all.length > MAX_AUDIT_BUNDLES;
  if (truncated) {
    notes.push(`only the ${MAX_AUDIT_BUNDLES} newest of ${all.length} bundles were read`);
  }
  const verdicts: Record<ProofBundle["verdict"], number> = { pass: 0, fail: 0, unverified: 0 };
  const achieved = emptyRungs();
  const floors: Record<ProvabilityLevel, number> = { cited: 0, grounded: 0, checked: 0, proven: 0 };
  const claims = { total: 0, met: 0, unmet: 0, assumptions: 0, assumptionsRefused: 0 };
  const reasons = new Map<UnmetReason, number>();
  let waived = 0;
  let okSource = 0;
  let waivedBundles = 0;
  let unreadable = 0;
  let count = 0;
  const gaming = { sharedEvidence: [], replayMismatches: [], restatedProofs: [] } as {
    -readonly [K in keyof ProvabilityAudit["gaming"]]: Array<ProvabilityAudit["gaming"][K][number]>;
  };
  const sessionsWithBundles = new Set<string>();
  const turnsRead = new Set<string>();
  for (const listing of all.slice(0, MAX_AUDIT_BUNDLES)) {
    let bundle: ProofBundle;
    try {
      bundle = await readListing(listing);
    } catch (err) {
      unreadable += 1;
      notes.push(`unreadable bundle ${shown(listing.path, opts.cwd)}: ${(err as Error).message}`);
      continue;
    }
    // The store checked the top level only; everything summed below is
    // checked here, so a malformed bundle is unreadable rather than a crash
    // or a `null` total.
    const problem = bundleProblem(bundle);
    if (problem !== undefined) {
      unreadable += 1;
      notes.push(`unreadable bundle ${shown(listing.path, opts.cwd)}: ${problem}`);
      continue;
    }
    count += 1;
    sessionsWithBundles.add(listing.sessionId);
    turnsRead.add(
      [listing.spec.root, listing.sessionId, String(listing.turnNumber)].join("\u0000"),
    );
    verdicts[bundle.verdict] += 1;
    achieved[bundle.achieved] += 1;
    floors[bundle.level] += 1;
    claims.total += bundle.claimCount;
    claims.met += bundle.met;
    claims.unmet += bundle.unmet;
    claims.assumptions += bundle.assumptions + (bundle.hypotheses ?? 0);
    claims.assumptionsRefused += bundle.assumptionsRefused ?? 0;
    waived += bundle.judgeWaived;
    if (bundle.judgeWaived > 0) waivedBundles += 1;
    for (const claim of bundle.claims) {
      for (const b of claim.bindings) if (b.kind === "source" && b.ok) okSource += 1;
      if (claim.status !== "unmet") continue;
      for (const reason of claimReasons(claim)) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    gamingSignals(bundle, shown(listing.path, opts.cwd), gaming);
  }

  // The event log: one line per gate PASS (a retried turn is several),
  // which the bundles now match pass for pass where they were persisted —
  // and which also counts passes whose bundle was never written (render:
  // none, a persist that failed).
  const markerOf = (dir: string): string => `${sep}proofs${sep}${dir}${sep}`;
  const ofSpec = (line: GradedLine, dir: string | undefined): boolean =>
    dir === undefined ||
    (typeof line.bundlePath === "string" && line.bundlePath.includes(markerOf(dir))) ||
    sessionsWithBundles.has(line.sessionId);
  const lines = (await gradedLines(opts.sessionRootDir, opts.sinceMs, notes)).filter((line) =>
    ofSpec(line, opts.spec?.proofsDir),
  );
  // A tenants root is shared by every managed harness on the machine: its
  // logs are narrowed to the harness's spec whenever that is known.
  if (opts.tenants !== undefined) {
    const only = opts.spec?.proofsDir ?? opts.tenants.only;
    for (const root of tenantSessionRoots(opts.tenants)) {
      for (const line of await gradedLines(root, opts.sinceMs, notes)) {
        if (ofSpec(line, only)) lines.push(line);
      }
    }
  }
  const passes = {
    count: lines.length,
    sessions: new Set(lines.map((l) => l.sessionId)).size,
    verdicts: { pass: 0, fail: 0, unverified: 0 } as Record<ProofBundle["verdict"], number>,
    achieved: emptyRungs(),
    retries: 0,
    escalations: 0,
    judgeCostUsdMicros: 0,
  };
  for (const line of lines) {
    if (isVerdict(line.verdict)) passes.verdicts[line.verdict] += 1;
    if (isRung(line.achieved)) passes.achieved[line.achieved] += 1;
    if (typeof line.retryIndex === "number" && line.retryIndex > 0) passes.retries += 1;
    if (typeof line.escalatedTo === "string") passes.escalations += 1;
    if (typeof line.judgeCostUsdMicros === "number") {
      passes.judgeCostUsdMicros += line.judgeCostUsdMicros;
    }
  }

  const declared = claims.assumptions + claims.assumptionsRefused;
  const audit: ProvabilityAudit = {
    version: 1,
    generatedAt: opts.now.toISOString(),
    ...(opts.sinceMs !== undefined ? { since: new Date(opts.sinceMs).toISOString() } : {}),
    ...(opts.spec !== undefined ? { spec: opts.spec.name } : {}),
    ...(opts.tenants !== undefined ? { tenantsRoot: opts.tenants.root } : {}),
    bundles: { count, turns: turnsRead.size, unreadable, truncated, verdicts, achieved, floors },
    claims,
    unmetReasons: [...reasons.entries()]
      .map(([reason, n]) => ({ reason, count: n }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    assumptionRate: claims.total === 0 ? null : round3(declared / claims.total),
    judgeWaivers: {
      bindings: waived,
      okSourceBindings: okSource,
      rate: okSource === 0 ? null : round3(waived / okSource),
      bundles: waivedBundles,
    },
    passes,
    gaming,
  };
  return { audit, notes };
}

function rungLine(counts: RungCounts): string {
  return (["none", ...PROVABILITY_LEVELS] as Rung[]).map((r) => `${r} ${counts[r]}`).join(" · ");
}

export function renderAudit(audit: ProvabilityAudit, notes: readonly string[]): string {
  const b = audit.bundles;
  const lines: string[] = [
    `provability audit${audit.spec !== undefined ? ` · ${audit.spec}` : ""} · ${
      audit.since !== undefined ? `since ${audit.since}` : "all time"
    }${audit.tenantsRoot !== undefined ? ` · tenants ${audit.tenantsRoot}` : ""}`,
    `  bundles     ${plural(b.turns, "graded turn")}${
      b.count !== b.turns ? ` (${plural(b.count, "bundle")}: every pass of a retried turn)` : ""
    } · ✓ ${b.verdicts.pass} pass · ✗ ${b.verdicts.fail} fail · ? ${b.verdicts.unverified} unverified${
      b.unreadable > 0 ? ` · ${b.unreadable} unreadable` : ""
    }`,
    `  achieved    ${rungLine(b.achieved)}`,
    `  floors      ${PROVABILITY_LEVELS.map((l) => `${l} ${b.floors[l]}`).join(" · ")}`,
    `  claims      ${audit.claims.total} · met ${audit.claims.met} · unmet ${audit.claims.unmet} · assumptions ${
      audit.claims.assumptions + audit.claims.assumptionsRefused
    }${audit.claims.assumptionsRefused > 0 ? ` (${audit.claims.assumptionsRefused} refused)` : ""}`,
    `  assumption rate  ${
      audit.assumptionRate === null
        ? "n/a (no claims)"
        : `${percent(audit.assumptionRate)} of claims are declared assumptions`
    }`,
    `  judge waivers    ${
      audit.judgeWaivers.rate === null
        ? `${audit.judgeWaivers.bindings} (no grounded source bindings)`
        : `${audit.judgeWaivers.bindings} of ${audit.judgeWaivers.okSourceBindings} met source bindings (${percent(
            audit.judgeWaivers.rate,
          )}) in ${plural(audit.judgeWaivers.bundles, "bundle")}`
    }`,
    `  gate passes      ${plural(audit.passes.count, "provability_graded line")} in ${plural(
      audit.passes.sessions,
      "session",
    )} · ${plural(audit.passes.retries, "retry", "retries")} · ${plural(
      audit.passes.escalations,
      "escalation",
    )} · ✓ ${audit.passes.verdicts.pass} ✗ ${audit.passes.verdicts.fail} ? ${audit.passes.verdicts.unverified}`,
    "",
    "unmet reasons",
  ];
  if (audit.unmetReasons.length === 0) lines.push("  none");
  for (const r of audit.unmetReasons) lines.push(`  ${r.reason.padEnd(22)} ${r.count}`);
  const g = audit.gaming;
  lines.push("", "gaming signals (pointers to review, not verdicts)");
  lines.push(`  one evidence ref bound to many unrelated claims (${g.sharedEvidence.length})`);
  for (const s of g.sharedEvidence) {
    lines.push(
      `    ${s.bundle}  ${s.kind} ${s.origin} → ${s.claims} claims, mean overlap ${s.overlap}`,
    );
  }
  lines.push(`  replay mismatches (${g.replayMismatches.length})`);
  for (const s of g.replayMismatches) {
    lines.push(
      `    ${s.bundle}  ${s.ref}${s.origin !== undefined ? ` ${s.origin}` : ""}: "${s.claim}"`,
    );
  }
  lines.push(`  proof statements near-identical to the prose (${g.restatedProofs.length})`);
  for (const s of g.restatedProofs) {
    lines.push(`    ${s.bundle}  ${s.artifact} (similarity ${s.similarity}): "${s.claim}"`);
  }
  for (const note of notes) lines.push(`note: ${note}`);
  return ttyText(lines);
}

async function auditCommand(args: ParsedArgs, deps: ProvabilityCliDeps): Promise<number> {
  const sinceRaw = flagString(args, "since");
  const now = deps.now();
  const sinceMs = sinceRaw !== undefined ? parseSince(sinceRaw, now) : undefined;
  const specPath = args.positional[0];
  const spec = specPath !== undefined ? loadSpec(specPath, deps.cwd) : undefined;
  const tenants = tenantsScope(args, deps, spec);
  const { audit, notes } = await buildAudit({
    cwd: deps.cwd,
    sessionRootDir: sessionRoot(deps),
    now,
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    ...(spec !== undefined ? { spec } : {}),
    ...(tenants !== undefined ? { tenants } : {}),
  });
  if (args.flags["json"] === true) {
    for (const note of notes) deps.err(`note: ${ttySafe(note)}\n`);
    deps.out(`${JSON.stringify(audit, null, 2)}\n`);
  } else {
    deps.out(renderAudit(audit, notes));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// checkers (and doctor's probe)
// ---------------------------------------------------------------------------

export type CheckerReport = {
  readonly sandbox: {
    readonly backend: string | null;
    readonly available: boolean;
    readonly reason?: string;
  };
  readonly spec?: string;
  /** Set when the spec's harness never runs a checker (see {@link runsProofCheckers}). */
  readonly note?: string;
  readonly checkers: ReadonlyArray<
    CheckerListing & { readonly configured: boolean; readonly image?: string }
  >;
};

/** Whether a checker runs in a sandbox (the ones whose probe needs a container). */
const SANDBOX_CHECKERS: ReadonlySet<string> = new Set(["smt", "lean4"]);

/** The builtin keys of the two tools that run a checker (tool-proof's exports). */
const CHECKER_TOOL_KEYS: ReadonlySet<string> = new Set(["proofCheck", "proofCheckers"]);

/**
 * Whether a harness ever runs a proof checker — the question doctor's probe
 * and the `configured` marks answer for (design §11: doctor probes the
 * checkers a harness USES). A checker runs only inside `ProofCheck` /
 * `ProofCheckers`, and a run carries those when the gate adds them
 * (evaluation-service's `wantsProofCheckTools`, the one rule: a `proven`
 * floor, or `formal.checkers` the spec chose itself) or when the spec listed
 * one in `tools:` (the gate swaps it for its bound twin at any level). Every
 * gated spec lowers `formal.checkers: [builtin, smt]`, so reading the list
 * alone would probe — and on docker, pull — the Z3 image for a `cited`
 * harness that never calls a checker.
 */
export function runsProofCheckers(
  config: ProvabilityConfig,
  tools: readonly string[] = [],
): boolean {
  return wantsProofCheckTools(config) || tools.some((key) => CHECKER_TOOL_KEYS.has(key));
}

function imageOf(id: string, config: ProvabilityConfig): string | undefined {
  if (id === "smt") return DEFAULT_SMT_IMAGE;
  if (id === "lean4") return config.formal.image ?? DEFAULT_LEAN4_IMAGE;
  return undefined;
}

/**
 * Probe `ids` (default: every checker this release ships, the configured
 * ones first in their preference order) under `config`. The sandbox is the
 * one the run would use — `CREWHAUS_SANDBOX`, built by `@crewhaus/sandbox` —
 * unless the deps inject one.
 */
export async function probeCheckers(
  config: ProvabilityConfig,
  deps: Pick<ProvabilityCliDeps, "env" | "sandboxAvailable" | "createSandbox" | "probeTimeoutMs">,
  ids?: readonly string[],
): Promise<CheckerReport> {
  const configured = defaultCheckerIds(config);
  const order = ids ?? [...new Set([...configured, ...KNOWN_CHECKER_IDS])];
  const resolved = resolveSandboxBackend(deps.env);
  const sandboxAvailable = deps.sandboxAvailable ?? sandboxAvailableFromEnv(deps.env);
  const checkers = buildDefaultCheckers(
    {
      ...config,
      formal: {
        ...config.formal,
        checkers: order.filter((id): id is "builtin" | "smt" | "lean4" =>
          (KNOWN_CHECKER_IDS as readonly string[]).includes(id),
        ),
      },
    },
    {
      sandboxAvailable,
      createSandbox:
        deps.createSandbox ?? ((opts) => createSandbox({ allowedImages: opts.allowedImages })),
    },
  ).filter((checker) => order.includes(checker.id));
  const listed = await listCheckers(checkers, deps.probeTimeoutMs ?? AVAILABILITY_TIMEOUT_MS);
  return {
    sandbox: resolved.ok
      ? {
          backend: resolved.backend,
          available: sandboxAvailable,
          ...(sandboxAvailable
            ? {}
            : {
                reason:
                  resolved.backend === "noop"
                    ? "CREWHAUS_SANDBOX=noop turns container execution off"
                    : "no container sandbox is wired for this run",
              }),
        }
      : { backend: null, available: false, reason: resolved.reason },
    checkers: listed.map((listing) => {
      const image = imageOf(listing.id, config);
      return {
        ...listing,
        configured: configured.includes(listing.id),
        ...(image !== undefined ? { image } : {}),
      };
    }),
  };
}

export function renderCheckers(report: CheckerReport): string {
  const s = report.sandbox;
  const lines = [
    `proof checkers${report.spec !== undefined ? ` · ${report.spec}` : ""}`,
    `  sandbox  ${s.backend ?? "invalid"}${s.available ? " (available)" : ` — ${s.reason ?? "unavailable"}`}`,
  ];
  if (report.note !== undefined) lines.push(`  note     ${report.note}`);
  for (const c of report.checkers) {
    lines.push(
      "",
      `${c.available ? "✓" : "✗"} ${c.id}  ${c.available ? "available" : `unavailable — ${c.reason ?? "cannot run here"}`}${
        c.configured ? " · configured" : ""
      }${c.image !== undefined ? ` · image ${c.image}` : ""}`,
    );
    if (c.language !== "") lines.push(...wrap(c.language, "    "));
  }
  return ttyText(lines);
}

/** The cwd spec's lowered block, when there is a parseable spec that declares one. */
function cwdSpec(cwd: string): SpecView | undefined {
  const path = join(cwd, "crewhaus.yaml");
  if (!existsSync(path)) return undefined;
  try {
    return loadSpec(path, cwd);
  } catch {
    return undefined;
  }
}

async function checkersCommand(args: ParsedArgs, deps: ProvabilityCliDeps): Promise<number> {
  const specPath = args.positional[0];
  const spec = specPath !== undefined ? loadSpec(specPath, deps.cwd) : cwdSpec(deps.cwd);
  const config = spec?.provability ?? defaultProvabilityConfig();
  const report = await probeCheckers(config, deps);
  // A spec whose harness never runs a checker configures none: its lowered
  // `formal.checkers` is a default nothing reads (see runsProofCheckers).
  const unused = spec?.provability !== undefined && !runsProofCheckers(config, spec.tools);
  const withSpec: CheckerReport =
    spec?.provability === undefined
      ? report
      : unused
        ? {
            ...report,
            spec: spec.name,
            note: `${spec.name} never runs a proof checker — its ${config.level} floor adds no ProofCheck, and its tools: list none (a proven floor, formal.checkers of its own, or proofCheck in tools: would)`,
            checkers: report.checkers.map((c) => ({ ...c, configured: false })),
          }
        : { ...report, spec: spec.name };
  deps.out(
    args.flags["json"] === true
      ? `${JSON.stringify(withSpec, null, 2)}\n`
      : renderCheckers(withSpec),
  );
  return 0;
}

/** One `crewhaus doctor` line: `{label, pass, warn?, reason?}`. */
export type ProvabilityDoctorCheck = {
  readonly label: string;
  readonly pass: boolean;
  readonly warn?: boolean;
  readonly reason?: string;
};

/**
 * `crewhaus doctor`'s provability lines: when the cwd spec's harness runs a
 * proof checker at all ({@link runsProofCheckers} over the lowered block and
 * `tools:`) and its `formal.checkers` lists a sandbox one (`smt`, `lean4`).
 *
 * The probe — the same `available()` `ProofCheckers` and `crewhaus
 * provability checkers` report — runs each checker's image healthcheck in
 * the sandbox, and on the default docker backend a `docker run` of an image
 * that is not local PULLS it (Lean 4 with Mathlib is gigabytes). So it sits
 * in doctor's `--probe` section beside the other live checks, and a plain
 * `doctor` prints one informational line saying what `--probe` would check.
 * Probed, an unavailable checker is a WARNING, not a failure: the builtin
 * checker is always there, so a harness still proves what it can, and the
 * model is told why the others refuse. No spec, no block, a harness that
 * never runs a checker (a `cited` floor on the lowered default checkers), or
 * only `builtin` → no lines at all (nothing that could fail).
 */
export async function provabilityDoctorChecks(
  config: ProvabilityConfig | undefined,
  deps: Pick<ProvabilityCliDeps, "env" | "sandboxAvailable" | "createSandbox" | "probeTimeoutMs">,
  opts: {
    readonly probe: boolean;
    /** The lowered `tools:` (builtin keys): a listed `proofCheck` runs the checkers at any floor. */
    readonly tools?: readonly string[];
  },
): Promise<ProvabilityDoctorCheck[]> {
  if (config === undefined || !runsProofCheckers(config, opts.tools)) return [];
  const listed = config.formal.checkers as readonly string[];
  const sandboxed = listed.filter((id) => SANDBOX_CHECKERS.has(id));
  if (sandboxed.length === 0) return [];
  if (!opts.probe) {
    return [
      {
        label: `provability checker${sandboxed.length === 1 ? "" : "s"} ${sandboxed.join(", ")}`,
        pass: true,
        warn: true,
        reason:
          "not probed — `crewhaus doctor --probe` runs each checker image's healthcheck (a first run may pull the image); `crewhaus provability checkers` lists them",
      },
    ];
  }
  const report = await probeCheckers(config, deps, defaultCheckerIds(config));
  return report.checkers.map((c) => ({
    label: `provability checker ${c.id}${c.image !== undefined ? ` (${c.image})` : ""}`,
    ...(c.available
      ? { pass: true }
      : {
          pass: true,
          warn: true,
          reason: `${c.reason ?? "cannot run here"} — claims at proven fall back to the builtin checker`,
        }),
  }));
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

async function pruneCommand(args: ParsedArgs, deps: ProvabilityCliDeps): Promise<number> {
  const raw = flagString(args, "older-than");
  if (raw === undefined) {
    throw new ProvabilityCliError(
      "provability prune: --older-than <duration> is required (e.g. 90d)",
    );
  }
  const olderThanMs = parseDurationMs(raw);
  if (olderThanMs === undefined) {
    throw new ProvabilityCliError(
      `invalid --older-than "${raw}" — expected a duration like 90d, 12h or 2w`,
    );
  }
  const dryRun = args.flags["dry-run"] === true;
  const now = deps.now();
  const cutoff = new Date(now.getTime() - olderThanMs);
  const specPath = args.positional[0];
  const spec = specPath !== undefined ? loadSpec(specPath, deps.cwd) : undefined;
  // Managed bundles too: they carry no TTL either, and this is the one verb
  // that manages their size (design §5.3).
  const tenants = tenantsScope(args, deps, spec);
  const dirs = allSpecDirs(deps.cwd, spec, tenants);
  const stale = (await listings(dirs)).filter((l) => l.mtimeMs < cutoff.getTime());
  let removed = 0;
  if (!dryRun) {
    for (const dir of dirs) {
      if (dir.research === true) {
        // A research run's bundle is its one proof.json (report.md and
        // report.json beside it are the run's output, not bundles: kept).
        // Re-checked at delete time: only a regular file is removed.
        for (const listing of researchListings(dir.root)) {
          if (listing.mtimeMs >= cutoff.getTime()) continue;
          try {
            if (lstatSync(listing.path).isFile()) {
              unlinkSync(listing.path);
              removed += 1;
            }
          } catch {
            // gone already
          }
        }
        continue;
      }
      removed += await createBundleStore({ rootDir: dir.root }).prune(olderThanMs, now);
    }
  }
  const paths = stale.map((l) => shown(l.path, deps.cwd));
  if (args.flags["json"] === true) {
    deps.out(
      `${JSON.stringify(
        {
          dryRun,
          olderThan: raw,
          cutoff: cutoff.toISOString(),
          ...(dryRun ? { wouldRemove: paths.length } : { removed }),
          ...(tenants !== undefined ? { tenantsRoot: tenants.root } : {}),
          bundles: paths,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const lines = dryRun
    ? [
        `would remove ${plural(paths.length, "bundle")} last written before ${cutoff.toISOString()} (dry run — nothing deleted)`,
      ]
    : [`removed ${plural(removed, "bundle")} last written before ${cutoff.toISOString()}`];
  for (const p of paths) lines.push(`  ${p}`);
  if (tenants !== undefined) lines.push(`  tenants root ${tenantsWords(tenants)} included`);
  if (dirs.length === 0) {
    lines.push(
      tenants !== undefined
        ? "  (no .crewhaus/proofs/ here, and no tenant proofs under the tenants root)"
        : "  (no .crewhaus/proofs/ here — a managed harness keeps its bundles under its tenants root: --tenants-root <dir>)",
    );
  }
  lines.push("proof artifacts (<proofs>/<spec>/artifacts/) are kept: bundles cite them.");
  if (dirs.some((dir) => dir.research === true)) {
    lines.push("research runs lose only their proof.json; report.md and report.json are kept.");
  }
  deps.out(ttyText(lines));
  return 0;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

/**
 * Run one verb. Returns the exit code (`check`: 0 pass, 1 otherwise; every
 * other verb 0) and throws {@link ProvabilityCliError} (or the spec parser's
 * `CrewhausError`) for a usage or input mistake — the entry file routes both
 * through `die()`. `action === ""` or `args.flags.help` prints the usage.
 */
export async function runProvabilityCommand(
  action: string,
  args: ParsedArgs,
  deps: ProvabilityCliDeps,
): Promise<number> {
  if (action === "" || args.flags["help"] === true) {
    deps.out(PROVABILITY_USAGE);
    return 0;
  }
  if (!isProvabilityAction(action)) {
    throw new ProvabilityCliError(
      `provability action must be one of: ${PROVABILITY_ACTIONS.join(", ")} (got "${action}")\n${PROVABILITY_USAGE}`,
    );
  }
  const allowed = FLAGS_BY_ACTION[action];
  for (const [name, value] of Object.entries(args.flags)) {
    if (value === undefined || value === false || name === "help") continue;
    if (!allowed.includes(name)) {
      throw new ProvabilityCliError(
        `provability ${action} does not take --${name} (it takes ${allowed.map((f) => `--${f}`).join(", ")})`,
      );
    }
  }
  const [min, max] = POSITIONALS[action];
  if (args.positional.length < min || args.positional.length > max) {
    throw new ProvabilityCliError(
      action === "check"
        ? `provability check: expected exactly one <answer.md>\n${PROVABILITY_USAGE}`
        : `provability ${action}: expected at most one <spec.yaml>, got ${args.positional.length} arguments`,
    );
  }
  switch (action) {
    case "show":
      return showCommand(args, deps);
    case "check":
      return checkCommand(args, deps);
    case "audit":
      return auditCommand(args, deps);
    case "checkers":
      return checkersCommand(args, deps);
    case "prune":
      return pruneCommand(args, deps);
  }
}
