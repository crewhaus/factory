/**
 * Plugin grants (#522): what each installed plugin's owner allowed it, and what Home
 * serves it from that.
 *
 * A plugin's manifest ASKS (its panes, its `integration` section's event families and
 * reads, the origins its `permissions.net` names, the host tools its `permissions.tools`
 * names). The owner GRANTS some of those, on some harnesses, through the
 * `plugins.grant` operation or `crewhaus plugins grant`. Home SERVES the intersection
 * of the live grant and what the current manifest asks, field by field, so a later
 * version that asks for more keeps only what was granted, and one that asks for less
 * narrows at once.
 *
 * The grants live in a control ledger under the Hangar root (`plugins/grants`,
 * segmented like every control ledger, with its own lock and claims). A row is
 * content-free: the plugin's name, version and code digest, the ids and names
 * granted, what the manifest asked at the time, who granted it and the receipt.
 * Each grant is a `pluginGrant` object (`pgt_…`), re-granted in place while it stays
 * `granted`; a revoke is terminal, and the next grant starts a new object.
 *
 * Reads never write: a review folds the ledger and the manifests and computes the
 * state word ("waiting", "allowed", "asks-for-more", "revoked") at read time.
 */
import { closeSync, existsSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type PluginGrantSet,
  type PluginReview,
  type PluginReviewState,
  mintId,
} from "@crewhaus/control-contract";
import {
  type Ledger,
  type LedgerRecord,
  casAppendLocked,
  foldStates,
  withLedgerLock,
} from "@crewhaus/control-records";
import { readSpecHeader } from "@crewhaus/harness-inventory";
import { SPEC_FILENAMES } from "@crewhaus/harness-supervisor";
import { type PluginEntry, grantedBridgeTools } from "@crewhaus/plugin-loader";
import { parseYamlOnly } from "@crewhaus/spec-patch/commit";
import { MAX_TEXT_BYTES } from "./constants";
import { harnessPathOf } from "./harness-paths";
import {
  type PluginGrantStanding,
  type PluginInventory,
  type PluginRow,
  type PluginRowBase,
  type ServedPlugin,
  netOriginsOf,
  pluginSeesHarness,
  servesHarness,
} from "./plugins";

// What `crewhaus plugins grants|grant|revoke` reads beside the ledger, through this
// module's own subpath, so the CLI writes the same rows as Home without taking the server.
export { type PluginRow, readPluginInventory } from "./plugins";

/** The plugin grants ledger under the Hangar root, with its own lock and claims. */
export function pluginGrantsLedger(hangarRoot: string): Ledger {
  return {
    root: hangarRoot,
    records: { dir: join("plugins", "grants") },
    lock: join("plugins", "lock"),
    claims: join("plugins", "claims"),
    machine: "pluginGrant",
  };
}

/** What a manifest asked for when a grant was made, harnesses aside. */
export type PluginAsked = {
  readonly panes: readonly string[];
  readonly events: readonly string[];
  readonly reads: readonly string[];
  readonly net: readonly string[];
  readonly tools: readonly string[];
};

/** One grant row, as the ledger holds it. */
export type PluginGrantRow = {
  readonly v: 1;
  readonly at: string;
  readonly id: string;
  readonly state: "granted" | "revoked";
  readonly plugin: string;
  readonly version: string;
  readonly entrypointDigest: string | null;
  readonly harnesses: readonly string[] | "all";
  readonly panes: readonly string[];
  readonly events: readonly string[];
  readonly reads: readonly string[];
  readonly net: readonly string[];
  readonly tools: readonly string[];
  readonly asked: PluginAsked;
  /** The receipt's actor. */
  readonly by: string;
  /** The receipt's id. */
  readonly cmd: string;
};

/** A plugin's newest grant object: its id, state, generation and current row. */
export type PluginGrantObject = {
  readonly id: string;
  readonly state: "granted" | "revoked";
  readonly gen: number;
  readonly row: PluginGrantRow;
};

