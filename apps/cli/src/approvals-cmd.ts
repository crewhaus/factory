/**
 * `crewhaus approvals` — the CLI face of the decision service.
 *
 * `list` and `show` read the approvals store under the harness's session root
 * (`foldReadOnly`, never a rewrite). `rules` lists the harness's standing rules, the
 * requests waiting for its owner and the whole-tool allows no record names. Every
 * change — `grant`, `deny`, `supersede`, `defer`, `revoke`, and the standing rule a grant
 * with `--always` makes — goes through control-service's `decisions` and `rules`, the
 * same code Home's routes use, wrapped in a command whose receipt is written first, in
 * the harness's own command ledger.
 * Receipts and control state are kept only in a known harness ({@link isKnownHarness}):
 * in any other directory a change answers without writing anything there.
 *
 * A decision counts by who makes it: the local user, as the member Home's access
 * records link them to. `--by` is a label shown with the decision and grants no
 * authority. A command started by an agent's tool (`CREWHAUS_AGENT_TOOL` set) decides
 * nothing: a person decides approvals.
 *
 * The module has no side effect on import, and its I/O comes through `ApprovalsDeps`,
 * so a test drives it in-process.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { LocalIdentity } from "@crewhaus/access-control";
import {
  APPROVAL_ID_RE,
  type CommandReceipt,
  EXIT_FOR_ERROR,
  EXIT_FOR_REJECTED_RECEIPT,
  isId,
} from "@crewhaus/control-contract";
import { readApproverProjection, readHarnessIdentity } from "@crewhaus/control-records";
import {
  type ControlService,
  DEFAULT_RULE_DAYS,
  type DecisionActor,
  MAX_RULE_DAYS,
  type ResolveAnswer,
  type RuleWriteAnswer,
  type Settlement,
  callValues,
  currentLocalIdentity,
  governedAncestorOf,
  harnessForSessionRoot,
  outcomeOf,
} from "@crewhaus/control-service";
import type { ParsedArgs } from "@crewhaus/infra-utils";
import {
  DISPLAY_CONTROL_RE,
  emptyRuleSet,
  evaluate,
  holdsDisplayControl,
} from "@crewhaus/permission-engine";
import {
  DEFAULT_TTL_DAYS,
  type PendingApproval,
  foldReadOnly,
  parseDeferUntil,
} from "@crewhaus/session-store";
import { REDACTED_VALUE, isCredentialKey, maskCredentialTokens } from "@crewhaus/spec-patch";
import {
  DEFER_REASON_CODES,
  SUPERSEDE_REASON_CODES,
  alreadyDecidedMessage,
  formatApprovalDetail,
  formatApprovalsTable,
  invalidReasonMessage,
  listedApprovals,
  withdrawnMessage,
} from "./approvals-cli";
import { directControl, harnessIdOf, liveHarnessDirs } from "./daemon-cmd";

/** Where the store lives under a harness. */
const SESSIONS_SUBDIR = join(".crewhaus", "sessions");

/** The variable a tool's child carries; under it, nothing is decided. */
export const AGENT_TOOL_ENV = "CREWHAUS_AGENT_TOOL";

/** What a command started by an agent's tool is told. */
export const AGENT_TOOL_REFUSAL =
  "This command was started by an agent's tool; a person decides approvals.";

/** The line printed when a session root found through the environment names no harness. */
export const NO_HARNESS_LINE =
  "Could not tell which harness these approvals belong to; pass --dir <harness> so its approver list applies.";

/** The sub-verbs that change something, and so refuse under an agent's tool. */
const CHANGES: ReadonlySet<string> = new Set(["grant", "deny", "supersede", "defer", "revoke"]);

/** Every control or bidirectional-text character {@link DISPLAY_CONTROL_RE} names. */
const DISPLAY_CONTROLS = new RegExp(DISPLAY_CONTROL_RE.source, "gu");

