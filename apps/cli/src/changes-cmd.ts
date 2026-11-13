/**
 * `crewhaus changes`: change records for this harness's spec, graders and cases.
 *
 *   list      every change and what it waits on (a read: nothing is written)
 *   show      one change: what it touches, its check, its decision and the next command
 *   propose   file a change from a proposed file, or from an optimize run
 *   check     run its check (says how many model calls and held-out reads first)
 *   adopt     apply a change whose decision was granted
 *   decline   decline a checked change
 *   withdraw  withdraw a change nobody has decided on
 *   rollback  apply an adopted change's inverse
 *
 * Every writing sub-verb runs under a `quality.changes.*` command receipt in the
 * harness's own ledger and takes the harness's mutating lease; a refusal exits with the
 * core's exit band. Deciding is `crewhaus approvals grant|deny <dec_>`. Factored out of
 * the entry file `index.ts`; side-effect-free on import, each verb returns lines and an
 * exit code, and bad arguments throw plain `Error`s that `index.ts` routes through
 * `die()`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openAuditLog } from "@crewhaus/audit-log";
import {
  CHANGE_SOURCES,
  type ChangeReason,
  type ChangeSource,
  EXIT_FOR_ERROR,
  EXIT_FOR_REJECTED_RECEIPT,
  PERSON_CHANGE_REASONS,
  isId,
  memberMayDecide,
} from "@crewhaus/control-contract";
import {
  readApproverProjection,
  readChangeAdoptions,
  readDeployments,
} from "@crewhaus/control-records";
import { type ControlService, currentLocalIdentity, outcomeOf } from "@crewhaus/control-service";
import { parseRegistryRef } from "@crewhaus/dataset-ops/datasets";
import { createFileBackedRegistry, latestVersion } from "@crewhaus/dataset-registry";
import {
  type AuditView,
  type ChangeRow,
  type CheckPlan,
  adoptChange,
  checkChange,
  createChange,
  declineChange,
  deploymentViewOf,
  effectiveChangeState,
  listLegacyProposals,
  mintChangeId,
  observeChanges,
  planCheck,
  readChange,
  readChangeContent,
  readChanges,
  rollbackChange,
  withdrawChange,
} from "@crewhaus/quality-service";
import { parseSpec } from "@crewhaus/spec";
import { AGENT_TOOL_ENV } from "./approvals-cmd";
import { holdCliMutatingLease, holdsCliMutatingLease } from "./mutating-lease";
import { OPTIMIZE_RUN_ID, readOptimizeCandidate } from "./optimize-proposal";
import { localStoredActor, qualityControl, withQualityReceipt } from "./quality-receipts";
import { currentCheckInstrument, hasExternalWriteTools, qualityRunners } from "./quality-runners";
import type { CliFamily } from "./verbs";

export type ChangesCommandResult = { readonly lines: readonly string[]; readonly exitCode: number };

export type ChangesCommandOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly now?: () => number;
  /** The control service; tests inject one. */
  readonly control?: ControlService;
  /** Register a spec-registry version of a written spec (the CLI's `autoRegisterSpec`). */
  readonly register?: (yamlText: string) => Promise<{ version: string } | undefined>;
};

/**
 * The `changes` family in the CLI's verb inventory (`verbs.ts`): each sub-verb and the
 * flags its parser takes.
 */
export const CLI_FAMILY = {
  verb: "changes",
  since: "0.9.0",
  sub: {
    list: { flags: { json: "boolean" } },
    show: { flags: { json: "boolean" } },
    propose: {
      flags: {
        from: "value",
        source: "value",
        kind: "value",
        dataset: "value",
        graders: "value",
        spec: "value",
        "dry-run": "boolean",
        json: "boolean",
      },
    },
    check: { flags: { live: "boolean", yes: "boolean", json: "boolean" } },
    adopt: {
      flags: {
        expect: "value",
        "without-holdout": "boolean",
        "watch-hours": "value",
        json: "boolean",
      },
    },
    decline: { flags: { reason: "value" } },
    withdraw: { flags: { reason: "value" } },
    rollback: { flags: { expect: "value", json: "boolean" } },
  },
} as const satisfies CliFamily;

