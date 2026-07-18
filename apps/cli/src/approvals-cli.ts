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
 */
import type { PendingApproval } from "@crewhaus/session-store";

/**
 * The operator-facing lifecycle state of a parked approval, derived from the
 * store record. `consumed` is a spent one-shot grant (a later identical call
 * re-asks under a fresh id); `granted`/`denied` are recorded-but-not-yet-spent
 * decisions; `pending` still awaits one.
 */
export type ApprovalDisplayStatus = "pending" | "granted" | "denied" | "consumed";

/** Derive the display status from the record's `decision` + `consumedAt`. */
export function approvalStatus(a: PendingApproval): ApprovalDisplayStatus {
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
 * approver can inspect exactly what a grant authorizes.
 */
export function formatApprovalDetail(a: PendingApproval, now: number = Date.now()): string {
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
  if (a.decidedBy !== undefined) row("decidedBy", a.decidedBy);
  if (a.decidedAt !== undefined) row("decidedAt", a.decidedAt);
  if (a.consumedAt !== undefined) row("consumedAt", a.consumedAt);
  lines.push("input:");
  const inputText =
    a.input === undefined ? "  (not recorded)" : indentJson(JSON.stringify(a.input, null, 2));
  lines.push(inputText);
  return `${lines.join("\n")}\n`;
}

/** Indent every line of a JSON blob by two spaces for the detail view. */
function indentJson(json: string): string {
  return json
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}
