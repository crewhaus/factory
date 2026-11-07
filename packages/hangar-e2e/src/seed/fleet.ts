/**
 * The seeded fleet: one harness for each shape the console knows, written by the
 * real store libraries wherever one exists. Everything is derived from `seed` and
 * `now`, so seeding twice at one path gives the same bytes.
 *
 * `makeFixtureHarness` writes the spec and the ops tree, which have no writer
 * library. A record whose store mints a random id with no seam also goes through
 * it, and each such place says so below.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { feedbackRecord, logLine, makeFixtureHarness } from "@crewhaus/hangar-server";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { createMemoryStore } from "@crewhaus/memory-store";
import { createSessionStore } from "@crewhaus/session-store";
import { createWikiStore } from "@crewhaus/wiki-store";
import { loadConsoleGrammar } from "../console-routes";
import { sandboxEnv } from "../system";

/**
 * Script that must stay text wherever the console shows outside content, and a
 * markdown link that would run if a renderer trusted its target.
 */
export const MARKUP_PAYLOAD =
  '<img src=x onerror="globalThis.__e2eSentinel=1"><script>globalThis.__e2eSentinel=2</script> [click me](javascript:globalThis.__e2eSentinel=3)';
/** What proves the payload arrived on screen, as characters. */
export const MARKUP_VISIBLE = "<img src=x";

export type SeedFleetOptions = {
  readonly seed: string;
  /** Epoch ms that every record is stamped with. */
  readonly now: number;
  /** The shapes to seed; every shape the console knows when absent. */
  readonly shapes?: readonly string[];
  /** Plant the untrusted payload in every field that holds outside text. */
  readonly markup?: boolean;
  /** Added to every harness's spec and `.env`. */
  readonly specExtra?: string;
  readonly envLines?: readonly string[];
  /**
   * Seed what the accessibility journeys need on screen: three pending
   * approvals (a keyboard tour spends two grants and needs one left to hold
   * focus), an open review item, an eval history below its pinned baseline
   * (the charts, the trend, an Advisor item to explain), a spec registry
   * with one archived version (the version dialogs open from its row), and,
   * for the cli shape, a stand-in compiled bundle, so a start can be planned
   * on a machine with no `crewhaus` CLI installed (a journey answers the
   * start itself; nothing is ever spawned). Off by default, so every other
   * journey's fleet is unchanged.
   */
  readonly rich?: boolean;
};

/** The tools the rich seed's approvals ask for, in order. */
export const RICH_APPROVAL_TOOLS = ["Bash", "SendMessage", "Fetch"] as const;
/** The archived spec version the rich seed registers. */
export const RICH_SPEC_VERSION = "1.0.0";

export type SeededHarness = {
  readonly id: string;
  readonly dir: string;
  readonly target: string;
  readonly specName: string;
  readonly sessionIds: readonly string[];
  readonly wikiSlug: string;
  readonly runId: string;
  /** The rich seed's pending approval ids, oldest first; empty otherwise. */
  readonly approvalIds: readonly string[];
  /** The rich seed's open review item id, or null. */
  readonly reviewId: string | null;
};

const DAY_MS = 86_400_000;

