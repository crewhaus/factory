/**
 * Loop contract 0.4 (Batch C, G11) — the `crewhaus approvals` verbs' pure
 * rendering layer. The FS wiring (constructing the file-backed
 * `PendingApprovalStore` over the harness's `.crewhaus/sessions/`) lives in
 * `index.ts`; this module is side-effect-free so the status derivation +
 * table/detail formatting are unit-testable without spawning the CLI.
 *
 * A `PendingApproval` is parked by the runtime when a tool permission resolves
 * to `ask` on a NON-interactive surface and `permissions.ask_mode` is `"pause"`
 * (the default). The operator resolves it out of band with
 * `crewhaus approvals grant|deny <id>`; the next run that re-issues the same
 * `(toolName, input)` call finds the recorded decision and proceeds
 * pre-resolved (a `grant` is one-shot — consumed on use).
 *
 * The first decision wins (#507): a second `grant` or `deny` is refused and
 * names the first. A decision is changed before it is used with
 * `crewhaus approvals supersede <id> --reason <code>`, which parks a fresh
 * request in its place; a waiting request can be marked
 * `crewhaus approvals defer <id> --until <time> --reason <code>`.
 */
import { hostname, userInfo } from "node:os";
import { localActorOf } from "@crewhaus/access-control";
import { DEFER_REASONS, type PendingApproval, SUPERSEDE_REASONS } from "@crewhaus/session-store";

/**
 * The operator-facing lifecycle state of a parked approval, derived from the
 * store record. `consumed` is a spent one-shot grant (a later identical call
 * re-asks under a fresh id); `granted`/`denied` are recorded-but-not-yet-spent
 * decisions; `granted-always` is a standing allow (#383 — the terminal state
 * whether or not the parked call was since consumed, because the standing
 * behavior rides the `alwaysAllow` rule in `.crewhaus/settings.json`, not
 * this record); `superseded` was replaced by a fresh request (checked first,
 * as `effectiveDecisionState` does); `pending` still awaits one.
 */
export type ApprovalDisplayStatus =
  | "pending"
  | "granted"
  | "granted-always"
  | "denied"
  | "consumed"
  | "superseded";

/** Derive the display status from the record's `decision` + `consumedAt`. */
export function approvalStatus(a: PendingApproval): ApprovalDisplayStatus {
  if (a.supersededBy !== undefined) return "superseded";
  if (a.decision === "grant" && a.always === true) return "granted-always";
  if (a.consumedAt !== undefined) return "consumed";
  if (a.decision === "grant") return "granted";
  if (a.decision === "deny") return "denied";
  return "pending";
}

/**
 * A compact relative age (`3s` / `12m` / `4h` / `9d`) from an ISO timestamp.
 * `?` for an unparseable stamp. Coarse by design — approvals are inspected,
 * not stopwatched.
 */
