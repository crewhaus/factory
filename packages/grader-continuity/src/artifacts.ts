/**
 * Artifact readers for the continuity graders. Everything here reads a
 * FINISHED sample's files off disk — the eval-runner's per-sample directory
 * (`RunResult.artifacts`, PR 19) with its session JSONLs at the top level
 * and the isolated `.crewhaus/` fabric root nested inside (§7.2). Graders
 * never touch the host's live stores; the continuity-store handles built
 * here are read-only views over the sample's own state directory (reads
 * never take the store lock).
 *
 * Without `artifacts` (hand-built RunResults, transcript-only grading) the
 * loaders degrade gracefully: `RunResult.transcript` becomes the single
 * session and the focus/handoff surfaces read as absent.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type PlanRecord,
  type Requirement,
  createContinuityStore,
} from "@crewhaus/continuity-store";
import type { RunResult } from "@crewhaus/eval-grader";
import type { Event as TranscriptEvent } from "@crewhaus/event-log";

const SESSION_FILE_REGEX = /^(sess_[0-9a-f]{16})\.jsonl$/;
const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;
const SPEC_DIR_REGEX = /^[a-zA-Z0-9_\-.]+$/;

/** One session's event log, parsed. */
export type SampleSession = {
  readonly sessionId: string;
  readonly events: readonly TranscriptEvent[];
};

/** The continuity end-state discovered under the sample's state root. */
export type SampleContinuityState = {
  /** REQ ledger entries across every discovered focus store (spec- and
   *  session-scoped), in discovery order. */
  readonly requirements: readonly Requirement[];
  readonly focusBodies: readonly string[];
  /** Raw `handoff.md` contents (usually zero or one). */
  readonly handoffs: readonly string[];
  readonly plans: readonly PlanRecord[];
};

export type SampleArtifacts = {
  /** Sessions ordered by their first event's timestamp (ascending) — for a
   *  two-session sample, index 0 is session 1 and the last is session 2. */
  readonly sessions: readonly SampleSession[];
  readonly state: SampleContinuityState;
};

function parseJsonlEvents(raw: string): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn tail line from a crashed writer — skip
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    if (typeof (parsed as Record<string, unknown>)["kind"] !== "string") continue;
    out.push(parsed as TranscriptEvent);
  }
  return out;
}

/**
 * Load every session log in the sample directory: `transcript.jsonl` (the
 * primary session, renamed by the runner) plus any `sess_*.jsonl` a
 * multi-session invoker left behind. Falls back to `run.transcript` as a
 * single pseudo-session when no on-disk artifacts are available.
 */
export function loadSessions(run: RunResult): readonly SampleSession[] {
  const artifacts = run.artifacts;
  const sessions: SampleSession[] = [];
  if (artifacts !== undefined && existsSync(artifacts.sampleDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(artifacts.sampleDir);
    } catch {
      entries = [];
    }
    for (const file of entries.sort()) {
      const match = SESSION_FILE_REGEX.exec(file);
      const isTranscript = file === "transcript.jsonl";
      if (match === null && !isTranscript) continue;
      let raw: string;
      try {
        raw = readFileSync(join(artifacts.sampleDir, file), "utf8");
      } catch {
        continue;
      }
      const events = parseJsonlEvents(raw);
      if (events.length === 0) continue;
      sessions.push({
        sessionId: isTranscript ? artifacts.sessionId : (match?.[1] as string),
        events,
      });
    }
  }
  if (sessions.length === 0 && run.transcript.length > 0) {
    sessions.push({
      sessionId: artifacts?.sessionId ?? "sess_0000000000000000",
      events: run.transcript,
    });
  }
  sessions.sort((a, b) => (a.events[0]?.ts ?? 0) - (b.events[0]?.ts ?? 0));
  return sessions;
}

/** Scan `<stateRoot>/state/` for continuity stores (spec scope plus nested
 *  `sessions/<id>/` session scopes) and read their end state through the
 *  continuity-store's own parsers — one format owner, no duplicated
 *  focus.md/plan-file parsing here. */