/** Every plugin's newest grant object, by plugin name. */
export type PluginGrants = ReadonlyMap<string, PluginGrantObject>;

export type PluginGrantsRead =
  | { readonly ok: true; readonly grants: PluginGrants }
  | { readonly ok: false; readonly reason: string };

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

/** A ledger record as a grant row, or undefined when it is not one. */
function grantRowOf(record: LedgerRecord): PluginGrantRow | undefined {
  const r = record as Record<string, unknown>;
  const asked = r["asked"] as Record<string, unknown> | undefined;
  const harnesses = r["harnesses"];
  if (
    typeof r["id"] !== "string" ||
    (r["state"] !== "granted" && r["state"] !== "revoked") ||
    typeof r["plugin"] !== "string" ||
    typeof r["version"] !== "string" ||
    !(harnesses === "all" || isStringArray(harnesses)) ||
    !isStringArray(r["panes"]) ||
    !isStringArray(r["events"]) ||
    !isStringArray(r["reads"]) ||
    !isStringArray(r["net"]) ||
    !isStringArray(r["tools"]) ||
    typeof asked !== "object" ||
    asked === null ||
    !["panes", "events", "reads", "net", "tools"].every((k) => isStringArray(asked[k]))
  ) {
    return undefined;
  }
  return record as unknown as PluginGrantRow;
}

/**
 * Fold the grants ledger: each plugin's newest grant object. A read: it opens the
 * ledger's segments read-only and writes nothing, so an absent ledger is no grants.
 */
export function readPluginGrants(hangarRoot: string): PluginGrantsRead {
  const fold = foldStates(pluginGrantsLedger(hangarRoot));
  if (!fold.ok) {
    if (fold.code === "not-found") return { ok: true, grants: new Map() };
    return { ok: false, reason: fold.reason };
  }
  const grants = new Map<string, PluginGrantObject>();
  // The fold keeps first-seen order, so a later object for the same plugin wins.
  for (const object of fold.objects.values()) {
    const row = grantRowOf(object.record);
    if (row === undefined) continue;
    grants.set(row.plugin, {
      id: object.id,
      state: row.state,
      gen: fold.generations.get(object.id) ?? 0,
      row,
    });
  }
  return { ok: true, grants };
}

/** A plugin's live grant: its newest object, while it is `granted`. */
export function liveGrantOf(grants: PluginGrants, plugin: string): PluginGrantObject | undefined {
  const newest = grants.get(plugin);
  return newest?.state === "granted" ? newest : undefined;
}

/** A harness a review can offer: its id and directory. */
export type GrantableHarness = { readonly id: string; readonly dir: string };

/** What a plugin asks for now, field by field; `harnesses` prefills the owner's choice. */
export type PluginAsks = PluginAsked & { readonly harnesses: readonly string[] };

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * What the manifest asks for now: its pane ids; its `integration` event families; its
 * reads, plus `run.trace` when it declares the trace observer; the origins its `net`
 * list names; the host tools its `permissions.tools` names; and, to prefill the owner's
 * choice, the harnesses its `fs` read list covers.
 */
export function asksOf(
  row: PluginRowBase,
  harnesses: readonly GrantableHarness[] = [],
): PluginAsks {
  const observes = row.extensionPoints.some((e) => e.point === "onTraceEvent" && e.declared);
  return {
    harnesses: harnesses
      .filter((h) => pluginSeesHarness({ fs: row.permissions.fs }, h.dir))
      .map((h) => h.id),
    panes: unique(row.panes.map((p) => p.id)),
    events: unique(row.integration?.events ?? []),
    reads: unique([...(row.integration?.reads ?? []), ...(observes ? ["run.trace"] : [])]),
    net: netOriginsOf(row.permissions.net),
    tools: unique(row.permissions.tools),
  };
}

/** The asks, harnesses aside: what a grant row records as `asked`. */
export function askedOf(asks: PluginAsked): PluginAsked {
  return {
    panes: [...asks.panes],
    events: [...asks.events],
    reads: [...asks.reads],
    net: [...asks.net],
    tools: [...asks.tools],
  };
}

