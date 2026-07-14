import { spawnSync } from "node:child_process";
/**
 * v0.3.0 PR 14 (design §6.3) — the `crewhaus dream run|status|init` verbs.
 *
 * Kept in a side-effect-free module (the CLI entry file runs an argv switch
 * on import), mirroring `retention.ts` / `memory-cli.ts`: `index.ts` holds
 * only the dispatch registration.
 *
 *   - `run`    — both phases per the spec's `memory.dream` (mode/budget):
 *                the deterministic pass always; then, for `mode: full` with
 *                `budget_usd > 0`, ONE bounded model synthesis session
 *                (`sessionTarget: "dream"`, singleTurn, capped tool loop,
 *                item-27 budget option). CRON-SAFE: runs are idempotency-
 *                keyed on the schedule window, so a cron, a daemon janitor
 *                tick, and a manual invocation can never double-fire.
 *   - `status` — schedule state + next due, from
 *                `.crewhaus/dream/<spec>/state.json`.
 *   - `init`   — scaffolds `.github/workflows/crewhaus-dream.yml` (odd-
 *                minute cron convention) via ci-scaffold.
 *
 * The model-phase runner built here is the REFERENCE implementation of
 * dream-engine's `DreamModelPhase` seam: the daemon emitters generate the
 * same shape. `buildDreamModelPhase` takes an injectable `chatLoop` so
 * tests can pin the exact runChatLoop options (budget mapping included)
 * without a model call.
 */
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lower } from "@crewhaus/compiler";
import { createCostTracker } from "@crewhaus/cost-tracker";
import { CrewhausError } from "@crewhaus/errors";
import { openEventLog } from "@crewhaus/event-log";
import type { ParseArgsSchema, ParsedArgs } from "@crewhaus/infra-utils";
import {
  type DreamModelPhase,
  type DreamRunReport,
  type MemoryWiringFragment,
  memoryFragmentFromIr,
  wireDream,
  wireMemory,
} from "@crewhaus/memory-service";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import { parseSpec } from "@crewhaus/spec";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { DREAM_WORKFLOW_RELPATH, buildDreamWorkflowYaml } from "./ci-scaffold";
import { scaffoldWorkflowFile } from "./flywheel";

export class DreamCliError extends CrewhausError {
  override readonly name = "DreamCliError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export const DREAM_CLI_SCHEMA: ParseArgsSchema = {
  flags: [
    // Bypass the window idempotency (the run still takes the lock and
    // records its outcome) — for operators re-running after fixing config.
    { name: "force" },
    // `init`: overwrite an existing workflow scaffold.
    { name: "help", short: "h" },
  ],
};

const DREAM_USAGE =
  "usage: crewhaus dream [run|status|init] <spec.yaml> [--force]\n" +
  "  run     both phases per the spec's memory.dream (cron-safe: window-idempotent)\n" +
  "  status  schedule state + next due (.crewhaus/dream/<spec>/state.json)\n" +
  "  init    scaffold .github/workflows/crewhaus-dream.yml (odd-minute cron)\n" +
  "  --force run: bypass the window idempotency · init: overwrite the workflow\n";

// ---------------------------------------------------------------------------
// spec loading
// ---------------------------------------------------------------------------

/** The memory/continuity slice shared by the carrying IR variants (the
 *  union doesn't expose the optional fields — same structural view the
 *  compiler tests use). */
type FabricIr = {
  readonly name: string;
  readonly agent?: { readonly model: string };
  readonly memory?: {
    readonly enabled?: boolean;
    readonly dream?: {
      readonly everyMs: number;
      readonly mode: "deterministic" | "full";
      readonly budgetUsd?: number;
      readonly instructions?: string;
    };
  };
  readonly continuity?: { readonly scope: "spec" | "session" };
};