/** `text` with each control or bidirectional-text character written as `\uXXXX`. */
function escapeControls(text: string): string {
  return text.replace(
    DISPLAY_CONTROLS,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * A rule's pattern, or another value a rule's line prints (its end), as a line prints
 * it: as it is, or, when it holds a control or bidirectional-text character, as a JSON
 * string with every such character escaped, so a terminal shows what the value holds
 * rather than acting on it.
 */
export function displayPattern(text: string): string {
  return holdsDisplayControl(text) ? escapeControls(JSON.stringify(text)) : text;
}

/**
 * Whether `dir` is a harness this CLI may keep receipts and control state in: a live
 * registry row names it (by its real path), it has its own `harness.json`, or it holds
 * a `.crewhaus/` directory (a link an operator made counts). A `crewhaus.yaml` alone
 * does not: with no `.crewhaus/` there is no approval, rule or settings file to act on.
 * Other heads that write a harness's control state may ask the same.
 */
export function isKnownHarness(dir: string, deps: Pick<ApprovalsDeps, "registryDirs">): boolean {
  const realOrResolved = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const real = realOrResolved(dir);
  let rows: readonly string[] = [];
  try {
    rows = deps.registryDirs();
  } catch {
    // A registry that cannot be read names no harness.
  }
  if (rows.some((row) => realOrResolved(row) === real)) return true;
  if (readHarnessIdentity(dir).state !== "absent") return true;
  try {
    return statSync(join(dir, ".crewhaus")).isDirectory();
  } catch {
    return false;
  }
}

export type ApprovalsDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** The local user deciding. */
  readonly identity: LocalIdentity;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** The session root a tenant scope or `CREWHAUS_SESSION_DIR` names, as a run resolves it. */
  readonly scopedSessionRoot: () => string | undefined;
  /** Whether a person is at a terminal (stdin and stdout). */
  readonly isTTY: () => boolean;
  /** Ask a person a question at the terminal; the line they typed. */
  readonly ask: (question: string) => Promise<string>;
  /** The control service this head acts through. */
  readonly control: ControlService;
  /** The live registered harness directories. */
  readonly registryDirs: () => readonly string[];
  /** A harness directory's id, for a receipt's target. */
  readonly harnessIdOf: (dir: string) => string | undefined;
  readonly now?: () => number;
};

const HELP: readonly string[] = [
  "usage: crewhaus approvals list|show|grant|deny|supersede|defer <id> [--dir <root>] [--by <label>] [--json]",
  "       crewhaus approvals rules [--dir <root>] [--json]",
  "       crewhaus approvals revoke <rule_id> | --legacy <pattern> [--dir <root>]",
  "  list                 all parked approvals under .crewhaus/sessions/, newest first",
  "  show <id>            full detail for one approval (incl. the verbatim tool input)",
  "  grant <id> [--once]  record a GRANT — the next run re-issuing the same tool call",
  "                       proceeds pre-approved. --once (default) is one-shot: the",
  "                       runtime consumes the grant on use, so a later identical call",
  "                       re-asks.",
  "  grant <id> --always [--days <n>]",
  "                       grant this call AND make a standing rule for it: an allow that",
  "                       names exactly what this call acted on (its path, URL, command",
  "                       or address), for 30 days unless --days says otherwise (1-365).",
  "                       Only the harness's owner makes one; a member's --always grants",
  "                       this call once and asks the owner, who answers with",
  "                       `crewhaus approvals grant|deny <dec_id>`.",
  "       [--pattern <glob>]",
  "                       the owner, at a terminal, may name a wider glob for the same",
  "                       tool; it shows the approvals it would cover and asks you to",
  "                       type the tool's name.",
  "  grant|deny <dec_id>  answer a member's request for a standing rule (the owner).",
  "  deny <id>            record a DENY — the parked call is refused with a note on resume.",
  "  The first decision on a request wins: a second grant or deny is refused.",
  "  --by <label>         a label shown with the decision; it grants no authority",
  "                       (default: CREWHAUS_USER, else cli). A decision counts as the",
  "                       member Home's access records link your OS user to.",
  "  supersede <id> --reason <code>",
  "                       replace a decision before it is used: a fresh request is",
  "                       parked in its place, to grant or deny.",
  `                       --reason is one of: ${SUPERSEDE_REASON_CODES.join(", ")}`,
  "  defer <id> --until <time> --reason <code>",
  "                       mark a waiting request as deferred until a time with Z or",
  "                       an offset (for example 2026-12-01T09:00:00Z).",
  `                       --reason is one of: ${DEFER_REASON_CODES.join(", ")}`,
  "  rules                the harness's standing rules, the requests waiting for its",
  "                       owner, and whole-tool allows no record keeps, each with its verb.",
  "  revoke <rule_id>     end a standing rule now (the owner). --legacy <pattern> removes",
  "                       a whole-tool allow from .crewhaus/settings.json instead.",
  "  These resolve the parks a headless run creates when a tool permission asks and",
  "  `permissions.ask_mode: pause` (the default) is set.",
];

function str(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

/** How a decision ends, as its receipt records it. */
function settlementOf(answer: { readonly outcome: string }): Settlement {
  switch (answer.outcome) {
    case "decided":
    case "superseded":
    case "deferred":
    case "revoked":
    case "removed":
      return { state: "succeeded" };
    case "forbidden":
      return { state: "rejected", outcome: outcomeOf("forbidden") };
    case "invalid":
      return { state: "rejected", outcome: outcomeOf("invalid") };
    case "not-found":
      return { state: "rejected", outcome: outcomeOf("not_found") };
    case "already-decided":
    case "ended":
    case "recorded":
      return { state: "rejected", outcome: outcomeOf("already_decided") };
    case "stale":
      return { state: "rejected", outcome: outcomeOf("conflict") };
    case "expired":
      return { state: "rejected", outcome: outcomeOf("precondition_failed") };
    default:
      return { state: "failed", outcome: outcomeOf("unavailable") };
  }
}

/** The exit for a refused decision: forbidden is the control band's, any other refusal a rejected receipt's. */
function exitFor(outcome: string): number {
  return outcome === "forbidden" ? EXIT_FOR_ERROR.forbidden : EXIT_FOR_REJECTED_RECEIPT;
}

type Located =
  | { readonly ok: true; readonly rootDir: string; readonly harnessDir: string | undefined }
  | { readonly ok: false; readonly code: number; readonly message: string };

/**
 * The store the run path writes to, and the harness whose approver list decides. An
 * explicit `--dir` wins. With no scoped root, the working directory decides when it is a
 * known harness ({@link isKnownHarness}); otherwise no harness does, and nothing is kept
 * beside the decision. A root a tenant scope or `CREWHAUS_SESSION_DIR` names is matched
 * to the harness it belongs to; one that names several is said so. One that names none
 * is refused when it lies inside a harness that has an approver list (`--dir` names the
 * harness that decides it), and is otherwise decided by the working directory only when
 * that is a known harness with `.crewhaus/`.
 */
function locate(args: ParsedArgs, deps: ApprovalsDeps, always: boolean): Located {
  const dir = str(args, "dir");
  if (dir !== undefined) {
    const harnessDir = resolve(deps.cwd, dir);
    return { ok: true, rootDir: join(harnessDir, SESSIONS_SUBDIR), harnessDir };
  }
  const scoped = deps.scopedSessionRoot();
  if (scoped === undefined) {
    return {
      ok: true,
      rootDir: join(deps.cwd, SESSIONS_SUBDIR),
      harnessDir: isKnownHarness(deps.cwd, deps) ? deps.cwd : undefined,
    };
  }
  // The working directory is a candidate only when it is a known harness with `.crewhaus/`:
  // a directory that only names the root in an environment file decides nothing.
  const cwdHolds = isKnownHarness(deps.cwd, deps) && existsSync(join(deps.cwd, ".crewhaus"));
  const found = harnessForSessionRoot(scoped, {
    registry: deps.registryDirs,
    ...(cwdHolds ? { cwd: deps.cwd } : {}),
  });
  if (found.state === "one") return { ok: true, rootDir: scoped, harnessDir: found.dir };
  if (found.state === "several") {
    const governed = found.dirs.some((d) => readApproverProjection(d).state !== "absent");
    if (governed || always) {
      return {
        ok: false,
        code: EXIT_FOR_ERROR.invalid,
        message: `the approvals under ${scoped} belong to more than one harness (${found.dirs.join(", ")}); pass --dir <harness> to say which`,
      };
    }
    deps.stderr(`${NO_HARNESS_LINE}\n`);
    return { ok: true, rootDir: scoped, harnessDir: undefined };
  }
  if (always) {
    return {
      ok: false,
      code: EXIT_FOR_ERROR.invalid,
      message: `--always writes .crewhaus/settings.json under the HARNESS root, but the approvals store was located via CREWHAUS_SESSION_DIR/tenant scope (${scoped}), and no harness it belongs to was found. Re-run with --dir <harness root>.`,
    };
  }
  const governed = governedAncestorOf(scoped);
  if (governed !== undefined) {
    return {
      ok: false,
      code: EXIT_FOR_ERROR.invalid,
      message: `the approvals under ${scoped} lie inside ${governed}, a harness with a list of who may approve, and no harness names them as its own; pass --dir <harness> to say which harness decides them`,
    };
  }
  deps.stderr(`${NO_HARNESS_LINE}\n`);
  return { ok: true, rootDir: scoped, harnessDir: cwdHolds ? deps.cwd : undefined };
}

/** Run `change` as a receipted command, after this process's one recovery of the harness. */
const recovered = new Set<string>();

async function receipted<T extends { readonly outcome: string }>(
  deps: ApprovalsDeps,
  harnessDir: string | undefined,
  kind: "decisions.resolve" | "decisions.supersede" | "decisions.defer" | "rules.revoke",
  target: string | undefined,
  change: (receipt: CommandReceipt | undefined) => Promise<T>,
): Promise<
  | { readonly value: T; readonly receipt?: CommandReceipt }
  | { readonly refused: string; readonly code: number }
> {
  // With no harness there is no ledger to write a receipt in: the change stands alone.
  if (harnessDir === undefined) return { value: await change(undefined) };
  if (!recovered.has(harnessDir)) {
    recovered.add(harnessDir);
    try {
      await deps.control.commands.recover({ harness: harnessDir });
    } catch {
      // Recovery is the writer's courtesy to the last crash, never a gate on this verb.
    }
  }
  const answer = await deps.control.commands.submit<T>(
    {
      kind,
      ...(target !== undefined ? { target } : {}),
      ledger: { harness: harnessDir },
      via: "cli",
    },
    async (receipt) => {
      const value = await change(receipt);
      return { settle: settlementOf(value), value };
    },
  );
  if (!answer.ok) {
    return { refused: answer.refusal.message, code: EXIT_FOR_ERROR[answer.refusal.code] };
  }
  if (answer.replayed || answer.value === undefined) {
    return { refused: "the command was already recorded", code: EXIT_FOR_REJECTED_RECEIPT };
  }
  return { value: answer.value, receipt: answer.receipt };
}

/** The rule step as a command of its own, so the rule's row carries its receipt. */
function ruleCommand(deps: ApprovalsDeps, harnessDir: string) {
  return async (run: (cmd: string | undefined) => Promise<RuleWriteAnswer>) => {
    const answer = await deps.control.commands.submit<RuleWriteAnswer>(
      { kind: "rules.create", ledger: { harness: harnessDir }, via: "cli" },
      async (receipt) => {
        const made = await run(receipt.id);
        return {
          settle: made.ok
            ? { state: "succeeded" }
            : { state: "failed", outcome: outcomeOf("internal") },
          value: made,
        };
      },
    );
    if (!answer.ok) return { ok: false as const, reason: answer.refusal.message };
    return answer.replayed || answer.value === undefined
      ? { ok: false as const, reason: "the rule's command was already recorded" }
      : answer.value;
  };
}

/** A tool input as the preview shows it: a value under a credential's key, and a token in text, hidden. */
function masked(value: unknown, underKey = false): unknown {
  if (typeof value === "string") return underKey ? REDACTED_VALUE : maskCredentialTokens(value);
  if (Array.isArray(value)) return value.map((item) => masked(item, underKey));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        masked(item, underKey || isCredentialKey(key)),
      ]),
    );
  }
  return underKey && value !== null && value !== undefined ? REDACTED_VALUE : value;
}

