/**
 * Fixture builders shared by the three test files.
 *
 * They write the REAL on-disk shapes: a `PendingApproval` line exactly as
 * `@crewhaus/session-store`'s `persist` appends it, and a session-log line
 * exactly as `@crewhaus/event-log` writes it (`{kind, payload}`). Tests that
 * built a convenient-but-wrong shape would pass against a reader that agreed
 * with them and fail against the product.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/** A syntactically valid approval id: `appr_` + 16 hex. `n` seeds it so ids are
 *  stable across runs — an id built from a clock or a random makes an ordering
 *  assertion unreproducible. */
export function approvalId(n: number): string {
  return `appr_${n.toString(16).padStart(16, "0")}`;
}

export type ApprovalFixture = {
  readonly id?: string;
  readonly toolName?: string;
  readonly input?: unknown;
  readonly inputHash?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly surface?: string;
  readonly createdAt?: string;
  readonly decision?: "grant" | "deny";
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly consumedAt?: string;
  readonly always?: boolean;
};

/** One `PendingApproval` record, defaults filled in. */
export function approval(fixture: ApprovalFixture = {}): Record<string, unknown> {
  const id = fixture.id ?? approvalId(1);
  return {
    id,
    toolName: fixture.toolName ?? "Read",
    inputHash: fixture.inputHash ?? `hash-${id}`,
    ...(fixture.input !== undefined ? { input: fixture.input } : {}),
    runId: fixture.runId ?? "run_1",
    sessionId: fixture.sessionId ?? "sess_1",
    surface: fixture.surface ?? "daemon",
    createdAt: fixture.createdAt ?? "2026-09-18T10:00:00.000Z",
    ...(fixture.decision !== undefined ? { decision: fixture.decision } : {}),
    ...(fixture.decidedBy !== undefined ? { decidedBy: fixture.decidedBy } : {}),
    ...(fixture.decidedAt !== undefined ? { decidedAt: fixture.decidedAt } : {}),
    ...(fixture.consumedAt !== undefined ? { consumedAt: fixture.consumedAt } : {}),
    ...(fixture.always !== undefined ? { always: fixture.always } : {}),
  };
}

/** Write an approvals ledger under `<harnessDir>/.crewhaus/sessions/`. */
export function writeApprovals(
  harnessDir: string,
  records: ReadonlyArray<Record<string, unknown> | string>,
): string {
  const dir = path.join(harnessDir, ".crewhaus", "sessions");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "approvals.jsonl");
  const body = records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");
  writeFileSync(file, records.length === 0 ? "" : `${body}\n`);
  return file;
}

/** A harness directory: the `crewhaus.yaml` is what the fleet walk looks for. */
export function makeHarness(root: string, rel: string): string {
  const dir = path.join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "crewhaus.yaml"), "name: fixture\n");
  return dir;
}

/** One `tool_use` session line — where the permission miner finds tool INPUT. */
export function toolUse(name: string, input: unknown): string {
  return JSON.stringify({ kind: "tool_use", payload: { id: "tu_1", name, input } });
}

/**
 * One resolved `permission` line — where the miner finds the ask COUNTS.
 * The durable line carries no input, which is why the miner has to correlate
 * `permission.toolName` with `tool_use.name`.
 */
export function permissionAsk(toolName: string, outcome: "approved" | "denied"): string {
  return JSON.stringify({
    kind: "permission",
    payload: { toolName, decision: "ask", askOutcome: outcome },
  });
}

/** Write a session log under `<harnessDir>/.crewhaus/sessions/<id>.jsonl`. */
export function writeSession(
  harnessDir: string,
  sessionId: string,
  lines: ReadonlyArray<string>,
): string {
  const dir = path.join(harnessDir, ".crewhaus", "sessions");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  return file;
}

/**
 * A session that asked about ONE tool with ONE input, `approved` times
 * approved and `denied` times denied — the shape `aggregateAsks` mines.
 */
export function askSession(
  harnessDir: string,
  sessionId: string,
  args: {
    readonly toolName: string;
    readonly input: unknown;
    readonly approved?: number;
    readonly denied?: number;
  },
): string {
  const lines = [toolUse(args.toolName, args.input)];
  for (let i = 0; i < (args.approved ?? 0); i++)
    lines.push(permissionAsk(args.toolName, "approved"));
  for (let i = 0; i < (args.denied ?? 0); i++) lines.push(permissionAsk(args.toolName, "denied"));
  return writeSession(harnessDir, sessionId, lines);
}

/** Write `.crewhaus/settings.json` verbatim (the text, so a test can write one
 *  that does not parse). */
export function writeSettings(harnessDir: string, text: string): string {
  const dir = path.join(harnessDir, ".crewhaus");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.json");
  writeFileSync(file, text);
  return file;
}