function loadDreamSpec(specPath: string | undefined): {
  ir: FabricIr;
  fragment: MemoryWiringFragment;
  absSpec: string;
} {
  if (specPath === undefined || specPath === "") {
    throw new DreamCliError(`crewhaus dream: missing <spec.yaml> argument\n${DREAM_USAGE}`);
  }
  const absSpec = resolve(specPath);
  let yamlText: string;
  try {
    yamlText = readFileSync(absSpec, "utf-8");
  } catch (err) {
    throw new DreamCliError(
      `crewhaus dream: cannot read spec "${specPath}": ${(err as Error).message}`,
    );
  }
  const ir = lower(parseSpec(yamlText)) as unknown as FabricIr;
  if (ir.memory?.dream === undefined || ir.memory.enabled === false) {
    throw new DreamCliError(
      `crewhaus dream: spec "${ir.name}" declares no memory.dream schedule — add\n  memory:\n    dream:\n      every: 24h\n      mode: full\n      budget_usd: 0.5\nand recompile. (mode: deterministic / budget_usd: 0 keep the pass model-free.)`,
    );
  }
  // The dream always consolidates the SPEC-scoped agenda (§14.5) — override
  // a session-scoped continuity (channel) so the store wiring never needs a
  // conversation id.
  const raw = memoryFragmentFromIr(ir);
  const fragment: MemoryWiringFragment =
    raw.continuity !== undefined
      ? { ...raw, continuity: { ...raw.continuity, scope: "spec" } }
      : raw;
  return { ir, fragment, absSpec };
}

// ---------------------------------------------------------------------------
// the model phase (the DreamModelPhase reference implementation)
// ---------------------------------------------------------------------------

/** The exact runChatLoop option subset the dream session uses — a dedicated
 *  type so tests can inject a capturing `chatLoop` and pin every field. */
export type DreamChatLoopOptions = {
  readonly model: string;
  readonly instructions: string;
  readonly runContext: RunContext;
  readonly singleTurn: true;
  readonly seedMessages: ReadonlyArray<{ readonly role: "user"; readonly content: string }>;
  readonly sessionName: string;
  readonly sessionTarget: "dream";
  readonly tools: ReadonlyArray<RegisteredTool>;
  readonly hooks: ReadonlyArray<never>;
  readonly maxToolIterations: number;
  readonly budget: {
    readonly usdMicros: number;
    readonly onExceed: { readonly kind: "stop" };
  };
  readonly spinner: false;
};

export type DreamChatLoopFn = (opts: DreamChatLoopOptions) => Promise<string>;

/**
 * Build the model-phase runner (§6.2): ONE bounded fresh session seeded
 * with the playbook + phase-1 findings, seeing ONLY the memory-fabric
 * tools (wired fresh, spec scope), capped by the item-27 budget option
 * (`budget_usd` → usdMicros, `onExceed: stop`) and the tool-iteration
 * bound. Spend is observed with a cost-tracker on the run's own trace bus.
 */
