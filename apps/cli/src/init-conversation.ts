/**
 * v0.3.0 §2.9 / PR 18 — the conversational `crewhaus init --interactive`
 * (the scene of the release's motivating failure, rebuilt).
 *
 * The old model path was a single-shot forced `emit_spec` call: one stdin
 * line, `toolChoice: { type: "tool" }`, extra typed lines silently
 * discarded, nothing persisted. This module replaces it with a REAL
 * conversation on `runChatLoop`:
 *
 *   - TWO tools, NO forced toolChoice: `ask_user` (the question is surfaced
 *     on the terminal and the answer arrives as the next user message via
 *     the multi-turn REPL — nothing discarded) and `emit_spec` (the same
 *     `{ yaml }` contract as before; `parseSpec` failures return to the
 *     conversation as tool errors the model fixes IN-CONTEXT, not via blind
 *     re-attempts with an error ledger).
 *   - The continuity fabric is ON for the interview itself: `wireMemory`
 *     with a continuity fragment, spec-scoped under the TARGET directory as
 *     `init-<dirname>` — so REQ pinning (FocusWrite), the verbatim
 *     requirements ledger, compaction protection, and the teardown handoff
 *     all apply to the creator conversation.
 *   - The session is persisted and RESUMABLE: `--resume` replays the
 *     transcript, reseeds the ledger from `context_evicted` events, and a
 *     kick-off turn makes the first assistant message the resume summary
 *     ("Resuming: N requirements confirmed, M open questions …") — no work
 *     redone, no question re-asked.
 *   - A terminal failure (billing/auth/token exhaustion) propagates as the
 *     PR-3 `RunFailedError`; the CLI renders the FailureReport plus
 *     {@link INIT_INTERVIEW_SAVED_NOTE}.
 *
 * Testable by construction: the model adapter, the input stream, the home
 * directory (skill discovery), and the compaction sizing are all injectable,
 * so a mock adapter can drive fully scripted conversations.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { CrewhausError } from "@crewhaus/errors";
import { wireMemory } from "@crewhaus/memory-service";
import {
  BUILTIN_DEFAULT_RULES,
  type PermissionRule,
  type RuleSet,
} from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import { createSessionStore } from "@crewhaus/session-store";
import { createSkillTool } from "@crewhaus/skills-registry";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { ASK_USER_TOOL, EMIT_SPEC_TOOL, buildInterviewSystemPrompt } from "./init-interactive";

/** The saved-interview hint appended to every terminal-failure report and to
 *  the incomplete-interview error (design §2.9's exact promise). */
export const INIT_INTERVIEW_SAVED_NOTE =
  "Your interview is saved — `crewhaus init --interactive --resume` continues where it stopped.";

/** The synthetic kick-off turn a `--resume` boot runs so the FIRST assistant
 *  message is the resume summary — the user never re-types anything. */
export const RESUME_KICKOFF_MESSAGE =
  "Resume the interview from the saved session. Start your reply with the resume summary " +
  '("Resuming: N requirements confirmed, M open questions …") computed from the requirements ' +
  "ledger and focus, then continue where the interview stopped — never re-ask a confirmed requirement.";

/** The interview ended (exit/EOF/no emit) without a validated spec. Message
 *  carries the resume hint; `kind: "config"` keeps die()'s one-liner shape. */
export class InterviewIncompleteError extends CrewhausError {
  override readonly name = "InterviewIncompleteError";
  constructor(message: string) {
    super("config", message);
  }
}

/**
 * v0.3.0 §2.9 — TTY gate for the conversational path, mirroring the CLI's
 * destructive-verb convention (`memory clear`, `state restore`): interactive
 * conversation needs an interactive terminal, and `--yes` explicitly asks
 * for the non-conversational path. Pure; `index.ts` threads the real
 * `process.stdin.isTTY`.
 */
export function conversationalPathAllowed(opts: {
  readonly stdinIsTTY: boolean;
  readonly assumeYes: boolean;
}): { readonly allowed: boolean; readonly reason?: string } {
  if (opts.assumeYes) {
    return { allowed: false, reason: "--yes requested the scripted questionnaire" };
  }
  if (!opts.stdinIsTTY) {
    return {
      allowed: false,
      reason: "the conversational interview needs an interactive terminal (TTY)",
    };
  }
  return { allowed: true };
}

/** Tools the interview pre-allows (flag-source `alwaysAllow`) so the REPL
 *  never stalls on an approval prompt mid-conversation. Deliberately NOT
 *  MemoryClear — destructive, and an interview has no business clearing
 *  stores; it stays behind the default ask gate. */
const INTERVIEW_ALLOWED_TOOLS = [
  ASK_USER_TOOL.name,
  EMIT_SPEC_TOOL.name,
  "FocusRead",
  "FocusWrite",
  "PlanRead",
  "PlanUpdate",
  "PlanComplete",
  "GoalWrite",
  "GoalUpdate",
  "GoalList",
  "Skill",
] as const;