/** Approvals in the store a wider glob would also cover: the count, and the first five, masked. */
function widenPreview(
  rootDir: string,
  harnessDir: string,
  tool: string,
  pattern: string,
): { readonly count: number; readonly first: readonly string[] } {
  const folded = foldReadOnly(rootDir);
  const covered = folded.records.filter((record) => {
    if (record.toolName !== tool) return false;
    const values = callValues(tool, record.input, harnessDir);
    return (
      evaluate(
        {
          toolName: tool,
          input: record.input,
          ...(values !== undefined && values !== "no-scoping-argument"
            ? { operativeValues: values }
            : {}),
          readOnly: false,
          destructive: false,
        },
        "default",
        { ...emptyRuleSet, settings: [{ type: "alwaysAllow", pattern, source: "settings" }] },
      ) === "allow"
    );
  });
  return {
    count: covered.length,
    first: covered
      .slice(0, 5)
      .map(
        (record) =>
          `  ${record.id}  ${escapeControls(JSON.stringify(masked(record.input ?? null)))}`,
      ),
  };
}

/** What a request asks for, in a line: an allow's pattern, or a delegation rule's action. */
function termsLabel(terms: NonNullable<ResolveAnswer["proposal"]>["terms"]): string {
  return terms.ruleKind === "allow" ? terms.pattern : `delegation of ${terms.action}`;
}