const USAGE: readonly string[] = [
  "usage:",
  "  crewhaus changes list [--json]                 every change, and what it waits on",
  "  crewhaus changes show <chg> [--json]           one change: its check, decision and next step",
  "  crewhaus changes propose --from <proposed.yaml|opt_…> [--source <s>] [--kind spec|graders|dataset]",
  "       [--dataset <d>] [--graders <g>] [--spec <s>] [--dry-run]",
  "                                                 file a change; nothing is written to the spec",
  "  crewhaus changes check <chg> [--live] [--yes]  check it against the eval history (and the",
  "                                                 holdout); says what it spends, then stops without --yes",
  "  crewhaus changes adopt <chg> --expect <rev> [--without-holdout] [--watch-hours <n>]",
  "                                                 apply a change whose decision was granted",
  "  crewhaus changes decline <chg> --reason not-worth-it|wrong-direction|needs-owner|other",
  "  crewhaus changes withdraw <chg> [--reason <code>]",
  "  crewhaus changes rollback <chg> --expect <rev> apply an adopted change's inverse",
  "",
  "  Deciding is `crewhaus approvals grant|deny <dec_…>`. Adopting never activates:",
  "  `crewhaus deploy activate` does.",
];

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

type FlagKind = "value" | "boolean";

type Args = {
  readonly positional: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
};

function parseArgs(
  verb: string,
  argv: readonly string[],
  spec: Readonly<Record<string, FlagKind>>,
): Args {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = spec[name];
    if (kind === undefined) {
      const known = Object.keys(spec).map((key) => `--${key}`);
      throw new Error(`changes ${verb}: unknown flag "${arg}" (expected: ${known.join(", ")})`);
    }
    if (kind === "boolean") {
      booleans.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`changes ${verb}: ${arg} needs a value`);
    if (values.has(name)) throw new Error(`changes ${verb}: ${arg} can be given once`);
    values.set(name, value);
    i++;
  }
  return { positional, values, booleans };
}

/** The one `<chg>` a verb acts on. */
function changeId(verb: string, args: Args): string {
  if (args.positional.length !== 1) {
    throw new Error(`changes ${verb}: name one change (chg_…)`);
  }
  const chg = args.positional[0] as string;
  if (!isId("chg", chg)) throw new Error(`changes ${verb}: "${chg}" is not a change id (chg_…)`);
  return chg;
}