function interviewRuleSet(): RuleSet {
  const flag: PermissionRule[] = INTERVIEW_ALLOWED_TOOLS.map((pattern) => ({
    type: "alwaysAllow",
    pattern,
    source: "flag",
  }));
  return { flag, settings: [], yaml: [], hooks: [], builtin: [...BUILTIN_DEFAULT_RULES] };
}

/**
 * Extract the REQ → spec-field mapping lines from the interview transcript:
 * the LAST assistant message containing `REQ-nnn … →` lines wins (the
 * discipline mandates the mapping in the reply that precedes `emit_spec`).
 * Best-effort and pure — the CLI prints whatever the model actually
 * produced; correctness of the written spec never depends on it.
 */
export function extractReqMappingLines(rawJsonl: string): string[] {
  const mapRe = /REQ-\d+.*(?:→|->)/;
  let lines: string[] = [];
  for (const line of rawJsonl.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: { kind?: unknown; payload?: { content?: unknown } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue; // torn tail line from a crashed writer
    }
    if (parsed.kind !== "assistant_message") continue;
    const content = parsed.payload?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((b) => {
                const block = b as { type?: unknown; text?: unknown };
                return block.type === "text" && typeof block.text === "string" ? block.text : "";
              })
              .join("\n")
          : "";
    const matching = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => mapRe.test(l));
    if (matching.length > 0) lines = matching;
  }
  return lines;
}

export type ConversationalInterviewResult = {
  readonly yaml: string;
  readonly spec: Spec;
  readonly sessionId: string;
  /** The REQ → spec-field mapping lines from the model's final reply
   *  (empty when the model produced none — best-effort surface). */
  readonly mappingLines: readonly string[];
};

export type ConversationalInterviewOptions = {
  /** The harness directory: the spec lands here, and the interview's own
   *  continuity state + session live under `<targetDir>/.crewhaus/`. */
  readonly targetDir: string;
  /** Continuity/session scope name — `init-<dirname>` by convention. */
  readonly specName: string;
  /** Model string for the interview (the router grammar). */
  readonly model: string;
  /** `--resume`: restart the most recent persisted interview session. */
  readonly resume?: boolean;
  /** Status-line sink; defaults to process.stdout. */
  readonly log?: (line: string) => void;
  // ---- injection seams (tests) ------------------------------------------
  /** Scripted ProviderAdapter — bypasses the model router. */
  readonly _adapter?: ProviderAdapter;
  /** Compaction summarizer adapter (defaults to `_adapter`/router). */
  readonly _compactionAdapter?: ProviderAdapter;
  /** Input stream override (defaults to process.stdin). */
  readonly input?: NodeJS.ReadableStream;
  /** Home directory for skill/command discovery isolation. */
  readonly homeDir?: string;
  /** Compaction sizing overrides (motivating-failure tests). */
  readonly _compaction?: {
    readonly contextLimit?: number;
    readonly compactionThreshold?: number;
    readonly snipKeepHead?: number;
    readonly snipKeepTail?: number;
  };
};

/**
 * Run the conversational interview to completion: boots a persisted
 * `runChatLoop` session with the continuity fabric on, lets the model
 * interview the user (ask_user) and submit drafts (emit_spec, validated
 * in-conversation), and returns the first spec that parses. The caller
 * writes the YAML — this function performs no writes outside
 * `<targetDir>/.crewhaus/`.
 *
 * Throws {@link InterviewIncompleteError} when the conversation ends
 * (exit/EOF) without a validated spec, and lets `RunFailedError` from the
 * runtime propagate so the CLI can render the classified FailureReport with
 * {@link INIT_INTERVIEW_SAVED_NOTE}.
 */