function ruleNote(answer: ResolveAnswer, harnessDir: string | undefined): string {
  if (answer.rule !== undefined) {
    return ` (standing rule ${answer.rule.id}: allows ${displayPattern(answer.rule.pattern)} until ${displayPattern(answer.rule.expiresAt)}; end it with \`crewhaus approvals revoke ${answer.rule.id}${harnessDir !== undefined ? ` --dir ${harnessDir}` : ""}\`)`;
  }
  if (answer.proposal !== undefined && answer.proposal.state === "pending") {
    return ` (once — a standing rule is the owner's to make: asked the owner for ${displayPattern(termsLabel(answer.proposal.terms))} as ${answer.proposal.id})`;
  }
  return "";
}

/**
 * Run `crewhaus approvals <action>`. Answers the exit code; every line goes through
 * `deps`.
 */
export async function runApprovalsCommand(
  args: ParsedArgs,
  action: string,
  deps: ApprovalsDeps,
): Promise<number> {
  const out = deps.stdout;
  const fail = (code: number, message: string): number => {
    deps.stderr(`crewhaus: ${message}\n`);
    return code;
  };
  if (args.flags["help"] === true || action === "") {
    out(`${HELP.join("\n")}\n`);
    return 0;
  }
  const agentTool = deps.env[AGENT_TOOL_ENV];
  if (CHANGES.has(action) && agentTool !== undefined && agentTool !== "") {
    return fail(EXIT_FOR_ERROR.forbidden, AGENT_TOOL_REFUSAL);
  }
  const json = args.flags["json"] === true;
  const now = deps.now ?? (() => Date.now());

  if (action === "rules" || action === "revoke") {
    const harnessDir = resolve(deps.cwd, str(args, "dir") ?? ".");
    if (action === "rules") return listRules(harnessDir, deps, json);
    return revoke(args, harnessDir, deps);
  }

  const always = args.flags["always"] === true;
  const located = locate(args, deps, always && action === "grant");
  if (!located.ok) return fail(located.code, located.message);
  const { rootDir, harnessDir } = located;

  if (action === "list" || action === "show") {
    const folded = foldReadOnly(rootDir);
    if (folded.state === "unreadable") {
      return fail(
        1,
        `cannot read the approvals under ${rootDir}: ${folded.reason ?? "unreadable"}`,
      );
    }
    if (action === "list") {
      const list = listedApprovals(folded.records, now(), DEFAULT_TTL_DAYS);
      out(json ? `${JSON.stringify(list, null, 2)}\n` : formatApprovalsTable(list));
      return 0;
    }
    const id = args.positional[0];
    if (typeof id !== "string" || id === "")
      return fail(1, "missing <id> — see `crewhaus approvals`");
    const found = folded.records.find((a: PendingApproval) => a.id === id);
    if (found === undefined) return fail(1, `no approval "${id}" under ${rootDir}`);
    out(
      json
        ? `${JSON.stringify(found, null, 2)}\n`
        : formatApprovalDetail(found, now(), { ignored: folded.ignoredById.get(id) ?? 0 }),
    );
    return 0;
  }

  const id = args.positional[0];
  if (typeof id !== "string" || id === "")
    return fail(1, "missing <id> — see `crewhaus approvals`");
  if (!APPROVAL_ID_RE.test(id) && !isId("dec", id)) {
    return fail(
      EXIT_FOR_ERROR.invalid,
      `invalid approvalId "${id}" — expected appr_<16 hex>, or a request's dec_ id`,
    );
  }
  // With no harness to keep it in, a store that is not there holds nothing to decide,
  // and none is made.
  if (harnessDir === undefined && APPROVAL_ID_RE.test(id) && !existsSync(rootDir)) {
    return fail(EXIT_FOR_REJECTED_RECEIPT, `no approval "${id}" under ${rootDir}`);
  }
  const display = str(args, "by") ?? deps.env["CREWHAUS_USER"] ?? "cli";
  const actor: DecisionActor = { kind: "local", identity: deps.identity, display };
  const hrn = harnessDir !== undefined ? deps.harnessIdOf(harnessDir) : undefined;
  const decisionTarget = hrn !== undefined ? `${hrn}/decision/${id}` : undefined;

  if (action === "supersede") {
    const reason = str(args, "reason");
    if (reason === undefined || !SUPERSEDE_REASON_CODES.includes(reason)) {
      return fail(EXIT_FOR_ERROR.invalid, invalidReasonMessage("supersede", reason));
    }
    if (!APPROVAL_ID_RE.test(id)) {
      return fail(
        EXIT_FOR_ERROR.invalid,
        `${id} is a request to the owner; grant or deny it instead`,
      );
    }
    const done = await receipted(deps, harnessDir, "decisions.supersede", decisionTarget, () =>
      deps.control.decisions.supersede({
        ...(harnessDir !== undefined ? { harnessDir } : {}),
        rootDir,
        ref: id,
        reason,
        actor,
        via: "cli",
      }),
    );
    if ("refused" in done) return fail(done.code, done.refused);
    const answer = done.value;
    if (answer.outcome === "not-found")
      return fail(exitFor(answer.outcome), `no approval "${id}" under ${rootDir}`);
    if (answer.outcome === "forbidden") {
      return fail(exitFor(answer.outcome), answer.reason ?? "not allowed to replace this request");
    }
    const withdrawn =
      answer.record !== null ? withdrawnMessage(id, answer.winner ?? answer.record) : undefined;
    if (withdrawn !== undefined) return fail(EXIT_FOR_REJECTED_RECEIPT, withdrawn);
    if (answer.outcome === "already-decided") {
      return fail(
        EXIT_FOR_REJECTED_RECEIPT,
        `${id} was already replaced by ${answer.winner?.supersededBy ?? "another request"}`,
      );
    }
    if (answer.outcome === "stale" || answer.fresh === undefined) {
      return fail(
        EXIT_FOR_REJECTED_RECEIPT,
        `${id} cannot be replaced: ${answer.reason ?? "it is not open"}`,
      );
    }
    const derived = answer.derivedRules ?? [];
    const ruleNotes = derived
      .map((rule) =>
        rule.revoked
          ? `; standing rule ${rule.id} ended`
          : `; standing rule ${rule.id} still stands: ${rule.verb ?? `crewhaus approvals revoke ${rule.id}`}`,
      )
      .join("");
    out(
      json
        ? `${JSON.stringify(
            {
              record: answer.record,
              fresh: answer.fresh,
              ...(answer.derivedRules !== undefined ? { derivedRules: answer.derivedRules } : {}),
            },
            null,
            2,
          )}\n`
        : `superseded ${id} — ${answer.fresh.toolName}; ${answer.fresh.id} now waits for a decision: crewhaus approvals grant|deny ${answer.fresh.id}${ruleNotes}\n`,
    );
    if (answer.ruleError !== undefined) {
      return fail(1, `the supersede stands, but: ${answer.ruleError}`);
    }
    return 0;
  }

  if (action === "defer") {
    const until = str(args, "until");
    if (until === undefined)
      return fail(1, "missing --until <time> (for example 2026-12-01T09:00:00Z)");
    const when = parseDeferUntil(until, now());
    if (typeof when === "string") return fail(1, when);
    const reason = str(args, "reason");
    if (reason === undefined || !DEFER_REASON_CODES.includes(reason)) {
      return fail(1, invalidReasonMessage("defer", reason));
    }
    if (!APPROVAL_ID_RE.test(id))
      return fail(1, `${id} is a request to the owner; it cannot be deferred`);
    const done = await receipted(deps, harnessDir, "decisions.defer", decisionTarget, () =>
      deps.control.decisions.defer({
        ...(harnessDir !== undefined ? { harnessDir } : {}),
        rootDir,
        ref: id,
        until,
        reason,
        actor,
        via: "cli",
      }),
    );
    if ("refused" in done) return fail(done.code, done.refused);
    const answer = done.value;
    if (answer.outcome === "not-found") {
      return fail(exitFor(answer.outcome), `no approval "${id}" under ${rootDir}`);
    }
    if (answer.outcome === "forbidden") {
      return fail(exitFor(answer.outcome), answer.reason ?? "not allowed to defer this request");
    }
    if (answer.outcome === "expired") return fail(exitFor(answer.outcome), `${id} has expired`);
    if (answer.outcome === "already-decided") {
      return fail(
        exitFor(answer.outcome),
        `${id} is not waiting: ${alreadyDecidedMessage(id, answer.winner ?? answer.record ?? ({} as PendingApproval))}`,
      );
    }
    out(
      json
        ? `${JSON.stringify(answer.record, null, 2)}\n`
        : `deferred ${id} until ${answer.record?.deferredUntil ?? until} (${reason})\n`,
    );
    return 0;
  }

  // grant | deny
  const choice: "grant" | "deny" = action === "grant" ? "grant" : "deny";
  if (always && choice !== "grant")
    return fail(EXIT_FOR_ERROR.invalid, "--always applies only to `approvals grant`");
  const daysText = str(args, "days");
  const pattern = str(args, "pattern");
  if ((daysText !== undefined || pattern !== undefined) && !always) {
    return fail(EXIT_FOR_ERROR.invalid, "--days and --pattern apply only with --always");
  }
  let days: number | undefined;
  if (daysText !== undefined) {
    days = /^\d+$/.test(daysText) ? Number(daysText) : Number.NaN;
    if (!(Number.isInteger(days) && days >= 1 && days <= MAX_RULE_DAYS)) {
      return fail(
        EXIT_FOR_ERROR.invalid,
        `--days must be a whole number from 1 to ${MAX_RULE_DAYS} (default ${DEFAULT_RULE_DAYS})`,
      );
    }
  }
  let confirm: string | undefined;
  if (pattern !== undefined) {
    if (!deps.isTTY()) {
      return fail(
        EXIT_FOR_ERROR.invalid,
        "--pattern asks you to confirm at a terminal; run it in one",
      );
    }
    if (harnessDir === undefined)
      return fail(EXIT_FOR_ERROR.invalid, "--pattern needs the harness: pass --dir <harness>");
    if (!deps.control.decisions.mayManageRules(harnessDir, actor)) {
      return fail(EXIT_FOR_ERROR.forbidden, "Needs the owner.");
    }
    const record = foldReadOnly(rootDir).records.find((r) => r.id === id);
    if (record === undefined)
      return fail(EXIT_FOR_REJECTED_RECEIPT, `no approval "${id}" under ${rootDir}`);
    const preview = widenPreview(rootDir, harnessDir, record.toolName, pattern);
    out(
      `${displayPattern(pattern)} also covers ${preview.count} approval(s) in this store${preview.count > 0 ? ":" : "."}\n`,
    );
    for (const line of preview.first) out(`${line}\n`);
    confirm = (
      await deps.ask(`Type the tool's name (${record.toolName}) to make this wider rule: `)
    ).trim();
  }

  const done = await receipted(deps, harnessDir, "decisions.resolve", decisionTarget, () =>
    deps.control.decisions.resolve(
      {
        ...(harnessDir !== undefined ? { harnessDir } : {}),
        rootDir,
        ref: id,
        choice,
        actor,
        via: "cli",
        ...(always ? { always: true } : {}),
        ...(days !== undefined ? { days } : {}),
        ...(pattern !== undefined ? { pattern } : {}),
        ...(confirm !== undefined ? { confirm } : {}),
      },
      harnessDir !== undefined ? { ruleCommand: ruleCommand(deps, harnessDir) } : {},
    ),
  );
  if ("refused" in done) return fail(done.code, done.refused);
  const answer = done.value;
  const isRequest = isId("dec", id);
  switch (answer.outcome) {
    case "not-found":
      return fail(
        exitFor(answer.outcome),
        isRequest
          ? `no request "${id}" in ${harnessDir ?? "this harness"}`
          : `no approval "${id}" under ${rootDir}`,
      );
    case "forbidden":
      return fail(exitFor(answer.outcome), answer.reason ?? "not allowed to decide this request");
    case "invalid":
      return fail(exitFor(answer.outcome), answer.reason ?? "the request is not valid");
    case "expired":
      return fail(exitFor(answer.outcome), `${id} has expired`);
    case "already-decided":
    case "stale":
      if (isRequest || answer.record === null) {
        return fail(
          exitFor(answer.outcome),
          `${id} was already ${answer.proposal?.state ?? answer.adoption?.state ?? "decided"}`,
        );
      }
      return fail(
        exitFor(answer.outcome),
        alreadyDecidedMessage(id, answer.winner ?? answer.record ?? ({} as PendingApproval)),
      );
    case "decided":
      break;
  }
  if (json) {
    out(
      `${JSON.stringify(
        answer.adoption !== undefined
          ? { adoption: answer.adoption }
          : isRequest
            ? {
                proposal: answer.proposal,
                ...(answer.rule !== undefined ? { rule: answer.rule } : {}),
              }
            : answer.record,
        null,
        2,
      )}\n`,
    );
  } else if (answer.adoption !== undefined) {
    // A change-adoption decision: a grant applies nothing; adopting is its own command.
    out(
      choice === "grant"
        ? `granted ${id} — ${answer.adoption.subject.chg} may be adopted: crewhaus changes adopt ${answer.adoption.subject.chg} --expect ${answer.adoption.subject.baseRevision}\n`
        : `denied ${id} — ${answer.adoption.subject.chg} will not be adopted\n`,
    );
  } else if (isRequest) {
    out(
      `${choice === "grant" ? "granted" : "denied"} ${id} — ${displayPattern(answer.proposal === undefined ? "" : termsLabel(answer.proposal.terms))}${ruleNote(answer, harnessDir)}\n`,
    );
  } else {
    const note = always
      ? ruleNote(answer, harnessDir)
      : choice === "grant"
        ? " (one-shot — the runtime consumes it on the next matching tool call)"
        : "";
    out(
      `${choice === "grant" ? "granted" : "denied"} ${id} — ${answer.record?.toolName ?? ""}${note}\n`,
    );
  }
  if (answer.ruleError !== undefined) {
    return fail(
      1,
      `the decision stands, but its standing rule could not be made: ${answer.ruleError}`,
    );
  }
  return 0;
}

