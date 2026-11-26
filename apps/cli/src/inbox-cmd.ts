/**
 * `crewhaus inbox`: one inbox for every decision and problem across the harnesses this
 * machine has registered (#517, #513), read the way Home reads it. Each harness's
 * attention read model comes from Home's index when Home keeps one, or is folded on the
 * spot; the Advisor's findings are the ones Home last gathered (the CLI runs no
 * preflight). `list`, `show` and `stats` only read: they write, create and compact no
 * file, and work with Home stopped. The other verbs act (`./inbox-acts`), each under a
 * receipt in the harness's own ledger.
 *
 * Run as the machine's own user, it shows what a harness asked, masked the way
 * `crewhaus approvals` masks it.
 */
import { existsSync } from "node:fs";
import {
  type AccessSnapshot,
  type LocalIdentity,
  loadAccessSnapshot,
} from "@crewhaus/access-control";
import {
  type HarnessAttention,
  type HarnessFacts,
  assembleInbox,
  attentionListBody,
  attentionProjection,
  choiceEffectOf,
  classWordOf,
  harnessAttention,
  metricsOf,
  sentenceOf,
  windowMs,
  withAdvisorSnapshots,
} from "@crewhaus/attention";
import { listMessages } from "@crewhaus/attention/act";
import {
  ATTENTION_BANDS,
  ATTENTION_ID_RE,
  ATTENTION_KINDS,
  type AttentionItem,
  EXIT_FOR_ERROR,
  attentionRef,
  encodeCursor,
  isId,
  memberMayDecide,
  parseRef,
} from "@crewhaus/control-contract";
import { createApproverReader } from "@crewhaus/control-records";
import {
  type ControlService,
  type Projection,
  type RunHome,
  currentLocalIdentity,
  readModel,
  readStoredActor,
} from "@crewhaus/control-service";
import {
  HARNESS_ID_RE,
  openHangarRegistry,
  resolveHangarRoot,
  slugOf,
} from "@crewhaus/harness-registry";
import { harnessEnvFacts, systemClock } from "@crewhaus/harness-supervisor";
import { masked } from "./approvals-cmd";
import { type DaemonCommandOptions, directControl, resolveHarness } from "./daemon-cmd";
import { type FamilyArgs, parseFamilyArgs as parseArgs } from "./family-args";
import { fromAgentTool } from "./graph-resume";
import {
  type ActAsk,
  type ActContext,
  type ActHarness,
  type ActOutcome,
  INBOX_AGENT_REFUSAL,
  type InboxAct,
  actIn,
  askProblem,
  doneLine,
  exitOf,
  fileCapOf,
  readSmallFile,
  targetsOf,
} from "./inbox-acts";
import { jsonSafe, printable } from "./printable";
import { cliRunHome } from "./runs-cmd";
import type { CliFamily } from "./verbs";

export const CLI_FAMILY = {
  verb: "inbox",
  since: "0.9.0",
  bare: "list",
  sub: {
    list: {
      flags: {
        harness: "value",
        kind: "value",
        band: "value",
        mine: "boolean",
        all: "boolean",
        json: "boolean",
      },
    },
    show: { flags: { messages: "boolean", json: "boolean" } },
    stats: { flags: { harness: "value", since: "value", json: "boolean" } },
    decide: {
      flags: { harness: "value", expect: "value", "note-file": "value", json: "boolean" },
    },
    assign: { flags: { to: "value", harness: "value", json: "boolean" } },
    unassign: { flags: { harness: "value", json: "boolean" } },
    defer: { flags: { until: "value", reason: "value", harness: "value", json: "boolean" } },
    undefer: { flags: { harness: "value", json: "boolean" } },
    snooze: { flags: { until: "value", harness: "value", json: "boolean" } },
    dismiss: {
      flags: { reason: "value", "note-file": "value", harness: "value", json: "boolean" },
    },
    reopen: { flags: { "note-file": "value", harness: "value", json: "boolean" } },
    acknowledge: { flags: { "note-file": "value", harness: "value", json: "boolean" } },
    discuss: { flags: { file: "value", harness: "value", json: "boolean" } },
  },
} as const satisfies CliFamily;