export function formatApprovalAge(fromIso: string, now: number = Date.now()): string {
  const then = Date.parse(fromIso);
  if (!Number.isFinite(then)) return "?";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Pad a cell to `width` (never truncates — ids/tools stay copy-pasteable). */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * Render `store.list()` output as an aligned table (newest-first is the
 * store's own order). Empty → a single friendly line. Columns: id, status,
 * tool, surface, age, session.
 */
export function formatApprovalsTable(
  approvals: ReadonlyArray<PendingApproval>,
  now: number = Date.now(),
): string {
  if (approvals.length === 0) {
    return "no approvals recorded.\n";
  }
  const header = ["ID", "STATUS", "TOOL", "SURFACE", "AGE", "SESSION"] as const;
  const rows = approvals.map((a) => [
    a.id,
    approvalStatus(a),
    a.toolName,
    a.surface,
    formatApprovalAge(a.createdAt, now),
    a.sessionId,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: ReadonlyArray<string>): string =>
    cells
      .map((c, i) => pad(c, widths[i] ?? c.length))
      .join("  ")
      .trimEnd();
  const out = [line(header), ...rows.map(line)];
  const pending = approvals.filter((a) => approvalStatus(a) === "pending").length;
  out.push("");
  out.push(
    `${approvals.length} approval(s), ${pending} pending. Resolve with: crewhaus approvals grant|deny <id>`,
  );
  return `${out.join("\n")}\n`;
}

/**
 * Multi-line detail for one approval, including the verbatim tool input so an
 * approver can inspect exactly what a grant authorizes. `ignored` is how many
 * later lines tried to change its decision and were ignored.
 */
export function formatApprovalDetail(
  a: PendingApproval,
  now: number = Date.now(),
  opts: { readonly ignored?: number } = {},
): string {
  const lines: string[] = [];
  const row = (label: string, value: string): void => {
    lines.push(`${pad(`${label}:`, 12)}${value}`);
  };
  row("id", a.id);
  row("status", approvalStatus(a));
  row("tool", a.toolName);
  row("surface", a.surface);
  row("session", a.sessionId);
  row("run", a.runId);
  row("created", `${a.createdAt} (${formatApprovalAge(a.createdAt, now)} ago)`);
  row("inputHash", a.inputHash);
  if (a.decision !== undefined) row("decision", a.decision);
  if (a.always === true) row("always", "true (standing allow — see .crewhaus/settings.json)");
  if (a.decidedBy !== undefined) row("decidedBy", a.decidedBy);
  if (a.decidedAt !== undefined) row("decidedAt", a.decidedAt);
  if (a.consumedAt !== undefined) row("consumedAt", a.consumedAt);
  if (a.supersededBy !== undefined && a.supersededReason === "run-cancelled") {
    // Withdrawn, not replaced: nothing waits in its place.
    row("withdrawn", `run ${a.supersededBy} was cancelled`);
  } else if (a.supersededBy !== undefined) {
    const why = a.supersededReason !== undefined ? ` (${a.supersededReason})` : "";
    row("replacedBy", `${a.supersededBy}${why}`);
  }
  if (a.deferredUntil !== undefined) row("deferred", `until ${a.deferredUntil}`);
  const ignored = opts.ignored ?? 0;
  if (ignored > 0) {
    lines.push(
      `${ignored} later line${ignored === 1 ? "" : "s"} tried to change this decision and ${ignored === 1 ? "was" : "were"} ignored`,
    );
  }
  lines.push("input:");
  const inputText =
    a.input === undefined ? "  (not recorded)" : indentJson(JSON.stringify(a.input, null, 2));
  lines.push(inputText);
  // 0.7.1 — where the call acts, symlinks followed: what a grant covers. A
  // call that lands anywhere else by the time it resumes is asked again.
  if (Array.isArray(a.places) && a.places.length > 0) {
    lines.push("lands at:");
    lines.push(...placeLines(a.places));
  }
  // Asked again because a symlink on the path moved: the approval this one
  // stands in for, and where that call landed.
  const before = a.supersedes;
  if (typeof before === "object" && before !== null && typeof before.id === "string") {
    const was = before.decision === "grant" ? "granted" : "requested";
    if (Array.isArray(before.places) && before.places.length > 0) {
      lines.push(`asked again: approval ${before.id} was ${was} where the call landed at:`);
      lines.push(...placeLines(before.places));
    } else {
      lines.push(`asked again: approval ${before.id} was ${was} for the input as written`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** One `  <path> -> <place>, <place>` line per path a call names. */
function placeLines(places: ReadonlyArray<unknown>): string[] {
  return places.map((p) => {
    const { path, at } = (typeof p === "object" && p !== null ? p : {}) as {
      path?: unknown;
      at?: unknown;
    };
    return `  ${String(path)} -> ${Array.isArray(at) ? at.join(", ") : "?"}`;
  });
}

/** Indent every line of a JSON blob by two spaces for the detail view. */
function indentJson(json: string): string {
  return json
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

/** The codes `crewhaus approvals supersede --reason` takes. */
export const SUPERSEDE_REASON_CODES: readonly string[] = SUPERSEDE_REASONS;
/** The codes `crewhaus approvals defer --reason` takes. */
export const DEFER_REASON_CODES: readonly string[] = DEFER_REASONS;

/**
 * What `approvals list` shows: every record the fold returns that the runtime
 * would still see (within `ttlDays` of its park), replaced ones included so the
 * history reads, newest-touched first.
 */
export function listedApprovals(
  records: ReadonlyArray<PendingApproval>,
  now: number,
  ttlDays: number,
): PendingApproval[] {
  const cutoff = now - ttlDays * 86_400_000;
  const touched = (a: PendingApproval): number => {
    const at = Date.parse(a.decidedAt ?? a.createdAt);
    return Number.isFinite(at) ? at : 0;
  };
  return records
    .filter((a) => {
      const created = Date.parse(a.createdAt);
      return Number.isFinite(created) && created >= cutoff;
    })
    .sort((a, b) => touched(b) - touched(a));
}

/**
 * Why a `grant` or `deny` was refused because the request is no longer waiting,
 * and the one verb that changes a decision before it is used.
 */
export function alreadyDecidedMessage(id: string, winner: PendingApproval): string {
  const withdrawn = withdrawnMessage(id, winner);
  if (withdrawn !== undefined) return withdrawn;
  if (winner.supersededBy !== undefined) {
    return `${id} was replaced by ${winner.supersededBy}; decide that one instead: crewhaus approvals grant|deny ${winner.supersededBy}`;
  }
  if (winner.consumedAt !== undefined) return `${id} was already granted and used`;
  const was = winner.decision === "deny" ? "denied" : "granted";
  return `${id} was already ${was}; to change it before it is used: crewhaus approvals supersede ${id} --reason <code>`;
}

/**
 * Why a request withdrawn because its run was cancelled cannot be decided or
 * replaced, or `undefined` for any other record. It names no verb: nothing waits
 * in its place, and its `supersededBy` is a run, not a request.
 */
export function withdrawnMessage(id: string, record: PendingApproval): string | undefined {
  if (record.supersededBy === undefined || record.supersededReason !== "run-cancelled") {
    return undefined;
  }
  return `${id} was withdrawn when its run was cancelled; there is nothing to decide`;
}

/** An invalid `--reason`, with the codes the verb takes. */
export function invalidReasonMessage(
  verb: "supersede" | "defer",
  given: string | undefined,
): string {
  const codes = verb === "supersede" ? SUPERSEDE_REASON_CODES : DEFER_REASON_CODES;
  const got = given === undefined ? "missing --reason" : `"${given}" is not a reason`;
  return `${got} — \`approvals ${verb}\` takes one of: ${codes.join(", ")}`;
}

/**
 * The OS user running the CLI as `local:<user>@<host>`, which the store keeps
 * only as a keyed digest; `undefined` when the identity cannot be read.
 */
export function localApprovalActor(): string | undefined {
  try {
    return localActorOf({ username: userInfo().username, hostname: hostname() });
  } catch {
    return undefined;
  }
}