async function listRules(harnessDir: string, deps: ApprovalsDeps, json: boolean): Promise<number> {
  const listing = deps.control.rules.list(harnessDir);
  if (json) {
    deps.stdout(`${JSON.stringify(listing, null, 2)}\n`);
    return listing.unreadable.length > 0 ? 1 : 0;
  }
  const lines: string[] = [];
  lines.push(listing.rules.length === 0 ? "standing rules: none" : "standing rules:");
  for (const rule of listing.rules) {
    lines.push(
      `  ${rule.id}  ${displayPattern(rule.pattern)}  until ${displayPattern(rule.expiresAt)}`,
    );
    lines.push(`    ${rule.verb}`);
  }
  if (listing.proposals.length > 0) {
    lines.push("waiting for the owner:");
    for (const proposal of listing.proposals) {
      lines.push(
        `  ${proposal.id}  ${displayPattern(proposal.terms.pattern)}  until ${displayPattern(proposal.terms.expiresAt)}`,
      );
      for (const verb of proposal.verbs) lines.push(`    ${verb}`);
    }
  }
  if (listing.legacy.length > 0) {
    lines.push("whole-tool allows no record keeps:");
    for (const allow of listing.legacy) {
      lines.push(`  ${displayPattern(allow.pattern)}  — ${allow.note}`);
      lines.push(`    ${displayPattern(allow.verb)}`);
    }
  }
  for (const problem of listing.unreadable) lines.push(`note: ${problem}`);
  deps.stdout(`${lines.join("\n")}\n`);
  return listing.unreadable.length > 0 ? 1 : 0;
}

