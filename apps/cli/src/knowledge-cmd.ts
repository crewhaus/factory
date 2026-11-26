/**
 * `crewhaus knowledge <verb>`: what this harness knows, from the terminal.
 *
 * | Verb | What |
 * |---|---|
 * | `status` | what the harness knows, where it is kept, whether search is built |
 * | `list [--type t] [--status s] [--scope s]` | browse what it knows |
 * | `show <item> [--history]` | one thing it knows, and what it was before |
 * | `why <item>` | where it came from, and whether that is still there |
 * | `usage <item>` | the runs that used it (or what one run used, for a `run_` id) |
 * | `search <words> [--harness h]` | find something, in this harness or every registered one |
 * | `reindex` | build this harness's search index again |
 * | `erase <item>… [--include-sources] [--shared <dir>] [--yes --confirm <name>]` | delete data marked personal |
 *
 * Each works on the harness in the working directory and with Home stopped. Every verb but
 * `reindex` and a confirmed `erase` only reads: a search index is used when one was built, and
 * otherwise the one harness is read without writing anything. `erase` shows what it would
 * delete first; deleting takes the harness's owner, `--yes` and the harness's name. Refusals
 * throw {@link KnowledgeCmdError}, which the entry file routes through `die()`. Side-effect-free
 * on import.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { localActorOf } from "@crewhaus/access-control";
import type {
  KnowledgeItem,
  KnowledgeLifecycle,
  KnowledgeStore,
} from "@crewhaus/control-contract/knowledge";
import {
  KNOWLEDGE_LIFECYCLES,
  KNOWLEDGE_STORES,
  isKnowledgeStore,
  parseKnowledgeId,
} from "@crewhaus/control-contract/knowledge";
import { currentLocalIdentity } from "@crewhaus/control-service";
import { harnessSpecName } from "@crewhaus/harness-lifecycle/knowledge-sync";
import {
  openHangarRegistry,
  readHarnessIdentityFile,
  resolveHangarRoot,
} from "@crewhaus/harness-registry";
import type { ParseArgsSchema, ParsedArgs } from "@crewhaus/infra-utils";
import {
  type FoldedItem,
  HarnessRead,
  type HarnessReadOptions,
  type ItemFilter,
  type SearchHarness,
  Shard,
  UNREGISTERED_HRN,
  buildShard,
  foldItems,
  foldUsage,
  kindsOf,
  maskedBody,
  readHistory,
  readItem,
  readItems,
  search,
} from "@crewhaus/knowledge-index";
import {
  type ErasurePlan,
  type ErasureResidue,
  authorizeErasure,
  executeErasure,
  factItemId,
  planErasure,
} from "@crewhaus/knowledge-index/erasure";
import { isMemoryEntryId } from "@crewhaus/memory-store";
import { AGENT_TOOL_ENV } from "./approvals-cmd";
import {
  KNOWLEDGE_ERASE_SCHEMA,
  KNOWLEDGE_LIST_SCHEMA,
  KNOWLEDGE_REINDEX_SCHEMA,
  KNOWLEDGE_SEARCH_SCHEMA,
  KNOWLEDGE_SHOW_SCHEMA,
  KNOWLEDGE_STATUS_SCHEMA,
  KNOWLEDGE_USAGE_SCHEMA,
  KNOWLEDGE_WHY_SCHEMA,
} from "./arg-schemas";
import { type OwnerCheck, ownerCheck } from "./owner-check";

/** The verbs this module answers; `sync` is the older one beside them. */
export const KNOWLEDGE_ACTIONS = [
  "status",
  "list",
  "show",
  "why",
  "usage",
  "search",
  "reindex",
  "erase",
] as const;

export type KnowledgeAction = (typeof KNOWLEDGE_ACTIONS)[number];

/** The flags each verb reads, and no other: a flag it does not read is refused as unknown. */
export const KNOWLEDGE_SCHEMAS: Readonly<Record<KnowledgeAction, ParseArgsSchema>> = {
  status: KNOWLEDGE_STATUS_SCHEMA,
  list: KNOWLEDGE_LIST_SCHEMA,
  show: KNOWLEDGE_SHOW_SCHEMA,
  why: KNOWLEDGE_WHY_SCHEMA,
  usage: KNOWLEDGE_USAGE_SCHEMA,
  search: KNOWLEDGE_SEARCH_SCHEMA,
  reindex: KNOWLEDGE_REINDEX_SCHEMA,
  erase: KNOWLEDGE_ERASE_SCHEMA,
};

