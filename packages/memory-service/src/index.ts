/**
 * `@crewhaus/memory-service` — the memory fabric's composition root
 * (v0.3.0 design §1 principle 1, §10, PR 10; module catalog critical-path #2).
 *
 * ONE composition root instead of N copies of codegen: every consumer of the
 * memory fabric — target emitters, the `crewhaus run` interpreter, and (via
 * PR 13) sub-agent bridges — makes one stable call,
 *
 *   const wired = await wireMemory(FRAGMENT, { catalog, cwd });
 *   await runChatLoop({ ...base, tools: catalog.list(), ...wired.options });
 *
 * and this package does the wiring the emitters used to template per shape
 * (`renderMemory` in target-cli, with "keep in sync" mirrors that were
 * fiction): construct the stores, register the tools, and hand back the
 * injected-closure seams `RunChatLoopOptions` expects. Emitters stay dumb
 * (typed IR in, one line out — Pillar 1); runtime-core stays store-free
 * (the #53 inverted-DI pattern).
 *
 * ## The fragment
 *
 * `MemoryWiringFragment` is a SERIALIZABLE value — an emitter can
 * `JSON.stringify` it into a bundle — describing what to wire. It is the
 * shape `IrMemory`/`IrContinuity` (design §9) lower into via
 * {@link memoryFragmentFromIr} (PR 11); this package stays structural and
 * deliberately does not import `@crewhaus/ir`. The fragment carries only
 * knobs this root actually wires — no dead config: `dream` joins with its
 * engine (PR 14); continuity `proof` is the one carried-but-degraded field
 * (see {@link ContinuityWiringFragment.proof}).
 *
 * ## What gets wired (feature → stores/tools/seams)
 *
 *   memory on      → file `MemoryStore` (`.crewhaus/memories/<spec>.jsonl`)
 *                    · tools Remember / Recall / MemoryForget
 *                    · `options.memory` seam: autoRecall/recall +
 *                      autoCapture/onCapture — the capture path stamps
 *                      `provenance {sessionId, evidence: toolUseIds}` from
 *                      the session event log (§2.4 proof-linked capture)
 *                      and walks `sub_agent_start` brackets into child
 *                      session logs (§7.1: child facts carry the child's
 *                      sessionId provenance + a `subagent:<name>` tag)
 *   continuity on  → `ContinuityStore` (`.crewhaus/state/<spec>/`)
 *                    · tools FocusRead/FocusWrite, PlanRead/PlanUpdate/
 *                      PlanComplete, GoalWrite/GoalUpdate/GoalList,
 *                      MemoryClear (`plan: false` keeps only the Focus pair
 *                      + MemoryClear)
 *                    · `options.continuity` seam: loadPlan/onPlanDirty
 *                      rendering the `<current_plan>` tail, the `ledger`
 *                      flag, onHandoff → deterministic `handoff.md`
 *                    · `options.skills`/`options.slashCommands`: the builtin
 *                      `continuity` skill and the continuity slash commands,
 *                      merged at LOWEST precedence via `discoverSkills`'
 *                      `builtinSkills` / `loadCommands`' `builtinDirs` —
 *                      user (`~/.crewhaus`) and project (`<cwd>/.crewhaus`)
 *                      entries override by name
 *   wiki on        → `WikiStore` (`.crewhaus/wiki/<spec>/`)
 *                    · the ten thredz-vocabulary `wiki_*` tools
 *                    · `log_knowledge_gap` routed into the plan store as a
 *                      `[gap]` goal when continuity is also on (§3.2)
 *
 * Everything is ABSENT-SAFE: a fragment with none of the blocks wires
 * nothing — no stores touched, no tools registered, `options` spreads empty.
 *
 * ## Backends (v0.3.0 Goal 3, design §4.3/§4.4)
 *
 * `"file"` (the default) is the local fabric above. With `thredz` configured
 * (the fragment's `thredz` slice / `memory.backend: "thredz"`) and a live
 * connection in `deps.thredz` (from {@link connectThredz}, which registers
 * the wiki+goals vocabulary as bare-name MCP aliases), the WIKI backend
 * flips: no local wiki store/tools are constructed, recall routes through
 * the MCP client, and continuity goal writes mirror to Thredz (spec scope
 * only). Facts, focus, ledger, and dream state stay local always. Thredz
 * configured but unreachable DEGRADES to the local backend with a boot
 * warning — never a crash (§4.4).
 *
 * ## Scoping + tenancy (§2.7)
 *
 * `continuity.scope: "session"` nests the continuity store under
 * `<spec>/sessions/<sessionId>/` (per-conversation state for channel
 * daemons) — the session id arrives as `deps.sessionScope`. Facts and wiki
 * stay spec-scoped always (§14.5: per-conversation goals/wiki would burn
 * quotas and fragment knowledge). A `deps.tenant` re-roots every store under
 * the tenant's directory with the stores' own fail-closed path fencing
 * (continuity/wiki take the `tenant` option; the fact store — which has no
 * fence of its own — is constructed inside the tenant root).
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ContinuityScope,
  type ContinuityStore,
  createContinuityStore,
  renderStatus,
} from "@crewhaus/continuity-store";
import { DEFAULT_SKILLS, DREAM_SKILL_BODY, builtinCommandsDir } from "@crewhaus/default-skills";
import {
  type DreamEngine,
  type DreamJanitorStep,
  type DreamModelPhase,
  type DreamRunReport,
  createDreamEngine,
  dreamJanitorStep,
} from "@crewhaus/dream-engine";
import { createEmbedder } from "@crewhaus/embedder";
import { CrewhausError } from "@crewhaus/errors";
import {
  type MemoryStore,
  captureChildFacts,
  captureFacts,
  createMemoryStore,
  deriveMemoryDecision,
  summarizeDurableFactsWithEvidence,
  turnsFromEventsWithChildren,
} from "@crewhaus/memory-store";
import { createPiiRedactor } from "@crewhaus/pii-redactor";
import { type LoadedSkill, type SkillRef, discoverSkills } from "@crewhaus/skills-registry";
import { type SlashCommand, loadCommands } from "@crewhaus/slash-commands";
import type { Tenant } from "@crewhaus/tenancy";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { createMemoryTools } from "@crewhaus/tool-memory";
import { type ContinuityEvent, createPlanTools } from "@crewhaus/tool-plan";
import { type KnowledgeGap, type WikiEvent, createWikiTools } from "@crewhaus/tool-wiki";
import { type WikiStore, createWikiStore } from "@crewhaus/wiki-store";
import {
  type ExamRunner,
  GAP_GOAL_PREFIX,
  type IrLearningLike,
  type LearningWiringFragment,
  createExamTool,
  renderedLearningSkill,
  withLearningDreamSeed,
} from "./learning.js";
import {
  type ThredzConnection,
  classifyThredzFailure,
  parseThredzRecallLines,
  withThredzGoalMirror,
} from "./thredz.js";

// v0.3.0 Goal 2 — the learning wiring surface (design §3.3, PR 17): skill
// substitution, the study-rotation preamble, the exam seam, and the dream
// learning seed.
export {
  GAP_GOAL_PREFIX,
  buildLearningDreamSeed,
  createExamTool,
  learningSkillSubstitutions,
  nextCurriculumRung,
  renderStudyRotationPreamble,
  renderedLearningSkill,
  withLearningDreamSeed,
  type CreateExamToolOptions,
  type ExamReport,
  type ExamRunner,
  type ExamRunnerRequest,
  type ExamSampleOutcome,
  type IrLearningLike,
  type LearningExamFragment,
  type LearningStudyFragment,
  type LearningWiringFragment,
} from "./learning.js";

// v0.3.0 Goal 3 — the Thredz wiring surface (design §4.3/§4.4): boot helper,
// alias vocabulary, failure classifier, and the injected-client seam types.
export {
  THREDZ_SERVER_NAME,
  THREDZ_GOAL_TOOL_NAMES,
  THREDZ_ALIAS_TOOL_NAMES,
  THREDZ_ALIAS_TOOL_FLAGS,
  THREDZ_GOAL_MAP_FILE,
  classifyThredzFailure,
  connectThredz,
  extractThredzGoalId,
  parseThredzRecallLines,
  withThredzGoalMirror,
  type ConnectThredzOptions,
  type ThredzCallResult,
  type ThredzClient,
  type ThredzConnection,
  type ThredzFailureClass,
  type ThredzGoalMirrorOptions,
} from "./thredz.js";

// PR 19 — the cross-backend WikiStore conformance suite (design §5): an
// exported test-kit function so the file backend and the Thredz backend
// (PR 16) run the SAME contract assertions. Kept in its own module; this is
// its only touchpoint in this file so parallel-branch merges stay trivial.
export {
  type ConformanceCheck,
  type ConformanceReport,
  type WikiBackendFactory,
  type WikiConformanceBackend,
  type WikiVisibility,
  WIKI_CONFORMANCE_CHECKS,
  runWikiBackendConformance,
} from "./backend-conformance";

export class MemoryServiceError extends CrewhausError {
  override readonly name = "MemoryServiceError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

// ---------------------------------------------------------------------------
// the fragment — what a future IrMemory/IrContinuity lowers into (design §9)
// ---------------------------------------------------------------------------

/** Storage backend discriminator. `"thredz"` lowers from the `thredz:`
 *  block (design §4) and flips the WIKI backend to the Thredz MCP server —
 *  see the Backends section above for exactly what flips and what stays
 *  local. */