async function revoke(args: ParsedArgs, harnessDir: string, deps: ApprovalsDeps): Promise<number> {
  const fail = (code: number, message: string): number => {
    deps.stderr(`crewhaus: ${message}\n`);
    return code;
  };
  const actor: DecisionActor = {
    kind: "local",
    identity: deps.identity,
    display: str(args, "by") ?? deps.env["CREWHAUS_USER"] ?? "cli",
  };
  const legacy = str(args, "legacy");
  const id = args.positional[0];
  if ((legacy === undefined) === (id === undefined)) {
    return fail(
      EXIT_FOR_ERROR.invalid,
      "give one of <rule_id> or --legacy <pattern> — see `crewhaus approvals`",
    );
  }
  const known = isKnownHarness(harnessDir, deps);
  if (legacy !== undefined) {
    // A directory that is no harness has no settings file to remove an allow from.
    if (!known) {
      return fail(
        EXIT_FOR_REJECTED_RECEIPT,
        `no allow ${displayPattern(legacy)} in the settings file`,
      );
    }
    const done = await receipted(deps, harnessDir, "rules.revoke", undefined, () =>
      deps.control.rules.revokeLegacy({ harnessDir, pattern: legacy, actor }),
    );
    if ("refused" in done) return fail(done.code, done.refused);
    const answer = done.value;
    if (answer.outcome === "removed") {
      deps.stdout(`removed the allow ${displayPattern(legacy)} from ${answer.path}\n`);
      return 0;
    }
    if (answer.outcome === "forbidden") return fail(EXIT_FOR_ERROR.forbidden, answer.reason);
    if (answer.outcome === "recorded") {
      return fail(
        EXIT_FOR_REJECTED_RECEIPT,
        `${displayPattern(legacy)} is a standing rule: revoke it by its id (see \`crewhaus approvals rules\`)`,
      );
    }
    if (answer.outcome === "not-found")
      return fail(
        EXIT_FOR_REJECTED_RECEIPT,
        `no allow ${displayPattern(legacy)} in the settings file`,
      );
    return fail(EXIT_FOR_REJECTED_RECEIPT, answer.reason);
  }
  const ruleId = id as string;
  if (!isId("rule", ruleId))
    return fail(EXIT_FOR_ERROR.invalid, `"${ruleId}" is not a rule id (rule_…)`);
  // A directory that is no harness holds no standing rule.
  if (!known) return fail(EXIT_FOR_REJECTED_RECEIPT, `no standing rule ${ruleId} in ${harnessDir}`);
  const hrn = deps.harnessIdOf(harnessDir);
  const done = await receipted(
    deps,
    harnessDir,
    "rules.revoke",
    hrn !== undefined ? `${hrn}/rule/${ruleId}` : undefined,
    () => deps.control.rules.revoke({ harnessDir, id: ruleId, actor }),
  );
  if ("refused" in done) return fail(done.code, done.refused);
  const answer = done.value;
  switch (answer.outcome) {
    case "revoked":
      deps.stdout(
        `revoked ${ruleId} — ${displayPattern(answer.rule.pattern)}${answer.settingsRemoved ? "" : " (another live rule keeps the allow)"}\n`,
      );
      return 0;
    case "forbidden":
      return fail(EXIT_FOR_ERROR.forbidden, answer.reason);
    case "not-found":
      return fail(EXIT_FOR_REJECTED_RECEIPT, `no standing rule ${ruleId} in ${harnessDir}`);
    case "ended":
      return fail(EXIT_FOR_REJECTED_RECEIPT, `${ruleId} has already ended (${answer.rule.state})`);
    case "unavailable":
      return fail(EXIT_FOR_ERROR.unavailable, answer.reason);
  }
}

