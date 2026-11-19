/**
 * `crewhaus runs inspect <run|sess_…>`: explain a run from its records, in the terminal.
 *
 * It prints the summary and the key events; `--timeline key|full`, `--why <action>` and
 * `--context <call>|all` print one view instead, and `--json` prints the view object. It
 * reads the harness's run ledger, the session log and the decision log through
 * `@crewhaus/run-inspect`, and writes nothing: no identity, no lease, no lock.
 *
 * Everything printed is masked first, as `crewhaus daemon logs` masks: the harness's own
 * env values are scrubbed, credential-shaped tokens are masked, and a value under a
 * credential's key name is replaced. Only then is long content cut short, so a cut never
 * leaves part of a secret unmasked. Text output then has its terminal control
 * characters removed, and `--json` escapes the ones JSON leaves raw, so a tool's output
 * cannot drive the terminal it is read in.
 */
import { EXIT_FOR_ERROR } from "@crewhaus/control-contract";
import { harnessScrubber, readHarnessEnvFiles, scrubDeep } from "@crewhaus/harness-supervisor";
import {
  type CheckView,
  type ContextList,
  type ContextUsed,
  GAP_WORDS,
  HIDDEN_FOR_SAFETY,
  type InspectGap,
  type InspectRefusal,
  type InspectSummary,
  ONLY_INSTRUCTIONS,
  type Provenance,
  TIMELINE_MAX_LIMIT,
  type TimelinePage,
  WHY_ACTION_RE,
  type WhyRecord,
  foldContext,
  foldSummary,
  foldTimeline,
  foldWhy,
  loadRun,
  terminalSafe,
} from "@crewhaus/run-inspect";
import { REDACTED_VALUE, isCredentialKey, maskCredentialTokens } from "@crewhaus/spec-patch";
import { resolveHarness } from "./daemon-cmd";
import type { RunsDeps, RunsOutput } from "./runs-cmd";

/** `runs inspect`'s parsed arguments, as `runs-cmd.ts` hands them over. */
export type InspectArgs = {
  readonly positional: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly json: boolean;
};

const invalid = (message: string, verb = "crewhaus runs inspect --help"): RunsOutput => ({
  lines: [`runs inspect: ${message}`, `  try: ${verb}`],
  exitCode: EXIT_FOR_ERROR.invalid,
});

function refused(answer: InspectRefusal): RunsOutput {
  return {
    lines: [
      terminalSafe(`runs inspect: ${answer.message}`),
      ...(answer.verb !== undefined ? [terminalSafe(`  try: ${answer.verb}`)] : []),
    ],
    exitCode: EXIT_FOR_ERROR[answer.code],
  };
}

/**
 * A view as it may leave this process: the harness's env values scrubbed, token shapes
 * masked in every string, and every value under a credential's key name replaced.
 */
export function maskedView(view: unknown, harnessDir: string): unknown {
  const scrubbed = scrubDeep(view, harnessScrubber(harnessDir));
  const walk = (value: unknown, underKey: boolean): unknown => {
    if (typeof value === "string") return underKey ? REDACTED_VALUE : maskCredentialTokens(value);
    if (Array.isArray(value)) return value.map((item) => walk(item, underKey));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          walk(item, underKey || isCredentialKey(key)),
        ]),
      );
    }
    return underKey && value !== null && value !== undefined ? REDACTED_VALUE : value;
  };
  return walk(scrubbed, false);
}

/** The longest piece of content a view prints, in characters. */
export const SHOWN_MAX = 4000;

/**
 * A view as it is printed: masked whole first, then every string cut to `SHOWN_MAX`.
 * The folds return content whole so the cut never comes before the mask: a secret
 * that crossed the cut would leave a fragment no masker matches.
 */
