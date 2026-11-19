/**
 * Fixture harnesses for the attention tests, written through the real writers and minters:
 * approvals through session-store's store (its `generateApprovalId`), `dec_` rows and run
 * rows through control-records' `append` with `mintId`/`mintRunId`, review entries with
 * `reviewEntryId`. A facts port that reads a harness's own `.env` stands in for the env
 * chain helper Home and the CLI use.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintId, mintRunId } from "@crewhaus/control-contract";
import { append, decisionsLedger, runsLedger } from "@crewhaus/control-records";
import {
  type ReviewQueueEntry,
  enqueueReviewEntries,
  reviewEntryId,
} from "@crewhaus/feedback-distill";
import {
  createPendingApprovalStore,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import type { AdvisorSnapshot, HarnessFacts } from "../types";

export const NOW = Date.parse("2026-11-10T12:00:00.000Z");
export const iso = (ms: number): string => new Date(ms).toISOString();
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function tempRoot(): { readonly root: string; readonly cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "attention-")));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function harnessDir(root: string, name: string, model = "claude-opus-5"): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".crewhaus", "sessions"), { recursive: true });
  writeFileSync(
    join(dir, "crewhaus.yaml"),
    `name: ${name}\ntarget: cli\nagent:\n  model: ${model}\n  instructions: help\n`,
  );
  return dir;
}

/** Park one request through the store's own writer; answers its id. */
export async function park(
  dir: string,
  opts: {
    readonly tool?: string;
    readonly input?: unknown;
    readonly at?: number;
    readonly runId?: string;
    readonly sessionId?: string;
    readonly askDigest?: string;
    readonly kind?: "tool" | "input";
    readonly requiredClass?: "operator" | "maintainer" | "owner";
  } = {},
): Promise<string> {
  const at = opts.at ?? NOW - 10 * MIN;
  const store = createPendingApprovalStore({
    rootDir: join(dir, ".crewhaus", "sessions"),
    now: () => new Date(at),
  });
  const id = generateApprovalId();
  const tool = opts.tool ?? "Bash";
  const input = opts.input ?? { command: "ls" };
  await store.persist({
    id,
    toolName: tool,
    inputHash: hashApprovalInput(tool, input),
    input,
    runId: opts.runId ?? mintRunId({ now: at }),
    sessionId: opts.sessionId ?? `sess_${"a".repeat(16)}`,
    surface: "daemon",
    createdAt: iso(at),
    ...(opts.askDigest !== undefined ? { askDigest: opts.askDigest } : {}),
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    ...(opts.requiredClass !== undefined ? { requiredClass: opts.requiredClass } : {}),
  } as never);
  return id;
}

/** Decide one request through the store. */
export async function decide(
  dir: string,
  id: string,
  choice: "grant" | "deny",
  at: number,
): Promise<void> {
  const store = createPendingApprovalStore({
    rootDir: join(dir, ".crewhaus", "sessions"),
    now: () => new Date(at),
  });
  await store.resolve(id, choice, "ana", { via: "cli" });
}

/** One `dec_` request to the owner for a standing rule; answers its id. */
export function proposal(
  dir: string,
  opts: { readonly at?: number; readonly delegate?: string } = {},
): string {
  const at = opts.at ?? NOW - HOUR;
  const id = mintId("dec", { now: at });
  const terms =
    opts.delegate !== undefined
      ? { ruleKind: "delegate", action: opts.delegate, terms: { days: 7 }, days: 7 }
      : { ruleKind: "allow", tool: "Bash", pattern: "ls *", expiresAt: iso(at + 30 * DAY) };
  const answer = append(decisionsLedger(dir), {
    id,
    kind: "standing-rule-proposal",
    state: "pending",
    createdAt: iso(at),
    expiresAt: iso(at + 7 * DAY),
    requiredClass: "owner",
    proposedBy: "local:#0123456789abcdef",
    ...(opts.delegate === undefined ? { derivedFrom: `appr_${"b".repeat(16)}` } : {}),
    terms,
  });
  if (!answer.ok) throw new Error(answer.reason);
  return id;
}

/** One run that ran and ended `state` (with `failureClass` when failed); answers its id. */
export function run(
  dir: string,
  opts: {
    readonly at: number;
    readonly state: "succeeded" | "failed";
    readonly failureClass?: string;
    readonly session?: string;
  },
): string {
  const id = mintRunId({ now: opts.at });
  const ledger = runsLedger(dir);
  const trigger = { kind: "api" };
  const session = opts.session ?? `sess_${"c".repeat(16)}`;
  const started = append(ledger, {
    id,
    state: "running",
    at: iso(opts.at - 1000),
    trigger,
    session,
  });
  if (!started.ok) throw new Error(started.reason);
  const ended = append(ledger, {
    id,
    state: opts.state,
    at: iso(opts.at),
    trigger,
    ...(opts.failureClass !== undefined ? { failureClass: opts.failureClass } : {}),
  });
  if (!ended.ok) throw new Error(ended.reason);
  return id;
}

/** One open review entry; answers its id. */
export function review(dir: string, at = NOW - 2 * HOUR, sampleId = "s1"): string {
  const ref = { runId: "run_00000000000000aa", sampleId };
  const id = reviewEntryId("abstained", ref);
  const entry: ReviewQueueEntry = {
    schemaVersion: 1,
    id,
    kind: "abstained",
    sourceRef: ref,
    ts: iso(at),
    status: "open",
    context: "the sample asked about refunds",
  };
  enqueueReviewEntries(dir, [entry]);
  return id;
}

/** A `run_failed` event in a session log. */
export function failure(
  dir: string,
  session: string,
  cls: string,
  message: string,
  at: number,
): void {
  const file = join(dir, ".crewhaus", "sessions", `${session}.jsonl`);
  const line = JSON.stringify({ kind: "run_failed", ts: at, payload: { class: cls, message } });
  writeFileSync(file, `${existsSync(file) ? readFileSync(file, "utf8") : ""}${line}\n`);
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (m !== null) out[m[1] as string] = (m[2] as string).trim();
  }
  return out;
}

/** A facts port over a harness's own `.env`, with `processEnv` standing for the process. */
export function testFacts(
  processEnv: Readonly<Record<string, string>> = {},
  snapshots: ReadonlyMap<string, AdvisorSnapshot> = new Map(),
): HarnessFacts & { reads: number } {
  const facts = {
    reads: 0,
    envVars(dir: string) {
      const file = join(dir, ".env");
      return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
    },
    envNameSource(dir: string, name: string) {
      if (processEnv[name] !== undefined) return "process" as const;
      const file = join(dir, ".env");
      if (!existsSync(file)) return undefined;
      return Object.hasOwn(parseEnv(readFileSync(file, "utf8")), name)
        ? { file: realpathSync(file) }
        : undefined;
    },
    advisorSnapshot(dir: string) {
      return snapshots.get(dir);
    },
  };
  return facts;
}

/** Every file under `root`, with its bytes' digest stand-in and mtime, for a no-write check. */
export function treeState(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        out.set(`${path}/`, String(stats.mtimeMs));
        walk(path);
      } else {
        out.set(path, `${readFileSync(path).toString("base64")}@${stats.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}