/** The rich seed's records for one harness, as `makeFixtureHarness` options. */
function richRecords(
  seed: string,
  target: string,
  specName: string,
  sessionId: string,
  runId: string,
  now: number,
  model: string,
) {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const approvalIds = RICH_APPROVAL_TOOLS.map(
    (_tool, i) => `appr_${hexFor(seed, target, "approval", String(i))}`,
  );
  const approvals = RICH_APPROVAL_TOOLS.map((toolName, i) => ({
    id: approvalIds[i],
    toolName,
    inputHash: `hash-${hexFor(seed, target, "approval-input", String(i))}`,
    input:
      toolName === "Bash"
        ? { command: "ls -la" }
        : toolName === "SendMessage"
          ? { channel: "ops", text: "ship it" }
          : { url: "https://example.invalid/status" },
    runId,
    sessionId,
    surface: "daemon",
    createdAt: iso(now - (3 - i) * 60_000),
  }));
  const reviewId = `rev_rater_disagreement_${sessionId}_t1`;
  const reviewQueue = [
    {
      schemaVersion: 1,
      id: reviewId,
      kind: "rater_disagreement",
      sourceRef: { sessionId, turn: 1 },
      ts: iso(now - 60_000),
      status: "open",
      context: "split verdict — a: up, b: down",
    },
  ];
  // Newest last, and the newest below the pinned baseline, so the Advisor
  // has an eval item whose quick action queues the optimize loop.
  const rates = [0.9, 0.7, 0.4];
  const evalRunIds = rates.map((_rate, i) => `run_${hexFor(seed, target, "eval", String(i))}`);
  const evalIndex = rates.map((passRate, i) => ({
    runId: evalRunIds[i],
    specName,
    specHash: "h",
    datasetName: "smoke",
    datasetHash: "d",
    passRate,
    meanScore: passRate,
    sampleCount: 2,
    ts: iso(now - (rates.length - i) * DAY_MS),
    outDir: "/gone",
  }));
  const baselines = {
    [`${specName}::smoke`]: {
      specName,
      datasetName: "smoke",
      runId: evalRunIds[0],
      outDir: "/gone",
      datasetHash: "d",
      ts: iso(now - rates.length * DAY_MS),
    },
  };
  const specRegistry = {
    dirName: specName,
    manifest: { versions: [RICH_SPEC_VERSION], pins: {} },
    versions: {
      [RICH_SPEC_VERSION]: `name: ${specName}\ntarget: ${target}\nagent:\n  model: ${model}\n`,
    },
  };
  // Never run: the journeys that press Start answer the request themselves.
  const bundle = target === "cli" ? { bundle: { entry: "agent.ts", body: "// stand-in\n" } } : {};
  return {
    approvalIds,
    reviewId,
    options: { approvals, reviewQueue, evalIndex, baselines, specRegistry, ...bundle },
  };
}

export type Fleet = {
  readonly dir: string;
  readonly registryRoot: string;
  /** The server's and any child's base environment: never `process.env`. */
  readonly env: Readonly<Record<string, string>>;
  readonly harnesses: readonly SeededHarness[];
};

const hexFor = (seed: string, ...parts: readonly string[]): string =>
  createHash("sha256")
    .update([seed, ...parts].join("\0"))
    .digest("hex")
    .slice(0, 16);