export function shownView(view: unknown, harnessDir: string): unknown {
  const cut = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.length > SHOWN_MAX ? `${value.slice(0, SHOWN_MAX)}…` : value;
    }
    if (Array.isArray(value)) return value.map(cut);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cut(item)]));
    }
    return value;
  };
  return cut(maskedView(view, harnessDir));
}

/** JSON text with DEL and the C1 controls escaped too: `JSON.stringify` leaves them raw. */
export function jsonSafe(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

const BADGES: Readonly<Record<string, string>> = {
  reconstructed: "Pieced together",
  "not-recorded": "Not recorded",
  generated: "Generated",
};

/** " (Pieced together)" or " (Not recorded)" after a field that is not plainly recorded. */
function badge(field: Provenance<unknown> | undefined): string {
  const word = field !== undefined ? BADGES[field.state] : undefined;
  return word !== undefined ? ` (${word})` : "";
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function gapLines(gaps: readonly InspectGap[]): string[] {
  if (gaps.length === 0) return [];
  const seen = new Map<string, { gap: InspectGap; count: number }>();
  for (const gap of gaps) {
    const known = seen.get(gap.reason);
    if (known !== undefined) known.count += gap.count ?? 1;
    else seen.set(gap.reason, { gap, count: gap.count ?? 1 });
  }
  return [
    "Missing",
    ...[...seen.values()].map(
      ({ gap, count }) =>
        `  - ${GAP_WORDS[gap.reason]}${count > 1 ? ` (${count})` : ""}${gap.remedy !== undefined ? ` See: ${gap.remedy}` : ""}`,
    ),
  ];
}

function durationWords(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function summaryLines(summary: InspectSummary, harnessFlag: string | undefined): string[] {
  const status = summary.status.value;
  const subject =
    summary.subject.kind === "run"
      ? `Run ${summary.subject.run} · session ${summary.subject.session}`
      : `Session ${summary.subject.session} (its runs can't be told apart)`;
  const facts = [
    summary.startedAt !== undefined ? `started ${summary.startedAt}` : undefined,
    summary.durationMs.value !== undefined
      ? `took ${durationWords(summary.durationMs.value)}`
      : undefined,
    `${summary.cost.value?.words ?? "Cost not recorded"}${badge(summary.cost)}`,
  ].filter((part): part is string => part !== undefined);
  const revisions = summary.revisions.value;
  const lines = [
    `${summary.title}  —  ${status?.word ?? "Status unknown"}${badge(summary.status)}${status?.failureClass !== undefined ? ` (${status.failureClass})` : ""}`,
    subject,
    facts.join(" · "),
  ];
  if (summary.wake !== undefined) {
    lines.push(`Operator wake    ${summary.wake.value?.words ?? ""}${badge(summary.wake)}`);
  }
  if (revisions !== undefined) {
    lines.push(
      `Built from       spec revision ${revisions.spec}${revisions.runtime !== undefined ? ` · runtime ${revisions.runtime}` : ""}${revisions.deployment !== undefined ? ` · deployment ${revisions.deployment}` : ""}${badge(summary.revisions)}`,
    );
  }
  lines.push(
    `What was asked   ${summary.asked.value !== undefined ? `"${oneLine(summary.asked.value)}"` : "—"}${badge(summary.asked)}`,
    `What happened    ${summary.happened.value ?? "—"}${badge(summary.happened)}`,
    `Outcome          ${summary.outcome.value !== undefined ? oneLine(summary.outcome.value) : "—"}${badge(summary.outcome)}`,
  );
  if (summary.parent !== undefined) lines.push(`Started by run   ${summary.parent}`);
  if (summary.continues !== undefined) lines.push(`Continues run    ${summary.continues}`);
  for (const child of summary.children) {
    lines.push(
      `Child run        ${child.run}${child.name !== undefined ? ` (helper ${child.name})` : ""}`,
    );
  }
  const execution = summary.execution.value?.id;
  if (execution !== undefined) {
    lines.push(
      `Trace events     crewhaus daemon logs${harnessFlag !== undefined ? ` ${harnessFlag}` : ""} --run ${execution}`,
    );
  }
  if ((summary.runs?.length ?? 0) > 1) {
    lines.push("Runs in this session");
    for (const run of summary.runs ?? []) {
      lines.push(
        `  ${run.chosen ? "*" : " "} ${run.run}${run.trigger !== undefined ? `  ${run.trigger}` : ""}${run.parent !== undefined ? `  (child of ${run.parent})` : ""}`,
      );
    }
  }
  return [...lines, ...gapLines(summary.gaps)];
}

function timelineLines(page: TimelinePage, ref: string): string[] {
  const heading =
    page.view === "key" ? "Key events, newest first" : "Everything recorded, newest first";
  if (page.entries.length === 0) {
    return [
      heading,
      page.empty === "filtered"
        ? `  No key events. Show everything recorded: crewhaus runs inspect ${ref} --timeline full`
        : "  Nothing was recorded for this run.",
    ];
  }
  const lines = [heading];
  for (const entry of page.entries) {
    const action =
      entry.span !== undefined && (entry.kind === "tool" || entry.kind === "answer")
        ? `  why: ${entry.kind}:${entry.span}`
        : "";
    lines.push(`  ${entry.at}  ${entry.title}${action}`);
    if (entry.detail !== undefined && entry.detail !== "")
      lines.push(`      ${oneLine(entry.detail)}`);
  }
  if (page.next !== undefined) {
    lines.push(
      `  Earlier events: crewhaus runs inspect ${ref} --timeline ${page.view} --before ${page.next}`,
    );
  }
  if (page.truncated)
    lines.push("  Only part of this run's record was read: a size limit was reached.");
  return lines;
}

function checkLine(check: CheckView): string {
  const later = check.later
    .map(
      (l) =>
        `, then ${l.outcome}${l.by !== undefined ? ` by ${l.by}` : ""}${l.surface !== undefined ? ` in ${l.surface}` : ""}`,
    )
    .join("");
  const rules = check.rules !== undefined ? ` (rules: ${check.rules.join(", ")})` : "";
  const score =
    check.score !== undefined
      ? ` (scored ${check.score.value}${check.score.threshold !== undefined ? `, bar ${check.score.threshold}` : ""})`
      : "";
  return `  - ${check.gate}: ${check.outcome}${later}${rules}${score}${check.reason !== undefined ? ` — ${oneLine(check.reason)}` : ""}`;
}

function whyLines(why: WhyRecord): string[] {
  const started = why.started.value;
  const used = why.used.value;
  const rules = why.rules.value;
  const did = why.did.value;
  const result = why.result.value;
  const models = why.options.value?.models ?? [];
  const lines = [`Why did this happen? (${why.action})`];
  lines.push(
    `What started it   ${started?.trigger.words ?? "not recorded"}${started?.wake !== undefined ? `; ${started.wake.words}` : ""}${started?.asked !== undefined ? `; asked "${oneLine(started.asked)}"` : ""}${badge(why.started)}`,
  );
  lines.push(
    used !== undefined
      ? `What it used      model call ${used.call}: ${used.blocks.join(", ")}${used.files > 0 ? `; ${used.files} project files` : ""}${used.recalled > 0 ? `; ${used.recalled} memories` : ""}${used.hidden > 0 ? `; ${used.hidden} ${HIDDEN_FOR_SAFETY.toLowerCase()}` : ""} (see --context ${used.call})${badge(why.used)}`
      : `What it used      not recorded${why.used.gap !== undefined ? `: ${GAP_WORDS[why.used.gap.reason]}` : ""}`,
  );
  lines.push(
    rules !== undefined
      ? `Rules in force    spec revision ${rules.spec}${rules.settings !== undefined ? ` · settings ${rules.settings.fingerprint.slice(0, 12)} (${rules.settings.rules} rules)` : ""}${rules.mode !== undefined ? ` · permission mode ${rules.mode}` : ""}${badge(why.rules)}`
      : "Rules in force    not recorded",
  );
  if (did !== undefined) {
    lines.push(
      `What it did       ${did.what}${did.input !== undefined ? ` with ${oneLine(typeof did.input === "string" ? did.input : (JSON.stringify(did.input) ?? ""), 300)}` : ""}${badge(why.did)}`,
    );
    if (did.reasonGiven !== undefined)
      lines.push(`  Reason it gave: "${oneLine(did.reasonGiven, 400)}"`);
    lines.push(`  ${did.note}`);
  }
  lines.push(
    models.length > 0
      ? `Other options     model choice: ${models.map((m) => `${m.policy ?? m.tier ?? "a rule"} picked ${m.model ?? "a model"}${m.reason !== undefined ? ` (${oneLine(m.reason, 120)})` : ""}`).join("; ")}`
      : "Other options     model choice: not recorded",
    "                  tool choice: not recorded (providers don't report alternatives)",
  );
  const checks = why.checks.value ?? [];
  lines.push(`Checks${badge(why.checks)}`);
  if (checks.length === 0) lines.push("  (none recorded)");
  for (const check of checks) lines.push(checkLine(check));
  lines.push(
    `Result            ${result?.text !== undefined ? oneLine(result.text, 400) : "—"}${result?.isError === true ? " (failed)" : ""}${badge(why.result)}`,
  );
  for (const correction of result?.corrections ?? []) {
    lines.push(
      `  Corrected later (${correction.at}): ${[
        correction.rating,
        correction.comment,
        correction.correction,
      ]
        .filter((p) => p !== undefined)
        .map((p) => oneLine(p as string, 200))
        .join(" · ")}`,
    );
  }
  return [...lines, ...gapLines(why.gaps)];
}

function contextLines(context: ContextUsed): string[] {
  const params = Object.entries(context.model.params)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const lines = [
    `Context for model call ${context.call}${context.turn !== undefined ? ` (turn ${context.turn.session})` : ""}`,
    `  Model          ${context.model.wire} (${context.model.provider})${params !== "" ? ` · ${params}` : ""}`,
  ];
  if (context.onlyInstructions) lines.push(`  ${ONLY_INSTRUCTIONS}`);
  lines.push("  Included");
  for (const block of context.blocks) {
    lines.push(`    ${block.kind} (${block.bytes} bytes${block.cached ? ", cached" : ""})`);
  }
  for (const file of context.files)
    lines.push(`    project file ${file.path} (${file.bytes} bytes)`);
  const recalled = context.recalled.value;
  if (recalled !== undefined && recalled !== null) {
    lines.push(
      `  Recalled       ${recalled.requested} requested, ${recalled.returned} returned${badge(context.recalled)}`,
    );
    for (const item of recalled.items) {
      const ref =
        item.ref !== null
          ? `${item.ref.store}/${item.ref.backend}/${item.ref.localId}${item.ref.version !== undefined ? ` v${item.ref.version}` : ""}`
          : "(no ref)";
      lines.push(
        `    ${ref}  ${item.label ?? item.status}${item.rules !== undefined ? ` (rules: ${item.rules.join(", ")})` : ""}`,
      );
    }
  } else if (context.recalled.state === "not-recorded") {
    lines.push("  Recalled       not recorded");
  }
  const tools = context.tools.value;
  if (tools !== undefined) {
    lines.push(
      `  Tools          ${tools.advertised} offered of ${tools.inSpec} in the spec${tools.names !== undefined ? `: ${tools.names.join(", ")}` : ""}${badge(context.tools)}`,
    );
  }
  lines.push(
    `  Messages       ${context.messages.count}${context.messages.afterCompaction ? " (after compaction)" : ""}`,
    "  Now            not recorded: whether these have changed since isn't known here",
  );
  return lines;
}

/** `crewhaus runs inspect`. */
export async function runRunsInspect(args: InspectArgs, deps: RunsDeps): Promise<RunsOutput> {
  const ref = args.positional[0];
  if (ref === undefined) {
    return invalid("name a run (run_…) or a session (sess_…)", "crewhaus runs list");
  }
  if (args.positional.length > 1) {
    return invalid(`one run or session at a time; got ${args.positional.length}`);
  }
  const { timeline, why, context, limit: limitRaw, before } = args.values;
  const chosen = [timeline, why, context].filter((v) => v !== undefined).length;
  if (chosen > 1) return invalid("pass at most one of --timeline, --why and --context");
  if (timeline !== undefined && timeline !== "key" && timeline !== "full") {
    return invalid("--timeline is key or full");
  }
  if (why !== undefined && !WHY_ACTION_RE.test(why)) {
    return invalid(
      "--why names a step: tool:, answer:, model: or turn: and its 16-hex span id",
      `crewhaus runs inspect ${terminalSafe(ref).slice(0, 80)} --timeline full`,
    );
  }
  let call: number | "all" | undefined;
  if (context !== undefined) {
    if (context === "all") call = "all";
    else if (/^[1-9][0-9]{0,6}$/.test(context)) call = Number(context);
    else return invalid("--context is a model call's number (1, 2, …) or all");
  }
  if (
    (why !== undefined || context !== undefined) &&
    (limitRaw !== undefined || before !== undefined)
  ) {
    return invalid("--limit and --before page the timeline");
  }
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > TIMELINE_MAX_LIMIT) {
      return invalid(`--limit is a whole number from 1 to ${TIMELINE_MAX_LIMIT}`);
    }
  }

  const opts = {
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
  };
  const harnessFlag = args.values["harness"];
  const harness = resolveHarness(harnessFlag, opts);
  const loaded = loadRun({
    harnessDir: harness.dir,
    ref,
    ...(args.values["run"] !== undefined ? { run: args.values["run"] } : {}),
    envVars: readHarnessEnvFiles(harness.dir).vars,
    now: deps.now?.() ?? Date.now(),
  });
  if (!loaded.ok) return refused(loaded);

  const pageOptions = {
    ...(limit !== undefined ? { limit } : {}),
    ...(before !== undefined ? { before } : {}),
  };
  let view: unknown;
  let render: (masked: unknown) => string[];
  if (why !== undefined) {
    const answer = foldWhy(loaded, why);
    if ("ok" in answer) return refused(answer);
    view = answer;
    render = (masked) => whyLines(masked as WhyRecord);
  } else if (call !== undefined) {
    const answer = foldContext(loaded, call);
    if ("ok" in answer) return refused(answer);
    view = answer;
    render = (masked) =>
      "calls" in (masked as object)
        ? (masked as ContextList).calls.flatMap((c, i) => [
            ...(i > 0 ? [""] : []),
            ...contextLines(c),
          ])
        : contextLines(masked as ContextUsed);
  } else if (timeline !== undefined) {
    const answer = foldTimeline(loaded, { view: timeline, ...pageOptions });
    if ("ok" in answer) return refused(answer);
    view = answer;
    render = (masked) => timelineLines(masked as TimelinePage, ref);
  } else {
    const page = foldTimeline(loaded, { view: "key", ...pageOptions });
    if ("ok" in page) return refused(page);
    view = { summary: foldSummary(loaded), timeline: page };
    render = (masked) => {
      const both = masked as { summary: InspectSummary; timeline: TimelinePage };
      return [...summaryLines(both.summary, harnessFlag), "", ...timelineLines(both.timeline, ref)];
    };
  }
  const masked = shownView(view, harness.dir);
  if (args.json) return { lines: [jsonSafe(masked)], exitCode: 0 };
  return { lines: render(masked).map(terminalSafe), exitCode: 0 };
}
