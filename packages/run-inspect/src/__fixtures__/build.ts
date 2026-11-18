/**
 * Fixture builders for run-inspect's tests: session logs written as JSONL in code, run
 * rows appended to a harness's run ledger, and decision-log segments in its session
 * root. Every id is fixed, so a fixture reads the same on every run.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { append, runsLedger } from "@crewhaus/control-records";

const made: string[] = [];

export function removeFixtures(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const SESSION = "sess_00000000000000a1";
export const NOW = Date.parse("2026-11-14T12:00:00.000Z");

/** A canonical run id: `run_` and 26 Crockford characters. */
export function runId(n: number): string {
  return `run_${String(n).padStart(26, "0")}`;
}

/** A span id: 16 lowercase hex, never all zeros. */
export function spanId(n: number): string {
  return n.toString(16).padStart(16, "0");
}

export function apprId(n: number): string {
  return `appr_${n.toString(16).padStart(16, "0")}`;
}

type LineOptions = { readonly run?: string; readonly span?: string; readonly ts?: number };

/** A session log, line by line, with each line's byte offset. */
export class LogBuilder {
  private readonly parts: string[] = [];
  private bytes = 0;
  private clock = NOW - 60_000;

  /** Append one line; answers its byte offset. */
  add(kind: string, payload: unknown, options: LineOptions = {}): number {
    const off = this.bytes;
    this.clock += 10;
    const line = JSON.stringify({
      ts: options.ts ?? this.clock,
      version: 1,
      kind,
      payload,
      ...(options.run !== undefined ? { run: options.run } : {}),
      ...(options.span !== undefined ? { span: options.span } : {}),
    });
    this.parts.push(`${line}\n`);
    this.bytes += Buffer.byteLength(line) + 1;
    return off;
  }

  /** Append raw text (a torn line, say); answers its byte offset. */
  raw(text: string): number {
    const off = this.bytes;
    this.parts.push(text);
    this.bytes += Buffer.byteLength(text);
    return off;
  }

  get size(): number {
    return this.bytes;
  }

  text(): string {
    return this.parts.join("");
  }

  /** A run's `run_stamp`, on its root span. */
  stamp(
    run: string,
    root: string,
    options: {
      readonly trigger?: Readonly<Record<string, unknown>>;
      readonly recording?: Readonly<Record<string, boolean>>;
      readonly execution?: string;
      readonly parent?: string;
      readonly continues?: string;
    } = {},
  ): number {
    return this.add(
      "run_stamp",
      {
        v: 1,
        run,
        ...(options.parent !== undefined ? { parent: options.parent } : {}),
        ...(options.continues !== undefined ? { continues: options.continues } : {}),
        ...(options.execution !== undefined ? { execution: options.execution } : {}),
        resumeScope: `session:${SESSION}`,
        shape: "cli",
        mode: "single-turn",
        model: "test-model",
        sessionTurnBase: 0,
        trigger: options.trigger ?? { kind: "cli" },
        revisions: {
          spec: { specHash: "sha256:abc123", source: "spawn-env" },
          runtime: "0.9.0",
          settings: { fingerprint: "f".repeat(64), rules: 3 },
        },
        recording: {
          advisorEvents: true,
          costTracking: true,
          watchme: false,
          runLedger: true,
          ...options.recording,
        },
      },
      { run, span: root },
    );
  }

  /** A `span_closed` line. */
  close(
    run: string,
    span: string,
    kind: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): number {
    return this.add(
      "span_closed",
      {
        v: 1,
        run,
        span,
        kind,
        startedAt: "2026-11-14T11:59:00.000Z",
        durationMs: 5,
        status: "ok",
        ...fields,
      },
      { run, span },
    );
  }
}