/** Seed a fleet under `dir`, and register it. */
export async function seedFleet(dir: string, opts: SeedFleetOptions): Promise<Fleet> {
  const shapes = opts.shapes ?? (await loadConsoleGrammar()).shapeTargets;
  const env = sandboxEnv(dir);
  const registryRoot = join(dir, "registry");
  const nowDate = (): Date => new Date(opts.now);
  // The same environment as the server, or registering would touch the real
  // watch-me store through the registry's write-through.
  const registry = openHangarRegistry({ root: registryRoot, env, now: () => opts.now });
  const harnesses: SeededHarness[] = [];

  for (const target of shapes) {
    const harnessDir = join(dir, "harnesses", target);
    const specName = `fleet-${target}`;
    const untrusted = (plain: string): string =>
      opts.markup === true ? `${plain} ${MARKUP_PAYLOAD}` : plain;
    const iso = new Date(opts.now).toISOString();
    const sessionId = `sess_${hexFor(opts.seed, target, "session")}`;
    const runId = `run_${hexFor(opts.seed, target, "run")}`;
    const memoryId = `mem_${hexFor(opts.seed, target, "memory")}`;
    const wikiSlug = "getting-started";
    const wikiBody = `${untrusted("How this harness is run.")}\n`;
    const model = "claude-opus-5";

    mkdirSync(harnessDir, { recursive: true });
    const rich =
      opts.rich === true
        ? richRecords(opts.seed, target, specName, sessionId, runId, opts.now, model)
        : null;
    makeFixtureHarness(harnessDir, {
      ...(rich !== null ? rich.options : {}),
      specName,
      target,
      model,
      ...(opts.specExtra !== undefined ? { specExtra: opts.specExtra } : {}),
      // Built from parts: a test value that only ever reaches loopback fakes.
      envLines: [
        `ANTHROPIC_API_KEY=${["sk", "ant", "seed", hexFor(opts.seed, target, "key")].join("-")}`,
        ...(opts.envLines ?? []),
      ],
      // The session log's writer is the runtime's event log, which a seed has no
      // seam for, so the log goes through the fixture option. The record beside
      // it is rewritten by the real store below.
      sessions: [
        {
          id: sessionId,
          log: [
            logLine("user_message", { content: untrusted("What should I do first?") }, iso),
            logLine("assistant_message", { content: untrusted("Start with the spec.") }, iso),
            logLine(
              "cost_accrual",
              { provider: "anthropic", modelId: model, costUsdMicros: 1200 },
              iso,
            ),
          ],
        },
      ],
      // The memory store mints its ids with Math.random and has no seam for them,
      // so its entries go through the fixture option. They are read back through
      // the real store below, which holds this to the format that store writes.
      memories: {
        [specName]: [
          {
            id: memoryId,
            text: untrusted("The operator prefers short answers."),
            tags: ["seed"],
            createdAt: iso,
            schemaVersion: 2,
          },
        ],
      },
      feedback: {
        seed: [
          {
            ...(feedbackRecord(sessionId, 1, "up", iso) as Record<string, unknown>),
            comment: untrusted("Helpful."),
          },
        ],
      },
      runLedger: [
        {
          runId,
          kind: "daemon",
          argv: ["bun", "dist/daemon.ts"],
          startedAt: iso,
          logFile: `logs/${runId}.log`,
        },
        { runId, endedAt: iso, exitCode: 0 },
      ],
      runLogs: [{ runId, log: `${untrusted("booted")}\n`, events: [] }],
      focus: `${untrusted("Ship the first version.")}\n`,
      goals: `goals:\n  - ${JSON.stringify(untrusted("Answer every question."))}\n`,
    });

    if (rich !== null) {
      // The Advisor's eval action can only queue what the harness can run.
      mkdirSync(join(harnessDir, "eval"), { recursive: true });
      writeFileSync(join(harnessDir, "eval", "dataset.jsonl"), '{"id":"a","input":"x"}\n');
      writeFileSync(join(harnessDir, "eval", "graders.yaml"), "graders: []\n");
    }

    const sessions = createSessionStore({
      rootDir: join(harnessDir, ".crewhaus", "sessions"),
      now: nowDate,
    });
    await sessions.create({
      id: sessionId,
      name: untrusted("First conversation"),
      target,
      model,
    });

    const wiki = createWikiStore({
      specName,
      rootDir: join(harnessDir, ".crewhaus", "wiki"),
      now: nowDate,
    });
    await wiki.write({
      slug: wikiSlug,
      title: untrusted("Getting started"),
      body: wikiBody,
      tags: ["seed"],
    });

    const memory = createMemoryStore({
      specName,
      rootDir: join(harnessDir, ".crewhaus", "memories"),
      now: nowDate,
    });
    const memories = await memory.list();
    if (memories.length !== 1 || memories[0]?.entry.id !== memoryId) {
      throw new Error(`the memory store did not read back the seeded entry for ${specName}`);
    }

    const entry = registry.upsert({ dir: harnessDir, specName, target });
    harnesses.push({
      id: entry.id,
      dir: harnessDir,
      target,
      specName,
      sessionIds: [sessionId],
      wikiSlug,
      runId,
      approvalIds: rich?.approvalIds ?? [],
      reviewId: rich?.reviewId ?? null,
    });
  }

  return { dir, registryRoot, env, harnesses };
}

function walk(dir: string, prefix: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    const path = join(dir, name);
    if (lstatSync(path).isDirectory()) walk(path, relative, out);
    else out.push(relative);
  }
}

/** The sha256 of a directory: every relative path, sorted, and its bytes. */
export function digestTree(dir: string): string {
  const files: string[] = [];
  walk(dir, "", files);
  const hash = createHash("sha256");
  for (const relative of files) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(join(dir, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** One digest per harness directory. The Hangar root's cache is outside the fleet. */
export function digestFleet(fleet: Fleet): Readonly<Record<string, string>> {
  return Object.fromEntries(
    fleet.harnesses.map((harness) => [harness.target, digestTree(harness.dir)]),
  );
}