export type MemoryBackend = "file" | "thredz";

/** The `memory:` slice — `IrMemory` (#53) plus the §9 extensions this root
 *  wires today (`backend`, `ttlMs`, `wiki`, `dream`). */
export type MemoryFactsFragment = {
  /** Presence of the block implies enabled; explicit `false` wires nothing. */
  readonly enabled?: boolean;
  readonly backend?: MemoryBackend;
  /** TTL (ms) stamped on auto-captured facts — explicit forgetting (§3.4).
   *  Tool-initiated `Remember` keeps its own per-call `ttlDays` input. */
  readonly ttlMs?: number;
  readonly autoCapture?: boolean;
  readonly autoCaptureThreshold?: number;
  readonly autoRecall?: boolean;
  readonly recallK?: number;
  readonly wiki?: WikiWiringFragment;
  readonly dream?: DreamWiringFragment;
};

/** The `memory.dream` slice (§6/§9) — `IrMemoryDream` structurally. */
export type DreamWiringFragment = {
  /** Consolidation cadence in ms (`memory.dream.every`, lowered). */
  readonly everyMs: number;
  /** The IR carries this resolved (default `full`); optional here so
   *  hand-built fragments stay ergonomic. */
  readonly mode?: "deterministic" | "full";
  /** Model-phase spend cap (USD). Absent or 0 = deterministic only. */
  readonly budgetUsd?: number;
  /** Playbook override; default = the builtin `dream` skill body. */
  readonly instructions?: string;
};

/** The `memory.wiki` slice (§3.1/§9). */
export type WikiWiringFragment = {
  readonly enabled?: boolean;
  /** Wiki hits fused into the auto-recall bundle (default
   *  {@link DEFAULT_WIKI_RECALL_K}) when `autoRecall` is on. */
  readonly recallK?: number;
  /** Embedder factory grammar (`mock/deterministic`, `openai/…`) enabling
   *  hybrid recall on BOTH the wiki and the fact store. A structural
   *  `deps.embedder` wins over this. */
  readonly embedder?: string;
  /** Fuse top-`recallK` wiki hits into the session-start `<recalled_memory>`
   *  bundle (§3.4) — the seam's recall() returns fact lines + wiki lines. */
  readonly autoRecall?: boolean;
  /** Learning-mode write governance (§3.3): `wiki_write` rejects bodies
   *  without a `## Sources` heading. The `learning:` lowering sets this. */
  readonly requireSources?: boolean;
};

/** The `continuity:` slice (§2.1/§9). `scope` arrives RESOLVED (`auto` is a
 *  compiler concern). */
export type ContinuityWiringFragment = {
  readonly enabled?: boolean;
  /** Plan/goal persistence + the Plan/Goal tool families. `false` keeps
   *  only focus (FocusRead/FocusWrite) + MemoryClear. Default true. */
  readonly plan?: boolean;
  /** §2.4 proof-of-action mode. `"ladder"` (the lowered default) is what
   *  tool-plan implements: `claimed` is free, the `proven` transition is
   *  machine-checked. `"require"`/`"off"` are CARRIED for forward compat but
   *  degrade to the ladder with a boot note — enforcement needs a proof-mode
   *  seam on tool-plan's `createPlanTools` (noted follow-up; this package
   *  consumes the store/tool packages, it does not modify them). */
  readonly proof?: "ladder" | "require" | "off";
  /** The §2.3 requirements ledger — threaded to the runtime seam. Default
   *  true. */
  readonly ledger?: boolean;
  /** Deterministic teardown handoff.md. Default true. */
  readonly handoff?: boolean;
  /** `"session"` nests the store under `<spec>/sessions/<deps.sessionScope>/`. */
  readonly scope?: "spec" | "session";
  readonly focusMaxChars?: number;
};

/**
 * v0.3.0 Goal 3 — the `thredz:` slice (§4.1/§9), serializable. The
 * credential/base-url live ONLY in the synthesized MCP server config (the
 * §4.2 secret machinery); this fragment carries the WIRING knobs — whether
 * goal writes mirror, the enforced visibility, and the boot handle. The
 * client itself arrives structurally via `deps.thredz` ({@link ThredzClient})
 * so the fragment stays a JSON literal in emitted bundles.
 */
export type ThredzWiringFragment = {
  /** Mirror continuity goal writes to Thredz `goal_write`/`goal_update`
   *  (spec scope only, §14.5 decision 5). The compiler lowers this resolved;
   *  hand-built fragments default to "on when continuity goals are on". */
  readonly goals?: boolean;
  /** The enforced default visibility (informational at this layer — the
   *  synthesized server env `THREDZ_DEFAULT_VISIBILITY` does the enforcing). */
  readonly visibility?: "private" | "shared";
  /** The boot-registered agent handle (`connectThredz` consumes it). */
  readonly agentName?: string;
};

/**
 * The serializable input `wireMemory` consumes — the shape the future
 * `IrMemory`/`IrContinuity` lower into. Emitters embed it as a JSON literal
 * (`wireMemory({...}, { catalog: defaultCatalog, cwd: process.cwd() })`);
 * the interpreter builds it from the IR via {@link memoryFragmentFromIr}.
 */
export type MemoryWiringFragment = {
  /** The spec name — scopes every store path (validated by each store). */
  readonly specName: string;
  readonly memory?: MemoryFactsFragment;
  readonly continuity?: ContinuityWiringFragment;
  /** v0.3.0 Goal 3 — present when `thredz:` is on (design §4). */
  readonly thredz?: ThredzWiringFragment;
  /** v0.3.0 Goal 2 — present when `learning:` is on (design §3.3, PR 17). */
  readonly learning?: LearningWiringFragment;
};

/** Structural mirror of `IrMemory` (#53 + the v0.3.0 §9 extensions) — kept
 *  structural so this package never imports `@crewhaus/ir`. */
export type IrMemoryLike = {
  readonly enabled?: boolean;
  readonly backend?: "file" | "thredz";
  readonly ttlMs?: number;
  readonly autoCapture?: boolean;
  readonly autoCaptureThreshold?: number;
  readonly autoRecall?: boolean;
  readonly recallK?: number;
  readonly wiki?: {
    readonly enabled?: boolean;
    readonly recallK?: number;
    readonly embedder?: string;
    readonly autoRecall?: boolean;
    readonly requireSources?: boolean;
  };
  readonly dream?: {
    readonly everyMs: number;
    readonly mode: "deterministic" | "full";
    readonly budgetUsd?: number;
    readonly instructions?: string;
  };
};

