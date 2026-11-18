/**
 * `crewhaus inbox list|show|stats`: one inbox for every decision and problem across the
 * harnesses this machine has registered (#517, #513), read the way Home reads it. Each
 * harness's attention read model comes from Home's index when Home keeps one, or is
 * folded on the spot; the Advisor's findings are the ones Home last gathered (the CLI
 * runs no preflight). Reads only: nothing here writes, creates or compacts a file, and it
 * works with Home stopped.
 *
 * Run as the machine's own user, it shows what a harness asked, masked the way
 * `crewhaus approvals` masks it.
 */
import { existsSync } from "node:fs";
import {
  type HarnessAttention,
  type HarnessFacts,
  assembleInbox,
  attentionListBody,
  attentionProjection,
  classWordOf,
  harnessAttention,
  metricsOf,
  sentenceOf,
  windowMs,
  withAdvisorSnapshots,
} from "@crewhaus/attention";
import {
  ATTENTION_BANDS,
  ATTENTION_ID_RE,
  ATTENTION_KINDS,
  type AttentionItem,
  EXIT_FOR_ERROR,
  attentionRef,
  encodeCursor,
  parseRef,
} from "@crewhaus/control-contract";
import { type Projection, readModel } from "@crewhaus/control-service";
import {
  HARNESS_ID_RE,
  openHangarRegistry,
  resolveHangarRoot,
  slugOf,
} from "@crewhaus/harness-registry";
import { harnessEnvFacts } from "@crewhaus/harness-supervisor";
import { masked } from "./approvals-cmd";
import { parseFamilyArgs as parseArgs } from "./family-args";
import type { CliFamily } from "./verbs";

export const CLI_FAMILY = {
  verb: "inbox",
  since: "0.9.0",
  bare: "list",
  sub: {
    list: {
      flags: { harness: "value", kind: "value", band: "value", all: "boolean", json: "boolean" },
    },
    show: { flags: { json: "boolean" } },
    stats: { flags: { harness: "value", since: "value", json: "boolean" } },
  },
} as const satisfies CliFamily;

export type InboxDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
};

const USAGE = [
  "usage: crewhaus inbox [list] [--harness <h>] [--kind <kind>] [--band decide|fix|consider] [--all] [--json]",
  "       crewhaus inbox show <att_…> [--json]",
  "       crewhaus inbox stats [--harness <h>] [--since 30d] [--json]",
  "  Everything waiting on a person across this machine's harnesses: requests to decide,",
  "  problems to fix, and suggestions to consider. <h> is a harness id or its name.",
];

/** The refusal `inbox show` gives without an item. */
export const SHOW_NEEDS_ONE = "inbox show: name an item, att_… (see `crewhaus inbox list`)";

type Harness = { readonly id: string; readonly dir: string; readonly name: string };

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
      .map((e) => ({ id: e.id, dir: e.dir, name: e.slug ?? slugOf(e.specName) }));
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
};

function readerOf(
  env: Readonly<Record<string, string | undefined>>,
  harnesses: readonly Harness[],
) {
  const hangarRoot = resolveHangarRoot(env);
  const byDir = new Map(harnesses.map((h) => [h.dir, h.id]));
  const envFacts = harnessEnvFacts(env);
  const facts = withAdvisorSnapshots(envFacts, hangarRoot, (dir) => byDir.get(dir));
  return { hangarRoot, facts, projection: attentionProjection(envFacts) } satisfies Reader;
}