export function buildDreamModelPhase(opts: {
  readonly model: string;
  readonly specName: string;
  readonly fragment: MemoryWiringFragment;
  readonly cwd: string;
  readonly chatLoop?: DreamChatLoopFn;
}): DreamModelPhase {
  const chatLoop: DreamChatLoopFn = opts.chatLoop ?? runChatLoop;
  return {
    model: opts.model,
    run: async (input) => {
      const tools: RegisteredTool[] = [];
      await wireMemory(opts.fragment, {
        catalog: {
          register: (t: RegisteredTool) => {
            tools.push(t);
          },
        },
        cwd: opts.cwd,
      });
      const runContext = createRunContext();
      const tracker = createCostTracker(runContext.eventBus, { suppressEvents: true });
      try {
        const summary = await chatLoop({
          model: opts.model,
          instructions: input.playbook,
          runContext,
          singleTurn: true,
          seedMessages: [{ role: "user", content: input.prompt }],
          sessionName: opts.specName,
          sessionTarget: "dream",
          tools,
          hooks: [],
          maxToolIterations: input.maxToolIterations,
          budget: {
            usdMicros: Math.round(input.budgetUsd * 1_000_000),
            onExceed: { kind: "stop" },
          },
          spinner: false,
        });
        return {
          sessionId: runContext.sessionId,
          spentUsd: tracker.getRunCost(runContext.runId).totalUsdMicros / 1_000_000,
          summary,
        };
      } finally {
        tracker.unsubscribe();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// rendering (the §6.3 output shape)
// ---------------------------------------------------------------------------

function shortIso(iso: string): string {
  return `${iso.slice(0, 16)}Z`;
}

function renderEvery(ms: number): string {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  const MINUTE = 60_000;
  if (ms % DAY === 0) return `${ms / DAY}d`;
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms % MINUTE === 0) return `${ms / MINUTE}m`;
  return `${Math.round(ms / 1000)}s`;
}

function line(label: string, detail: string): string {
  return `    ✓ ${label.padEnd(18)} ${detail}`;
}

/** Render a run report in the design-§6.3 shape. Exported for tests. */
export function renderDreamRunReport(report: DreamRunReport): string[] {
  const c = report.phase1.counts;
  const lines: string[] = [`crewhaus dream — ${report.specName}`];
  if (report.cached) {
    lines.push(
      `  window ${report.windowKey} already consolidated (cached report from ${shortIso(report.startedAt)})`,
    );
  }
  lines.push("  deterministic");
  lines.push(
    line(
      "session summaries",
      c.sessionsIndexed === 0 ? "nothing new to index" : `${c.sessionsIndexed} sessions → indexed`,
    ),
  );
  lines.push(
    line("fact dedupe", `${c.factsBefore} → ${c.factsAfter} (${c.factsSuperseded} superseded)`),
  );
  lines.push(
    line("fact decay", `${c.factsStale} fact${c.factsStale === 1 ? "" : "s"} >90d flagged stale`),
  );
  lines.push(
    line(
      "proof freeze",
      `${c.proofsChecked} checked · ${c.sessionsPinned} session${c.sessionsPinned === 1 ? "" : "s"} pinned before TTL`,
    ),
  );
  lines.push(
    line("wiki staleness", `${c.wikiStale} article${c.wikiStale === 1 ? "" : "s"} unverified >30d`),
  );
  lines.push(
    line(
      "focus refresh",
      `next-actions rebuilt from ${c.openPlans} open plan${c.openPlans === 1 ? "" : "s"}`,
    ),
  );
  lines.push(
    line(
      "trash purge",
      `${c.trashPurged} snapshot${c.trashPurged === 1 ? "" : "s"} past the 7d undo window`,
    ),
  );

  const model = report.model;
  if (model === undefined) {
    lines.push("  model              (mode deterministic — no model phase)");
  } else if (model.ran) {
    lines.push(`  model (${model.model} · cap $${model.budgetUsd.toFixed(2)})`);
    if (model.actions.length === 0) {
      lines.push("    (no tool mutations — the session found nothing to consolidate)");
    }
    for (const action of model.actions) {
      lines.push(
        `    ✓ ${action.toolName}${action.detail !== undefined ? ` ${action.detail}` : ""}`,
      );
    }
  } else if (model.refusal !== undefined) {
    lines.push(`  model (${model.model}) REFUSED — ${model.refusal}`);
  } else if (model.error !== undefined) {
    lines.push(`  model (${model.model}) FAILED — ${model.error} (window not consumed; retries)`);
  } else {
    lines.push(`  model              skipped — ${model.skipped ?? "deterministic only"}`);
  }

  const seconds = report.durationMs / 1000;
  const spent = model?.ran === true && model.spentUsd !== undefined ? model.spentUsd : undefined;
  lines.push(
    `  done in ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()}s` +
      `${spent !== undefined ? ` · spent $${spent.toFixed(2)}` : ""}` +
      ` · next due ${shortIso(report.nextDueAt)}`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// verbs
// ---------------------------------------------------------------------------

async function runVerb(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const { ir, fragment } = loadDreamSpec(args.positional[0]);
  const model = ir.agent?.model;
  const modelPhase =
    model !== undefined
      ? buildDreamModelPhase({ model, specName: ir.name, fragment, cwd })
      : undefined;

  const sessionRootDir = join(cwd, ".crewhaus", "sessions");
  const wired = wireDream(fragment, {
    cwd,
    ...(modelPhase !== undefined ? { modelPhase } : {}),
    // The dream_run proof record lands in the dream session's own log when
    // the model phase ran (state.json is the durable record otherwise).
    appendEvent: async (event) => {
      const sessionId = (event.payload as { sessionId?: unknown }).sessionId;
      if (typeof sessionId !== "string") return;
      const log = await openEventLog(sessionId, { rootDir: sessionRootDir });
      await log.append({ kind: "dream_run", payload: event.payload });
      await log.close();
    },
    log: (lineText) => process.stderr.write(`${lineText}\n`),
  });
  if (wired === null) {
    throw new DreamCliError(`crewhaus dream: spec "${ir.name}" has no dream schedule`);
  }
  if (model === undefined) {
    process.stderr.write(
      "[dream] this shape has no single agent model — running the deterministic phase only\n",
    );
  }

  const report = await wired.engine.run({
    trigger: "cli",
    ...(args.flags["force"] === true ? { force: true } : {}),
  });
  for (const lineText of renderDreamRunReport(report)) {
    process.stdout.write(`${lineText}\n`);
  }
  // A refusal or model failure exits non-zero AFTER the report renders —
  // scheduled runs must alert (the deterministic pass still completed).
  if (report.outcome === "model_refused_unpriced") {
    throw new DreamCliError(report.model?.refusal ?? "dream: unpriced model refused");
  }
  if (report.outcome === "model_failed") {
    throw new DreamCliError(
      `dream: model phase failed — ${report.model?.error ?? "unknown error"} (deterministic pass completed; the window was not consumed, so the next scheduled run retries)`,
    );
  }
}

async function statusVerb(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const { ir, fragment } = loadDreamSpec(args.positional[0]);
  const wired = wireDream(fragment, { cwd });
  if (wired === null) {
    throw new DreamCliError(`crewhaus dream: spec "${ir.name}" has no dream schedule`);
  }
  const status = await wired.engine.status();
  const cfg = status.config;
  const lines = [
    `crewhaus dream — ${ir.name}`,
    `  every ${renderEvery(cfg.everyMs)} · mode ${cfg.mode} · budget $${cfg.budgetUsd.toFixed(2)}`,
    `  state ${join(wired.engine.stateDir(), "state.json")}`,
  ];
  if (status.state === null) {
    lines.push("  never run — overdue (a boot catch-up or 'crewhaus dream run' will start it)");
  } else {
    lines.push(`  last run ${shortIso(status.state.lastRunAt)} (${status.state.lastOutcome})`);
    lines.push(
      status.overdue
        ? "  next due now (overdue)"
        : `  next due ${shortIso(status.nextDueAt ?? status.state.lastRunAt)}`,
    );
    if (status.state.lastEvidence.length > 0) {
      lines.push(`  last evidence ${status.state.lastEvidence.join(", ")}`);
    }
  }
  for (const lineText of lines) {
    process.stdout.write(`${lineText}\n`);
  }
}

/** Finding 7 (mirrors index.ts's resolveWorkflowRoot, which is private to
 *  the dispatch module): GitHub only reads workflows at the repo root. */
function workflowRootFor(
  harnessAbsDir: string,
  fallbackRoot: string,
): {
  root: string;
  harnessDir: string;
} {
  const top = spawnSync("git", ["-C", harnessAbsDir, "rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  });
  const toplevel = top.status === 0 ? top.stdout.trim() : "";
  const root = toplevel !== "" ? toplevel : realpathSync(fallbackRoot);
  const rel = relative(root, realpathSync(harnessAbsDir));
  if (rel === "" || rel === ".") return { root, harnessDir: "" };
  if (rel.startsWith("..") || isAbsolute(rel)) return { root: harnessAbsDir, harnessDir: "" };
  return { root, harnessDir: rel.split(sep).join("/") };
}

async function initVerb(args: ParsedArgs): Promise<void> {
  const { ir, absSpec } = loadDreamSpec(args.positional[0]);
  const dream = ir.memory?.dream;
  if (dream === undefined) throw new DreamCliError("unreachable: loadDreamSpec guarantees dream");
  const { root, harnessDir } = workflowRootFor(dirname(absSpec), process.cwd());
  const specPathInWorkflow = relative(harnessDir === "" ? root : join(root, harnessDir), absSpec)
    .split(sep)
    .join("/");
  const scaffolded = scaffoldWorkflowFile({
    rootDir: root,
    relPath: DREAM_WORKFLOW_RELPATH,
    content: buildDreamWorkflowYaml({
      specPath: specPathInWorkflow,
      everyMs: dream.everyMs,
      ...(harnessDir !== "" ? { harnessDir } : {}),
    }),
    force: args.flags["force"] === true,
  });
  process.stdout.write(`wrote ${scaffolded.path}\n`);
  process.stdout.write(
    `  cron: ${dream.everyMs < 86_400_000 ? '"19 * * * *" (hourly — sub-daily cadence)' : '"19 4 * * *" (nightly)'} · window idempotency dedupes over-fires\n  next: commit the workflow and add the ANTHROPIC_API_KEY repo secret\n        (the model phase is capped at $${(dream.budgetUsd ?? 0).toFixed(2)} per run by memory.dream.budget_usd)\n`,
  );
}

/** The `crewhaus dream` dispatch target — `index.ts` routes here. */
export async function runDreamCommand(
  args: ParsedArgs,
  action: "run" | "status" | "init",
): Promise<void> {
  if (args.flags["help"] === true) {
    process.stdout.write(DREAM_USAGE);
    return;
  }
  if (action === "run") return runVerb(args);
  if (action === "status") return statusVerb(args);
  return initVerb(args);
}