/** Structural mirror of `IrContinuity` (v0.3.0 §9) — the compiler lowers a
 *  fully-RESOLVED shape (defaults filled in, `auto` scope resolved), so every
 *  field but `focusMaxChars` is required there; this mirror keeps them
 *  optional so hand-built fragments stay ergonomic. */
export type IrContinuityLike = {
  readonly plan?: boolean;
  readonly proof?: "ladder" | "require" | "off";
  readonly ledger?: boolean;
  readonly handoff?: boolean;
  readonly scope?: "spec" | "session";
  readonly focusMaxChars?: number;
};

/** Structural mirror of the wiring-relevant `IrThredz` fields (§4.1). The
 *  credential (`apiKey`) and `baseUrl` deliberately do NOT appear — they
 *  belong to the synthesized MCP server config, never to a fragment an
 *  emitter serializes into a bundle. */
export type IrThredzLike = {
  readonly goals?: boolean;
  readonly visibility?: "private" | "shared";
  readonly agentName?: string;
};

/**
 * Build the fragment from a lowered IR's `name` + `memory` + `continuity`
 * blocks EXACTLY as the pre-PR-10 `renderMemory` codegen read them — only
 * fields the IR carries are serialized, so the fragment (and therefore the
 * emitted bundle) stays minimal and deterministic. Shared by every target
 * emitter and the `crewhaus run` interpreter so the paths cannot drift.
 * Presence of `ir.continuity` means enabled (the compiler already dropped
 * `continuity: false` at lower time).
 */