/** One harness as Home reads it: its saved model brought up to date, or a fold on the spot. */
function readHarness(reader: Reader, harness: Harness, now: number): HarnessAttention {
  const read = readModel(
    reader.hangarRoot,
    harness.id,
    harness.dir,
    reader.projection as unknown as Projection<ReturnType<Reader["projection"]["empty"]>>,
    now,
  );
  const advisor = reader.facts.advisorSnapshot?.(harness.dir);
  return harnessAttention(
    read.state,
    {
      harness: harness.id,
      dir: harness.dir,
      now,
      content: true,
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

/** One item's lines: id, what, where and since, why now, and the commands that act. */
function itemLines(item: AttentionItem, names: ReadonlyMap<string, string>, now: number): string[] {
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
  if (item.recommendation !== undefined) {
    out.push(
      `    Suggested: ${item.recommendation.choiceId}. ${sentenceOf(item.recommendation.reason)}`,
    );
  }
  for (const choice of item.choices) {
    out.push(
      choice.cliTwin !== null
        ? `    ${choice.id}: ${choice.cliTwin}`
        : `    ${choice.id}: ${choice.nullReason ?? "no command"}`,
    );
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

export async function runInboxCommand(argv: readonly string[], deps: InboxDeps = {}): Promise<Out> {
  if (argv.includes("--help") || argv.includes("-h")) return { lines: USAGE, exitCode: 0 };
  const first = argv[0];
  const sub = first === undefined || first.startsWith("-") ? "list" : first;
  const rest = first === undefined || first.startsWith("-") ? argv : argv.slice(1);
  if (sub !== "list" && sub !== "show" && sub !== "stats") {
    throw new Error(
      `unknown inbox verb "${sub}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
    );
  }
  const label = `inbox ${sub}`;
  const args = parseArgs(label, rest, CLI_FAMILY.sub[sub].flags);
  const value = (name: string) => args.values.get(name)?.[0];
  const json = args.booleans.has("json");
  const env = deps.env ?? process.env;
  const now = (deps.now ?? Date.now)();
  const all = harnessesOf(env);
  const names = new Map(all.map((h) => [h.id, h.name]));

  if (sub === "show") {
    const raw = args.positional[0];
    if (raw === undefined) return fail("invalid", SHOW_NEEDS_ONE);
    const parsed = parseRef(raw);
    const id = ATTENTION_ID_RE.test(raw)
      ? raw
      : !("error" in parsed) && parsed.kind === "attention" && parsed.scope === "home"
        ? parsed.id
        : undefined;
    if (id === undefined || !ATTENTION_ID_RE.test(id)) return fail("invalid", SHOW_NEEDS_ONE);
    const reader = readerOf(env, all);
    const inbox = assembleInbox(
      all.map((h) => readHarness(reader, h, now)),
      now,
      { state: "all" },
    );
    const item = inbox.all.find((candidate) => candidate.ref === attentionRef(id));
    if (item === undefined) {
      return fail(
        "not_found",
        `inbox show: no item ${id} here. Run \`crewhaus inbox list\` to see what is open.`,
      );
    }
    const view = shown(item);
    if (json) return { lines: [JSON.stringify(view, null, 2)], exitCode: 0 };
    return {
      lines: [
        `${BAND_LABEL[view.band] ?? view.band} · ${view.kind} · ${view.state}`,
        ...itemLines(view, names, now),
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
      `inbox ${sub}: no harness "${value("harness")}". Run \`crewhaus harness list\`.`,
    );
  }
  const reader = readerOf(env, all);
  const perHarness = scoped.map((h) => readHarness(reader, h, now));

  if (sub === "stats") {
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
  const inbox = assembleInbox(perHarness, now, {
    state: args.booleans.has("all") ? "all" : "open",
    ...(kind !== undefined ? { kind } : {}),
    ...(band !== undefined ? { band } : {}),
  });
  const body = attentionListBody(
    { ...inbox, items: inbox.items.map(shown) },
    {
      // A terminal prints every item: nothing is cut to a page.
      limit: Number.POSITIVE_INFINITY,
      filtered: kind !== undefined || band !== undefined || value("harness") !== undefined,
      visible: all.length,
      nameOf: (id) => names.get(id),
      snapshotAt: encodeCursor({ v: 1, kind: "fleet", epoch: 0, seq: 0 }),
    },
  );
  if (json) return { lines: [JSON.stringify(body, null, 2)], exitCode: 0 };
  const lines: string[] = [];
  for (const b of ATTENTION_BANDS) {
    const inBand = body.items.filter((item) => item.band === b);
    if (inBand.length === 0) continue;
    lines.push(BAND_LABEL[b] ?? b);
    for (const item of inBand) lines.push(...itemLines(item, names, now));
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
