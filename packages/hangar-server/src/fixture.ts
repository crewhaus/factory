/**
 * Deterministic harness-directory synthesizer for tests (the
 * grader-continuity `fixture.ts` pattern). Builds a standalone harness dir —
 * `crewhaus.yaml` + a `.crewhaus` state tree — with every store the routes
 * read: sessions (live, expired-mtime, torn lines), the durable sessions
 * index, eval history (index/baselines/run dirs), memories with tombstones,
 * wiki, continuity state, dream state, watchme state, feedback records, and
 * the M2 ops tree (runfile, run ledger, captured run logs + events, control
 * token, approvals, review queue, retention pins, deployment records,
 * incidents, spec changelogs, and a compiled bundle with or without the F-5
 * spec-hash stamp).
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

  // -- M2: the process layer's harness-local ops state ---------------------
  /** `.crewhaus/run/runs.jsonl` lines (ledger entries and/or patches). */
  readonly runLedger?: readonly unknown[];
  /** Captured run artifacts: `logs/<runId>.log` + `.events.jsonl`. */
  readonly runLogs?: ReadonlyArray<{
    readonly runId: string;
    /** Raw captured text (UNSCRUBBED, as a real child writes it). */
    readonly log?: string;
    /** Extracted TraceEvents, as the pump persists them. */
    readonly events?: readonly unknown[];
  }>;
  /** `.crewhaus/run/daemon.json`. Written verbatim so a test can synthesize
   *  a stale runfile (a pid that is gone) as easily as a live one. */
  readonly runfile?: unknown;
  /** `.crewhaus/run/control-token` contents (built from parts by callers —
   *  never a realistic-shaped literal in a fixture). */
  readonly controlToken?: string;
  /** `approvals.jsonl` lines beside the session files. */
  readonly approvals?: readonly unknown[];
  /** `.crewhaus/review/queue.jsonl` lines. */
  readonly reviewQueue?: readonly unknown[];
  /** `.crewhaus/deployments.json` (F-6 — read-only; nothing writes it yet). */
  readonly deployments?: unknown;
  /** `.crewhaus/retention.json`. */
  readonly retention?: unknown;
  /** `.crewhaus/incidents/<name>/` directories. */
  readonly incidents?: readonly string[];
  /** `.crewhaus/specs/<name>/CHANGELOG.md` bodies. */
  readonly specChangelogs?: Readonly<Record<string, string>>;
  /** A compiled bundle at `dist/`: the entry file plus, optionally, the
   *  F-5 spec-hash-stamped `package.json`. */
  readonly bundle?: {
    readonly entry: string;
    readonly body?: string;
    /** Omit for a pre-F-5 (unstamped) bundle. */
    readonly specHash?: string;
    readonly compiledWith?: string;
  };
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

  // -- M2: the harness-local ops tree the process layer owns ---------------

  if (
    opts.runLedger !== undefined ||
    opts.runLogs !== undefined ||
    opts.runfile !== undefined ||
    opts.controlToken !== undefined
  ) {
    const runRoot = join(ch, "run");
    mkdirSync(join(runRoot, "logs"), { recursive: true });
    if (opts.runLedger !== undefined) {
      writeFileSync(join(runRoot, "runs.jsonl"), jsonl(opts.runLedger), { mode: 0o600 });
    }
    if (opts.runfile !== undefined) {
      writeFileSync(join(runRoot, "daemon.json"), `${JSON.stringify(opts.runfile, null, 2)}\n`, {
        mode: 0o600,
      });
    }
    if (opts.controlToken !== undefined) {
      writeFileSync(join(runRoot, "control-token"), `${opts.controlToken}\n`, { mode: 0o600 });
    }
    for (const run of opts.runLogs ?? []) {
      if (run.log !== undefined) {
        writeFileSync(join(runRoot, "logs", `${run.runId}.log`), run.log, { mode: 0o600 });
      }
      if (run.events !== undefined) {
        writeFileSync(join(runRoot, "logs", `${run.runId}.events.jsonl`), jsonl(run.events), {
          mode: 0o600,
        });
      }
    }
  }

  // Approvals live BESIDE the session files, so a relocated session root
  // relocates them too — the fixture writes them where the default root is.
  if (opts.approvals !== undefined) {
    writeFileSync(join(sessionsDir, "approvals.jsonl"), jsonl(opts.approvals), { mode: 0o600 });
  }

  if (opts.reviewQueue !== undefined) {
    const reviewDir = join(ch, "review");
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(join(reviewDir, "queue.jsonl"), jsonl(opts.reviewQueue), { mode: 0o600 });
  }

  if (opts.deployments !== undefined) {
    writeFileSync(join(ch, "deployments.json"), `${JSON.stringify(opts.deployments, null, 2)}\n`);
  }

  if (opts.retention !== undefined) {
    writeFileSync(join(ch, "retention.json"), `${JSON.stringify(opts.retention, null, 2)}\n`);
  }

  for (const name of opts.incidents ?? []) {
    mkdirSync(join(ch, "incidents", name), { recursive: true });
    writeFileSync(join(ch, "incidents", name, "report.md"), `# ${name}\n`);
  }

  for (const [name, body] of Object.entries(opts.specChangelogs ?? {})) {
    mkdirSync(join(ch, "specs", name), { recursive: true });
    writeFileSync(join(ch, "specs", name, "CHANGELOG.md"), body);
  }

  if (opts.bundle !== undefined) {
    const distDir = join(dir, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, opts.bundle.entry), opts.bundle.body ?? "// compiled bundle\n");
    if (opts.bundle.specHash !== undefined) {
      // The F-5 stamp, exactly as `crewhaus compile` writes it. Omitting it
      // is how a test synthesizes a pre-F-5 ("unstamped") bundle.
      writeFileSync(
        join(distDir, "package.json"),
        `${JSON.stringify(
          {
            name: "crewhaus-compiled-bundle",
            version: "0.0.0",
            crewhaus: {
              specHash: opts.bundle.specHash,
              ...(opts.bundle.compiledWith !== undefined
                ? { compiledWith: opts.bundle.compiledWith }
                : {}),
            },
          },
          null,
          2,
        )}\n`,
      );
    }
  }

  return dir;
}