export async function runConversationalInterview(
  opts: ConversationalInterviewOptions,
): Promise<ConversationalInterviewResult> {
  const log = opts.log ?? ((line: string): void => void process.stdout.write(line));
  const sessionRootDir = join(opts.targetDir, ".crewhaus", "sessions");

  // --resume resolves to the most-recently-updated persisted interview for
  // this spec name — the same resolution `crewhaus run --continue` uses.
  let resumeId: string | undefined;
  if (opts.resume === true) {
    const store = createSessionStore({ rootDir: sessionRootDir });
    const sessions = await store.list();
    const match = sessions.find((s: { name: string }) => s.name === opts.specName);
    if (match === undefined) {
      throw new InterviewIncompleteError(
        `no saved interview for "${opts.specName}" under ${sessionRootDir} — start one with: crewhaus init --interactive`,
      );
    }
    resumeId = match.id;
    log(`[interview] resuming session ${match.id} (last updated ${match.updatedAt})\n`);
  }

  // The abort controller is the loop's clean exit: once a spec validates,
  // the turn_end subscriber aborts and the REPL breaks BEFORE prompting for
  // another line (the in-flight turn — the model's closing confirmation —
  // always completes first).
  const controller = new AbortController();
  const runContext = createRunContext({
    abortSignal: controller.signal,
    ...(resumeId !== undefined ? { sessionId: resumeId } : {}),
  });
  const sessionId = runContext.sessionId;

  // v0.3.0 §2.9 — continuity fabric ON for the interview itself: the SAME
  // wireMemory composition-root call every harness makes, spec-scoped under
  // the target directory. Registers Focus/Plan/Goal tools, returns the
  // ledger/tail/handoff seam, and merges the builtin `continuity` skill +
  // slash commands at lowest precedence.
  const tools: RegisteredTool[] = [];
  const wired = await wireMemory(
    { specName: opts.specName, continuity: {} },
    {
      catalog: {
        register: (tool) => {
          tools.push(tool);
        },
      },
      cwd: opts.targetDir,
      sessionRootDir,
      log,
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    },
  );

  // The two interview tools — free-form conversation, no forced toolChoice.
  let emitted: { yaml: string; spec: Spec } | undefined;
  tools.push(
    buildTool({
      name: ASK_USER_TOOL.name,
      description: ASK_USER_TOOL.description,
      inputSchema: z.object({ question: z.string().min(1) }),
      readOnly: true,
      destructive: false,
      concurrencySafe: false,
      execute: async ({ question }) => {
        // Surface the question distinctly; the answer arrives through the
        // REPL's next `you>` line — multi-turn stdin, nothing discarded.
        log(`\n[interviewer] ${question}\n`);
        return (
          "Question delivered. End your turn now — the user's answer arrives as the " +
          "next user message. Never re-ask a requirement already recorded as confirmed."
        );
      },
    }),
    buildTool({
      name: EMIT_SPEC_TOOL.name,
      description: EMIT_SPEC_TOOL.description,
      inputSchema: z.object({ yaml: z.string().min(1) }),
      readOnly: true,
      destructive: false,
      concurrencySafe: false,
      execute: async ({ yaml }) => {
        // parseSpec throws SpecParseError on an invalid draft; tool-executor
        // turns the throw into an `is_error` tool result, so the validation
        // error goes BACK into the conversation and the model revises
        // in-context — the ledger and Q&A history stay in play.
        const spec = parseSpec(yaml);
        emitted = { yaml, spec };
        return (
          "Spec validated against the live schema — the interview is complete and the " +
          "CLI writes crewhaus.yaml next. Reply with a one-line confirmation."
        );
      },
    }),
  );
  const skills = wired.options.skills ?? [];
  if (skills.length > 0) tools.push(createSkillTool(skills));

  const unsubscribe = runContext.eventBus.subscribe((event): void => {
    if (event.kind === "turn_end" && emitted !== undefined) controller.abort();
  });

  const common = {
    model: opts.model,
    instructions: buildInterviewSystemPrompt(),
    tools,
    permissionMode: "default" as const,
    permissionRules: interviewRuleSet(),
    runContext,
    sessionRootDir,
    sessionName: opts.specName,
    sessionTarget: "init",
    ...(wired.options.continuity !== undefined ? { continuity: wired.options.continuity } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(wired.options.slashCommands !== undefined
      ? { slashCommands: wired.options.slashCommands }
      : {}),
    ...(opts._adapter !== undefined ? { _adapter: opts._adapter } : {}),
    ...(opts._compactionAdapter !== undefined
      ? { _compactionAdapter: opts._compactionAdapter }
      : {}),
    ...(opts._compaction ?? {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  };

  try {
    if (resumeId !== undefined) {
      // Kick-off turn: replay the transcript + rebuild the ledger from the
      // logged `context_evicted` events, then run ONE seeded turn so the
      // first assistant message is the resume summary — the user types
      // nothing to get back to where the interview stopped.
      await runChatLoop({
        ...common,
        singleTurn: true,
        resume: { sessionId: resumeId },
        seedMessages: [{ role: "user", content: RESUME_KICKOFF_MESSAGE }],
      });
      // Continue conversationally unless the kick-off already emitted the
      // spec (everything was confirmed before the original session died).
      if (emitted === undefined) {
        await runChatLoop({ ...common, resume: { sessionId: resumeId } });
      }
    } else {
      await runChatLoop(common);
    }
  } finally {
    unsubscribe();
  }

  if (emitted === undefined) {
    throw new InterviewIncompleteError(
      `the interview ended without a validated spec — nothing was written. ${INIT_INTERVIEW_SAVED_NOTE}`,
    );
  }

  // Best-effort: the REQ → spec-field mapping the model listed before
  // emit_spec, read back from the persisted transcript.
  let mappingLines: string[] = [];
  try {
    mappingLines = extractReqMappingLines(
      readFileSync(join(sessionRootDir, `${sessionId}.jsonl`), "utf-8"),
    );
  } catch {
    // No transcript / unreadable — the mapping line is a bonus, never a gate.
  }

  return { yaml: emitted.yaml, spec: emitted.spec, sessionId, mappingLines };
}