/** A run whose model called one tool and answered: the common shape of a short run. */
export function simpleRun(
  b: LogBuilder,
  run: string,
  base: number,
  options: {
    readonly ask?: string;
    readonly answer?: string;
    readonly tool?: string;
    readonly result?: string;
    readonly trigger?: Readonly<Record<string, unknown>>;
    readonly recording?: Readonly<Record<string, boolean>>;
    readonly execution?: string;
    readonly parent?: string;
    readonly cost?: ReadonlyArray<Readonly<Record<string, unknown>>>;
    /** A routing line, written on the turn before the first model call. */
    readonly route?: Readonly<Record<string, unknown>>;
  } = {},
): { root: string; turn: string; model: string; tool: string; answerModel: string } {
  const root = spanId(base + 1);
  const turn = spanId(base + 2);
  const model = spanId(base + 3);
  const tool = spanId(base + 4);
  const answerModel = spanId(base + 5);
  const on = (span: string) => ({ run, span });
  b.stamp(run, root, {
    ...(options.trigger !== undefined ? { trigger: options.trigger } : {}),
    ...(options.recording !== undefined ? { recording: options.recording } : {}),
    ...(options.execution !== undefined ? { execution: options.execution } : {}),
    ...(options.parent !== undefined ? { parent: options.parent } : {}),
  });
  b.add("user_message", { content: options.ask ?? "please read the notes" }, on(root));
  if (options.route !== undefined) b.add("model_route", options.route, on(turn));
  b.add(
    "context_manifest",
    {
      v: 1,
      run,
      span: model,
      turn: { run: 1, session: 1 },
      call: 1,
      blocks: [{ kind: "instructions", bytes: 12, fingerprint: "a".repeat(64), cached: true }],
      tools: { fingerprint: "b".repeat(64), advertised: 2, inSpec: 2, names: ["Read", "Write"] },
      model: { wire: "test-model", provider: "anthropic", params: { maxTokens: 8192 } },
      messages: { count: 1, afterCompaction: false },
    },
    on(model),
  );
  b.add(
    "assistant_message",
    {
      content: [
        { type: "text", text: "I will read the notes first." },
        { type: "tool_use", id: "tu_1", name: options.tool ?? "Read", input: { path: "notes.md" } },
      ],
    },
    on(model),
  );
  b.close(run, model, "model", { parent: turn, call: 1, turn: { run: 1, session: 1 } });
  b.add(
    "tool_use",
    { id: "tu_1", name: options.tool ?? "Read", input: { path: "notes.md" } },
    on(tool),
  );
  b.add(
    "verdict",
    {
      v: 1,
      run,
      span: tool,
      on: { kind: "tool", toolUseId: "tu_1", call: 1 },
      gate: "permission",
      outcome: "allow",
      mode: "default",
    },
    on(tool),
  );
  b.add(
    "tool_result",
    { toolUseId: "tu_1", content: options.result ?? "the notes say hello", isError: false },
    on(tool),
  );
  b.close(run, tool, "tool", {
    parent: turn,
    toolUseId: "tu_1",
    call: 1,
    turn: { run: 1, session: 1 },
  });
  b.add(
    "context_manifest",
    {
      v: 1,
      run,
      span: answerModel,
      turn: { run: 1, session: 1 },
      call: 2,
      blocks: [{ kind: "instructions", bytes: 12, fingerprint: "a".repeat(64), cached: true }],
      tools: { fingerprint: "b".repeat(64), advertised: 2, inSpec: 2 },
      model: { wire: "test-model", provider: "anthropic", params: { maxTokens: 8192 } },
      messages: { count: 3, afterCompaction: false },
    },
    on(answerModel),
  );
  for (const cost of options.cost ?? []) b.add("cost_accrual", cost, on(turn));
  b.add(
    "assistant_message",
    { content: [{ type: "text", text: options.answer ?? "The notes say hello." }] },
    on(answerModel),
  );
  b.close(run, answerModel, "model", { parent: turn, call: 2, turn: { run: 1, session: 1 } });
  b.close(run, turn, "turn", { parent: root, turn: { run: 1, session: 1 } });
  b.close(run, root, "run");
  return { root, turn, model, tool, answerModel };
}

/** A harness directory with a session log, run rows and decision-log segments. */
export function harnessWith(input: {
  readonly session?: string;
  readonly log?: string;
  readonly rows?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly decisions?: ReadonlyArray<Readonly<Record<string, unknown>> | string>;
}): { readonly dir: string; readonly sessions: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-inspect-")));
  made.push(dir);
  writeFileSync(join(dir, "crewhaus.yaml"), "name: inspect-fixture\ntarget: cli\n");
  const sessions = join(dir, ".crewhaus", "sessions");
  mkdirSync(sessions, { recursive: true });
  if (input.log !== undefined) {
    writeFileSync(join(sessions, `${input.session ?? SESSION}.jsonl`), input.log);
  }
  for (const row of input.rows ?? []) {
    const written = append(runsLedger(dir), { at: "2026-11-14T11:59:00.000Z", ...row });
    if (!written.ok) throw new Error(`fixture row not written: ${JSON.stringify(written)}`);
  }
  if (input.decisions !== undefined) {
    const segments = join(sessions, "approvals.d", "decisions");
    mkdirSync(segments, { recursive: true });
    writeFileSync(
      join(segments, "000001.jsonl"),
      `${input.decisions.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`,
    );
  }
  return { dir, sessions };
}

/** A decision-log line. */
export function decisionLine(
  event: string,
  decision: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    v: 1,
    at: "2026-11-14T12:00:00.000Z",
    event,
    decision,
    sessionId: SESSION,
    tool: "Write",
    inputDigest: "d".repeat(64),
    placesDigest: "e".repeat(64),
    surface: "single-turn",
    ...overrides,
  };
}