/**
 * Whether the local user may change what a harness's settings file allows: always on
 * a harness with no approver list, and otherwise only for its owner, as the Home that
 * wrote the list knows them. `undefined` when allowed, else why not.
 */
export function settingsWriteRefusal(
  harnessDir: string,
  deps: Pick<ApprovalsDeps, "control" | "identity">,
): string | undefined {
  const read = readApproverProjection(harnessDir);
  if (read.state === "absent") return undefined;
  if (read.state === "unreadable") {
    return `this harness's list of who may approve cannot be read (${read.reason}); rewrite it with \`crewhaus access sync\``;
  }
  if (read.projection.accessRoot === undefined) {
    return "this harness's list of who may approve does not say which Home wrote it; rewrite it with `crewhaus access sync`";
  }
  return deps.control.decisions.mayManageRules(harnessDir, {
    kind: "local",
    identity: deps.identity,
  })
    ? undefined
    : "Needs the owner.";
}

/** The terminal's answer to one question. */
async function askAtTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((done) => rl.question(question, done));
  } finally {
    rl.close();
  }
}

/** This process's own I/O, for the CLI's dispatch. */
export function defaultApprovalsDeps(scopedSessionRoot: () => string | undefined): ApprovalsDeps {
  const env = process.env;
  return {
    env,
    cwd: process.cwd(),
    identity: currentLocalIdentity(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    scopedSessionRoot,
    isTTY: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: askAtTerminal,
    control: directControl({ env }),
    registryDirs: () => liveHarnessDirs({ env }),
    harnessIdOf: (dir) => harnessIdOf(dir, { env }),
  };
}

/**
 * `crewhaus permissions suggest --apply`'s check before it writes: the exit code when
 * the local user may not change the settings file's permissions here, after saying
 * why; `undefined` when they may.
 */
export function settingsApplyGate(
  harnessDir: string,
  deps: Pick<ApprovalsDeps, "control" | "identity" | "stderr"> = defaultApprovalsDeps(
    () => undefined,
  ),
): number | undefined {
  const refusal = settingsWriteRefusal(harnessDir, deps);
  if (refusal === undefined) return undefined;
  deps.stderr(`crewhaus: --apply refused: ${refusal} .crewhaus/settings.json is unchanged.\n`);
  return EXIT_FOR_ERROR.forbidden;
}