export type InboxDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly cwd?: string;
  /** The control service the acts go through; the CLI's direct one by default. */
  readonly control?: () => ControlService;
  /** This machine's user; the one running the process by default. */
  readonly identity?: LocalIdentity;
  /** What a paused graph run's build is started with; the CLI's own supervisor by default. */
  readonly home?: (harnessDir: string) => RunHome;
};

const USAGE = [
  "usage: crewhaus inbox [list] [--harness <h>] [--kind <kind>] [--band decide|fix|consider] [--mine] [--all] [--json]",
  "       crewhaus inbox show <att_…> [--messages] [--json]",
  "       crewhaus inbox stats [--harness <h>] [--since 30d] [--json]",
  "       crewhaus inbox decide <att_…> <choice> [--expect <state>] [--note-file <path>]",
  "       crewhaus inbox assign <att_…> --to <prn_…>   |   unassign <att_…>",
  "       crewhaus inbox defer <att_…> --until <time> --reason <reason>   |   undefer <att_…>",
  "       crewhaus inbox snooze <att_…> --until <time>",
  "       crewhaus inbox dismiss <att_…> --reason <reason>   |   acknowledge <att_…>   |   reopen <att_…>",
  "       crewhaus inbox discuss <att_…> --file <path>",
  "  Everything waiting on a person across this machine's harnesses: requests to decide,",
  "  problems to fix, and suggestions to consider. <h> is a harness id or its name.",
  "  `show` lists an item's choices. `defer` puts it off for everyone, `snooze` hides it",
  "  from you only. An item about several harnesses is acted on in each; --harness picks one.",
];

/** The refusal `inbox show` gives without an item. */
export const SHOW_NEEDS_ONE = "inbox show: name an item, att_… (see `crewhaus inbox list`)";

type Harness = ActHarness;

type Out = { readonly lines: readonly string[]; readonly exitCode: number };

const fail = (code: keyof typeof EXIT_FOR_ERROR, line: string): Out => ({
  lines: [line],
  exitCode: EXIT_FOR_ERROR[code],
});

/** Every registered harness whose folder is there, without writing the registry. */
function harnessesOf(env: Readonly<Record<string, string | undefined>>): Harness[] {
  try {
    return openHangarRegistry({ env: { ...env, CREWHAUS_NO_REGISTRY: "1" } })
      .list()
      .filter((e) => e.archived === undefined && e.missingSince === null && existsSync(e.dir))
      .map((e) => ({
        id: e.id,
        dir: e.dir,
        name: e.slug ?? slugOf(e.specName),
        groups: e.groups,
      }));
  } catch {
    return [];
  }
}

/** The harness `--harness` names: its id or its name. */
function pick(harnesses: readonly Harness[], raw: string | undefined): Harness[] | undefined {
  if (raw === undefined) return [...harnesses];
  const hit = HARNESS_ID_RE.test(raw)
    ? harnesses.find((h) => h.id === raw)
    : harnesses.find((h) => h.name === raw);
  return hit === undefined ? undefined : [hit];
}

type Reader = {
  readonly hangarRoot: string;
  readonly facts: HarnessFacts;
  readonly projection: ReturnType<typeof attentionProjection>;
  readonly identity: LocalIdentity;
};

function readerOf(
  env: Readonly<Record<string, string | undefined>>,
  harnesses: readonly Harness[],
  identity: LocalIdentity,
) {
  const hangarRoot = resolveHangarRoot(env);
  const byDir = new Map(harnesses.map((h) => [h.dir, h.id]));
  const envFacts = harnessEnvFacts(env);
  const facts = withAdvisorSnapshots(envFacts, hangarRoot, (dir) => byDir.get(dir));
  return {
    hangarRoot,
    facts,
    projection: attentionProjection(envFacts),
    identity,
  } satisfies Reader;
}

/** One harness as Home reads it: its saved model brought up to date, or a fold on the spot. */
async function readHarness(
  reader: Reader,
  harness: Harness,
  now: number,
): Promise<HarnessAttention> {
  const read = readModel(
    reader.hangarRoot,
    harness.id,
    harness.dir,
    reader.projection as unknown as Projection<ReturnType<Reader["projection"]["empty"]>>,
    now,
  );
  const advisor = reader.facts.advisorSnapshot?.(harness.dir);
  const viewer = await readStoredActor(reader.hangarRoot, harness.dir, reader.identity).catch(
    () => undefined,
  );
  return harnessAttention(
    read.state,
    {
      harness: harness.id,
      dir: harness.dir,
      now,
      content: true,
      ...(viewer !== undefined ? { viewer } : {}),
      freshness: {
        asOf: new Date(now).toISOString(),
        mode: read.freshness,
        ...(read.stale ? { stale: true } : {}),
      },
    },
    { facts: reader.facts, ...(advisor !== undefined ? { advisor } : {}) },
  );
}

