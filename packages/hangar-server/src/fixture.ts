/**
 * Deterministic harness-directory synthesizer for tests (the
 * grader-continuity `fixture.ts` pattern). Builds a standalone harness dir —
 * `crewhaus.yaml` + a `.crewhaus` state tree — with every store the M1
 * routes read: sessions (live, expired-mtime, torn lines), the durable
 * sessions index, eval history (index/baselines/run dirs), memories with
 * tombstones, wiki, continuity state, dream state, watchme state, and
 * feedback records.
 *
 * Everything is injectable and clock-driven; nothing here contains a
 * realistic-shaped secret (tests build those from string parts).
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FixtureSession = {
  readonly id: string;
  readonly name?: string;
  readonly model?: string;
  readonly target?: string;
  readonly updatedAt?: string;
  readonly lastTurnIndex?: number;
  /** JSONL line objects (or raw strings, e.g. a torn line) for `<id>.jsonl`. */
  readonly log?: ReadonlyArray<unknown | string>;
  /** Set both files' mtimes to this epoch-ms (expired-mtime fixtures). */
  readonly mtimeMs?: number;
};

export type FixtureHarnessOptions = {
  readonly specName?: string;
  readonly target?: string;
  readonly model?: string;
  /** Extra YAML appended verbatim to crewhaus.yaml (badges, mcp, …). */
  readonly specExtra?: string;
  /** Omit crewhaus.yaml entirely (unreadable-spec cases). */
  readonly noSpec?: boolean;
  /** `.env` lines, verbatim. */
  readonly envLines?: readonly string[];
  readonly sessions?: readonly FixtureSession[];
  /** Durable index summaries for evicted ids: id → summary object. */
  readonly sessionIndex?: Readonly<Record<string, unknown>>;
  /** Eval run-index entries (JSONL) + baselines + run dirs. */
  readonly evalIndex?: readonly unknown[];
  readonly baselines?: Record<string, unknown>;
  readonly evalRuns?: ReadonlyArray<{
    readonly runId: string;
    readonly results?: unknown;
    readonly samples?: Readonly<
      Record<string, { grades?: unknown; meta?: unknown; transcript?: readonly unknown[] }>
    >;
  }>;
  /** memories/<stem>.jsonl lines. */
  readonly memories?: Readonly<Record<string, readonly unknown[]>>;
  readonly wikiIndex?: unknown;
  readonly wikiArticles?: Readonly<Record<string, string>>;
  readonly focus?: string;
  readonly goals?: string;
  readonly dreamState?: Readonly<Record<string, unknown>>;
  readonly watchmeState?: unknown;
  readonly watchmeObservations?: readonly unknown[];
  /** feedback/<file>.jsonl lines (bare FeedbackRecord objects). */
  readonly feedback?: Readonly<Record<string, readonly unknown[]>>;
};

const jsonl = (lines: ReadonlyArray<unknown | string>): string =>
  `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`;

/** A durable session-log line in the event-log envelope encoding. */
export function logLine(kind: string, payload: unknown, ts?: string): unknown {
  return { ...(ts !== undefined ? { ts } : {}), version: 1, kind, payload };
}

/** A minimal bare FeedbackRecord (the shape `crewhaus distill` folds). */
export function feedbackRecord(
  sessionId: string,
  turnNumber: number,
  thumbs: "up" | "down",
  ts: string,
): unknown {
  return {
    schemaVersion: 1,
    id: `fb_${sessionId.slice(-4)}_${turnNumber}`,
    sessionId,
    turnNumber,
    modality: "binary",
    rating: { thumbs },
    source: "cli",
    ts,
  };
}