function requireValue(verb: string, args: Args, name: string): string {
  const value = args.values.get(name);
  if (value === undefined) throw new Error(`changes ${verb}: --${name} is required`);
  return value;
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

type Session = {
  readonly harnessDir: string;
  readonly now: () => number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly control: ControlService;
  readonly register?: (yamlText: string) => Promise<{ version: string } | undefined>;
};

function sessionOf(options: ChangesCommandOptions): Session {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  return {
    harnessDir: resolve(options.cwd ?? process.cwd()),
    now,
    env,
    control: options.control ?? qualityControl({ env, now }),
    ...(options.register !== undefined ? { register: options.register } : {}),
  };
}

/** Whether the local user may decide at `requiredClass` here, now. */
function localMayDecide(session: Session, requiredClass: "maintainer" | "owner"): boolean {
  const read = readApproverProjection(session.harnessDir);
  if (read.state === "absent") return true;
  if (read.state !== "present") return false;
  const who = session.control.decisions.principalOf({
    kind: "local",
    identity: currentLocalIdentity(),
  });
  if (who.service === true || who.principal === undefined) return false;
  return memberMayDecide(read.projection, who.principal, requiredClass, session.now());
}

/** What a person decides, refused when an agent's tool started the command. */
function agentToolRefusal(session: Session, what: string): ChangesCommandResult | undefined {
  const marker = session.env[AGENT_TOOL_ENV];
  if (marker === undefined || marker === "") return undefined;
  return {
    lines: [`This command was started by an agent's tool; a person ${what}.`],
    exitCode: EXIT_FOR_ERROR.forbidden,
  };
}

/** The audit log's day files, newest last. */
const AUDIT_DAY_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * The SLO mitigation records the run path's SLO sink wrote to the harness's audit log
 * since `sinceMs`: what the watch after activation reads for an SLO rollback. A log
 * that cannot be read is `"unreadable"`, never an empty tail.
 */
export async function sloAuditSince(
  harnessDir: string,
  sinceMs: number,
): Promise<AuditView[] | "unreadable"> {
  const dir = join(harnessDir, ".crewhaus", "audit");
  if (!existsSync(dir)) return [];
  try {
    // A day before, so a day file named in another zone than the record's time is read.
    const sinceDay = new Date(sinceMs - 86_400_000).toISOString().slice(0, 10);
    const days = readdirSync(dir)
      .filter((name) => AUDIT_DAY_RE.test(name))
      .map((name) => name.slice(0, 10))
      .filter((day) => day >= sinceDay)
      .sort();
    if (days.length === 0) return [];
    const log = await openAuditLog({ rootDir: dir });
    const out: AuditView[] = [];
    for (const day of days) {
      for await (const record of log.read({ day })) {
        if (record.kind === "slo_mitigation" && record.ts >= sinceMs) {
          out.push({ kind: record.kind, ts: record.ts, payload: record.payload });
        }
      }
    }
    return out;
  } catch {
    return "unreadable";
  }
}

/**
 * A writer's courtesy pass: record what the other records already say. It reads the
 * SLO mitigation records written since the oldest watched change was activated, and a
 * `checking` change is taken for an interrupted check when this process holds the
 * harness's mutating lease (a check holds it for as long as it runs).
 */
async function observe(session: Session): Promise<void> {
  try {
    const read = readChanges(session.harnessDir);
    const watched =
      read.state === "present"
        ? read.rows.filter((r) => r.state === "monitoring").map((r) => Date.parse(r.at))
        : [];
    const since = watched.filter(Number.isFinite);
    const audit =
      since.length > 0 ? await sloAuditSince(session.harnessDir, Math.min(...since)) : [];
    await observeChanges({
      harnessDir: session.harnessDir,
      now: session.now,
      audit,
      interruptedCheck: () => holdsCliMutatingLease(session.harnessDir, session.env),
    });
  } catch {
    // Observation never stops the verb a person asked for.
  }
}

const done = (lines: readonly string[]): ChangesCommandResult => ({ lines, exitCode: 0 });

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

function effectiveRows(session: Session) {
  const read = readChanges(session.harnessDir);
  if (read.state !== "present") return { read, effective: [] };
  const deployments = readDeployments(session.harnessDir);
  const views =
    deployments.state === "present"
      ? deployments.records.flatMap((r) => {
          const v = deploymentViewOf(r);
          return v === undefined ? [] : [v];
        })
      : [];
  const decisions = readChangeAdoptions(session.harnessDir);
  const effective = effectiveChangeState(
    read.rows,
    views,
    decisions.state === "present" ? decisions.rows : [],
    session.now(),
  );
  return { read, effective };
}

function listVerb(session: Session, argv: readonly string[]): ChangesCommandResult {
  const args = parseArgs("list", argv, CLI_FAMILY.sub.list.flags);
  if (args.positional.length > 0) throw new Error("changes list: takes no arguments");
  const { read, effective } = effectiveRows(session);
  const legacy = listLegacyProposals(session.harnessDir);
  if (read.state === "unreadable") {
    return { lines: [`the change records can't be read: ${read.reason}`], exitCode: 1 };
  }
  const rows = read.state === "present" ? read.rows : [];
  if (args.booleans.has("json")) {
    return done([
      JSON.stringify(
        {
          changes: rows.map((row) => ({
            ...row,
            effective: effective.find((e) => e.chg === row.id),
          })),
          legacy,
          anomalies: read.state === "present" ? read.anomalies : [],
        },
        null,
        2,
      ),
    ]);
  }
  if (rows.length === 0 && legacy.length === 0) {
    return done([
      "No changes yet. File one with `crewhaus changes propose --from <proposed.yaml>`, or run `crewhaus optimize --propose`.",
    ]);
  }
  const lines = [`changes in ${session.harnessDir} (newest first):`];
  for (const row of [...rows].reverse()) {
    const e = effective.find((x) => x.chg === row.id);
    lines.push(
      `  ${row.id}  ${(e?.display ?? row.state).padEnd(24)}  ${row.kind.padEnd(7)}  ${row.source}  ${row.at}`,
    );
  }
  for (const name of legacy) lines.push(`  ${name}  legacy proposal (no lifecycle)`);
  if (read.state === "present")
    for (const anomaly of read.anomalies) lines.push(`  note: ${anomaly}`);
  return done(lines);
}

/** The commands that move a change on from where it is. */
function nextCommands(row: ChangeRow, decisionState: string | undefined): string[] {
  const id = row.id;
  switch (row.state) {
    case "proposed":
    case "failed":
      return [`crewhaus changes check ${id}`, `crewhaus changes withdraw ${id}`];
    case "checked":
      return [
        `crewhaus changes decline ${id} --reason not-worth-it`,
        `crewhaus changes withdraw ${id}`,
      ];
    case "awaiting-decision":
      if (row.decision === undefined) return [];
      return decisionState === "granted"
        ? [`crewhaus changes adopt ${id} --expect ${row.base.revision}`]
        : [`crewhaus approvals grant ${row.decision}`, `crewhaus approvals deny ${row.decision}`];
    case "adopted":
      return [
        "crewhaus deploy activate",
        ...(row.adoption !== undefined
          ? [`crewhaus changes rollback ${id} --expect ${row.adoption.revision}`]
          : []),
      ];
    case "monitoring":
      return row.adoption !== undefined
        ? [`crewhaus changes rollback ${id} --expect ${row.adoption.revision}`]
        : [];
    default:
      return [];
  }
}

function showVerb(session: Session, argv: readonly string[]): ChangesCommandResult {
  const args = parseArgs("show", argv, CLI_FAMILY.sub.show.flags);
  const chg = changeId("show", args);
  const { effective } = effectiveRows(session);
  const row = readChange(session.harnessDir, chg);
  if (row === undefined) return { lines: [`no change ${chg} here`], exitCode: 1 };
  const e = effective.find((x) => x.chg === chg);
  let patch: { diff?: Array<{ kind: string; path: string }>; dataset?: string } = {};
  try {
    patch = JSON.parse(readChangeContent(session.harnessDir, chg, "patch.json") ?? "{}");
  } catch {
    patch = {};
  }
  const next = nextCommands(row, e?.decision);
  if (args.booleans.has("json")) {
    return done([JSON.stringify({ change: row, effective: e, patch, next }, null, 2)]);
  }
  const lines = [
    `${row.id}  ${e?.display ?? row.state}`,
    `  kind ${row.kind} · source ${row.source} · proposed against ${row.base.revision}`,
    `  touches: ${row.touches.surfaces.join(", ") || "nothing named"}${row.touches.protected ? " · a protected bar" : ""}${row.touches.intent ? " · the intent" : ""}${row.touches.security ? " · a security surface" : ""}`,
  ];
  for (const d of patch.diff ?? []) lines.push(`    ${d.kind} ${d.path}`);
  if (row.verdict !== undefined) {
    lines.push(
      `  check: ${row.verdict.comparison} · holdout ${row.verdict.holdout} · ${row.verdict.regressions} regression(s), ${row.verdict.recoveries} recovery(ies)`,
    );
  }
  if (row.evidenceRef !== undefined) lines.push(`  evidence: ${row.evidenceRef}`);
  if (row.decision !== undefined) {
    lines.push(
      `  decision ${row.decision} (${e?.decision ?? "unknown"}), needs a ${row.requiredClass ?? "maintainer"}`,
    );
  }
  if (row.adoption !== undefined) lines.push(`  adopted: the spec is at ${row.adoption.revision}`);
  if (next.length > 0) {
    lines.push("  next:");
    for (const command of next) lines.push(`    ${command}`);
  }
  return done(lines);
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

/** The settle of a receipted change verb, from its answer. */
function settleOf(ok: boolean, code?: string) {
  return ok
    ? { state: "succeeded" as const }
    : {
        state: "rejected" as const,
        outcome: outcomeOf(
          code === "unavailable"
            ? "unavailable"
            : code === "not-authorized"
              ? "forbidden"
              : "invalid",
        ),
      };
}

function receiptLines(
  answer: Awaited<ReturnType<typeof withQualityReceipt<{ ok: boolean; lines: string[] }>>>,
): ChangesCommandResult {
  if (!answer.ok) return { lines: [`not done — ${answer.reason}`], exitCode: answer.exitCode };
  const value = answer.value;
  if (value === undefined) {
    return { lines: [`${answer.receipt.id} already ran`], exitCode: 0 };
  }
  return value.ok
    ? { lines: [...value.lines, `Done (${answer.receipt.id})`], exitCode: 0 }
    : {
        lines: [...value.lines, `Not done (${answer.receipt.id})`],
        exitCode: EXIT_FOR_REJECTED_RECEIPT,
      };
}

function readFrom(session: Session, from: string, specRel: string): string {
  // An optimize run: its patches applied to the spec as it is now.
  if (OPTIMIZE_RUN_ID.test(from)) return readOptimizeCandidate(session.harnessDir, from, specRel);
  const path = resolve(session.harnessDir, from);
  if (!existsSync(path)) throw new Error(`changes propose: no file at ${path}`);
  return readFileSync(path, "utf8");
}

async function proposeVerb(
  session: Session,
  argv: readonly string[],
): Promise<ChangesCommandResult> {
  const args = parseArgs("propose", argv, CLI_FAMILY.sub.propose.flags);
  if (args.positional.length > 0)
    throw new Error("changes propose: pass the file as --from <file>");
  const from = requireValue("propose", args, "from");
  const kind = args.values.get("kind") ?? "spec";
  if (kind !== "spec" && kind !== "graders" && kind !== "dataset") {
    throw new Error(`changes propose: --kind is spec, graders or dataset (got "${kind}")`);
  }
  if (OPTIMIZE_RUN_ID.test(from) && kind !== "spec")
    throw new Error("changes propose: an optimize run proposes a spec change (--kind spec)");
  const source = (args.values.get("source") ?? "manual") as ChangeSource;
  if (!(CHANGE_SOURCES as readonly string[]).includes(source)) {
    throw new Error(`changes propose: --source is one of ${CHANGE_SOURCES.join(", ")}`);
  }
  const spec = args.values.get("spec") ?? "crewhaus.yaml";
  const graders = args.values.get("graders") ?? join("eval", "graders.yaml");
  const dataset = args.values.get("dataset") ?? join("eval", "dataset.jsonl");
  const candidateText = readFrom(session, from, spec);
  let baseText: string;
  if (kind === "dataset") {
    const ref = parseRegistryRef(dataset);
    if (ref === undefined)
      throw new Error(
        "changes propose: a dataset change adds cases to a registry dataset (--dataset registry:<name>)",
      );
    const registry = createFileBackedRegistry({
      rootDir: join(session.harnessDir, ".crewhaus", "datasets"),
    });
    const version = await latestVersion(registry, ref.name);
    if (version === undefined)
      throw new Error(`changes propose: dataset ${ref.name} has no versions`);
    baseText = JSON.stringify({ dataset: `${ref.name}@${version}` });
  } else {
    const target = join(session.harnessDir, kind === "spec" ? spec : graders);
    if (!existsSync(target)) throw new Error(`changes propose: no ${kind} file at ${target}`);
    baseText = readFileSync(target, "utf8");
  }
  if (baseText === candidateText) {
    return {
      lines: [
        "changes propose: the proposed file is the same as the current one — nothing to propose",
      ],
      exitCode: 1,
    };
  }
  const chg = mintChangeId(session.now());
  if (args.booleans.has("dry-run")) {
    return done([`would file ${chg} (${kind}, source ${source}); nothing was written`]);
  }
  await holdCliMutatingLease(session.harnessDir, "changes propose", { env: session.env });
  await observe(session);
  const actor = await localStoredActor(session.harnessDir, session.control);
  const answer = await withQualityReceipt<{ ok: boolean; lines: string[] }>(
    {
      harnessDir: session.harnessDir,
      kind: "quality.changes.create",
      target: { kind: "change", id: chg },
      body: { kind, source },
      control: session.control,
      env: session.env,
    },
    async (receipt) => {
      const created = await createChange({
        harnessDir: session.harnessDir,
        chg,
        kind,
        source,
        spec,
        graders,
        dataset,
        baseText,
        candidateText,
        actor,
        cmd: receipt.id,
        via: "cli",
        now: session.now,
      });
      const value = created.ok
        ? { ok: true, lines: [`proposed ${chg} — check it with \`crewhaus changes check ${chg}\``] }
        : { ok: false, lines: [`not proposed: ${created.reason}`] };
      return { settle: settleOf(created.ok), value };
    },
  );
  return receiptLines(answer);
}

function planLines(chg: string, plan: CheckPlan): string[] {
  const lines = [`checking ${chg} (${plan.kind}) will:`];
  if (plan.agentRuns > 0) {
    lines.push(
      `  run ${plan.agentRuns} eval(s) over ${plan.cases} case(s) — about ${plan.agentRuns * plan.cases} model conversation(s), plus judge calls`,
    );
  } else {
    lines.push(
      `  regrade recorded answers to ${plan.cases} case(s) — no agent calls; judges may be called`,
    );
  }
  lines.push(
    plan.holdoutUses > 0
      ? `  read the holdout (${plan.holdoutCases} case(s)) ${plan.holdoutUses} time(s); each read is counted`
      : "  read no held-out case",
  );
  lines.push(`  isolation: ${plan.isolation}`);
  if (plan.holdoutIsolation !== undefined) {
    lines.push(`  holdout isolation: ${plan.holdoutIsolation}`);
  }
  return lines;
}

async function checkVerb(session: Session, argv: readonly string[]): Promise<ChangesCommandResult> {
  const args = parseArgs("check", argv, CLI_FAMILY.sub.check.flags);
  const chg = changeId("check", args);
  const live = args.booleans.has("live");
  if (live) {
    const refused = agentToolRefusal(session, "confirms a live check");
    if (refused !== undefined) return refused;
  }
  const row = readChange(session.harnessDir, chg);
  if (row === undefined) return { lines: [`no change ${chg} here`], exitCode: 1 };
  if (live && !localMayDecide(session, "maintainer")) {
    return {
      lines: ["a live check needs a maintainer or the owner of this harness"],
      exitCode: EXIT_FOR_ERROR.forbidden,
    };
  }
  const gradersRel = (() => {
    try {
      const patch = JSON.parse(
        readChangeContent(session.harnessDir, chg, "patch.json") ?? "{}",
      ) as { graders?: string };
      return patch.graders ?? join("eval", "graders.yaml");
    } catch {
      return join("eval", "graders.yaml");
    }
  })();
  const gradersYaml = (() => {
    try {
      return readFileSync(join(session.harnessDir, gradersRel), "utf8");
    } catch {
      return "graders: []\n";
    }
  })();
  const writes = new Map<string, boolean>();
  for (const name of ["base.yaml", "proposed.yaml"] as const) {
    const text = readChangeContent(session.harnessDir, chg, name);
    if (text === undefined || row.kind !== "spec") continue;
    try {
      writes.set(text, await hasExternalWriteTools(text));
    } catch {
      writes.set(text, true);
    }
  }
  let specName: string | undefined;
  try {
    const base = readChangeContent(session.harnessDir, chg, "base.yaml");
    const specText =
      row.kind === "spec" && base !== undefined
        ? base
        : readFileSync(join(session.harnessDir, "crewhaus.yaml"), "utf8");
    specName = parseSpec(specText).name;
  } catch {
    specName = undefined;
  }
  const runners = qualityRunners({
    harnessDir: session.harnessDir,
    gradersYaml,
    externalWrites: writes,
    ...(specName !== undefined ? { specName } : {}),
  });
  const actor = await localStoredActor(session.harnessDir, session.control);
  const options = {
    harnessDir: session.harnessDir,
    chg,
    runners,
    actor,
    via: "cli",
    now: session.now,
    ...(live ? { live: { confirmedBy: actor } } : {}),
  };
  const plan = await planCheck(options);
  if (!("kind" in plan)) {
    return { lines: [plan.ok ? `${chg} cannot be checked` : plan.reason], exitCode: 1 };
  }
  if (plan.isolation === "needs-live") {
    return {
      lines: [
        plan.isolationReason ??
          "this harness has a tool that writes outside the process and no recorded tool results to replay",
        `  a maintainer can check it live: crewhaus changes check ${chg} --live --yes`,
      ],
      exitCode: 1,
    };
  }
  if (plan.holdoutIsolation === "needs-live") {
    return {
      lines: [
        ...planLines(chg, plan),
        "this harness has a tool that writes outside the process, and its recorded tool results hold nothing for the holdout's cases;",
        `  a maintainer can check it live: crewhaus changes check ${chg} --live --yes`,
      ],
      exitCode: 1,
    };
  }
  if (!args.booleans.has("yes")) {
    return {
      lines: [
        ...planLines(chg, plan),
        `run it with: crewhaus changes check ${chg}${live ? " --live" : ""} --yes`,
      ],
      exitCode: 0,
    };
  }
  await holdCliMutatingLease(session.harnessDir, "changes check", { env: session.env });
  await observe(session);
  const answer = await withQualityReceipt<{ ok: boolean; lines: string[] }>(
    {
      harnessDir: session.harnessDir,
      kind: "quality.changes.check",
      target: { kind: "change", id: chg },
      ...(live ? { body: { live: true } } : {}),
      control: session.control,
      env: session.env,
    },
    async (receipt) => {
      const checked = await checkChange({ ...options, cmd: receipt.id });
      if (!checked.ok) {
        return {
          settle: settleOf(false, checked.code),
          value: { ok: false, lines: [checked.reason] },
        };
      }
      const v = checked.verdict;
      const lines = [
        `check: ${v.comparison} · holdout ${v.holdout} · ${v.regressions} regression(s), ${v.recoveries} recovery(ies)`,
        `evidence: ${checked.evidenceRef}`,
      ];
      if (checked.decision !== undefined) {
        lines.push(
          `ready to decide: crewhaus approvals grant ${checked.decision}   (or: crewhaus approvals deny ${checked.decision})`,
        );
      }
      return { settle: settleOf(true), value: { ok: true, lines } };
    },
  );
  return receiptLines(answer);
}

async function adoptVerb(session: Session, argv: readonly string[]): Promise<ChangesCommandResult> {
  const args = parseArgs("adopt", argv, CLI_FAMILY.sub.adopt.flags);
  const chg = changeId("adopt", args);
  const expect = requireValue("adopt", args, "expect");
  const refused = agentToolRefusal(session, "adopts a change");
  if (refused !== undefined) return refused;
  const hoursFlag = args.values.get("watch-hours");
  const watchHours = hoursFlag === undefined ? undefined : Number(hoursFlag);
  if (
    watchHours !== undefined &&
    (!Number.isFinite(watchHours) || watchHours <= 0 || watchHours > 24 * 90)
  ) {
    throw new Error("changes adopt: --watch-hours is a number of hours above 0 and at most 2160");
  }
  await holdCliMutatingLease(session.harnessDir, "changes adopt", { env: session.env });
  await observe(session);
  const actor = await localStoredActor(session.harnessDir, session.control);
  const principal = session.control.decisions.principalOf({
    kind: "local",
    identity: currentLocalIdentity(),
  }).principal;
  const answer = await withQualityReceipt<{ ok: boolean; lines: string[] }>(
    {
      harnessDir: session.harnessDir,
      kind: "quality.changes.adopt",
      target: { kind: "change", id: chg },
      body: { expect, ...(args.booleans.has("without-holdout") ? { withoutHoldout: true } : {}) },
      control: session.control,
      env: session.env,
    },
    async (receipt) => {
      const adopted = await adoptChange({
        harnessDir: session.harnessDir,
        chg,
        expect,
        ...(args.booleans.has("without-holdout") ? { withoutHoldout: true } : {}),
        ...(watchHours !== undefined ? { watchHours } : {}),
        actor,
        writerActor: { kind: "person", ...(principal !== undefined ? { by: principal } : {}) },
        mayDecide: (requiredClass) => localMayDecide(session, requiredClass),
        instrumentNow: (inputs) => currentCheckInstrument(session.harnessDir, inputs),
        ...(session.register !== undefined ? { register: session.register } : {}),
        cmd: receipt.id,
        via: "cli",
        now: session.now,
      });
      return adopted.ok
        ? { settle: settleOf(true), value: { ok: true, lines: [...adopted.lines] } }
        : { settle: settleOf(false, adopted.code), value: { ok: false, lines: [adopted.reason] } };
    },
  );
  return receiptLines(answer);
}

function reasonOf(verb: string, given: string | undefined, fallback: ChangeReason): ChangeReason {
  if (given === undefined) return fallback;
  if (!(PERSON_CHANGE_REASONS as readonly string[]).includes(given)) {
    throw new Error(`changes ${verb}: --reason is one of ${PERSON_CHANGE_REASONS.join(", ")}`);
  }
  return given as ChangeReason;
}

async function endVerb(
  session: Session,
  verb: "decline" | "withdraw",
  argv: readonly string[],
): Promise<ChangesCommandResult> {
  const args = parseArgs(verb, argv, CLI_FAMILY.sub[verb].flags);
  const chg = verb === "decline" ? changeId("decline", args) : changeId("withdraw", args);
  const reason =
    verb === "decline"
      ? reasonOf(verb, requireValue("decline", args, "reason"), "other")
      : reasonOf(verb, args.values.get("reason"), "other");
  if (verb === "decline") {
    await holdCliMutatingLease(session.harnessDir, "changes decline", { env: session.env });
  } else {
    await holdCliMutatingLease(session.harnessDir, "changes withdraw", { env: session.env });
  }
  await observe(session);
  const actor = await localStoredActor(session.harnessDir, session.control);
  const answer = await withQualityReceipt<{ ok: boolean; lines: string[] }>(
    {
      harnessDir: session.harnessDir,
      kind: verb === "decline" ? "quality.changes.decline" : "quality.changes.withdraw",
      target: { kind: "change", id: chg },
      body: { reason },
      control: session.control,
      env: session.env,
    },
    async (receipt) => {
      const run = verb === "decline" ? declineChange : withdrawChange;
      const ended = await run({
        harnessDir: session.harnessDir,
        chg,
        reason,
        actor,
        cmd: receipt.id,
        via: "cli",
        now: session.now,
      });
      return ended.ok
        ? { settle: settleOf(true), value: { ok: true, lines: [`${chg} ${ended.row.state}`] } }
        : { settle: settleOf(false, ended.code), value: { ok: false, lines: [ended.reason] } };
    },
  );
  return receiptLines(answer);
}

async function rollbackVerb(
  session: Session,
  argv: readonly string[],
): Promise<ChangesCommandResult> {
  const args = parseArgs("rollback", argv, CLI_FAMILY.sub.rollback.flags);
  const chg = changeId("rollback", args);
  const expect = requireValue("rollback", args, "expect");
  const refused = agentToolRefusal(session, "rolls back a change");
  if (refused !== undefined) return refused;
  await holdCliMutatingLease(session.harnessDir, "changes rollback", { env: session.env });
  await observe(session);
  const actor = await localStoredActor(session.harnessDir, session.control);
  const principal = session.control.decisions.principalOf({
    kind: "local",
    identity: currentLocalIdentity(),
  }).principal;
  const answer = await withQualityReceipt<{ ok: boolean; lines: string[] }>(
    {
      harnessDir: session.harnessDir,
      kind: "quality.changes.rollback",
      target: { kind: "change", id: chg },
      body: { expect },
      control: session.control,
      env: session.env,
    },
    async (receipt) => {
      const rolled = await rollbackChange({
        harnessDir: session.harnessDir,
        chg,
        expect,
        actor,
        writerActor: { kind: "person", ...(principal !== undefined ? { by: principal } : {}) },
        ...(session.register !== undefined ? { register: session.register } : {}),
        cmd: receipt.id,
        via: "cli",
        now: session.now,
      });
      if (rolled.ok)
        return { settle: settleOf(true), value: { ok: true, lines: [...rolled.lines] } };
      const lines = [rolled.reason, ...(rolled.diff ?? []).map((d) => `  ${d.kind} ${d.path}`)];
      return { settle: settleOf(false, rolled.code), value: { ok: false, lines } };
    },
  );
  return receiptLines(answer);
}

/** Run `crewhaus changes <verb> …`. */
export async function runChangesCommand(
  argv: readonly string[],
  options: ChangesCommandOptions = {},
): Promise<ChangesCommandResult> {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    return done(USAGE);
  }
  if (rest.includes("--help") || rest.includes("-h")) return done(USAGE);
  const session = sessionOf(options);
  switch (verb) {
    case "list":
      return listVerb(session, rest);
    case "show":
      return showVerb(session, rest);
    case "propose":
      return proposeVerb(session, rest);
    case "check":
      return checkVerb(session, rest);
    case "adopt":
      return adoptVerb(session, rest);
    case "decline":
      return endVerb(session, "decline", rest);
    case "withdraw":
      return endVerb(session, "withdraw", rest);
    case "rollback":
      return rollbackVerb(session, rest);
    default:
      throw new Error(
        `changes: unknown verb "${verb}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
      );
  }
}