/** An item as this machine's user sees it: what a harness sent, masked. */
function shown(item: AttentionItem): AttentionItem {
  return item.body === undefined ? item : { ...item, body: masked(item.body) };
}

const ago = (iso: string, now: number): string => {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "at an unknown time";
  const abs = Math.abs(ms);
  const unit =
    abs < 3_600_000
      ? `${Math.max(1, Math.round(abs / 60_000))}m`
      : abs < 86_400_000
        ? `${Math.round(abs / 3_600_000)}h`
        : `${Math.round(abs / 86_400_000)}d`;
  return ms >= 0 ? `${unit} ago` : `in ${unit}`;
};

function idOf(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

/** A person an item or a message names, in words: never the raw id. */
type Who = (id: string) => string;

/**
 * "you" for the reader, a member's name as Home's records hold it, else "someone else"; the
 * id is for `--json`. Home's records are read once, and only when a name is wanted.
 */
export function whoOf(hangarRoot: string, me: ReadonlySet<string>): Who {
  let snapshot: AccessSnapshot | undefined | null = null;
  return (id) => {
    if (me.has(id)) return "you";
    if (id.startsWith("local:")) return "someone at this computer";
    if (snapshot === null) {
      let read: ReturnType<typeof loadAccessSnapshot> | undefined;
      try {
        read = loadAccessSnapshot(hangarRoot);
      } catch {
        read = undefined;
      }
      snapshot = read?.state === "present" ? read.snapshot : undefined;
    }
    const principals = snapshot?.subjects.principals;
    const name =
      principals !== undefined && isId("prn", id) && Object.hasOwn(principals, id)
        ? principals[id]?.displayName
        : undefined;
    return typeof name === "string" && name !== "" ? name : "someone else";
  };
}

/** Who has an item and until when it is out of the way, as lines. */
function standingLines(item: AttentionItem, who: Who): string[] {
  const out: string[] = [];
  if (item.assignee !== undefined) out.push(`    With ${who(item.assignee)}`);
  if (item.deferral !== undefined) {
    out.push(
      `    Put off until ${item.deferral.until}${
        item.deferral.deadlineMoved
          ? "; its deadline moved with it"
          : item.source.kind === "decision"
            ? "; its own deadline is unchanged"
            : ""
      }`,
    );
  }
  if (item.snoozedUntil !== undefined) out.push(`    Hidden from you until ${item.snoozedUntil}`);
  return out;
}

/**
 * Whether this person may make a lasting permission in a harness, as its list of who
 * decides says: anyone where it has none (its own machine's user), else its owner.
 * `undefined` where the list can't be read.
 */
function ownsHarness(dir: string, viewer: string | undefined, now: number): boolean | undefined {
  const read = createApproverReader()(dir);
  if (read.state === "absent") return true;
  if (read.state !== "present") return undefined;
  return viewer !== undefined && memberMayDecide(read.projection, viewer, "owner", now);
}

/** The harnesses this person may make a lasting permission in. */
type Owns = ReadonlyMap<string, boolean | undefined>;

function ownsOf(
  reads: readonly HarnessAttention[],
  harnesses: readonly Harness[],
  now: number,
): Owns {
  const viewers = new Map(reads.map((r) => [r.harness, r.viewer]));
  return new Map(harnesses.map((h) => [h.id, ownsHarness(h.dir, viewers.get(h.id), now)]));
}

/** An item's choices as this person has them: allowing from now on, or asking the owner to. */
function choicesFor(item: AttentionItem, owns: Owns): AttentionItem["choices"] {
  const owner = item.harness === undefined ? undefined : owns.get(item.harness);
  const other = owner === true ? "grant-propose" : owner === false ? "grant-always" : undefined;
  return item.choices.filter((choice) => choice.id !== other);
}

/** One item's lines: id, what, where and since, why now, and the commands that act. */
function itemLines(
  item: AttentionItem,
  names: ReadonlyMap<string, string>,
  now: number,
  owns: Owns,
  who: Who,
): string[] {
  const where = (item.harnesses ?? (item.harness !== undefined ? [item.harness] : []))
    .map((id) => names.get(id) ?? id)
    .join(", ");
  const out = [
    `  ${idOf(item.ref)}  ${sentenceOf(item.title)}`,
    `    ${[where, `since ${ago(item.since, now)}`, ...(item.band === "decide" ? [classWordOf(item.requiredClass)] : [])].filter((s) => s !== "").join(" · ")}`,
    `    ${sentenceOf(item.whyNow)}`,
  ];
  if (item.cause !== undefined) {
    out.push(`    Same cause: ${item.cause.label} (${item.affected.count} runs)`);
  }
  if (item.deadline !== undefined) {
    out.push(
      `    ${item.deadline.source === "agreement" ? "Decide by" : "Lapses"} ${item.deadline.at}`,
    );
  }
  if (item.band === "decide" && item.deadline === undefined && item.choices.length > 0) {
    out.push("    No deadline. It waits until someone decides.");
  }
  out.push(...standingLines(item, who));
  if (item.recommendation !== undefined) {
    out.push(
      `    Suggested: ${item.recommendation.choiceId}. ${sentenceOf(item.recommendation.reason)}`,
    );
  }
  for (const choice of choicesFor(item, owns)) {
    out.push(
      choice.cliTwin !== null
        ? `    ${choice.id}: ${choice.cliTwin}`
        : `    ${choice.id}: ${choice.nullReason ?? "no command"}`,
    );
    const effect = choiceEffectOf(item.kind, choice.id, choice);
    if (effect !== "") out.push(`      ${effect}`);
  }
  return out;
}

const BAND_LABEL: Readonly<Record<string, string>> = {
  decide: "Decide",
  fix: "Fix",
  consider: "Consider",
};

function unreachableLines(ids: readonly string[], names: ReadonlyMap<string, string>): string[] {
  return ids.map(
    (id) =>
      `Couldn't read the requests of ${names.get(id) ?? id}: its sessions folder is outside its folder. Keep the sessions folder inside the harness folder.`,
  );
}

/** The item a word names: its id, or its ref. */
function attentionIdOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseRef(raw);
  const id = ATTENTION_ID_RE.test(raw)
    ? raw
    : !("error" in parsed) && parsed.kind === "attention" && parsed.scope === "home"
      ? parsed.id
      : undefined;
  return id !== undefined && ATTENTION_ID_RE.test(id) ? id : undefined;
}