const LIST_FIELDS = ["panes", "events", "reads", "net", "tools"] as const;

/** Nothing served. */
export const SERVED_NOTHING: PluginGrantSet = Object.freeze({
  harnesses: [],
  panes: [],
  events: [],
  reads: [],
  net: [],
  tools: [],
});

/**
 * What Home serves a plugin: the live grant intersected with what the manifest asks
 * now, field by field. No grant, or a revoked one, serves nothing.
 */
export function servedOf(grant: PluginGrantObject | undefined, asks: PluginAsked): PluginGrantSet {
  if (grant === undefined || grant.state !== "granted") return SERVED_NOTHING;
  const out: Record<string, readonly string[] | "all"> = {
    harnesses: grant.row.harnesses === "all" ? "all" : [...grant.row.harnesses],
  };
  for (const field of LIST_FIELDS) {
    const asked = new Set(asks[field]);
    out[field] = grant.row[field].filter((value) => asked.has(value));
  }
  return out as unknown as PluginGrantSet;
}

const subset = (a: readonly string[], b: readonly string[]): boolean => {
  const of = new Set(b);
  return a.every((value) => of.has(value));
};

/**
 * Where a plugin stands with its owner. No grant: waiting. Revoked: revoked. A grant
 * for another version or code digest, from a manifest that now asks for something the
 * grant's manifest did not: asks for more. Otherwise allowed. `legacy`: no grant, and
 * a manifest with no `integration` section.
 */
export function standingOf(
  row: PluginRowBase,
  newest: PluginGrantObject | undefined,
  asks: PluginAsked = asksOf(row),
): PluginGrantStanding {
  const legacy = newest === undefined && row.integration === null;
  let state: PluginReviewState;
  if (newest === undefined) state = "waiting";
  else if (newest.state === "revoked") state = "revoked";
  else {
    const changed =
      newest.row.version !== row.version || newest.row.entrypointDigest !== row.entrypointDigest;
    const more = LIST_FIELDS.some((field) => !subset(asks[field], newest.row.asked[field]));
    state = changed && more ? "asks-for-more" : "allowed";
  }
  return { state, legacy };
}

/** `readPluginInventory`'s standing callback, over a folded grants ledger. */
export function standingFrom(grants: PluginGrants): (row: PluginRowBase) => PluginGrantStanding {
  return (row) => standingOf(row, grants.get(row.name));
}

/** Every plugin in the inventory with what Home serves it. A plugin with a problem is served nothing. */
export function servedPlugins(inventory: PluginInventory, grants: PluginGrants): ServedPlugin[] {
  return inventory.plugins.map((plugin) => ({
    plugin,
    served:
      plugin.problems.length > 0
        ? SERVED_NOTHING
        : servedOf(liveGrantOf(grants, plugin.name), asksOf(plugin)),
  }));
}

/** The shapes whose bundles load a spec's `plugins:` list. */
export const PLUGIN_SHAPES: ReadonlySet<string> = new Set(["cli", "channel"]);

/**
 * A harness whose crewhaus.yaml loads a plugin beyond what Home serves it there.
 * `tools` is every host tool that harness's entry hands the plugin, sorted, or null
 * when its spec file could not be read whole.
 */
export type PluginStillLoaded = {
  readonly id: string;
  readonly tools: readonly string[] | null;
};