/** A bad argument or a refusal: the entry file prints it and exits 1. */
export class KnowledgeCmdError extends Error {
  override readonly name = "KnowledgeCmdError";
}

export type KnowledgeCmdIo = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** One line of output, without its newline. */
  readonly stdout: (line: string) => void;
  readonly now: () => Date;
  /** Whether the local user is a harness's owner. */
  readonly owner: (harnessDir: string) => OwnerCheck;
};

function defaultIo(): KnowledgeCmdIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    now: () => new Date(),
    owner: (dir) => ownerCheck(dir),
  };
}

const HELP: Readonly<Record<KnowledgeAction, readonly string[]>> = {
  status: [
    "crewhaus knowledge status — what this harness knows, where it is kept, and whether search is built.",
    "usage: crewhaus knowledge status [--json]",
  ],
  list: [
    "crewhaus knowledge list — browse what this harness knows.",
    "usage: crewhaus knowledge list [--type <kind>] [--status <word>] [--scope spec|session|tenant|shared] [--json]",
    "  kinds: fact, wiki, plan, goal, requirement, focus, session, lesson, suggestion, document, dataset",
  ],
  show: [
    "crewhaus knowledge show — one thing this harness knows. --history adds what it was before.",
    "usage: crewhaus knowledge show <item> [--history] [--json]",
  ],
  why: [
    "crewhaus knowledge why — where something the harness knows came from, and whether that is still there.",
    "usage: crewhaus knowledge why <item> [--json]",
  ],
  usage: [
    "crewhaus knowledge usage — the runs that used something the harness knows.",
    "usage: crewhaus knowledge usage <item> | <run_id> [--json]",
  ],
  search: [
    "crewhaus knowledge search — find something the harnesses here know. No model reads the search, and it isn't kept.",
    "usage: crewhaus knowledge search <words> [--harness <id|name|dir>] [--json]",
    "  narrow it with type:fact, in:<harness>, #tag, since:7d or status:superseded",
  ],
  reindex: [
    "crewhaus knowledge reindex — build this harness's search index again.",
    "usage: crewhaus knowledge reindex [--json]",
  ],
  erase: [
    "crewhaus knowledge erase — delete data marked personal, everywhere this harness kept it. Shows what it will remove first.",
    "usage: crewhaus knowledge erase <item>… [--include-sources] [--shared <dir>] [--yes --confirm <harness name>] [--json]",
    "  --include-sources also removes what the conversation it came from left behind.",
    "  --shared names the shared store knowledge sync uses, when it is kept somewhere else.",
    "  Mark a fact first: crewhaus memory mark <mem_id> --personal",
  ],
};

const PAGE = 50;

type Here = {
  readonly dir: string;
  readonly hrn: string;
  /**
   * Whether the registry names this folder by the id its own `harness.json` gives, so Home's
   * cache may hold its index. Otherwise every read folds the harness in memory.
   */
  readonly registered: boolean;
  /** Why it is not, in words that name the verb that sets it right. */
  readonly unbound?: string;
  readonly name: string;
  readonly hangarRoot: string;
  readonly read: HarnessReadOptions;
};

function str(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

const flag = (args: ParsedArgs, name: string): boolean => args.flags[name] === true;

const NOT_REGISTERED =
  "This folder isn't registered yet, so there is nowhere to keep its search index. crewhaus harness adopt . registers it.";
const NOT_ITS_ID =
  "This folder's harness id is not the one registered for it, so its search index is not kept. crewhaus harness adopt . sets it right.";

/**
 * The harness in the working directory. Its id is the registry's row for this folder, with
 * its `harness.json` only as a cross-check: a folder the registry does not name, or names by
 * another id, has no index in Home's cache and is read in memory.
 */
function harnessHere(io: KnowledgeCmdIo): Here {
  const dir = resolve(io.cwd);
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // A folder that cannot be resolved is looked up as it was given.
  }
  let row: { readonly id: string } | undefined;
  try {
    const registry = openHangarRegistry({ env: { ...io.env, CREWHAUS_NO_REGISTRY: "1" } });
    row = registry.get(dir) ?? (real !== dir ? registry.get(real) : undefined);
  } catch {
    row = undefined;
  }
  const own = readHarnessIdentityFile(dir)?.id;
  const unbound =
    row === undefined
      ? NOT_REGISTERED
      : own !== undefined && own !== row.id
        ? NOT_ITS_ID
        : undefined;
  const hrn = unbound === undefined ? row?.id : undefined;
  const name = harnessSpecName(dir) ?? basename(dir);
  return {
    dir,
    hrn: hrn ?? UNREGISTERED_HRN,
    registered: hrn !== undefined,
    ...(unbound !== undefined ? { unbound } : {}),
    name,
    hangarRoot: resolveHangarRoot(io.env),
    read: {
      harnessDir: dir,
      hrn: hrn ?? UNREGISTERED_HRN,
      harnessName: name,
      now: io.now,
    },
  };
}