export function memoryFragmentFromIr(ir: {
  readonly name: string;
  readonly memory?: IrMemoryLike;
  readonly continuity?: IrContinuityLike;
  readonly thredz?: IrThredzLike;
  readonly learning?: IrLearningLike;
}): MemoryWiringFragment {
  const mem = ir.memory;
  const wiki = mem?.wiki;
  const dream = mem?.dream;
  const cont = ir.continuity;
  const thredz = ir.thredz;
  const learning = ir.learning;
  return {
    specName: ir.name,
    ...(mem !== undefined
      ? {
          memory: {
            ...(mem.enabled !== undefined ? { enabled: mem.enabled } : {}),
            ...(mem.backend !== undefined ? { backend: mem.backend } : {}),
            ...(mem.ttlMs !== undefined ? { ttlMs: mem.ttlMs } : {}),
            ...(mem.autoCapture !== undefined ? { autoCapture: mem.autoCapture } : {}),
            ...(mem.autoCaptureThreshold !== undefined
              ? { autoCaptureThreshold: mem.autoCaptureThreshold }
              : {}),
            ...(mem.autoRecall !== undefined ? { autoRecall: mem.autoRecall } : {}),
            ...(mem.recallK !== undefined ? { recallK: mem.recallK } : {}),
            ...(wiki !== undefined
              ? {
                  wiki: {
                    ...(wiki.enabled !== undefined ? { enabled: wiki.enabled } : {}),
                    ...(wiki.recallK !== undefined ? { recallK: wiki.recallK } : {}),
                    ...(wiki.embedder !== undefined ? { embedder: wiki.embedder } : {}),
                    ...(wiki.autoRecall !== undefined ? { autoRecall: wiki.autoRecall } : {}),
                    ...(wiki.requireSources !== undefined
                      ? { requireSources: wiki.requireSources }
                      : {}),
                  },
                }
              : {}),
            ...(dream !== undefined
              ? {
                  dream: {
                    everyMs: dream.everyMs,
                    mode: dream.mode,
                    ...(dream.budgetUsd !== undefined ? { budgetUsd: dream.budgetUsd } : {}),
                    ...(dream.instructions !== undefined
                      ? { instructions: dream.instructions }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(cont !== undefined
      ? {
          continuity: {
            ...(cont.plan !== undefined ? { plan: cont.plan } : {}),
            ...(cont.proof !== undefined ? { proof: cont.proof } : {}),
            ...(cont.ledger !== undefined ? { ledger: cont.ledger } : {}),
            ...(cont.handoff !== undefined ? { handoff: cont.handoff } : {}),
            ...(cont.scope !== undefined ? { scope: cont.scope } : {}),
            ...(cont.focusMaxChars !== undefined ? { focusMaxChars: cont.focusMaxChars } : {}),
          },
        }
      : {}),
    ...(thredz !== undefined
      ? {
          thredz: {
            ...(thredz.goals !== undefined ? { goals: thredz.goals } : {}),
            ...(thredz.visibility !== undefined ? { visibility: thredz.visibility } : {}),
            ...(thredz.agentName !== undefined ? { agentName: thredz.agentName } : {}),
          },
        }
      : {}),
    ...(learning !== undefined
      ? {
          learning: {
            domain: learning.domain,
            ...(learning.curriculum !== undefined ? { curriculum: learning.curriculum } : {}),
            ...(learning.sources !== undefined ? { sources: [...learning.sources] } : {}),
            ...(learning.exam !== undefined
              ? { exam: { dataset: learning.exam.dataset, graders: learning.exam.graders } }
              : {}),
            ...(learning.study !== undefined
              ? {
                  study: {
                    ...(learning.study.onHeartbeat !== undefined
                      ? { onHeartbeat: learning.study.onHeartbeat }
                      : {}),
                    ...(learning.study.onDream !== undefined
                      ? { onDream: learning.study.onDream }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// deps + outputs
// ---------------------------------------------------------------------------

/** Structural registrar — `defaultCatalog` satisfies it; the interpreter
 *  passes a shim that pushes into its local tools array. */
export type ToolRegistrar = {
  register(tool: RegisteredTool): void;
};

/** Structural embedder (memory-store's and wiki-store's shape). */
export type EmbedderLike = {
  embed(texts: ReadonlyArray<string>): Promise<number[][]>;
};

export type WireMemoryDeps = {
  /** Where registered tools land (e.g. `defaultCatalog`). */
  readonly catalog: ToolRegistrar;
  /** The harness working directory — stores live under `<cwd>/.crewhaus/`
   *  (unless a tenant re-roots them). */
  readonly cwd: string;
  /** Tenant fencing (§2.7) — threaded to every store. */
  readonly tenant?: Tenant;
  /** Where session `.jsonl` event logs live — proof-evidence verification
   *  and the auto-capture transcript reads resolve against this. Default
   *  `<cwd>/.crewhaus/sessions` (ignored under a tenant, whose own
   *  sessionRoot governs). The eval runner points it at its per-sample
   *  directory (§7.2 state isolation). */
  readonly sessionRootDir?: string;
  /** The session id backing `continuity.scope: "session"` stores and the
   *  default session for proof-evidence refs. */
  readonly sessionScope?: string;
  /** Event-log append seam for `plan_update`/`goal_update`/`action_proof`/
   *  `wiki_write` events (tool-plan's / tool-wiki's injected pattern). */
  readonly appendEvent?: (event: ContinuityEvent | WikiEvent) => void | Promise<void>;
  /** Structural embedder for hybrid recall — beats the fragment's
   *  `memory.wiki.embedder` factory string. */
  readonly embedder?: EmbedderLike;
  /** Status-line sink for `[memory] …` boot lines (the interpreter passes
   *  stdout; compiled bundles stay silent, matching pre-PR-10 behavior). */
  readonly log?: (line: string) => void;
  /** Home directory override for skill/command discovery (tests). */
  readonly homeDir?: string;
  readonly now?: () => Date;
  /** v0.3.0 Goal 3 — the live Thredz connection from {@link connectThredz}.
   *  `null` means "configured but boot failed" — wireMemory then DEGRADES to
   *  the local backend with a warning (§4.4), it never throws. Absent when
   *  the fragment carries no thredz slice. */
  readonly thredz?: ThredzConnection | null;
  /** v0.3.0 Goal 2 (§3.3, PR 17) — the injected programmatic exam runner
   *  (`@crewhaus/eval-runner`'s `createExamRunner`; injected because
   *  eval-runner depends on this package). With `learning.exam` configured
   *  AND a runner present, the `run_exam` tool registers and the `/exam`
   *  command joins the gated set. Absent → learning still wires (skill +
   *  /study /reflect) but no exam surface — a consumer without the eval
   *  stack never advertises an exam it cannot sit. */
  readonly examRunner?: ExamRunner;
};

/** The `RunChatLoopOptions.memory` seam shape (structural — assignability
 *  to runtime-core is pinned in tests; runtime-core is a devDependency). */
export type MemorySeam = {
  readonly autoRecall?: boolean;
  readonly recallK?: number;
  readonly recall?: (query: string, k: number) => Promise<readonly string[]>;
  readonly autoCapture?: boolean;
  readonly onCapture?: (completedTurns: number, sessionId: string) => Promise<void>;
};

/** Runtime-core's `HandoffInput`, structurally (see the assignability pin). */
export type HandoffSeamInput = {
  readonly plan: string | null;
  readonly ledger: ReadonlyArray<{
    readonly role: "user" | "assistant" | "tool";
    readonly text: string;
    readonly turnNumber?: number;
  }>;
  readonly sessionId: string;
  readonly stopReason: "complete" | "exit" | "abort";
};

/** The `RunChatLoopOptions.continuity` seam shape. */
export type ContinuitySeam = {
  readonly loadPlan: () => Promise<string | null>;
  readonly onPlanDirty?: () => Promise<string | null>;
  readonly ledger?: boolean;
  readonly onHandoff?: (input: HandoffSeamInput) => Promise<void>;
};

/**
 * Spread-ready `RunChatLoopOptions` slice: `runChatLoop({ ...base,
 * ...wired.options })`. Keys are present ONLY for wired features, so
 * spreading never clobbers a caller's own skills/slashCommands unless
 * continuity took ownership of them.
 */
export type WiredOptions = {
  readonly memory?: MemorySeam;
  readonly continuity?: ContinuitySeam;
  readonly skills?: ReadonlyArray<SkillRef>;
  readonly slashCommands?: ReadonlyMap<string, SlashCommand>;
};

export type WiredContinuity = {
  readonly store: ContinuityStore;
  readonly tools: readonly RegisteredTool[];
  readonly continuity: ContinuitySeam;
};

export type WiredWiki = {
  /** Which backend answered (design §4.3): `"file"` constructs the local
   *  store; `"thredz"` routes through the MCP client (the tool surface then
   *  comes from the bare-name aliases registered at MCP boot, so `tools` is
   *  empty and `store` null — articles live server-side). */
  readonly backend: "file" | "thredz";
  readonly store: WikiStore | null;
  readonly tools: readonly RegisteredTool[];
  /** Recall lines for the §3.4 auto-recall fusion — the same
   *  `[wiki:<slug>] <title> — <excerpt>` bundle shape on both backends. */
  readonly recall: (query: string, k: number) => Promise<readonly string[]>;
};

export type WiredMemory = {
  readonly stores: {
    readonly memory?: MemoryStore;
    readonly continuity?: ContinuityStore;
    readonly wiki?: WikiStore;
  };
  /** Every tool registered into `deps.catalog`, in registration order. */
  readonly tools: readonly RegisteredTool[];
  readonly options: WiredOptions;
};

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

/** The tenant's root directory (its sessionRoot's parent) — the same
 *  convention continuity-store/wiki-store/session-store fence against. */
function tenantRootOf(tenant: Tenant): string {
  return resolve(tenant.sessionRoot, "..");
}

function crewhausDirOf(deps: { readonly tenant?: Tenant; readonly cwd: string }): string {
  return deps.tenant !== undefined ? tenantRootOf(deps.tenant) : resolve(deps.cwd, ".crewhaus");
}

function memoryEnabled(fragment: MemoryWiringFragment): boolean {
  return fragment.memory !== undefined && fragment.memory.enabled !== false;
}

function continuityEnabled(fragment: Pick<MemoryWiringFragment, "continuity">): boolean {
  return fragment.continuity !== undefined && fragment.continuity.enabled !== false;
}

function wikiEnabled(fragment: MemoryWiringFragment): boolean {
  return (
    memoryEnabled(fragment) &&
    fragment.memory?.wiki !== undefined &&
    fragment.memory.wiki.enabled !== false
  );
}

function dreamEnabled(fragment: MemoryWiringFragment): boolean {
  return memoryEnabled(fragment) && fragment.memory?.dream !== undefined;
}

/** v0.3.0 Goal 3 — is Thredz configured on this fragment? Either the
 *  `thredz:` slice is present or a declared memory block carries
 *  `backend: "thredz"` (the compiler stamps both together). */
function thredzConfigured(fragment: Pick<MemoryWiringFragment, "memory" | "thredz">): boolean {
  return fragment.thredz !== undefined || fragment.memory?.backend === "thredz";
}

/** The §4.4 degrade line, printed once per boot when Thredz is configured
 *  but no live connection arrived (offline, npx failure, no MCP host). */
const THREDZ_DEGRADE_NOTE =
  "[thredz] unavailable — memory degraded to the local backend for this run (local stores under .crewhaus/ stay authoritative; nothing was lost)\n";

function resolveEmbedder(
  fragment: MemoryWiringFragment,
  deps: { readonly embedder?: EmbedderLike },
): EmbedderLike | undefined {
  if (deps.embedder !== undefined) return deps.embedder;
  const spec = fragment.memory?.wiki?.embedder;
  if (spec !== undefined) return createEmbedder({ model: spec });
  return undefined;
}

/** Parse a session `.jsonl` blob into `{kind, payload}` objects, skipping
 *  blank/malformed lines (the interpreter's `parseJsonlObjects` behavior). */
function parseSessionEvents(raw: string): Array<{ kind?: string; payload?: unknown }> {
  const out: Array<{ kind?: string; payload?: unknown }> = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        out.push(parsed as { kind?: string; payload?: unknown });
      }
    } catch {
      // Torn tail line from a crashed writer — skip, like both legacy paths.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// facts (the #53 memory block) — store + tools + runtime seam
// ---------------------------------------------------------------------------

type WiredFacts = {
  readonly store: MemoryStore;
  readonly tools: readonly RegisteredTool[];
  readonly memory: MemorySeam;
};

function wireFacts(fragment: MemoryWiringFragment, deps: WireMemoryDeps): WiredFacts {
  const mem = fragment.memory ?? {};
  const embedder = resolveEmbedder(fragment, deps);
  const store = createMemoryStore({
    specName: fragment.specName,
    rootDir: join(crewhausDirOf(deps), "memories"),
    ...(embedder !== undefined ? { embedder } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const bundle = createMemoryTools({ specName: fragment.specName, store });
  const tools = [bundle.remember, bundle.recall, bundle.forget];

  // Number.MAX_SAFE_INTEGER: the boot-time decision only needs the recall
  // flag + recallK — the real completed-turn count gates capture at teardown
  // (both legacy paths did exactly this).
  const decision = deriveMemoryDecision(mem, Number.MAX_SAFE_INTEGER);
  const sessionsDir = deps.sessionRootDir ?? join(crewhausDirOf(deps), "sessions");

  const memory: MemorySeam = {
    ...(decision.recall
      ? {
          autoRecall: true,
          recallK: decision.recallK,
          recall: async (query, k) => {
            const results = await store.recall(query, k);
            return results.map((r) => r.entry.text);
          },
        }
      : {}),
    ...(mem.autoCapture === true
      ? {
          autoCapture: true,
          onCapture: async (completedTurns, sessionId) => {
            if (!deriveMemoryDecision(mem, completedTurns).capture) return;
            let raw: string;
            try {
              raw = readFileSync(join(sessionsDir, `${sessionId}.jsonl`), "utf-8");
            } catch {
              return; // no transcript, nothing to capture
            }
            // §2.4 proof-linked capture: the turn extraction carries each
            // turn's successful tool_result ids, so captured facts land with
            // provenance {sessionId, evidence: toolUseIds}.
            // v0.3.0 §7.1 (PR 13 ∪ PR 10 reconciliation): the walk follows
            // sub_agent_start brackets into child session JSONLs (lazy reads,
            // capped per child by MAX_CAPTURE_EVENTS_PER_CHILD) so sub-agent
            // findings reach the store on BOTH wireMemory consumers — the
            // `crewhaus run` interpreter and compiled bundles. Child facts
            // land with provenance {sessionId: <child>} + a subagent:<name>
            // tag; unreadable child logs are skipped.
            const { turns, children } = await turnsFromEventsWithChildren(
              parseSessionEvents(raw),
              (childSessionId, maxEvents) => {
                let childRaw: string;
                try {
                  childRaw = readFileSync(join(sessionsDir, `${childSessionId}.jsonl`), "utf-8");
                } catch {
                  return undefined; // missing/unreadable child log — skip it
                }
                return parseSessionEvents(childRaw).slice(0, maxEvents);
              },
            );
            const facts = summarizeDurableFactsWithEvidence(turns);
            const written = await captureFacts(store, facts, ["auto-capture", sessionId], {
              sessionId,
              ...(mem.ttlMs !== undefined ? { ttlMs: mem.ttlMs } : {}),
            });
            written.push(
              ...(await captureChildFacts(store, children, ["auto-capture", sessionId], {
                ...(mem.ttlMs !== undefined ? { ttlMs: mem.ttlMs } : {}),
              })),
            );
            if (written.length > 0) {
              deps.log?.(
                `[memory] auto-captured ${written.length} durable fact(s) into ${store.path()}\n`,
              );
            }
          },
        }
      : {}),
  };

  return { store, tools, memory };
}

// ---------------------------------------------------------------------------
// continuity — store + tools + runtime seam
// ---------------------------------------------------------------------------

/** Render the `<current_plan>` tail content from store state: focus, the
 *  active plan's ladder, open goals. Deterministic; null when the store has
 *  nothing to say (the runtime then omits the block). */
async function renderPlanTail(
  store: ContinuityStore,
  includePlans: boolean,
): Promise<string | null> {
  const focus = await store.readFocus();
  const activePlan = includePlans ? await store.getActivePlan() : null;
  const goals = includePlans ? await store.listGoals() : [];
  const openGoals = goals.filter((g) => g.status !== "proven");

  const lines: string[] = [];
  if (focus !== null && focus.body !== "") {
    lines.push(`focus: ${focus.body}`);
  }
  if (activePlan !== null) {
    if (lines.length > 0) lines.push("");
    lines.push(`${activePlan.id} — ${activePlan.title}`);
    for (const step of activePlan.steps) {
      lines.push(`${step.index}. ${renderStatus(step.status)} ${step.text}`);
    }
  }
  if (openGoals.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("goals:");
    for (const goal of openGoals) {
      const progress =
        goal.target !== undefined
          ? ` (${goal.current ?? 0}/${goal.target}${goal.unit !== undefined ? ` ${goal.unit}` : ""})`
          : "";
      lines.push(`- ${goal.id} ${renderStatus(goal.status)} ${goal.title}${progress}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Wire the continuity slice alone: construct the (scoped, tenant-fenced)
 * continuity store, register the plan/focus/goal tools, and build the
 * `RunChatLoopOptions.continuity` seam. Returns null when the fragment
 * carries no enabled `continuity` block. Skill/command merging is
 * `wireMemory`'s job — granular callers keep their own prompt surface.
 */
export function wireContinuity(
  fragment: Pick<MemoryWiringFragment, "specName" | "continuity" | "thredz">,
  deps: WireMemoryDeps,
): WiredContinuity | null {
  if (!continuityEnabled(fragment)) return null;
  const cont = fragment.continuity ?? {};

  let scope: ContinuityScope = { kind: "spec" };
  if (cont.scope === "session") {
    if (deps.sessionScope === undefined) {
      throw new MemoryServiceError(
        `memory-service: continuity scope "session" needs deps.sessionScope (the conversation's session id) — ` +
          `the channel session router supplies it; spec-scoped harnesses use scope "spec".`,
      );
    }
    scope = { kind: "session", sessionId: deps.sessionScope };
  }

  // Under a tenant the store computes `<tenantRoot>/state` itself (and
  // fences it); outside one we anchor to the caller's cwd.
  const localStore = createContinuityStore({
    specName: fragment.specName,
    ...(deps.tenant !== undefined
      ? { tenant: deps.tenant }
      : {
          rootDir: join(deps.cwd, ".crewhaus", "state"),
          sessionRootDir: deps.sessionRootDir ?? join(deps.cwd, ".crewhaus", "sessions"),
        }),
    scope,
    ...(deps.sessionScope !== undefined ? { sessionId: deps.sessionScope } : {}),
    ...(cont.focusMaxChars !== undefined ? { focusMaxChars: cont.focusMaxChars } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  // v0.3.0 Goal 3 (§4.4) — the Thredz goal mirror. SPEC scope only (§14.5
  // resolved decision 5: goals are key-scoped server-side with tight plan
  // quotas — a per-conversation goal would burn the account immediately, so
  // session-scoped stores never mirror). The local write is authoritative
  // and always lands first; a Thredz-side failure skips with one classified
  // warning and never fails the write.
  const mirrorOn =
    fragment.thredz !== undefined &&
    (fragment.thredz.goals ?? true) &&
    cont.plan !== false &&
    scope.kind === "spec" &&
    deps.thredz !== null &&
    deps.thredz !== undefined;
  const store =
    mirrorOn && deps.thredz != null
      ? withThredzGoalMirror(localStore, {
          client: deps.thredz.client,
          specName: fragment.specName,
          ...(deps.log !== undefined ? { log: deps.log } : {}),
        })
      : localStore;

  const bundle = createPlanTools({
    specName: fragment.specName,
    store,
    ...(deps.sessionScope !== undefined ? { sessionId: deps.sessionScope } : {}),
    ...(deps.appendEvent !== undefined ? { appendEvent: deps.appendEvent } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  // §2.4 proof mode: the ladder is what tool-plan implements today. The
  // stricter/looser modes are carried through the fragment (spec → IR →
  // here) but degrade to the ladder until tool-plan grows a proof-mode
  // option — say so at boot instead of silently pretending (this package
  // consumes the plan-store packages; it does not modify them).
  if (cont.proof === "require" || cont.proof === "off") {
    deps.log?.(
      `[memory] continuity.proof "${cont.proof}" is carried but not enforced yet — running the default claimed→proven ladder (enforcement lands with tool-plan's proof-mode seam)\n`,
    );
  }

  const plan = cont.plan !== false;
  const tools = plan ? bundle.all : [bundle.focusRead, bundle.focusWrite, bundle.memoryClear];

  const continuity: ContinuitySeam = {
    loadPlan: () => renderPlanTail(store, plan),
    onPlanDirty: () => renderPlanTail(store, plan),
    ledger: cont.ledger !== false,
    ...(cont.handoff !== false
      ? {
          onHandoff: async (input: HandoffSeamInput) => {
            // Deterministic teardown write (§2.8): the store re-renders from
            // its own state — input.sessionId is the pickup pointer.
            await store.writeHandoff({ lastSessionId: input.sessionId });
          },
        }
      : {}),
  };

  return { store, tools, continuity };
}

// ---------------------------------------------------------------------------
// wiki — store + tools
// ---------------------------------------------------------------------------

export type WireWikiExtras = {
  /** Gap sink override — `wireMemory` routes gaps into the plan store when
   *  continuity is wired; standalone callers may supply their own. */
  readonly logGap?: (gap: KnowledgeGap) => string | Promise<string>;
};

/**
 * Wire the wiki slice alone. Three outcomes (design §4.3/§4.4):
 *
 *   - **Thredz backend** (fragment carries thredz/`backend: "thredz"` AND a
 *     live `deps.thredz` connection): the wiki surface is the bare-name
 *     aliases `connectThredz` already put on the catalog, so NO local store
 *     is constructed and NO local tools are registered (`store: null`,
 *     `tools: []`) — the local wiki on disk stays untouched (§5: removing
 *     `thredz:` reverts to files). The `recall` seam routes `wiki_recall`
 *     through the MCP client and renders the SAME recall-bundle line shape.
 *   - **Local backend**: as before — the (tenant-fenced) `WikiStore` plus
 *     the ten thredz-vocabulary `wiki_*` tools. This is ALSO the §4.4
 *     degrade target: Thredz configured but unreachable wires the local
 *     surface even without a `memory.wiki` block, so the tool vocabulary the
 *     spec promised never vanishes mid-run.
 *   - **null**: no wiki anywhere (no enabled `memory.wiki`, no thredz).
 */
export function wireWiki(
  fragment: Pick<MemoryWiringFragment, "specName" | "memory" | "thredz">,
  deps: WireMemoryDeps,
  extras: WireWikiExtras = {},
): WiredWiki | null {
  const full: MemoryWiringFragment = {
    specName: fragment.specName,
    ...(fragment.memory !== undefined ? { memory: fragment.memory } : {}),
    ...(fragment.thredz !== undefined ? { thredz: fragment.thredz } : {}),
  };
  const wantsThredz = thredzConfigured(full);
  const wikiOff = full.memory?.wiki?.enabled === false;

  // The Thredz backend flip (§4.3) — one connection, one vocabulary.
  if (wantsThredz && deps.thredz != null) {
    if (wikiOff) return null;
    const client = deps.thredz.client;
    const log = deps.log;
    return {
      backend: "thredz",
      store: null,
      tools: [],
      recall: async (query, k) => {
        let res: { content: string; isError: boolean };
        try {
          res = await client.callTool("wiki_recall", { query, limit: k });
        } catch (err) {
          log?.(
            `[thredz] wiki recall unavailable (thredz_unavailable): ${(err as Error).message}\n`,
          );
          return [];
        }
        if (res.isError) {
          log?.(`[thredz] wiki recall failed (${classifyThredzFailure(res.content)})\n`);
          return [];
        }
        return parseThredzRecallLines(res.content, k);
      },
    };
  }

  // Local backend — including the §4.4 degrade (thredz configured, no
  // connection): the promised wiki surface stays available on local files.
  const localOn = wantsThredz ? !wikiOff : wikiEnabled(full);
  if (!localOn) return null;
  const wiki = full.memory?.wiki ?? {};
  const embedder = resolveEmbedder(full, deps);

  const store = createWikiStore({
    specName: fragment.specName,
    ...(deps.tenant !== undefined
      ? { tenant: deps.tenant }
      : { rootDir: join(deps.cwd, ".crewhaus", "wiki") }),
    ...(embedder !== undefined ? { embedder } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  const bundle = createWikiTools({
    specName: fragment.specName,
    store,
    ...(embedder !== undefined ? { embedder } : {}),
    ...(wiki.requireSources === true ? { requireSources: true } : {}),
    ...(extras.logGap !== undefined ? { logGap: extras.logGap } : {}),
    ...(deps.appendEvent !== undefined ? { appendEvent: deps.appendEvent } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  return {
    backend: "file",
    store,
    tools: bundle.all,
    recall: async (query, k) => {
      const hits = await store.recall(query, k);
      return hits.map((h) => `[wiki:${h.ref.slug}] ${h.ref.title} — ${excerpt(h.body)}`);
    },
  };
}

// ---------------------------------------------------------------------------
// skills + slash commands (design §2.6 — builtin, lowest precedence)
// ---------------------------------------------------------------------------

/** Builtin slash commands gated by which feature backs their tools — an
 *  instruction body that loads a skill (or names a tool) the harness does
 *  not carry would strand the model. `/dream` (and the `dream` skill it
 *  loads) joins the gated set when `memory.dream` is configured (PR 14);
 *  `/study` `/reflect` join with the `learning:` block, and `/exam` only
 *  when the exam is actually runnable (`learning.exam` + an injected
 *  `deps.examRunner` — PR 17). */
const CONTINUITY_COMMANDS = ["plan", "focus", "next", "handoff", "clear-plan", "clear-focus"];
const MEMORY_COMMANDS = ["forget"];
const DREAM_COMMANDS = ["dream"];
const LEARNING_COMMANDS = ["study", "reflect"];
const EXAM_COMMANDS = ["exam"];

async function loadSkillsAndCommands(
  deps: WireMemoryDeps,
  features: {
    memory: boolean;
    dream: boolean;
    continuity: boolean;
    learning?: LearningWiringFragment;
    exam: boolean;
  },
): Promise<{ skills: ReadonlyArray<SkillRef>; slashCommands: ReadonlyMap<string, SlashCommand> }> {
  // Builtins the composition root ships: the continuity skill (when
  // continuity is on), the learning-loop skill RENDERED with the fragment's
  // domain/curriculum/sources substitutions (when learning is on, §3.3), and
  // the dream skill when a dream schedule is configured (its /dream command
  // loads it in-session, §6.3). All merge at LOWEST precedence — a user or
  // project skill with the same name overrides.
  const builtinSkills: LoadedSkill[] = [];
  for (const skill of DEFAULT_SKILLS) {
    if (skill.name === "continuity" && features.continuity) builtinSkills.push(skill);
    if (skill.name === "learning-loop" && features.learning !== undefined) {
      builtinSkills.push(renderedLearningSkill(features.learning));
    }
    if (skill.name === "dream" && features.dream) builtinSkills.push(skill);
  }
  const skills = await discoverSkills({
    cwd: deps.cwd,
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    ...(builtinSkills.length > 0 ? { builtinSkills } : {}),
  });

  const commands = await loadCommands({
    cwd: deps.cwd,
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    builtinDirs: [builtinCommandsDir],
  });
  const allowed = new Set([
    ...(features.continuity ? CONTINUITY_COMMANDS : []),
    ...(features.memory ? MEMORY_COMMANDS : []),
    ...(features.dream ? DREAM_COMMANDS : []),
    ...(features.learning !== undefined ? LEARNING_COMMANDS : []),
    ...(features.exam ? EXAM_COMMANDS : []),
  ]);
  for (const [name, command] of [...commands]) {
    const builtin = command.filePath.startsWith(builtinCommandsDir);
    if (builtin && !allowed.has(name)) commands.delete(name);
  }

  return { skills, slashCommands: commands };
}

// ---------------------------------------------------------------------------
// wireMemory — the composition root
// ---------------------------------------------------------------------------

/**
 * THE one stable call (design §1 principle 1). Constructs every store the
 * fragment asks for, registers the corresponding tools into `deps.catalog`,
 * and returns the spread-ready `RunChatLoopOptions` slice. Composes
 * {@link wireContinuity} and {@link wireWiki}; exposes them for callers that
 * need granularity.
 */
export async function wireMemory(
  fragment: MemoryWiringFragment,
  deps: WireMemoryDeps,
): Promise<WiredMemory> {
  if (typeof fragment.specName !== "string" || fragment.specName === "") {
    throw new MemoryServiceError("memory-service: fragment.specName is required");
  }

  // v0.3.0 Goal 3 (§4.4) — Thredz configured but no live connection (boot
  // failure, offline, or a consumer without an MCP host): degrade to the
  // local backend with ONE warning line. Never a crash — a lapsed Thredz
  // subscription must not kill a local-first harness.
  if (thredzConfigured(fragment) && deps.thredz == null) {
    deps.log?.(THREDZ_DEGRADE_NOTE);
  }

  const factsOn = memoryEnabled(fragment);
  const tools: RegisteredTool[] = [];
  const stores: { memory?: MemoryStore; continuity?: ContinuityStore; wiki?: WikiStore } = {};
  let options: WiredOptions = {};

  // 1. Facts (#53 memory block).
  if (factsOn) {
    const facts = wireFacts(fragment, deps);
    stores.memory = facts.store;
    tools.push(...facts.tools);
    options = { ...options, memory: facts.memory };
    const decision = deriveMemoryDecision(fragment.memory, Number.MAX_SAFE_INTEGER);
    deps.log?.(
      `[memory] Remember/Recall/MemoryForget wired (autoRecall=${decision.recall}, autoCapture=${fragment.memory?.autoCapture === true})\n`,
    );
  }

  // 2. Continuity (§2).
  const continuity = wireContinuity(fragment, deps);
  if (continuity !== null) {
    stores.continuity = continuity.store;
    tools.push(...continuity.tools);
    options = { ...options, continuity: continuity.continuity };
    deps.log?.(`[memory] continuity on — ${continuity.store.dir()} (focus · plans · goals)\n`);
  }

  // 3. Wiki (§3), with gaps routed into the plan store when it exists (§3.2).
  const wiki = wireWiki(fragment, deps, {
    ...(continuity !== null
      ? {
          logGap: async (gap: KnowledgeGap): Promise<string> => {
            const goal = await continuity.store.writeGoal({ title: `[gap] ${gap.topic}` });
            return `logged knowledge gap "${gap.topic}" → ${goal.id} (priority ${gap.priority}) — it is now a goal in the plan store; aim the next study pass at it`;
          },
        }
      : {}),
  });
  if (wiki !== null) {
    if (wiki.store !== null) stores.wiki = wiki.store;
    tools.push(...wiki.tools);
    deps.log?.(
      wiki.backend === "thredz"
        ? "[memory] wiki on — thredz backend (server-side articles via the thredz MCP aliases; the local wiki store stays untouched)\n"
        : `[memory] wiki on — ${wiki.store?.path()}\n`,
    );

    // §3.4/§9 — wiki auto-recall: fuse top-`recallK` wiki hits into the
    // session-start `<recalled_memory>` bundle. Explicit opt-in
    // (`wiki.autoRecall: true`), mirroring the fact store's autoRecall
    // semantics. Backend-invariant: `wiki.recall` renders the same line
    // shape from the local store or through the Thredz MCP client (§4.3).
    // The runtime classifies + delimiter-escapes the assembled block (the
    // same path fact lines take), so recalled wiki bodies still flow
    // through the boundary classifier before any model call.
    const wikiFrag = fragment.memory?.wiki;
    if (wikiFrag?.autoRecall === true) {
      const wikiK = wikiFrag.recallK ?? DEFAULT_WIKI_RECALL_K;
      const wikiRecall = wiki.recall;
      const base = options.memory;
      const baseRecall = base?.recall;
      options = {
        ...options,
        memory: {
          ...(base ?? {}),
          autoRecall: true,
          recall: async (query, k) => {
            const factLines = baseRecall !== undefined ? await baseRecall(query, k) : [];
            return [...factLines, ...(await wikiRecall(query, wikiK))];
          },
        },
      };
    }
  }

  // 4. Learning (§3.3, PR 17): the rendered learning-loop skill + the
  // /study /reflect commands join the surface below; the first-class exam
  // registers here when it is actually runnable (`learning.exam` configured
  // AND an injected runner). Exam failures auto-log knowledge gaps through
  // the SAME routing `log_knowledge_gap` uses — Thredz tasks on a live
  // hosted backend, plan-store `[gap]` goals locally — closing the
  // gap→study loop (failures become the next study pass's queue).
  const learning = fragment.learning;
  let examOn = false;
  if (learning !== undefined) {
    const thredzLive =
      thredzConfigured(fragment) && deps.thredz !== null && deps.thredz !== undefined
        ? deps.thredz
        : null;
    const examGapSink: ((gap: KnowledgeGap) => Promise<string>) | undefined =
      thredzLive !== null
        ? async (gap: KnowledgeGap): Promise<string> => {
            // Redact-on-write (§4.3): exam text leaving the machine for
            // Thredz passes the PII redactor, like every mirrored body.
            const redactor = createPiiRedactor();
            const res = await thredzLive.client.callTool("log_knowledge_gap", {
              topic: (await redactor.redact(gap.topic)).text,
              ...(gap.detail !== undefined
                ? { detail: (await redactor.redact(gap.detail)).text }
                : {}),
              tags: [...gap.tags],
              priority: gap.priority,
            });
            if (res.isError) {
              throw new Error(`log_knowledge_gap failed (${classifyThredzFailure(res.content)})`);
            }
            return `logged knowledge gap "${gap.topic}" to Thredz (tag knowledge-gap) — the next study pass picks it up`;
          }
        : continuity !== null
          ? async (gap: KnowledgeGap): Promise<string> => {
              const goal = await continuity.store.writeGoal({
                title: `${GAP_GOAL_PREFIX} ${gap.topic}`,
              });
              return `logged knowledge gap "${gap.topic}" → ${goal.id} — the next study pass picks it up`;
            }
          : undefined;
    if (learning.exam !== undefined && deps.examRunner !== undefined) {
      const examTool = createExamTool({
        learning: { ...learning, exam: learning.exam },
        examRunner: deps.examRunner,
        cwd: deps.cwd,
        ...(examGapSink !== undefined ? { logGap: examGapSink } : {}),
      });
      tools.push(examTool);
      examOn = true;
    }
    deps.log?.(
      `[learning] learning-loop on — domain "${learning.domain}"${
        examOn ? ` · exam: ${learning.exam?.dataset}` : ""
      }\n`,
    );
  }

  // 5. Skills + slash commands (§2.6): the composition root owns the prompt
  // surface whenever continuity or learning is on — builtins merged at
  // LOWEST precedence, commands gated by the features that back them.
  if (continuity !== null || learning !== undefined) {
    const { skills, slashCommands } = await loadSkillsAndCommands(deps, {
      memory: factsOn,
      dream: dreamEnabled(fragment),
      continuity: continuity !== null,
      ...(learning !== undefined ? { learning } : {}),
      exam: examOn,
    });
    options = { ...options, skills, slashCommands };
  }

  for (const tool of tools) {
    deps.catalog.register(tool);
  }

  return { stores, tools, options };
}

/** Default wiki hits fused into auto-recall (§9's `wiki.recallK: 6`). */
const DEFAULT_WIKI_RECALL_K = 6;

/** Cap on a fused wiki body inside the recall bundle — recall is a pointer
 *  surface (`wiki_get` fetches the full article), not a article dump. */
const WIKI_RECALL_EXCERPT_CHARS = 280;

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > WIKI_RECALL_EXCERPT_CHARS
    ? `${flat.slice(0, WIKI_RECALL_EXCERPT_CHARS)}…`
    : flat;
}

// ---------------------------------------------------------------------------
// dream — scheduled consolidation (design §6, PR 14)
// ---------------------------------------------------------------------------

/** Re-exported so consumers (CLI verbs, emitted daemons) get the engine's
 *  seam types from the composition root they already import. */
export type {
  DreamEngine,
  DreamJanitorStep,
  DreamModelPhase,
  DreamRunReport,
} from "@crewhaus/dream-engine";

/** The §6.3 boot catch-up line, exact (tests + the emitted bundles pin it). */
export const DREAM_BOOT_CATCHUP_NOTE =
  "[dream] overdue — deterministic pass done; run 'crewhaus dream' for full consolidation";

/**
 * Deps for the dream composition — deliberately NOT `WireMemoryDeps`: dream
 * wiring registers no tools (phase 2 acts through tools the CALLER wired
 * via `wireMemory` into its own session), so there is no catalog here.
 */
export type WireDreamDeps = {
  readonly cwd: string;
  /** Tenant fencing (§2.7) — re-roots every store under the tenant root. */
  readonly tenant?: Tenant;
  /** Where session `.jsonl` logs live. Default `<crewhausDir>/sessions`. */
  readonly sessionRootDir?: string;
  readonly embedder?: EmbedderLike;
  /** The injected model-session runner (built on runChatLoop by the CLI
   *  verb / daemon codegen). Absent → deterministic phase only. */
  readonly modelPhase?: DreamModelPhase;
  /** `dream_run` event sink — see `@crewhaus/event-log`'s payload type. */
  readonly appendEvent?: (event: {
    kind: "dream_run";
    payload: Record<string, unknown>;
  }) => void | Promise<void>;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
};

export type WiredDream = {
  readonly engine: DreamEngine;
};

/** Internal: construct a dream engine rooted at an explicit `.crewhaus`
 *  directory (the tenant-enumerating janitor step reuses it per tenant). */
function buildDreamEngine(
  fragment: MemoryWiringFragment,
  crewhausDir: string,
  deps: WireDreamDeps,
  opts: { readonly modelPhase?: DreamModelPhase } = {},
): DreamEngine {
  const dream = fragment.memory?.dream;
  if (dream === undefined) {
    throw new MemoryServiceError("memory-service: buildDreamEngine needs fragment.memory.dream");
  }
  const embedder = resolveEmbedder(fragment, deps);
  const sessionRootDir = deps.sessionRootDir ?? join(crewhausDir, "sessions");
  const memoryStore = createMemoryStore({
    specName: fragment.specName,
    rootDir: join(crewhausDir, "memories"),
    ...(embedder !== undefined ? { embedder } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  // §4.3 — with Thredz configured the local wiki store is not the wiki
  // backend, so the dream never consolidates it (facts + continuity stay
  // local always and keep consolidating; server-side wiki consolidation is
  // a future-features item).
  const wikiStore =
    wikiEnabled(fragment) && !thredzConfigured(fragment)
      ? createWikiStore({
          specName: fragment.specName,
          rootDir: join(crewhausDir, "wiki"),
          ...(embedder !== undefined ? { embedder } : {}),
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        })
      : undefined;
  // The dream consolidates the SPEC-scoped agenda always (§14.5: the
  // spec-scoped store holds the daemon's own agenda, which heartbeat/dream
  // read) — even when the harness's interactive continuity is
  // session-scoped (channel).
  const continuityStore = continuityEnabled(fragment)
    ? createContinuityStore({
        specName: fragment.specName,
        rootDir: join(crewhausDir, "state"),
        sessionRootDir,
        scope: { kind: "spec" },
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      })
    : undefined;
  // v0.3.0 Goal 2 (§3.3 study.on_dream, PR 17): with learning on, the model
  // phase's seeded prompt gains the top open knowledge gaps (the spec-scoped
  // plan store's `[gap]` goals) + the next unmastered curriculum rung —
  // composed onto the engine's EXISTING DreamModelPhase seam, computed fresh
  // per run. `study.on_dream: false` opts out.
  const learning = fragment.learning;
  const modelPhase =
    opts.modelPhase !== undefined && learning !== undefined && learning.study?.onDream !== false
      ? withLearningDreamSeed(opts.modelPhase, {
          learning,
          cwd: deps.cwd,
          listGaps: async (): Promise<readonly string[]> => {
            if (continuityStore === undefined) return [];
            const goals = await continuityStore.listGoals();
            return goals
              .filter((g) => g.status !== "proven" && g.title.startsWith(GAP_GOAL_PREFIX))
              .map((g) => g.title.slice(GAP_GOAL_PREFIX.length).trim());
          },
        })
      : opts.modelPhase;
  return createDreamEngine({
    specName: fragment.specName,
    crewhausDir,
    dream,
    sessionRootDir,
    memoryStore,
    ...(wikiStore !== undefined ? { wikiStore } : {}),
    ...(continuityStore !== undefined ? { continuityStore } : {}),
    ...(modelPhase !== undefined ? { modelPhase } : {}),
    playbook: DREAM_SKILL_BODY,
    ...(deps.appendEvent !== undefined ? { appendEvent: deps.appendEvent } : {}),
    ...(deps.log !== undefined ? { log: deps.log } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
}

/**
 * Wire the dream slice (§6): construct the stores the consolidation pass
 * reads/writes and hand back a ready `DreamEngine`. Returns null when the
 * fragment carries no `memory.dream` (or memory is disabled). The default
 * playbook is the builtin `dream` skill body; `dream.instructions` (spec)
 * overrides it inside the engine.
 */
export function wireDream(fragment: MemoryWiringFragment, deps: WireDreamDeps): WiredDream | null {
  if (!dreamEnabled(fragment)) return null;
  const engine = buildDreamEngine(fragment, crewhausDirOf(deps), deps, {
    ...(deps.modelPhase !== undefined ? { modelPhase: deps.modelPhase } : {}),
  });
  return { engine };
}

/**
 * The cli-shape boot catch-up (§6.3): when the schedule is OVERDUE, run the
 * DETERMINISTIC phase only — sub-second, zero spend — and return the exact
 * note line the bundle prints. Returns null when dream isn't configured,
 * isn't due, or another process is already consolidating (lock/window). Un-
 * attended model spend is never a side effect of starting a session — the
 * model phase stays behind `crewhaus dream` / the daemon janitor.
 */
export async function runDreamBootCatchUp(
  fragment: MemoryWiringFragment,
  deps: WireDreamDeps,
): Promise<string | null> {
  const wired = wireDream(fragment, deps);
  if (wired === null) return null;
  const status = await wired.engine.status();
  if (!status.overdue) return null;
  const report = await wired.engine.runDeterministic({ trigger: "boot" });
  if (report.cached) return null; // another process beat us to this window
  return DREAM_BOOT_CATCHUP_NOTE;
}

export type CreateDreamJanitorStepDeps = WireDreamDeps & {
  /** Managed daemons: enumerate `<tenantsRootDir>/<tenantId>/` per run and
   *  consolidate each tenant's stores DETERMINISTICALLY (the model phase is
   *  deliberately never run from a multi-tenant janitor — per-tenant model
   *  spend needs an explicit operator decision, i.e. a per-tenant cron of
   *  `crewhaus dream run`). */
  readonly tenantsRootDir?: string;
  /** Env override (tests). Default `process.env`. */
  readonly env?: Record<string, string | undefined>;
};

/**
 * The daemon integration (§6.3): a registrable janitor step, due-checked
 * against `.crewhaus/dream/<spec>/state.json` inside the existing
 * boot+hourly janitor tick. `CREWHAUS_DREAM=0` disables;
 * `CREWHAUS_DREAM_INTERVAL_MS` overrides the cadence. Returns null when the
 * fragment carries no dream schedule — emitters spread `...(step ? [step]
 * : [])` into `createJanitor({ steps })`.
 */
export function createDreamJanitorStep(
  fragment: MemoryWiringFragment,
  deps: CreateDreamJanitorStepDeps,
): DreamJanitorStep | null {
  if (!dreamEnabled(fragment)) return null;
  const env = deps.env !== undefined ? { env: deps.env } : {};

  if (deps.tenantsRootDir === undefined) {
    const wired = wireDream(fragment, deps);
    if (wired === null) return null;
    return dreamJanitorStep(wired.engine, env);
  }

  const tenantsRootDir = deps.tenantsRootDir;
  return {
    name: "dream_consolidation",
    run: async () => {
      let tenantIds: string[];
      try {
        const entries = await readdir(tenantsRootDir, { withFileTypes: true });
        tenantIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { status: "skipped", detail: `no tenants under ${tenantsRootDir}` };
        }
        throw err;
      }
      if (tenantIds.length === 0) {
        return { status: "skipped", detail: `no tenants under ${tenantsRootDir}` };
      }
      let ran = 0;
      let count = 0;
      const errors: string[] = [];
      for (const tenantId of tenantIds.sort()) {
        const engine = buildDreamEngine(fragment, join(tenantsRootDir, tenantId), {
          ...deps,
          sessionRootDir: join(tenantsRootDir, tenantId, "sessions"),
        });
        const outcome = await dreamJanitorStep(engine, env).run();
        if (outcome.status === "error") {
          errors.push(`${tenantId}: ${outcome.detail ?? "error"}`);
        } else if (outcome.status === "ok") {
          ran += 1;
          count += outcome.count ?? 0;
        }
      }
      if (errors.length > 0) {
        return { status: "error", count, detail: errors.join("; ") };
      }
      if (ran === 0) {
        return { status: "skipped", detail: `no tenant due (${tenantIds.length} checked)` };
      }
      return {
        status: "ok",
        count,
        detail: `deterministic consolidation across ${ran}/${tenantIds.length} tenant(s)`,
      };
    },
  };
}