/** Synthesize a harness dir at `dir`. Returns `dir` for chaining. */
export function makeFixtureHarness(dir: string, opts: FixtureHarnessOptions = {}): string {
  const specName = opts.specName ?? "fixture-harness";
  const target = opts.target ?? "cli";
  const model = opts.model ?? "anthropic/claude-sonnet-4";
  mkdirSync(dir, { recursive: true });
  const ch = join(dir, ".crewhaus");

  if (opts.noSpec !== true) {
    const yaml = [
      `name: ${specName}`,
      `target: ${target}`,
      "agent:",
      `  model: ${model}`,
      "instructions: |",
      "  You are a fixture. Answer briefly.",
      ...(opts.specExtra !== undefined ? [opts.specExtra] : []),
      "",
    ].join("\n");
    writeFileSync(join(dir, "crewhaus.yaml"), yaml);
  }

  if (opts.envLines !== undefined) {
    writeFileSync(join(dir, ".env"), `${opts.envLines.join("\n")}\n`, { mode: 0o600 });
  }

  const sessionsDir = join(ch, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  for (const s of opts.sessions ?? []) {
    const meta = {
      id: s.id,
      createdAt: s.updatedAt ?? "2026-08-01T00:00:00.000Z",
      updatedAt: s.updatedAt ?? "2026-08-01T00:00:00.000Z",
      name: s.name ?? "fixture session",
      target: s.target ?? target,
      model: s.model ?? model,
      lastTurnIndex: s.lastTurnIndex ?? 1,
    };
    const metaPath = join(sessionsDir, `${s.id}.json`);
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    const logPath = join(sessionsDir, `${s.id}.jsonl`);
    if (s.log !== undefined) writeFileSync(logPath, jsonl(s.log));
    if (s.mtimeMs !== undefined) {
      const t = new Date(s.mtimeMs);
      utimesSync(metaPath, t, t);
      if (s.log !== undefined) utimesSync(logPath, t, t);
    }
  }

  if (opts.sessionIndex !== undefined) {
    const indexDir = join(ch, "sessions-index");
    mkdirSync(indexDir, { recursive: true });
    for (const [id, summary] of Object.entries(opts.sessionIndex)) {
      writeFileSync(join(indexDir, `${id}.json`), `${JSON.stringify(summary, null, 2)}\n`);
    }
  }

  if (opts.evalIndex !== undefined || opts.baselines !== undefined || opts.evalRuns !== undefined) {
    const evalsDir = join(ch, "evals");
    mkdirSync(evalsDir, { recursive: true });
    if (opts.evalIndex !== undefined) {
      writeFileSync(join(evalsDir, "index.jsonl"), jsonl(opts.evalIndex));
    }
    if (opts.baselines !== undefined) {
      writeFileSync(
        join(evalsDir, "baselines.json"),
        `${JSON.stringify(opts.baselines, null, 2)}\n`,
      );
    }
    for (const run of opts.evalRuns ?? []) {
      const runDir = join(evalsDir, run.runId);
      mkdirSync(runDir, { recursive: true });
      if (run.results !== undefined) {
        writeFileSync(join(runDir, "results.json"), `${JSON.stringify(run.results, null, 2)}\n`);
      }
      for (const [sampleId, files] of Object.entries(run.samples ?? {})) {
        const sampleDir = join(runDir, sampleId);
        mkdirSync(sampleDir, { recursive: true });
        if (files.grades !== undefined) {
          writeFileSync(join(sampleDir, "grades.json"), `${JSON.stringify(files.grades)}\n`);
        }
        if (files.meta !== undefined) {
          writeFileSync(join(sampleDir, "meta.json"), `${JSON.stringify(files.meta)}\n`);
        }
        if (files.transcript !== undefined) {
          writeFileSync(join(sampleDir, "transcript.jsonl"), jsonl(files.transcript));
        }
      }
    }
  }

  for (const [stem, lines] of Object.entries(opts.memories ?? {})) {
    const memDir = join(ch, "memories");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${stem}.jsonl`), jsonl(lines));
  }

  if (opts.wikiIndex !== undefined || opts.wikiArticles !== undefined) {
    const wikiDir = join(ch, "wiki");
    mkdirSync(join(wikiDir, "articles"), { recursive: true });
    if (opts.wikiIndex !== undefined) {
      writeFileSync(join(wikiDir, "index.json"), `${JSON.stringify(opts.wikiIndex, null, 2)}\n`);
    }
    for (const [slug, body] of Object.entries(opts.wikiArticles ?? {})) {
      writeFileSync(join(wikiDir, "articles", `${slug}.md`), body);
    }
  }

  if (opts.focus !== undefined || opts.goals !== undefined) {
    const stateDir = join(ch, "state");
    mkdirSync(stateDir, { recursive: true });
    if (opts.focus !== undefined) writeFileSync(join(stateDir, "focus.md"), opts.focus);
    if (opts.goals !== undefined) writeFileSync(join(stateDir, "goals.yaml"), opts.goals);
  }

  for (const [spec, state] of Object.entries(opts.dreamState ?? {})) {
    const specDir = join(ch, "dream", spec);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  }

  if (opts.watchmeState !== undefined || opts.watchmeObservations !== undefined) {
    const wmDir = join(ch, "watchme");
    mkdirSync(wmDir, { recursive: true });
    if (opts.watchmeState !== undefined) {
      writeFileSync(join(wmDir, "state.json"), `${JSON.stringify(opts.watchmeState, null, 2)}\n`);
    }
    if (opts.watchmeObservations !== undefined) {
      writeFileSync(join(wmDir, "observations.jsonl"), jsonl(opts.watchmeObservations));
    }
  }

  for (const [file, lines] of Object.entries(opts.feedback ?? {})) {
    const fbDir = join(ch, "feedback");
    mkdirSync(fbDir, { recursive: true });
    writeFileSync(join(fbDir, `${file}.jsonl`), jsonl(lines));
  }

  return dir;
}