/** Every registered harness still on disk, read without writing the registry. */
function registered(io: KnowledgeCmdIo): SearchHarness[] {
  return openHangarRegistry({ env: { ...io.env, CREWHAUS_NO_REGISTRY: "1" } })
    .list({ includeMissing: false })
    .filter((entry) => entry.kind === "local")
    .map((entry) => ({
      hrn: entry.id,
      dir: entry.dir,
      name: entry.specName !== "" ? entry.specName : basename(entry.dir),
      hidden: entry.hidden,
    }));
}

/** An item id as it was typed: an id, a qualified id, or a bare fact id. */
async function itemIdOf(here: Here, given: string): Promise<string> {
  const id = given.includes("/knowledge/") ? (given.split("/knowledge/")[1] ?? "") : given;
  if (parseKnowledgeId(id) !== undefined) return id;
  if (isMemoryEntryId(id)) {
    const found = await factItemId({ dir: here.dir, hrn: here.hrn }, id);
    if (found !== undefined) return found;
    throw new KnowledgeCmdError(
      `No one fact here is ${id}. crewhaus knowledge list --type fact names them.`,
    );
  }
  throw new KnowledgeCmdError(
    `"${given}" is not an item. crewhaus knowledge list names each item by its id.`,
  );
}

async function itemHere(here: Here, args: ParsedArgs, verb: string) {
  const given = args.positional[0];
  if (given === undefined) throw new KnowledgeCmdError(`usage: crewhaus knowledge ${verb} <item>`);
  const id = await itemIdOf(here, given);
  const item = await readItem(here.read, id);
  if (item === undefined) throw new KnowledgeCmdError("There is no such item here.");
  return { id, item };
}

const day = (iso: string | undefined): string => iso?.slice(0, 10) ?? "an unknown day";

/** An item's status in a word or two. */
function statusWords(item: Pick<KnowledgeItem, "lifecycle" | "status" | "category">): string {
  const words: Readonly<Record<KnowledgeLifecycle, string>> = {
    live: item.status ?? "live",
    superseded: "replaced",
    expired: "expired",
    archived: "archived",
    cleared: "cleared",
    "deleted-restorable": "in the trash",
    retired: "retired",
  };
  return `${words[item.lifecycle]}${item.category === "person" ? ", personal" : ""}`;
}

const AUTHORS: Readonly<Record<KnowledgeItem["author"]["kind"], string>> = {
  agent: "the agent",
  operator: "a person",
  extractor: "the harness, from a conversation",
  sync: "another harness",
  upstream: "Thredz",
  unknown: "nobody on record",
};

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