export async function loadContinuityState(run: RunResult): Promise<SampleContinuityState> {
  const requirements: Requirement[] = [];
  const focusBodies: string[] = [];
  const handoffs: string[] = [];
  const plans: PlanRecord[] = [];

  const stateRoot = run.artifacts?.stateRootDir;
  const stateDir = stateRoot !== undefined ? join(stateRoot, "state") : undefined;
  if (stateDir === undefined || !existsSync(stateDir)) {
    return { requirements, focusBodies, handoffs, plans };
  }

  let specDirs: string[] = [];
  try {
    specDirs = readdirSync(stateDir).filter((d) => SPEC_DIR_REGEX.test(d));
  } catch {
    specDirs = [];
  }
  specDirs.sort();

  const readStore = async (specName: string, sessionId?: string): Promise<void> => {
    const storeDir =
      sessionId !== undefined
        ? join(stateDir, specName, "sessions", sessionId)
        : join(stateDir, specName);
    try {
      const store = createContinuityStore({
        specName,
        rootDir: stateDir,
        ...(sessionId !== undefined ? { scope: { kind: "session", sessionId } } : {}),
      });
      const focus = await store.readFocus();
      if (focus !== null) {
        focusBodies.push(focus.body);
        requirements.push(...focus.requirements);
      }
      plans.push(...(await store.listPlans()));
    } catch {
      // Not a parseable store — skip; graders degrade to event evidence.
    }
    const handoffPath = join(storeDir, "handoff.md");
    if (existsSync(handoffPath)) {
      try {
        handoffs.push(readFileSync(handoffPath, "utf8"));
      } catch {
        // unreadable handoff — treated as absent
      }
    }
  };

  for (const specName of specDirs) {
    await readStore(specName);
    const sessionsDir = join(stateDir, specName, "sessions");
    if (existsSync(sessionsDir)) {
      let sessionIds: string[] = [];
      try {
        sessionIds = readdirSync(sessionsDir).filter((d) => SESSION_ID_REGEX.test(d));
      } catch {
        sessionIds = [];
      }
      for (const sid of sessionIds.sort()) {
        await readStore(specName, sid);
      }
    }
  }
  return { requirements, focusBodies, handoffs, plans };
}

export async function loadArtifacts(run: RunResult): Promise<SampleArtifacts> {
  return {
    sessions: loadSessions(run),
    state: await loadContinuityState(run),
  };
}

// ---------------------------------------------------------------------------
// event payload readers
// ---------------------------------------------------------------------------

/** Text of a `user_message`/`assistant_message` payload; null for synthetic
 *  runtime-injected messages and for tool_result-only user messages. */
export function messageText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p["synthetic"] === true) return null;
  const content = p["content"];
  if (typeof content === "string") return content.trim() !== "" ? content : null;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string" && b["text"].trim() !== "") {
      texts.push(b["text"]);
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

export type EvictedRecord = { readonly role: string; readonly text: string };

export function evictedRecord(payload: unknown): EvictedRecord | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["role"] !== "string" || typeof p["text"] !== "string") return null;
  return { role: p["role"], text: p["text"] };
}

export type ActionProofRecord = {
  readonly planId: string;
  readonly step: number;
  readonly verdict: string;
};

export function actionProofRecord(payload: unknown): ActionProofRecord | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["planId"] !== "string" || typeof p["step"] !== "number") return null;
  if (typeof p["verdict"] !== "string") return null;
  return { planId: p["planId"], step: p["step"], verdict: p["verdict"] };
}

export type PlanUpdateRecord = {
  readonly planId: string;
  readonly action: string;
  readonly step?: number;
};

export function planUpdateRecord(payload: unknown): PlanUpdateRecord | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["planId"] !== "string" || typeof p["action"] !== "string") return null;
  return {
    planId: p["planId"],
    action: p["action"],
    ...(typeof p["step"] === "number" ? { step: p["step"] } : {}),
  };
}

/** `cost_accrual` payload's `costUsdMicros`, defensively. */
export function costUsdMicros(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) return 0;
  const v = (payload as Record<string, unknown>)["costUsdMicros"];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
