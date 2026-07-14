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
 * ## Backends
 *
 * `memory.backend` is a reserved discriminator: `"file"` (the default) is
 * implemented here; `"thredz"` fails fast with a clear not-yet-implemented
 * error until PR 16 lands the Thredz store implementations over the
 * already-connected McpHost client (design §4.3).
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
import { join, resolve } from "node:path";
import {
  type ContinuityScope,
  type ContinuityStore,
  createContinuityStore,
  renderStatus,
} from "@crewhaus/continuity-store";
import { DEFAULT_SKILLS, builtinCommandsDir } from "@crewhaus/default-skills";
import { createEmbedder } from "@crewhaus/embedder";
import { CrewhausError } from "@crewhaus/errors";
import {
  type MemoryStore,
  captureFacts,
  createMemoryStore,
  deriveMemoryDecision,
  summarizeDurableFactsWithEvidence,
  turnsFromEvents,
} from "@crewhaus/memory-store";
import { type SkillRef, discoverSkills } from "@crewhaus/skills-registry";
import { type SlashCommand, loadCommands } from "@crewhaus/slash-commands";
import type { Tenant } from "@crewhaus/tenancy";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { createMemoryTools } from "@crewhaus/tool-memory";
import { type ContinuityEvent, createPlanTools } from "@crewhaus/tool-plan";
import { type KnowledgeGap, type WikiEvent, createWikiTools } from "@crewhaus/tool-wiki";
import { type WikiStore, createWikiStore } from "@crewhaus/wiki-store";

export class MemoryServiceError extends CrewhausError {
  override readonly name = "MemoryServiceError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

// ---------------------------------------------------------------------------
// the fragment — what a future IrMemory/IrContinuity lowers into (design §9)
// ---------------------------------------------------------------------------

/** Storage backend discriminator. `"thredz"` is reserved: it lowers from the
 *  `thredz:` block (design §4) and flips every store to the Thredz MCP
 *  implementations in PR 16; until then it fails fast here. */
export type MemoryBackend = "file" | "thredz";

/** The `memory:` slice — `IrMemory` (#53) plus the §9 extensions this root
 *  wires today (`backend`, `ttlMs`, `wiki`). */
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
}): MemoryWiringFragment {
  const mem = ir.memory;
  const wiki = mem?.wiki;
  const cont = ir.continuity;
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
  readonly store: WikiStore;
  readonly tools: readonly RegisteredTool[];
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

function crewhausDirOf(deps: WireMemoryDeps): string {
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

function assertBackendImplemented(fragment: MemoryWiringFragment): void {
  const backend = fragment.memory?.backend;
  if (backend === undefined || backend === "file") return;
  // Reserved discriminator (design §4): loud and actionable, never a silent
  // local fallback that would strand writes on the wrong backend.
  throw new MemoryServiceError(
    `memory-service: backend "${backend}" is reserved but not implemented yet — the Thredz store flip ships with the thredz: block (design §4, PR 16). Use backend "file" (or omit it) until then.`,
  );
}

function resolveEmbedder(
  fragment: MemoryWiringFragment,
  deps: WireMemoryDeps,
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
            // §2.4 proof-linked capture: turnsFromEvents carries each turn's
            // successful tool_result ids, so captured facts land with
            // provenance {sessionId, evidence: toolUseIds}.
            const turns = turnsFromEvents(parseSessionEvents(raw));
            const facts = summarizeDurableFactsWithEvidence(turns);
            const written = await captureFacts(store, facts, ["auto-capture", sessionId], {
              sessionId,
              ...(mem.ttlMs !== undefined ? { ttlMs: mem.ttlMs } : {}),
            });
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
  fragment: Pick<MemoryWiringFragment, "specName" | "continuity">,
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
  const store = createContinuityStore({
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
 * Wire the wiki slice alone: construct the (tenant-fenced) wiki store and
 * register the ten thredz-vocabulary `wiki_*` tools. Returns null when the
 * fragment carries no enabled `memory.wiki` block (the wiki nests under
 * `memory:` — design §9 — so a disabled memory block disables it too).
 */
export function wireWiki(
  fragment: Pick<MemoryWiringFragment, "specName" | "memory">,
  deps: WireMemoryDeps,
  extras: WireWikiExtras = {},
): WiredWiki | null {
  const full: MemoryWiringFragment = {
    specName: fragment.specName,
    ...(fragment.memory !== undefined ? { memory: fragment.memory } : {}),
  };
  if (!wikiEnabled(full)) return null;
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

  return { store, tools: bundle.all };
}

// ---------------------------------------------------------------------------
// skills + slash commands (design §2.6 — builtin, lowest precedence)
// ---------------------------------------------------------------------------

/** Builtin slash commands gated by which feature backs their tools. The
 *  learning-loop commands (/study /reflect /exam) and /dream stay out until
 *  their skills/engines are wired (PR 14/17) — an instruction body that
 *  loads a skill the harness does not carry would strand the model. */
const CONTINUITY_COMMANDS = ["plan", "focus", "next", "handoff", "clear-plan", "clear-focus"];
const MEMORY_COMMANDS = ["forget"];

async function loadSkillsAndCommands(
  deps: WireMemoryDeps,
  features: { memory: boolean },
): Promise<{ skills: ReadonlyArray<SkillRef>; slashCommands: ReadonlyMap<string, SlashCommand> }> {
  // The continuity skill is the only builtin the composition root ships
  // today: learning-loop needs its {{domain}} substitutions rendered by the
  // learning: lowering (PR 17) and dream rides the dream engine (PR 14).
  const continuitySkill = DEFAULT_SKILLS.find((s) => s.name === "continuity");
  const skills = await discoverSkills({
    cwd: deps.cwd,
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    ...(continuitySkill !== undefined ? { builtinSkills: [continuitySkill] } : {}),
  });

  const commands = await loadCommands({
    cwd: deps.cwd,
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    builtinDirs: [builtinCommandsDir],
  });
  const allowed = new Set([...CONTINUITY_COMMANDS, ...(features.memory ? MEMORY_COMMANDS : [])]);
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
  assertBackendImplemented(fragment);

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
    const { skills, slashCommands } = await loadSkillsAndCommands(deps, { memory: factsOn });
    options = { ...options, continuity: continuity.continuity, skills, slashCommands };
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
    stores.wiki = wiki.store;
    tools.push(...wiki.tools);
    deps.log?.(`[memory] wiki on — ${wiki.store.path()}\n`);

    // §3.4/§9 — wiki auto-recall: fuse top-`recallK` wiki hits into the
    // session-start `<recalled_memory>` bundle. Explicit opt-in
    // (`wiki.autoRecall: true`), mirroring the fact store's autoRecall
    // semantics. The runtime classifies + delimiter-escapes the assembled
    // block (the same path fact lines take), so recalled wiki bodies still
    // flow through the boundary classifier before any model call.
    const wikiFrag = fragment.memory?.wiki;
    if (wikiFrag?.autoRecall === true) {
      const wikiK = wikiFrag.recallK ?? DEFAULT_WIKI_RECALL_K;
      const wikiStore = wiki.store;
      const base = options.memory;
      const baseRecall = base?.recall;
      options = {
        ...options,
        memory: {
          ...(base ?? {}),
          autoRecall: true,
          recall: async (query, k) => {
            const factLines = baseRecall !== undefined ? await baseRecall(query, k) : [];
            const hits = await wikiStore.recall(query, wikiK);
            return [
              ...factLines,
              ...hits.map((h) => `[wiki:${h.ref.slug}] ${h.ref.title} — ${excerpt(h.body)}`),
            ];
          },
        },
      };
    }
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