async function status(here: Here, args: ParsedArgs, io: KnowledgeCmdIo): Promise<number> {
  const read = await readItems({
    ...here.read,
    hangarRoot: here.hangarRoot,
    canReadContent: true,
    limit: 1,
  });
  const usage = await foldUsage(here.dir);
  const shard = here.registered ? Shard.open(here.hangarRoot, here.hrn, here.dir) : undefined;
  const changed = shard?.changed(new HarnessRead(here.read)).size ?? 0;
  const index = {
    built: shard !== undefined,
    ...(shard !== undefined ? { asOf: shard.meta.asOf, current: changed === 0 } : {}),
  };
  if (flag(args, "json")) {
    io.stdout(
      JSON.stringify(
        {
          harness: { hrn: here.registered ? here.hrn : null, name: here.name },
          total: read.total,
          stores: read.stores,
          usageRecorded: usage.recorded,
          thredz: read.thredz,
          index,
          notes: read.notes,
          ...(read.truncated !== undefined ? { truncated: read.truncated } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  io.stdout(`${here.name}: what it knows`);
  if (read.total === 0) {
    io.stdout("  Nothing yet. Facts appear when the harness remembers something while it works.");
  }
  for (const store of KNOWLEDGE_STORES) {
    const count = read.stores[store];
    if (count !== undefined) io.stdout(`  ${store.padEnd(13)}${count}`);
  }
  io.stdout(
    `Kept in this harness's folder. Thredz: ${read.thredz === "off" ? "not read from the terminal" : read.thredz}.`,
  );
  io.stdout(
    usage.recorded
      ? "Runs record what they use: crewhaus knowledge usage <item>"
      : "Usage isn't recorded here yet, so nothing is known about which runs used what.",
  );
  io.stdout(
    shard === undefined
      ? "Search isn't built yet: crewhaus knowledge reindex"
      : `Search was built on ${day(shard.meta.asOf)}${changed === 0 ? "" : "; some of it changed since: crewhaus knowledge reindex"}`,
  );
  if (read.truncated !== undefined) io.stdout(read.truncated.reason);
  for (const note of read.notes) io.stdout(`note: ${note.message} (${note.store})`);
  return 0;
}

/** `--type`, `--status` and `--scope` as a filter, or a refusal naming what they take. */
function filterOf(args: ParsedArgs): ItemFilter {
  const type = str(args, "type");
  const status = str(args, "status");
  const scope = str(args, "scope");
  let stores: KnowledgeStore[] | undefined;
  if (type !== undefined) {
    const kinds = (kindsOf(type) ?? []).map((kind) => (kind === "dataset" ? "datasets" : kind));
    stores = kinds.filter(isKnowledgeStore);
    if (stores.length === 0) {
      throw new KnowledgeCmdError(
        `knowledge list: --type "${type}" names nothing to list (fact, wiki, plan, goal, requirement, focus, session, lesson, suggestion, document or dataset)`,
      );
    }
  }
  const scopes = ["spec", "session", "tenant", "shared"] as const;
  const named = scopes.find((s) => s === scope);
  if (scope !== undefined && named === undefined) {
    throw new KnowledgeCmdError(`knowledge list: --scope is one of ${scopes.join(", ")}`);
  }
  const words: Readonly<Record<string, string>> = {
    corrected: "superseded",
    replaced: "superseded",
  };
  const word = status === undefined ? undefined : (words[status] ?? status);
  const lifecycle = KNOWLEDGE_LIFECYCLES.find((l) => l === word);
  return {
    ...(stores !== undefined ? { stores } : {}),
    ...(lifecycle !== undefined
      ? { lifecycles: [lifecycle] }
      : word !== undefined
        ? { status: word }
        : {}),
    ...(named !== undefined ? { scope: named } : {}),
  };
}

async function list(here: Here, args: ParsedArgs, io: KnowledgeCmdIo): Promise<number> {
  const filter = filterOf(args);
  const read = await readItems({
    ...here.read,
    hangarRoot: here.hangarRoot,
    canReadContent: true,
    filter,
    limit: PAGE * 10,
  });
  if (flag(args, "json")) {
    io.stdout(JSON.stringify(read, null, 2));
    return 0;
  }
  if (read.total === 0) {
    io.stdout(
      Object.keys(filter).length > 0
        ? "Nothing matches. Remove a filter to see everything."
        : "Nothing yet. Facts appear when the harness remembers something while it works.",
    );
  }
  for (const item of read.items) {
    io.stdout(`${item.id}  ${statusWords(item)}  ${item.title}`);
  }
  if (read.next !== undefined) {
    io.stdout(`… and ${read.total - read.items.length} more; narrow them with --type or --status`);
  }
  if (read.truncated !== undefined) io.stdout(read.truncated.reason);
  for (const note of read.notes) io.stdout(`note: ${note.message} (${note.store})`);
  return 0;
}

async function show(here: Here, args: ParsedArgs, io: KnowledgeCmdIo): Promise<number> {
  const { id, item } = await itemHere(here, args, "show");
  const history = flag(args, "history") ? await readHistory(here.read, id) : undefined;
  const body = item.body === undefined ? undefined : maskedBody(item.body);
  if (flag(args, "json")) {
    io.stdout(
      JSON.stringify(
        {
          item: { ...item.item, freshness: item.freshness },
          ...(body !== undefined ? { body } : {}),
          ...(history !== undefined
            ? {
                history: history.map((entry) => ({
                  ...entry,
                  ...(entry.body !== undefined ? { body: maskedBody(entry.body) } : {}),
                })),
              }
            : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  io.stdout(`${item.item.title}`);
  io.stdout(`  ${id}`);
  io.stdout(
    `  ${statusWords(item.item)}${item.item.tags.length > 0 ? ` · tags: ${item.item.tags.join(", ")}` : ""}`,
  );
  if (body !== undefined && body.trim() !== "") {
    for (const line of body.split("\n")) io.stdout(`  | ${line}`);
  }
  for (const line of actionLines(item.item)) io.stdout(`  ${line}`);
  for (const entry of history ?? []) {
    const what = entry.version !== undefined ? `version ${entry.version}` : entry.what;
    const by = entry.author !== undefined ? `, by ${AUTHORS[entry.author.kind]}` : "";
    io.stdout(
      `  ${day(entry.at)}  ${what}${by}${entry.reason !== undefined ? ` — ${entry.reason}` : ""}`,
    );
  }
  if (history !== undefined && history.length === 0) io.stdout("  No earlier versions are kept.");
  return 0;
}

function actionLines(item: Pick<KnowledgeItem, "operations">): string[] {
  return item.operations.flatMap((op) => (op.cliTwin !== null ? [`${op.op}: ${op.cliTwin}`] : []));
}

/** Where an item came from, in a sentence. */
function whyLine(folded: FoldedItem): string {
  const { origin, author, evidence, ref } = folded.item;
  if (ref.backend === "thredz") return "Kept in Thredz.";
  if (origin.kind === "document" && origin.sources !== undefined) {
    return ref.store === "documents"
      ? `Indexed from ${origin.sources.join(", ")}.`
      : `From the sources listed in it: ${origin.sources.join(", ")}.`;
  }
  if (origin.kind === "sync") {
    return `Shared by ${origin.fromHarness ?? "another harness"}.`;
  }
  if (author.kind === "operator") return "Written by a person.";
  if (origin.session === undefined) return "No recorded source.";
  switch (evidence.status) {
    case "available":
      return evidence.evictsAt !== undefined
        ? `From a conversation (${origin.session}), kept until ${day(evidence.evictsAt)}.`
        : `From a conversation (${origin.session}), which is kept.`;
    case "evicted":
      return `From a conversation (${origin.session}) that was removed.`;
    default:
      return `From a conversation (${origin.session}).`;
  }
}

async function why(here: Here, args: ParsedArgs, io: KnowledgeCmdIo): Promise<number> {
  const { id, item } = await itemHere(here, args, "why");
  const line = whyLine(item);
  if (flag(args, "json")) {
    const { author, origin, evidence } = item.item;
    io.stdout(JSON.stringify({ id, why: line, author, origin, evidence }, null, 2));
    return 0;
  }
  io.stdout(item.item.title);
  io.stdout(`  ${line}`);
  io.stdout(
    `  Written by ${AUTHORS[item.item.author.kind]}${item.item.author.via !== undefined ? ` (${item.item.author.via})` : ""}.`,
  );
  if (item.item.evidence.status === "frozen") io.stdout("  The excerpt that proved it is kept.");
  return 0;
}

const RUN_RE = /^run_[0-9a-z]+$/;
const NOT_RECORDED: Readonly<Record<string, string>> = {
  "no-usage-log": "This harness has no usage log, so what this run used isn't recorded.",
  evicted:
    "The lines from that long ago were removed, so what this run used isn't recorded any more.",
  "none-seen": "No line names this run, so what it used isn't recorded.",
};

async function runUsage(
  here: Here,
  run: string,
  args: ParsedArgs,
  io: KnowledgeCmdIo,
): Promise<number> {
  const fold = await foldUsage(here.dir);
  const { items } = await foldItems(new HarnessRead(here.read));
  const answer = fold.runUsage(run, await fold.digests(items));
  if (flag(args, "json")) {
    io.stdout(JSON.stringify({ run, ...answer }, null, 2));
    return 0;
  }
  if (answer.state === "not-recorded") {
    io.stdout(NOT_RECORDED[answer.reason] ?? "What this run used isn't recorded.");
    return 0;
  }
  const titles = new Map(items.map(({ item }) => [item.id, item.title]));
  io.stdout(`${run} used:`);
  for (const use of answer.items) {
    const name =
      use.id !== undefined
        ? (titles.get(use.id) ?? use.id)
        : `something in ${use.store} that isn't here any more`;
    io.stdout(
      `  ${name}  (${viaWords(use.via)}${use.status === "included" ? "" : `, ${statusOfUse(use.status)}`})`,
    );
  }
  io.stdout(FOOTNOTE);
  return 0;
}

const FOOTNOTE = "This shows what was in the run's context, not why a decision was made.";

function viaWords(via: string): string {
  switch (via) {
    case "recall":
      return "recalled at the start";
    case "tail":
      return "part of the current plan";
    case "retrieve":
      return "found in the documents";
    default:
      return "returned by a tool";
  }
}

function statusOfUse(status: string): string {
  return status === "warned" ? "flagged" : "hidden for safety";
}

async function usage(here: Here, args: ParsedArgs, io: KnowledgeCmdIo): Promise<number> {
  const given = args.positional[0] ?? "";
  if (RUN_RE.test(given)) return runUsage(here, given, args, io);
  const { id, item } = await itemHere(here, args, "usage");
  const fold = await foldUsage(here.dir);
  const used = await fold.usageOf(item);
  const decisions = fold.decisionsIn([...new Set(used.uses.map((use) => use.run))]);
  if (flag(args, "json")) {
    io.stdout(JSON.stringify({ id, ...used, decisions }, null, 2));
    return 0;
  }
  io.stdout(item.item.title);
  if (!used.recorded) {
    io.stdout("  Usage isn't recorded for this, so nothing is known about which runs used it.");
    return 0;
  }
  io.stdout(
    used.runs === 0
      ? "  No recorded run used it."
      : `  Used in ${used.runs} run${used.runs === 1 ? "" : "s"}, last on ${day(used.lastUsedAt)}.`,
  );
  for (const use of used.uses.slice(0, PAGE)) {
    const version = use.version !== undefined ? `, version ${use.version}` : "";
    const hidden = use.status === "included" ? "" : `, ${statusOfUse(use.status)}`;
    io.stdout(`  ${use.at}  ${use.run}  ${viaWords(use.via)}${version}${hidden}`);
  }
  if (used.olderRuns.length > 0) {
    io.stdout(`  Used after it was corrected: ${used.olderRuns.join(", ")}`);
  }
  if (decisions.length > 0) {
    io.stdout("  Decisions made in runs that used this:");
    for (const decision of decisions.slice(0, PAGE)) {
      io.stdout(`    ${decision.at}  ${decision.decision}  ${decision.tool}  (${decision.run})`);
    }
    io.stdout(`  ${FOOTNOTE}`);
  }
  return 0;
}

/** The harnesses a search looks in: the one named, else every registered one and this one. */
function searchIn(here: Here, args: ParsedArgs, io: KnowledgeCmdIo): SearchHarness[] {
  const rows = registered(io);
  const own: SearchHarness = { hrn: here.hrn, dir: here.dir, name: here.name };
  const named = str(args, "harness");
  if (named === undefined) {
    const known = rows.some((row) => resolve(row.dir) === here.dir);
    const isHarness = existsSync(join(here.dir, "crewhaus.yaml")) || here.registered;
    return known || !isHarness ? rows : [...rows, own];
  }
  const dir = resolve(io.cwd, named);
  const found = rows.find(
    (row) => row.hrn === named || row.name === named || resolve(row.dir) === dir,
  );
  if (found !== undefined) return [found];
  if (dir === here.dir) return [own];
  throw new KnowledgeCmdError(
    `No registered harness is "${named}". crewhaus harness list names them.`,
  );
}

async function find(here: Here, args: ParsedArgs, io: KnowledgeCmdIo): Promise<number> {
  const q = args.positional.join(" ").trim();
  if (q === "") throw new KnowledgeCmdError("usage: crewhaus knowledge search <words>");
  const harnesses = searchIn(here, args, io);
  const one = str(args, "harness") !== undefined;
  const answer = await search({
    q,
    harnesses,
    hangarRoot: here.hangarRoot,
    // The local operator reads every harness on their own machine.
    canRead: () => true,
    canReadContent: () => true,
    now: io.now,
    scope: one ? "harness" : "fleet",
    foldMissing: one,
    limit: PAGE,
  });
  if (flag(args, "json")) {
    io.stdout(JSON.stringify(answer, null, 2));
    return 0;
  }
  for (const hit of answer.items) {
    io.stdout(
      `${hit.title}  (${hit.kind} · ${hit.source.harnessName}${hit.freshness.stale ? " · changed since search was built" : ""})`,
    );
    if (hit.snippet !== undefined) io.stdout(`    ${hit.snippet.text}`);
    io.stdout(`    ${hit.ref}`);
  }
  if (answer.total > answer.items.length) {
    io.stdout(`… and ${answer.total - answer.items.length} more; add a word or a filter`);
  }
  if (answer.empty !== undefined) {
    io.stdout(
      answer.empty.reason === "no-data"
        ? "Nothing here matches."
        : (answer.empty.remedy ?? "Nothing here matches."),
    );
  }
  if (answer.coverage.namesOnly.length > 0 && answer.empty?.reason !== "not-indexed") {
    io.stdout(
      `Search is still being built for ${answer.coverage.namesOnly.length} harness${answer.coverage.namesOnly.length === 1 ? "" : "es"}. Names are searchable now; crewhaus knowledge reindex builds one from its own folder.`,
    );
  }
  if (answer.truncated !== undefined) io.stdout(answer.truncated.reason);
  return 0;
}

async function reindex(here: Here, args: ParsedArgs, io: KnowledgeCmdIo): Promise<number> {
  const agentTool = io.env[AGENT_TOOL_ENV];
  if (agentTool !== undefined && agentTool !== "") {
    throw new KnowledgeCmdError(
      "knowledge reindex: this command was started by an agent's tool; a person does this",
    );
  }
  if (!here.registered) throw new KnowledgeCmdError(here.unbound ?? NOT_REGISTERED);
  const built = await buildShard({ ...here.read, hangarRoot: here.hangarRoot });
  if (!built.ok) throw new KnowledgeCmdError(`The search index was not written: ${built.reason}`);
  if (flag(args, "json")) {
    const { items, docs, truncated, notes, asOf } = built.meta;
    io.stdout(JSON.stringify({ hrn: here.hrn, items, docs, truncated, notes, asOf }, null, 2));
    return 0;
  }
  io.stdout(`Search is built for ${here.name}: ${built.meta.items} items.`);
  if (built.meta.truncated) {
    io.stdout(
      "This harness knows more than the index lists, so some of it can't be found by search.",
    );
  }
  for (const note of built.meta.notes) io.stdout(`note: ${note.message} (${note.store})`);
  return 0;
}

/** What one of a thing is called, and several of it. */
const STORE_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  facts: ["line about it in the fact file", "lines about it in the fact file"],
  "fact-archive": ["line about it in the kept history", "lines about it in the kept history"],
  "session-summaries": ["conversation summary", "conversation summaries"],
  "wiki-versions": ["article version", "article versions"],
  "working-memory": ["part of working memory", "parts of working memory"],
  trash: ["trash snapshot", "trash snapshots"],
  "shared-store": ["copy in the shared store", "copies in the shared store"],
  "pulled-copies": ["line another harness pulled", "lines another harness pulled"],
  "search-index": ["search index", "search indexes"],
};

function counted(store: string, count: number): string {
  const [one, many] = STORE_WORDS[store] ?? [store, store];
  return `${count} ${count === 1 ? one : many}`;
}

const RESIDUE_WORDS: Readonly<Record<ErasureResidue["code"], string>> = {
  "session-logs":
    "The conversations themselves and what runs saved of them. A summary can be made again while they last.",
  "usage-lines": "The usage log. It holds no text.",
  backups: "Backups you made.",
  thredz: "Anything kept in Thredz.",
  "shared-retraction":
    "A note in the shared store that tells other harnesses to drop their copies. It holds no text.",
  "origin-harness": "The harness that shared it keeps its own copy. Mark and delete it there too.",
  "dream-reports":
    "Notes from earlier consolidations that quote it, until newer ones replace them.",
  "unread-stores":
    "A place a copy may be that could not be read: a harness's facts, or a shared store. Fix it, then run this again.",
  "shared-elsewhere":
    "A shared store kept somewhere else. Name it with --shared <dir> to delete the copies there too.",
  "shared-unconfirmed":
    "A line in the shared store that says it came from this but says something else, so it was left as it is.",
};

function planLines(plan: ErasurePlan): string[] {
  const out: string[] = [];
  if (plan.targets.length > 0) out.push("Will delete:");
  for (const target of plan.targets) {
    const where =
      target.harness !== undefined
        ? ` (${target.harness})`
        : target.dir !== undefined
          ? ` (at ${target.dir})`
          : "";
    out.push(`  ${counted(target.store, target.copies)}${where}`);
  }
  if (plan.targets.length > 0 && plan.residue.length > 0) out.push("Can't delete:");
  for (const left of plan.targets.length > 0 ? plan.residue : []) {
    out.push(
      `  ${RESIDUE_WORDS[left.code]}${left.until !== undefined ? ` Kept until ${day(left.until)}.` : ""}`,
    );
  }
  for (const refusal of plan.refusals) out.push(`Refused: ${refusal.item} — ${refusal.reason}`);
  return out;
}

async function erase(here: Here, args: ParsedArgs, io: KnowledgeCmdIo): Promise<number> {
  if (args.positional.length === 0) {
    throw new KnowledgeCmdError("usage: crewhaus knowledge erase <item>…");
  }
  const items: string[] = [];
  for (const given of args.positional) items.push(await itemIdOf(here, given));
  const shared = str(args, "shared");
  const plan = await planErasure({
    harnessDir: here.dir,
    // Only a folder the registry names by its own id has an index here to remove.
    ...(here.registered ? { hrn: here.hrn } : {}),
    harnessName: here.name,
    hangarRoot: here.hangarRoot,
    items,
    includeSources: flag(args, "include-sources"),
    ...(shared !== undefined ? { sharedDirs: [resolve(io.cwd, shared)] } : {}),
    basis: { kind: "marked" },
    harnesses: registered(io),
    now: io.now,
  });
  const json = flag(args, "json");
  const shown = {
    targets: plan.targets,
    residue: plan.residue,
    refusals: plan.refusals,
  };
  if (!flag(args, "yes")) {
    if (json) io.stdout(JSON.stringify({ dryRun: true, ...shown }, null, 2));
    else {
      for (const line of planLines(plan)) io.stdout(line);
      if (plan.refusals.length === 0 && plan.targets.length > 0) {
        io.stdout(
          `Nothing was deleted. This can't be undone; to delete it, add: --yes --confirm ${here.name}`,
        );
      }
    }
    return plan.refusals.length > 0 ? 1 : 0;
  }
  let principal: string | undefined;
  let refusal: string | undefined;
  const authorized = authorizeErasure(plan, {
    mayManage: (dir) => {
      const check = io.owner(dir);
      if (!check.ok) {
        refusal ??= check.reason;
        return false;
      }
      if (check.principal !== undefined) principal ??= check.principal;
      return true;
    },
    confirmName: str(args, "confirm") ?? "",
    harnessName: here.name,
  });
  if (!authorized.ok) {
    for (const line of json ? [] : planLines(plan)) io.stdout(line);
    throw new KnowledgeCmdError(
      refusal !== undefined ? `Nothing was deleted: ${refusal}` : authorized.reason,
    );
  }
  const done = await executeErasure(authorized.grant, {
    actor: {
      ...(principal !== undefined ? { principal } : {}),
      local: localActorOf(currentLocalIdentity()),
    },
    refreshIndex: async (harness) => {
      // Only where an index existed; a harness without one is not given one here.
      if (!harness.hadIndex) return;
      await buildShard({
        harnessDir: harness.dir,
        hrn: harness.hrn,
        harnessName: harnessSpecName(harness.dir) ?? basename(harness.dir),
        hangarRoot: here.hangarRoot,
        now: io.now,
      });
    },
  });
  if (!done.ok) throw new KnowledgeCmdError(done.reason);
  if (json) {
    io.stdout(
      JSON.stringify({ dryRun: false, receipt: done.receipt, failed: done.failed }, null, 2),
    );
  } else {
    io.stdout("Deleted:");
    for (const [store, count] of Object.entries(done.receipt.counts)) {
      io.stdout(`  ${counted(store, count)}`);
    }
    if (done.receipt.residue.length > 0) io.stdout("Still there:");
    for (const left of done.receipt.residue) {
      io.stdout(
        `  ${RESIDUE_WORDS[left.code]}${left.until !== undefined ? ` Kept until ${day(left.until)}.` : ""}`,
      );
    }
    io.stdout("A record that something was deleted is kept, without the content.");
    for (const store of done.failed) {
      io.stdout(`Could not delete: ${STORE_WORDS[store]?.[1] ?? store}. Run the command again.`);
    }
  }
  return done.failed.length > 0 ? 1 : 0;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** A printed line with no C0 or C1 control character, so text a harness wrote cannot drive the terminal. */
function printable(line: string): string {
  return line.replace(CONTROL_RE, "");
}

/** JSON with DEL and the C1 controls escaped as well: `JSON.stringify` escapes C0 itself. */
function jsonSafe(text: string): string {
  return text.replace(
    /[\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Run one `crewhaus knowledge` verb. Answers the exit code. */
export async function runKnowledgeCmd(
  action: KnowledgeAction,
  args: ParsedArgs,
  given: KnowledgeCmdIo = defaultIo(),
): Promise<number> {
  // Titles and bodies are what a harness wrote: every line is printed safe for a terminal.
  const io: KnowledgeCmdIo = {
    ...given,
    stdout: (line) => given.stdout(flag(args, "json") ? jsonSafe(line) : printable(line)),
  };
  if (flag(args, "help")) {
    for (const line of HELP[action]) io.stdout(line);
    return 0;
  }
  const here = harnessHere(io);
  switch (action) {
    case "status":
      return status(here, args, io);
    case "list":
      return list(here, args, io);
    case "show":
      return show(here, args, io);
    case "why":
      return why(here, args, io);
    case "usage":
      return usage(here, args, io);
    case "search":
      return find(here, args, io);
    case "reindex":
      return reindex(here, args, io);
    case "erase":
      return erase(here, args, io);
    default:
      throw new KnowledgeCmdError(`knowledge: unknown action "${String(action satisfies never)}"`);
  }
}