const unknownItem = (label: string, id: string): Out =>
  fail(
    "not_found",
    `${label}: no item ${id} here. Run \`crewhaus inbox list\` to see what is open.`,
  );

/** Every item, open and settled, as this person sees them. */
async function wholeInbox(reader: Reader, harnesses: readonly Harness[], now: number) {
  const reads = await Promise.all(harnesses.map((h) => readHarness(reader, h, now)));
  const me = new Set(reads.flatMap((h) => (h.viewer === undefined ? [] : [h.viewer])));
  return {
    ...assembleInbox(reads, now, { state: "all" }),
    owns: ownsOf(reads, harnesses, now),
    who: whoOf(reader.hangarRoot, me),
  };
}

/** What was said about an item, oldest first, with where when it is about several. */
function messagesView(item: AttentionItem, harnesses: readonly Harness[]) {
  const about = targetsOf(item, harnesses, undefined);
  const threads = about.map((h) => ({ harness: h, thread: listMessages(h.dir, idOf(item.ref)) }));
  const said = threads
    .flatMap(({ harness, thread }) => thread.messages.map((m) => ({ harness, message: m })))
    .sort((a, b) => Date.parse(a.message.at) - Date.parse(b.message.at));
  return { said, several: about.length > 1, truncated: threads.some((t) => t.thread.truncated) };
}