/** The name a `plugins:` item names, when it names one. */
function entryNameOf(item: unknown): string | undefined {
  if (typeof item === "string") return item;
  if (typeof item === "object" && item !== null) {
    const name = (item as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

/** A `plugins:` item as the loader reads it: a name, or `{name, tools}` with a list of names. */
function asPluginEntry(item: unknown): PluginEntry | undefined {
  if (typeof item === "string") return item;
  if (typeof item !== "object" || item === null) return undefined;
  const { name, tools } = item as { name?: unknown; tools?: unknown };
  if (typeof name !== "string" || !isStringArray(tools)) return undefined;
  return { name, tools };
}

/** A spec file's head, at most {@link MAX_TEXT_BYTES}, or undefined when it cannot be read. */
function readSpecHead(path: string): { text: string; truncated: boolean } | undefined {
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    fd = openSync(path, "r");
    const take = Math.min(stat.size, MAX_TEXT_BYTES);
    const buf = Buffer.alloc(take);
    const read = readSync(fd, buf, 0, take, 0);
    return { text: buf.subarray(0, read).toString("utf8"), truncated: stat.size > MAX_TEXT_BYTES };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The spec file a harness builds from, chosen as the supervisor chooses it
 * (`crewhaus.yaml`, else `crewhaus.yml`): its name, `absent` when neither is there,
 * or `unknown` when whether one is there cannot be told.
 */
function specFileOf(dir: string): string {
  for (const name of SPEC_FILENAMES) {
    const path = join(dir, name);
    try {
      lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      return "unknown";
    }
    // A link that leads nowhere is passed over by the supervisor too.
    if (!existsSync(path)) continue;
    return name;
  }
  return "absent";
}

/** Whether a spec's target may be a shape that loads `plugins:` (true when it cannot be told). */
const mayLoadPlugins = (target: unknown): boolean =>
  typeof target !== "string" || PLUGIN_SHAPES.has(target);

/**
 * The host tools one harness's spec hands `row` there, or `null` when it cannot tell,
 * or `undefined` when the spec does not load it. The spec is the file the harness
 * builds from (`crewhaus.yaml`, else `crewhaus.yml`); its shape and `plugins:` list
 * come from the parsed document, as the compiler reads them. The first `plugins:`
 * entry for the plugin decides, as it does in the bundle: a bare name hands it every
 * host tool its manifest asks for; `{name, tools}` hands those listed that it asks
 * for. A spec file that is there but cannot be read whole (unreadable, not a regular
 * file, resolving outside its harness, or past the read cap) cannot tell, unless what
 * can be read shows a shape that never loads `plugins:`.
 */
function toolsLoadedAt(
  row: PluginRowBase,
  harness: GrantableHarness,
  hangarRoot: string,
): readonly string[] | null | undefined {
  const file = specFileOf(harness.dir);
  if (file === "absent") return undefined;
  if (file === "unknown") return null;
  const at = harnessPathOf(harness.dir, hangarRoot, [file]);
  // Nothing outside the harness is read, so a spec file that resolves there cannot tell.
  if (!at.ok) return null;
  const head = readSpecHead(at.path);
  if (head === undefined) return null;
  const { text, truncated } = head;
  if (truncated) return mayLoadPlugins(readSpecHeader(text).target) ? null : undefined;
  let doc: unknown;
  try {
    doc = parseYamlOnly(text) as unknown;
  } catch {
    // A spec that does not parse does not build; it cannot tell only when it mentions the plugin.
    if (!text.includes(row.name)) return undefined;
    return mayLoadPlugins(readSpecHeader(text).target) ? null : undefined;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
  const { target, plugins } = doc as { target?: unknown; plugins?: unknown };
  if (!mayLoadPlugins(target)) return undefined;
  if (plugins === undefined || plugins === null) return undefined;
  if (!Array.isArray(plugins)) return null;
  const first = plugins.find((item) => entryNameOf(item) === row.name);
  if (first === undefined) return undefined;
  const entry = asPluginEntry(first);
  if (entry === undefined) return null;
  return [...grantedBridgeTools(row.permissions.tools, entry).tools].sort();
}

/**
 * The harnesses whose crewhaus.yaml loads `row` beyond what `served` covers: one the
 * served view does not cover at all, or one whose entry hands the plugin a host tool
 * outside `served.tools`. Each harness names the whole set its entry hands the plugin.
 * Only cli and channel harnesses load `plugins:`, so any other shape and a harness
 * with no spec file are never named. A harness whose spec file cannot be read whole
 * (unreadable, not a regular file, resolving outside its directory, or past the read
 * cap), one whose spec mentions the plugin but does not parse, and one whose entry is
 * in neither form are named with `tools: null`: it could not be told. Only the
 * harnesses given are read, so a caller passes those it may see. Reads only.
 */
export function stillLoadedBy(
  row: PluginRowBase,
  served: PluginGrantSet,
  harnesses: readonly GrantableHarness[],
  hangarRoot: string,
): PluginStillLoaded[] {
  const out: PluginStillLoaded[] = [];
  const allowed = new Set(served.tools);
  for (const harness of harnesses) {
    const tools = toolsLoadedAt(row, harness, hangarRoot);
    if (tools === undefined) continue;
    const beyond =
      tools === null ||
      !servesHarness(served, harness.id) ||
      tools.some((tool) => !allowed.has(tool));
    if (beyond) out.push({ id: harness.id, tools: tools === null ? null : [...tools] });
  }
  return out;
}

/**
 * The plugins waiting for the owner's OK on one harness: those with no problem that
 * declare a pane or the trace observer, whose filesystem ask covers this harness, and
 * that Home does not serve here (no grant, a revoked one, or one on other harnesses).
 */
export function waitingOn(
  inventory: PluginInventory,
  served: readonly ServedPlugin[],
  harness: GrantableHarness,
): string[] {
  const views = new Map(served.map((s) => [s.plugin.name, s.served] as const));
  return inventory.plugins
    .filter((row) => row.problems.length === 0)
    .filter(
      (row) =>
        row.panes.length > 0 ||
        row.extensionPoints.some((e) => e.point === "onTraceEvent" && e.declared),
    )
    .filter((row) => asksOf(row, [harness]).harnesses.includes(harness.id))
    .filter((row) => !servesHarness(views.get(row.name) ?? SERVED_NOTHING, harness.id))
    .map((row) => row.name);
}

/** A served or granted set with its harness ids folded to those `visible` answers for. */
function visibleSet(set: PluginGrantSet, visible: (id: string) => boolean): PluginGrantSet {
  return set.harnesses === "all" ? set : { ...set, harnesses: set.harnesses.filter(visible) };
}

/** The `crewhaus plugins grants <name>` line a review shows. */
export function reviewVerbOf(plugin: string): string {
  return `crewhaus plugins grants ${plugin}`;
}

/**
 * The owner's review of one plugin (`plugins.review`): what it asks, what is granted,
 * what is served, the state word and the live generation. Harness ids are folded to
 * those `visible` answers for; `"all"` stays `"all"`.
 */
export function pluginReviewOf(
  row: PluginRow,
  newest: PluginGrantObject | undefined,
  harnesses: readonly GrantableHarness[],
  visible: (id: string) => boolean,
): PluginReview {
  const asks = asksOf(row, harnesses);
  const live = newest?.state === "granted" ? newest : undefined;
  const standing = standingOf(row, newest, asks);
  const granted: PluginGrantSet | null =
    live === undefined
      ? null
      : {
          harnesses: live.row.harnesses === "all" ? "all" : [...live.row.harnesses],
          panes: [...live.row.panes],
          events: [...live.row.events],
          reads: [...live.row.reads],
          net: [...live.row.net],
          tools: [...live.row.tools],
        };
  return {
    plugin: row.name,
    version: row.version,
    entrypointDigest: row.entrypointDigest,
    signed: row.signed,
    crewhausRange: row.crewhausRange,
    state: standing.state,
    legacy: standing.legacy,
    asks: { ...asks, harnesses: asks.harnesses.filter(visible) },
    granted: granted === null ? null : visibleSet(granted, visible),
    served: visibleSet(row.problems.length > 0 ? SERVED_NOTHING : servedOf(live, asks), visible),
    gen: live?.gen ?? null,
    envNames: [...row.envNames],
    verb: reviewVerbOf(row.name),
  };
}

/** What an owner asks to grant. */
export type PluginGrantInput = PluginGrantSet & { readonly expect?: number };

/**
 * Why a grant cannot be made, naming the value, or undefined: a pane, event family,
 * read, origin or tool the plugin does not ask for, or a harness id Home does not
 * know. A plugin with a problem cannot be granted anything.
 */
export function grantProblem(
  row: PluginRowBase,
  input: PluginGrantInput,
  knownHarnesses: ReadonlySet<string>,
): string | undefined {
  if (row.problems.length > 0) {
    return `plugin "${row.name}" cannot be granted anything: ${row.problems.join("; ")}`;
  }
  const asks = asksOf(row);
  const words: Readonly<Record<(typeof LIST_FIELDS)[number], string>> = {
    panes: "pane",
    events: "event family",
    reads: "read",
    net: "origin",
    tools: "host tool",
  };
  for (const field of LIST_FIELDS) {
    const asked = new Set(asks[field]);
    for (const value of input[field]) {
      if (!asked.has(value)) {
        return `plugin "${row.name}" does not ask for the ${words[field]} ${JSON.stringify(value)}`;
      }
    }
  }
  if (input.harnesses !== "all") {
    for (const id of input.harnesses) {
      if (!knownHarnesses.has(id)) return `no harness ${JSON.stringify(id)} is registered`;
    }
  }
  return undefined;
}

/**
 * Whether `expect` matches the plugin's live grant: absent `expect` means "there is
 * no live grant", a number names the live grant's generation.
 */
export function expectHolds(
  live: PluginGrantObject | undefined,
  expect: number | undefined,
): boolean {
  return expect === undefined ? live === undefined : live !== undefined && live.gen === expect;
}

export type GrantOutcome =
  | {
      readonly ok: true;
      readonly id: string;
      readonly gen: number;
      readonly row: PluginGrantRow;
      /**
       * The harnesses whose crewhaus.yaml loads the plugin beyond what the new row
       * serves, when the caller asked with `loadedBy`.
       */
      readonly stillLoadedBy?: readonly PluginStillLoaded[];
    }
  | {
      readonly ok: false;
      readonly code: "stale";
      /** The live grant's generation now, or null when there is none. */
      readonly gen: number | null;
      readonly current: PluginGrantRow | null;
    }
  | { readonly ok: false; readonly code: "no-live-grant" }
  | { readonly ok: false; readonly code: "io"; readonly reason: string };

type Stamp = {
  readonly by: string;
  readonly cmd: string;
  /** The clock a row's `at` reads; the system clock when absent. */
  readonly now?: () => number;
};

const atOf = (stamp: Stamp): string => new Date(stamp.now?.() ?? Date.now()).toISOString();

/**
 * What a grant or revoke checks against harness specs once its row is written: the
 * plugin's inventory row and the harnesses to read (those the caller may see).
 */
export type PluginLoadedBy = {
  readonly row: PluginRowBase;
  readonly harnesses: readonly GrantableHarness[];
};

/** An applied outcome with the harnesses that load the plugin beyond `served`. */
function withStillLoaded(
  hangarRoot: string,
  outcome: GrantOutcome,
  loadedBy: PluginLoadedBy | undefined,
  served: (applied: PluginGrantObject, loadedBy: PluginLoadedBy) => PluginGrantSet,
): GrantOutcome {
  if (!outcome.ok || loadedBy === undefined) return outcome;
  return {
    ...outcome,
    stillLoadedBy: stillLoadedBy(
      loadedBy.row,
      served(
        { id: outcome.id, state: outcome.row.state, gen: outcome.gen, row: outcome.row },
        loadedBy,
      ),
      loadedBy.harnesses,
      hangarRoot,
    ),
  };
}

/**
 * Write one grant, under the ledger's lock: fold, find the plugin's live grant, hold
 * `expect` to its generation, then append through a compare-and-set on that object
 * (or on a new `pgt_` when there is no live grant). A stale `expect` appends nothing.
 * Validate the request with {@link grantProblem} first: this writes what it is given.
 * With `loadedBy`, an applied grant also answers {@link stillLoadedBy} against what
 * the new row serves, read after the lock is released.
 */
export async function grantPlugin(
  hangarRoot: string,
  input: {
    readonly row: PluginRowBase;
    readonly grant: PluginGrantInput;
    readonly loadedBy?: PluginLoadedBy;
  } & Stamp,
): Promise<GrantOutcome> {
  const ledger = pluginGrantsLedger(hangarRoot);
  const answer = await withLedgerLock<GrantOutcome>(ledger, async () => {
    const read = readPluginGrants(hangarRoot);
    if (!read.ok) return { ok: false, code: "io", reason: read.reason };
    const live = liveGrantOf(read.grants, input.row.name);
    if (!expectHolds(live, input.grant.expect)) {
      return { ok: false, code: "stale", gen: live?.gen ?? null, current: live?.row ?? null };
    }
    const id = live?.id ?? mintId("pgt");
    const { grant } = input;
    const row: PluginGrantRow = {
      v: 1,
      at: atOf(input),
      id,
      state: "granted",
      plugin: input.row.name,
      version: input.row.version,
      entrypointDigest: input.row.entrypointDigest,
      harnesses: grant.harnesses === "all" ? "all" : [...grant.harnesses],
      panes: [...grant.panes],
      events: [...grant.events],
      reads: [...grant.reads],
      net: [...grant.net],
      tools: [...grant.tools],
      asked: askedOf(asksOf(input.row)),
      by: input.by,
      cmd: input.cmd,
    };
    const cas = await casAppendLocked(ledger, id, live === undefined ? null : "granted", row);
    if (!cas.ok) return { ok: false, code: "io", reason: cas.reason };
    if (!cas.applied) {
      const current = cas.current === null ? null : (grantRowOf(cas.current) ?? null);
      return { ok: false, code: "stale", gen: live?.gen ?? null, current };
    }
    return { ok: true, id, gen: cas.gen, row };
  });
  if ("path" in answer) return ioOutcome(answer);
  return withStillLoaded(hangarRoot, answer, input.loadedBy, (applied, loadedBy) =>
    servedOf(applied, asksOf(loadedBy.row)),
  );
}

/** A lock or directory refusal, as an outcome. */
function ioOutcome(failure: { readonly reason?: string }): GrantOutcome {
  return { ok: false, code: "io", reason: failure.reason ?? "the grants ledger is unavailable" };
}

/**
 * Revoke a plugin's live grant, under the ledger's lock. No live grant is a refusal,
 * never a row. The revoked object stays as history; the next grant starts a new one.
 * With `loadedBy`, an applied revoke also answers {@link stillLoadedBy}: every given
 * harness whose crewhaus.yaml loads the plugin, since nothing is served now.
 */
export async function revokePlugin(
  hangarRoot: string,
  input: { readonly plugin: string; readonly loadedBy?: PluginLoadedBy } & Stamp,
): Promise<GrantOutcome> {
  const ledger = pluginGrantsLedger(hangarRoot);
  const answer = await withLedgerLock<GrantOutcome>(ledger, async () => {
    const read = readPluginGrants(hangarRoot);
    if (!read.ok) return { ok: false, code: "io", reason: read.reason };
    const live = liveGrantOf(read.grants, input.plugin);
    if (live === undefined) return { ok: false, code: "no-live-grant" };
    const row: PluginGrantRow = {
      ...live.row,
      at: atOf(input),
      state: "revoked",
      by: input.by,
      cmd: input.cmd,
    };
    // The ledger's own bookkeeping is not carried forward: the compare-and-set sets it.
    const {
      gen: _gen,
      claim: _claim,
      ...next
    } = row as PluginGrantRow & {
      gen?: unknown;
      claim?: unknown;
    };
    const cas = await casAppendLocked(ledger, live.id, "granted", next);
    if (!cas.ok) return { ok: false, code: "io", reason: cas.reason };
    if (!cas.applied) return { ok: false, code: "no-live-grant" };
    return { ok: true, id: live.id, gen: cas.gen, row };
  });
  if ("path" in answer) return ioOutcome(answer);
  return withStillLoaded(hangarRoot, answer, input.loadedBy, () => SERVED_NOTHING);
}