function showMessages(
  item: AttentionItem,
  harnesses: readonly Harness[],
  now: number,
  json: boolean,
  who: Who,
): Out {
  const { said, several, truncated } = messagesView(item, harnesses);
  const items = said.map(({ message }) => ({ ...message, text: String(masked(message.text)) }));
  if (json) {
    const body = {
      ref: item.ref,
      items,
      ...(items.length === 0
        ? { empty: { reason: "no-data", remedy: "No one has said anything here yet." } }
        : {}),
    };
    return { lines: [JSON.stringify(body, null, 2)], exitCode: 0 };
  }
  if (items.length === 0) return { lines: ["No one has said anything here yet."], exitCode: 0 };
  return {
    lines: [
      ...said.flatMap(({ harness, message }, i) => [
        `  ${[ago(message.at, now), who(message.by), `via ${message.via}`, ...(several ? [harness.name] : [])].join(" · ")}`,
        ...(items[i]?.text ?? "").split("\n").map((line) => `    ${line}`),
      ]),
      ...(truncated ? ["(older messages are left out)"] : []),
    ],
    exitCode: 0,
  };
}

/** Act on one item: the verbs that are not `list`, `show` or `stats`. */
async function actCommand(
  act: InboxAct,
  args: FamilyArgs,
  deps: InboxDeps,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Out> {
  const label = `inbox ${act}`;
  if (fromAgentTool(env)) return fail("forbidden", INBOX_AGENT_REFUSAL);
  const value = (name: string) => args.values.get(name)?.[0];
  const now = deps.now ?? Date.now;
  const id = attentionIdOf(args.positional[0]);
  if (id === undefined) {
    return fail("invalid", `${label}: name an item, att_… (see \`crewhaus inbox list\`)`);
  }
  const file = value(act === "discuss" ? "file" : "note-file");
  let text: string | undefined;
  if (file !== undefined) {
    const read = readSmallFile(file, fileCapOf(act), deps.cwd ?? process.cwd());
    if (!read.ok) return fail("invalid", `${label}: ${read.reason}`);
    text = read.text;
  }
  const choice = args.positional[1];
  const extra = args.positional[act === "decide" ? 2 : 1];
  if (extra !== undefined) return fail("invalid", `${label}: unexpected "${extra}"`);
  const field = (name: string, at: string | undefined) => (at !== undefined ? { [name]: at } : {});
  const ask: ActAsk = {
    act,
    ...(act === "decide" ? field("choice", choice) : {}),
    ...field("to", value("to")),
    ...field("until", value("until")),
    ...field("reason", value("reason")),
    ...field("expect", value("expect")),
    ...field(act === "discuss" ? "text" : "note", text),
  };
  const problem = askProblem(ask);
  if (problem !== undefined) return fail("invalid", `${label}: ${problem}`);

  const all = harnessesOf(env);
  const only = value("harness");
  const picked = only === undefined ? undefined : pick(all, only)?.[0];
  if (only !== undefined && picked === undefined) {
    return fail("not_found", `${label}: no harness "${only}". Run \`crewhaus harness list\`.`);
  }
  const identity = deps.identity ?? currentLocalIdentity();
  const reader = readerOf(env, all, identity);
  const inbox = await wholeInbox(reader, all, now());
  const item = inbox.all.find((candidate) => candidate.ref === attentionRef(id));
  if (item === undefined) return unknownItem(label, id);
  const targets = targetsOf(item, all, picked?.id);
  if (targets.length === 0) return unknownItem(label, id);
  if (act === "discuss" && targets.length > 1) {
    return fail(
      "invalid",
      `${label}: this is about ${targets.length} harnesses; name one with --harness`,
    );
  }
  const opts: DaemonCommandOptions = {
    env,
    identity,
    ...(deps.now !== undefined ? { clock: { ...systemClock, now: deps.now } } : {}),
  };
  const display = env["CREWHAUS_USER"] || identity.username;
  const context: ActContext = {
    control: deps.control?.() ?? directControl(opts),
    actor: { kind: "local", identity, ...(display !== "" ? { display } : {}) },
    display: display !== "" ? display : "cli",
    hangarRoot: reader.hangarRoot,
    now,
    graph: {
      env,
      resolve: (raw) => resolveHarness(raw, opts),
      home: deps.home ?? cliRunHome(opts, deps.now),
      harnessId: (dir) => all.find((h) => h.dir === dir)?.id ?? "",
    },
  };
  const outcomes: ActOutcome[] = [];
  for (const harness of targets) outcomes.push(await actIn(ask, item, harness, context));
  return actOut(ask, item, outcomes, args.booleans.has("json"));
}

function actOut(
  ask: ActAsk,
  item: AttentionItem,
  outcomes: readonly ActOutcome[],
  json: boolean,
): Out {
  const exitCode = exitOf(outcomes);
  if (json) {
    const body = outcomes.map((o) =>
      o.ok
        ? {
            ref: item.ref,
            harness: o.harness.id,
            event: o.answer.event,
            state: o.answer.state,
            ...(o.answer.detail !== undefined ? { detail: o.answer.detail } : {}),
            receipt: o.receipt,
          }
        : {
            ref: item.ref,
            harness: o.harness.id,
            error: { code: o.refusal.code, reason: o.refusal.reason, message: o.refusal.message },
            ...(o.receipt !== undefined ? { receipt: o.receipt } : {}),
          },
    );
    return { lines: [JSON.stringify(body.length === 1 ? body[0] : body, null, 2)], exitCode };
  }
  const several = outcomes.length > 1;
  const lines = outcomes.flatMap((o) => {
    const where = several ? `${o.harness.name}: ` : "";
    if (o.ok) {
      return [
        `${where}${doneLine(ask, item)}${o.answer.detail !== undefined ? ` ${o.answer.detail}` : ""}`,
        `  receipt ${o.receipt}`,
      ];
    }
    return [
      `${where}inbox ${ask.act}: ${o.refusal.message}`,
      ...(o.refusal.verb !== undefined ? [`  try: ${o.refusal.verb}`] : []),
      ...(o.receipt !== undefined ? [`  receipt ${o.receipt}`] : []),
    ];
  });
  return { lines, exitCode };
}

export async function runInboxCommand(argv: readonly string[], deps: InboxDeps = {}): Promise<Out> {
  const out = await inboxCommand(argv, deps);
  return { ...out, lines: out.lines.map(argv.includes("--json") ? jsonSafe : printable) };
}

async function inboxCommand(argv: readonly string[], deps: InboxDeps): Promise<Out> {
  if (argv.includes("--help") || argv.includes("-h")) return { lines: USAGE, exitCode: 0 };
  const first = argv[0];
  const sub = first === undefined || first.startsWith("-") ? "list" : first;
  const rest = first === undefined || first.startsWith("-") ? argv : argv.slice(1);
  if (!Object.hasOwn(CLI_FAMILY.sub, sub)) {
    throw new Error(
      `unknown inbox verb "${sub}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
    );
  }
  const verb = sub as keyof typeof CLI_FAMILY.sub;
  const label = `inbox ${verb}`;
  const args = parseArgs(label, rest, CLI_FAMILY.sub[verb].flags);
  const env = deps.env ?? process.env;
  if (verb !== "list" && verb !== "show" && verb !== "stats") {
    return actCommand(verb, args, deps, env);
  }
  const value = (name: string) => args.values.get(name)?.[0];
  const json = args.booleans.has("json");
  const now = (deps.now ?? Date.now)();
  const all = harnessesOf(env);
  const names = new Map(all.map((h) => [h.id, h.name]));
  const identity = deps.identity ?? currentLocalIdentity();

  if (verb === "show") {
    const id = attentionIdOf(args.positional[0]);
    if (id === undefined) return fail("invalid", SHOW_NEEDS_ONE);
    const inbox = await wholeInbox(readerOf(env, all, identity), all, now);
    const item = inbox.all.find((candidate) => candidate.ref === attentionRef(id));
    if (item === undefined) return unknownItem("inbox show", id);
    if (args.booleans.has("messages")) return showMessages(item, all, now, json, inbox.who);
    const view = shown(item);
    if (json) return { lines: [JSON.stringify(view, null, 2)], exitCode: 0 };
    return {
      lines: [
        `${BAND_LABEL[view.band] ?? view.band} · ${view.kind} · ${view.state}`,
        ...itemLines(view, names, now, inbox.owns, inbox.who),
        ...(view.body !== undefined
          ? [
              "  What the harness sent (masked):",
              ...JSON.stringify(view.body, null, 2)
                .split("\n")
                .map((l) => `    ${l}`),
            ]
          : []),
      ],
      exitCode: 0,
    };
  }

  const scoped = pick(all, value("harness"));
  if (scoped === undefined) {
    return fail(
      "not_found",
      `inbox ${verb}: no harness "${value("harness")}". Run \`crewhaus harness list\`.`,
    );
  }
  const reader = readerOf(env, all, identity);
  const perHarness = await Promise.all(scoped.map((h) => readHarness(reader, h, now)));

  if (verb === "stats") {
    const since = value("since") ?? "30d";
    const span = windowMs(since);
    if (span === undefined)
      return fail("invalid", "inbox stats: --since is a window like 30d, 12h or 90m");
    const inbox = assembleInbox(perHarness, now, { state: "all" });
    const body = {
      ...metricsOf({ items: inbox.all, decisions: inbox.decisions }, { since: now - span, now }),
      harnesses: scoped.length,
      ...(inbox.unreachable.length > 0 ? { unreachable: inbox.unreachable } : {}),
    };
    if (json) return { lines: [JSON.stringify(body, null, 2)], exitCode: 0 };
    const minutes = (ms: number | null) => (ms === null ? "—" : `${Math.round(ms / 60_000)}m`);
    return {
      lines: [
        `Since ${body.since}, across ${body.harnesses} harness${body.harnesses === 1 ? "" : "es"}:`,
        ...(body.open.length === 0
          ? ["  Nothing is open."]
          : body.open.map(
              (r) => `  open ${r.kind}: ${r.open} (half waited ${minutes(r.p50Ms)} or less)`,
            )),
        ...body.resolutionByVia.map(
          (r) => `  decided via ${r.decidedVia}: ${r.resolved} (half within ${minutes(r.p50Ms)})`,
        ),
        `  settled by a fallback: ${body.fallbacks}`,
        `  asked again within 30 days: ${body.reasks}`,
        ...unreachableLines(inbox.unreachable, names),
      ],
      exitCode: 0,
    };
  }

  const kind = value("kind");
  const band = value("band");
  if (kind !== undefined && !(ATTENTION_KINDS as readonly string[]).includes(kind)) {
    return fail("invalid", `inbox list: --kind is one of ${ATTENTION_KINDS.join(", ")}`);
  }
  if (band !== undefined && !(ATTENTION_BANDS as readonly string[]).includes(band)) {
    return fail("invalid", `inbox list: --band is one of ${ATTENTION_BANDS.join(", ")}`);
  }
  const mine = args.booleans.has("mine");
  const me = new Set(perHarness.map((h) => h.viewer).filter((v) => v !== undefined));
  const who = whoOf(reader.hangarRoot, me);
  const inbox = assembleInbox(perHarness, now, {
    state: args.booleans.has("all") ? "all" : "open",
    ...(kind !== undefined ? { kind } : {}),
    ...(band !== undefined ? { band } : {}),
  });
  const items = mine
    ? inbox.items.filter((item) => item.assignee !== undefined && me.has(item.assignee))
    : inbox.items;
  const body = attentionListBody(
    { ...inbox, items: items.map(shown) },
    {
      // A terminal prints every item: nothing is cut to a page.
      limit: Number.POSITIVE_INFINITY,
      filtered: mine || kind !== undefined || band !== undefined || value("harness") !== undefined,
      visible: all.length,
      nameOf: (id) => names.get(id),
      snapshotAt: encodeCursor({ v: 1, kind: "fleet", epoch: 0, seq: 0 }),
    },
  );
  if (json) return { lines: [JSON.stringify(body, null, 2)], exitCode: 0 };
  const lines: string[] = [];
  const owns = ownsOf(perHarness, scoped, now);
  for (const b of ATTENTION_BANDS) {
    const inBand = body.items.filter((item) => item.band === b);
    if (inBand.length === 0) continue;
    lines.push(BAND_LABEL[b] ?? b);
    for (const item of inBand) lines.push(...itemLines(item, names, now, owns, who));
  }
  if (body.items.length === 0) {
    lines.push(
      body.empty?.reason === "no-access"
        ? "No harness is registered on this machine yet. Run `crewhaus harness add <dir>`."
        : (body.empty?.remedy ?? "Nothing needs you right now."),
    );
  }
  lines.push(...unreachableLines(body.unreachable ?? [], names));
  if ((body.advisorUnchecked ?? []).length > 0) {
    lines.push("Advisor findings appear after Home has checked a harness.");
  }
  if (body.truncated !== undefined)
    lines.push(`(cut short; \`${body.truncated.verb}\` reads it all)`);
  return { lines, exitCode: 0 };
}
