/**
 * `@crewhaus/tool-work`: the Work tools (module brief 333, #516, #514, #513). A harness
 * that lists them keeps a work list: what it was asked to do, what it proposes, and what
 * it delivered. They read and write `./work-items`' store in the harness directory (the
 * standalone-harness convention: `process.cwd()`).
 *
 * | Tool | readOnly | destructive | What |
 * |---|---|---|---|
 * | `WorkList` | yes | no | the items, with their status in words and their place |
 * | `WorkGet` | yes | no | one item: what was asked, done-when, why, notes, runs |
 * | `WorkPropose` | no | no | a proposal, with its assessment; the same source is one item |
 * | `WorkUpdate` | no | yes | a note, a linked run, a delivery, an edit of its own proposal, or a close with a reason |
 *
 * The workspace tools beside them (`./workspace-tools`) deliver an accepted item as one pull
 * request.
 *
 * The tools propose, add notes, link runs and close with a reason. They never accept,
 * decline or cancel, never rewrite an accepted item, and never claim an operator's or an
 * API caller's source: the store refuses each (`WORK_ACTOR_RULES`). Only the owner's
 * policy (`tool_config.work.accept`, through {@link registerWorkConfig}) lets the runtime
 * accept a proposal of a listed kind, and never a feature or a speculative proposal with
 * nothing observed.
 *
 * ## One work list per harness, never per tenant
 *
 * The store lives in the harness directory, so only the harness itself and Home's own runs
 * (tenant {@link WORK_HOME_TENANT}) reach it. Inside any other tenant's context, a managed
 * daemon's client, all four tools refuse before they open the store.
 *
 * ## Pillar 3: text read back at the origin it came through
 *
 * Work text reaches the model through `WorkList` and `WorkGet`, which set
 * `classifyOutput: false` and classify inside the tool instead, field by field, each at the
 * origin its revision recorded: `api` for what a person or an API caller wrote, `memory`
 * for what the harness wrote in an earlier run, `mcp` for an adopted Thredz task. Fields of
 * one origin are then classified side by side, so an injection split across two of them is
 * caught; a malicious verdict replaces the field (or, side by side, every field of that
 * origin) with the redaction notice. Kept text is tagged into the run's data lineage at its
 * origin, so the sink side can attribute it.
 */
import {
  type BoundaryResult,
  type TrustOrigin,
  buildRedactionNotice,
  classifyBoundary,
} from "@crewhaus/boundary-classifier";
import {
  CANONICAL_RUN_ID_RE,
  WORK_BASES,
  WORK_KINDS,
  type WorkAssessment,
  isId,
  parseRef,
} from "@crewhaus/control-contract";
import { type RunContext, tagContent } from "@crewhaus/run-context";
import { currentTenantContext } from "@crewhaus/tenancy";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  type FoldedWorkItem,
  type WorkActor,
  type WorkConfig,
  type WorkRefusal,
  type WorkRevision,
  type WorkStore,
  evidenceWords,
  itemViews,
  openWorkStore,
  parseWorkConfig,
  viewContext,
} from "./work-items/index";
import { createWorkspaceTools } from "./workspace-tools";

export { WorkConfigError } from "./work-items/index";
export { bindWorkspaceRepositories } from "./workspace/bindings";
export {
  WorkspaceToolError,
  type WorkspaceToolsDeps,
  createWorkspaceTools,
} from "./workspace-tools";

let workConfig: WorkConfig = {};

/**
 * The boot registrar: `tool_config.work`, checked and kept for the tools. A block it cannot
 * take is refused with a message naming the key; no block registers nothing.
 */
export function registerWorkConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  workConfig = parseWorkConfig(config);
}

/** The registered `tool_config.work`. */
export function getWorkConfig(): WorkConfig {
  return workConfig;
}

export class WorkToolError extends Error {
  override readonly name = "WorkToolError";
}

/**
 * The tenant Home's own runs serve on a managed daemon (the gateway's `HOME_RUN_TENANT`;
 * a control-service test pins the two equal). The only tenant whose runs reach the store.
 */
export const WORK_HOME_TENANT = "home";

/** Refuse inside any tenant context but Home's own: the store is the harness's, not a tenant's. */
function assertHarnessTenant(): void {
  const ctx = currentTenantContext();
  if (ctx !== undefined && ctx.tenant.id !== WORK_HOME_TENANT) {
    throw new WorkToolError("Work items are not available to a managed tenant's runs.");
  }
}

type Classify = (text: string, opts: { readonly origin: TrustOrigin }) => Promise<BoundaryResult>;

export type WorkToolsDeps = {
  /** The harness directory; default `process.cwd()` when a call runs. */
  readonly harnessDir?: string;
  /** The classifier text meets; default `classifyBoundary`. */
  readonly classify?: Classify;
  readonly now?: () => number;
  /** The configuration the tools read; default the boot registration. */
  readonly config?: () => WorkConfig;
};

function runContextOf(ctx: ToolExecuteContext | undefined): RunContext | undefined {
  if (ctx?.runContext !== undefined) return ctx.runContext;
  return (ctx?.bridge as { runContext?: RunContext } | undefined)?.runContext;
}

/** Who a tool call writes as: the harness, in the run it is part of. */
function actorOf(rc: RunContext | undefined): WorkActor {
  const run = rc?.runId;
  return {
    by: "sys:runtime",
    via: "tool",
    role: "harness",
    ...(run !== undefined && CANONICAL_RUN_ID_RE.test(run) ? { run } : {}),
  };
}

/** A work item named as `wi_…` or `<harness>/work/wi_…`, as its bare id. */
function workIdOf(raw: string): string {
  if (isId("wi", raw)) return raw;
  const parsed = parseRef(raw);
  if (!("error" in parsed) && parsed.kind === "work") return parsed.id;
  throw new WorkToolError(`"${raw}" is not a work item: name it as wi_…`);
}

function fail(refusal: WorkRefusal): never {
  throw new WorkToolError(
    `${refusal.message}${refusal.current !== undefined ? ` (now: ${refusal.current})` : ""}`,
  );
}

type Field = { readonly key: string; readonly text: string; readonly origin: TrustOrigin };

/**
 * Classify each field at its own origin, then the fields of each origin side by side. A
 * field that comes back malicious is the redaction notice; a side-by-side verdict redacts
 * every field of that origin. Kept text is tagged at its origin.
 */
async function classifyFields(
  fields: readonly Field[],
  classify: Classify,
  rc: RunContext | undefined,
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  const kept: Field[] = [];
  for (const field of fields) {
    const verdict = await classify(field.text, { origin: field.origin });
    if (verdict.action === "redact") {
      out.set(field.key, verdict.redacted ?? buildRedactionNotice(verdict.verdict.hits));
    } else {
      kept.push(field);
    }
  }
  const origins = [...new Set(kept.map((f) => f.origin))];
  for (const origin of origins) {
    const group = kept.filter((f) => f.origin === origin);
    if (group.length < 2) continue;
    const joined = await classify(group.map((f) => f.text).join("\n"), { origin });
    if (joined.action === "redact") {
      const notice = joined.redacted ?? buildRedactionNotice(joined.verdict.hits);
      for (const f of group) out.set(f.key, notice);
    }
  }
  for (const field of kept) {
    if (out.has(field.key)) continue;
    out.set(field.key, field.text);
    if (rc !== undefined) tagContent(rc, field.text, field.origin);
  }
  return out;
}

const TOOL_ORIGIN: TrustOrigin = "memory";

function originOf(revision: WorkRevision, field: keyof WorkRevision["fieldOrigins"]): TrustOrigin {
  return revision.fieldOrigins[field] ?? TOOL_ORIGIN;
}

/** An assessment as the model reads it: a hypothesis always reads as one. */
function assessmentText(a: WorkAssessment): string {
  const lines = [`Problem: ${a.problem}`];
  if (a.audience !== undefined) lines.push(`Who it affects: ${a.audience}`);
  for (const [heading, list] of [
    ["Evidence", a.evidence],
    ["Counter-evidence", a.counterEvidence],
  ] as const) {
    if (list.length === 0) {
      if (heading === "Evidence") lines.push("Evidence: usage unknown");
      continue;
    }
    lines.push(`${heading}:`);
    for (const e of list) {
      lines.push(
        `- (${evidenceWords(e)}, ${e.kind}${e.ref !== undefined ? `, ${e.ref}` : ""}) ${e.note}`,
      );
    }
  }
  if (a.intentFit?.supports !== undefined) lines.push(`Fits the purpose: ${a.intentFit.supports}`);
  if (a.intentFit?.conflicts !== undefined)
    lines.push(`Conflicts with it: ${a.intentFit.conflicts}`);
  if (a.outcome !== undefined) lines.push(`Outcome: ${a.outcome}`);
  if (a.alternatives !== undefined) lines.push(`Alternatives: ${a.alternatives.join("; ")}`);
  if (a.doNothing !== undefined) lines.push(`If nothing is done: ${a.doNothing}`);
  const levels = (["cost", "upkeep", "uncertainty", "reversibility"] as const)
    .filter((k) => a[k] !== undefined)
    .map((k) => `${k} ${a[k]}/3`);
  if (levels.length > 0) lines.push(`Levels: ${levels.join(", ")}`);
  if (a.dependencies !== undefined) lines.push(`Depends on: ${a.dependencies.join("; ")}`);
  if (a.measure !== undefined) lines.push(`How value is measured: ${a.measure}`);
  return lines.join("\n");
}

const STATES = ["proposed", "open", "closed", "all"] as const;

const listInput = z
  .object({
    state: z
      .enum(STATES)
      .optional()
      .describe("Which items: proposed, open, closed or all. Default: open and proposed."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("At most this many rows. Default 30."),
  })
  .strict();

const getInput = z
  .object({ work: z.string().min(1).max(200).describe("The work item, wi_….") })
  .strict();

const evidenceInput = z
  .object({
    label: z.enum(["observed", "reported", "hypothesis"]),
    kind: z.enum([
      "observed-usage",
      "user-report",
      "maintainer-note",
      "advisory",
      "release-note",
      "dependency-change",
      "inferred",
      "simulated",
    ]),
    ref: z.string().min(1).max(500).optional(),
    note: z.string().min(1).max(2048),
    observedAt: z.string().optional(),
  })
  .strict();

const assessmentInput = z
  .object({
    problem: z.string().min(1).max(2048),
    audience: z.string().min(1).max(2048).optional(),
    evidence: z.array(evidenceInput).max(50),
    counterEvidence: z.array(evidenceInput).max(50),
    intentFit: z
      .object({
        supports: z.string().min(1).max(2048).optional(),
        conflicts: z.string().min(1).max(2048).optional(),
      })
      .strict()
      .optional(),
    outcome: z.string().min(1).max(2048).optional(),
    alternatives: z.array(z.string().min(1).max(500)).max(20).optional(),
    doNothing: z.string().min(1).max(2048).optional(),
    cost: z.number().int().min(0).max(3).optional(),
    upkeep: z.number().int().min(0).max(3).optional(),
    uncertainty: z.number().int().min(0).max(3).optional(),
    reversibility: z.number().int().min(0).max(3).optional(),
    dependencies: z.array(z.string().min(1).max(500)).max(20).optional(),
    measure: z.string().min(1).max(2048).optional(),
  })
  .strict();

const proposeInput = z
  .object({
    title: z.string().min(1).max(200),
    goal: z.string().min(1).max(8192).optional(),
    acceptance: z.array(z.string().min(1).max(500)).max(20).optional(),
    kind: z.enum(WORK_KINDS as unknown as [string, ...string[]]),
    basis: z
      .enum(WORK_BASES as unknown as [string, ...string[]])
      .describe(
        "Why it matters: compatibility-security (keeps it safe and working), user-pain (people ran into it) or speculative (an idea).",
      ),
    assessment: assessmentInput
      .optional()
      .describe("The case for it. Required for a feature, with doNothing."),
    source: z
      .object({
        kind: z.enum(["agent", "schedule", "github-issue", "channel", "continuity-goal"]),
        ref: z.string().min(1).max(500).optional(),
      })
      .strict()
      .optional()
      .describe("Where it came from. The same source is one item, however often it is proposed."),
    priority: z.number().int().min(1).max(4).optional(),
  })
  .strict();

const updateInput = z
  .object({
    work: z.string().min(1).max(200).describe("The work item, wi_…."),
    note: z.string().min(1).max(4096).optional(),
    close: z
      .object({
        outcome: z.enum(["done", "failed", "superseded"]),
        reasonCode: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
        supersededBy: z.string().optional(),
      })
      .strict()
      .optional(),
    deliver: z
      .object({ kind: z.enum(["report", "answer", "artifact"]), ref: z.string().min(1).max(500) })
      .strict()
      .optional(),
    link: z.literal(true).optional().describe("Link this run to the item."),
    edit: z
      .object({
        expect: z.number().int().positive().describe("The revision WorkGet showed."),
        title: z.string().min(1).max(200).optional(),
        goal: z.string().min(1).max(8192).optional(),
        acceptance: z.array(z.string().min(1).max(500)).max(20).optional(),
        kind: z.enum(WORK_KINDS as unknown as [string, ...string[]]).optional(),
        basis: z.enum(WORK_BASES as unknown as [string, ...string[]]).optional(),
        assessment: assessmentInput.optional(),
        priority: z.number().int().min(1).max(4).optional(),
      })
      .strict()
      .optional()
      .describe("Change your own proposal, before anyone accepts it."),
  })
  .strict();

/** Build the four tools over one harness. Tests pass `harnessDir` and a counted classifier. */
export function createWorkTools(deps: WorkToolsDeps = {}): {
  readonly workList: RegisteredTool;
  readonly workGet: RegisteredTool;
  readonly workPropose: RegisteredTool;
  readonly workUpdate: RegisteredTool;
} {
  const classify: Classify = deps.classify ?? ((text, opts) => classifyBoundary(text, opts));
  const config = deps.config ?? getWorkConfig;
  const storeOf = (): { readonly store: WorkStore; readonly dir: string } => {
    assertHarnessTenant();
    const dir = deps.harnessDir ?? process.cwd();
    return { store: openWorkStore(dir, deps.now !== undefined ? { now: deps.now } : {}), dir };
  };

  const workList = buildTool({
    name: "WorkList",
    description:
      "List this harness's work items: what it was asked to do, what it proposed, and what is done. Each row has the item id, its status, kind, basis, priority and place in the ranking. Text written by people or earlier runs is checked before you see it.",
    inputSchema: listInput,
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    scope: "internal",
    operativeArgs: [],
    classifyOutput: false,
    execute: async (input, ctx) => {
      const rc = runContextOf(ctx);
      const { store, dir } = storeOf();
      const folded = store.fold();
      if (!folded.ok) fail(folded);
      const all = [...folded.items.values()];
      const wanted = all.filter((item) =>
        input.state === undefined
          ? item.state !== "closed"
          : input.state === "all" || item.state === input.state,
      );
      const weights = config().ranking?.weights;
      const views = itemViews(store, wanted, viewContext(dir, folded, weights));
      const limit = input.limit ?? 30;
      const rows = views
        .sort((a, b) =>
          a.state !== b.state
            ? a.state.localeCompare(b.state)
            : (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
        )
        .slice(0, limit);
      if (rows.length === 0) return "No work items.";
      const fields: Field[] = rows.map((row) => {
        const item = folded.items.get(row.id) as FoldedWorkItem;
        const revision = store.revision(item.id, item.rev);
        return {
          key: row.id,
          text: row.title,
          origin: revision !== undefined ? originOf(revision, "title") : TOOL_ORIGIN,
        };
      });
      const titles = await classifyFields(fields, classify, rc);
      const lines = rows.map((row) => {
        const parts = [
          row.id,
          row.statusWord,
          row.kind,
          ...(row.basis !== undefined ? [row.basis] : []),
          ...(row.priority !== undefined ? [`priority ${row.priority}`] : []),
          ...(row.position !== undefined ? [`#${row.position}`] : []),
          ...(row.corrected !== undefined ? ["placed by a person"] : []),
        ];
        return `${parts.join(" · ")} — ${titles.get(row.id) ?? ""}`;
      });
      const more = views.length > rows.length ? [`(${views.length - rows.length} more)`] : [];
      return [...lines, ...more].join("\n");
    },
  });

  const workGet = buildTool({
    name: "WorkGet",
    description:
      "Read one work item: what was asked, when it is done, why (for a proposal: its evidence, each labelled observed, reported or hypothesis), its notes, deliveries, linked runs and revision. Text written by people or earlier runs is checked before you see it.",
    inputSchema: getInput,
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    scope: "internal",
    operativeArgs: [{ field: "work", kind: "id" }],
    classifyOutput: false,
    execute: async (input, ctx) => {
      const rc = runContextOf(ctx);
      const { store, dir } = storeOf();
      const wi = workIdOf(input.work);
      const read = store.get(wi);
      if ("ok" in read) fail(read);
      const { item, revision } = read;
      if (revision === undefined) {
        throw new WorkToolError("This item's content could not be read.");
      }
      const fold = store.fold();
      const folded = fold.ok ? fold : undefined;
      const view =
        folded === undefined
          ? undefined
          : itemViews(store, [item], viewContext(dir, folded, config().ranking?.weights))[0];
      const fields: Field[] = [
        { key: "title", text: revision.title, origin: originOf(revision, "title") },
      ];
      if (revision.goal !== undefined) {
        fields.push({ key: "goal", text: revision.goal, origin: originOf(revision, "goal") });
      }
      if (revision.acceptance !== undefined && revision.acceptance.length > 0) {
        fields.push({
          key: "acceptance",
          text: revision.acceptance.map((c) => `- ${c}`).join("\n"),
          origin: originOf(revision, "acceptance"),
        });
      }
      if (revision.assessment !== undefined) {
        fields.push({
          key: "assessment",
          text: assessmentText(revision.assessment),
          origin: originOf(revision, "assessment"),
        });
      }
      const sourceText = [revision.source?.ref, revision.source?.url]
        .filter((s) => s !== undefined)
        .join(" ");
      if (sourceText !== "") {
        fields.push({ key: "source", text: sourceText, origin: originOf(revision, "source") });
      }
      if (revision.sourceExcerpt !== undefined) {
        fields.push({
          key: "excerpt",
          text: revision.sourceExcerpt,
          origin: originOf(revision, "excerpt"),
        });
      }
      (revision.notes ?? []).forEach((note, i) => {
        fields.push({ key: `note.${i}`, text: note.text, origin: note.origin });
      });
      (revision.delivered ?? []).forEach((d, i) => {
        fields.push({ key: `delivered.${i}`, text: d.ref, origin: d.origin });
      });
      const text = await classifyFields(fields, classify, rc);
      const out = [
        `${item.id} — ${text.get("title")}`,
        `Status: ${view?.statusWord ?? item.state} · kind ${item.kind}${item.basis !== undefined ? ` · basis ${item.basis}` : ""}${item.priority !== undefined ? ` · priority ${item.priority}` : ""} · revision ${item.rev}`,
      ];
      if (revision.source !== undefined) {
        out.push(
          `Source: ${revision.source.kind}${text.has("source") ? ` ${text.get("source")}` : ""}`,
        );
      }
      if (text.has("goal")) out.push("", "What's asked:", text.get("goal") as string);
      if (text.has("acceptance")) out.push("", "Done when:", text.get("acceptance") as string);
      if (text.has("assessment")) out.push("", "Why:", text.get("assessment") as string);
      if (text.has("excerpt")) out.push("", "From the source:", text.get("excerpt") as string);
      const notes = revision.notes ?? [];
      if (notes.length > 0) {
        out.push("", "Notes:");
        notes.forEach((note, i) => out.push(`- ${note.at}: ${text.get(`note.${i}`)}`));
      }
      const delivered = revision.delivered ?? [];
      if (delivered.length > 0) {
        out.push("", "Delivered:");
        delivered.forEach((d, i) => out.push(`- ${d.kind}: ${text.get(`delivered.${i}`)}`));
      }
      if (item.runs.length > 0) out.push("", `Runs: ${item.runs.join(", ")}`);
      return out.join("\n");
    },
  });

  const workPropose = buildTool({
    name: "WorkPropose",
    description:
      "Propose work for this harness. A person (or the owner's policy) decides whether it is accepted. Say why it matters (basis) and, for a feature, what happens if nothing is done. Label evidence honestly: observed, reported, or hypothesis — a guess or a simulated reaction is a hypothesis, never a request. Proposing the same source again returns the existing item.",
    inputSchema: proposeInput,
    readOnly: false,
    destructive: false,
    scope: "internal",
    operativeArgs: [],
    execute: async (input, ctx) => {
      const rc = runContextOf(ctx);
      const { store } = storeOf();
      const accept = config().accept;
      const written = await store.propose(
        {
          title: input.title,
          ...(input.goal !== undefined ? { goal: input.goal } : {}),
          ...(input.acceptance !== undefined ? { acceptance: input.acceptance } : {}),
          kind: input.kind as FoldedWorkItem["kind"],
          basis: input.basis as NonNullable<FoldedWorkItem["basis"]>,
          ...(input.assessment !== undefined ? { assessment: input.assessment } : {}),
          ...(input.source !== undefined
            ? {
                source: {
                  kind: input.source.kind,
                  ...(input.source.ref !== undefined ? { ref: input.source.ref } : {}),
                },
              }
            : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
        },
        actorOf(rc),
        accept !== undefined ? { policy: { accept } } : {},
      );
      if (!written.ok) fail(written);
      return JSON.stringify({ work: written.item.id, state: written.item.state });
    },
  });

  const workUpdate = buildTool({
    name: "WorkUpdate",
    description:
      "Update a work item: add a note, link this run, record what you delivered, change your own proposal before it is accepted, or close an accepted item as done, failed or superseded with a reason code. You cannot accept, decline or cancel work. One call is one change: if any part is refused, nothing is written. An item keeps at most 100 notes and 100 deliveries, and their text has a size budget; once full, further notes or deliveries are refused.",
    inputSchema: updateInput,
    readOnly: false,
    destructive: true,
    scope: "internal",
    operativeArgs: [{ field: "work", kind: "id" }],
    execute: async (input, ctx) => {
      const rc = runContextOf(ctx);
      const actor = actorOf(rc);
      const { store } = storeOf();
      const wi = workIdOf(input.work);
      const wants =
        input.note !== undefined ||
        input.close !== undefined ||
        input.deliver !== undefined ||
        input.link === true ||
        input.edit !== undefined;
      if (!wants)
        throw new WorkToolError("Say what to change: note, link, deliver, edit or close.");
      // A run started for this item links on its first update, while the item is not
      // closed: after a close the run still records a note or a delivery. Only an
      // explicit link is refused on a closed item. One write: every check first, so a
      // refused call writes nothing and a retry duplicates nothing.
      if (input.link === true && actor.run === undefined) {
        throw new WorkToolError("This run has no id a work item can link to.");
      }
      const link =
        actor.run === undefined
          ? undefined
          : input.link === true
            ? { run: actor.run }
            : rc?.workItem === wi
              ? { run: actor.run, whileOpen: true }
              : undefined;
      const edit = input.edit;
      const written = await store.apply(
        wi,
        {
          ...(link !== undefined ? { link } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(edit !== undefined
            ? {
                edit: {
                  ...(edit as Omit<typeof edit, "kind" | "basis">),
                  ...(edit.kind !== undefined ? { kind: edit.kind as FoldedWorkItem["kind"] } : {}),
                  ...(edit.basis !== undefined
                    ? { basis: edit.basis as NonNullable<FoldedWorkItem["basis"]> }
                    : {}),
                },
              }
            : {}),
          ...(input.deliver !== undefined ? { deliver: input.deliver } : {}),
          ...(input.close !== undefined
            ? {
                close: {
                  outcome: input.close.outcome,
                  reasonCode: input.close.reasonCode,
                  ...(input.close.supersededBy !== undefined
                    ? { supersededBy: workIdOf(input.close.supersededBy) }
                    : {}),
                },
              }
            : {}),
        },
        actor,
      );
      if (!written.ok) fail(written);
      const after = store.get(wi);
      if ("ok" in after) fail(after);
      return JSON.stringify({ work: wi, state: after.item.state });
    },
  });

  return { workList, workGet, workPropose, workUpdate };
}

const DEFAULT_TOOLS = createWorkTools();

/** `WorkList`: the harness's work items, read only. */
export const workList: RegisteredTool = DEFAULT_TOOLS.workList;
/** `WorkGet`: one work item in full, read only. */
export const workGet: RegisteredTool = DEFAULT_TOOLS.workGet;
/** `WorkPropose`: propose work; a person or the owner's policy accepts it. */
export const workPropose: RegisteredTool = DEFAULT_TOOLS.workPropose;
/** `WorkUpdate`: a note, a link, a delivery, an edit of its own proposal, or a close. */
export const workUpdate: RegisteredTool = DEFAULT_TOOLS.workUpdate;

const DEFAULT_WORKSPACE_TOOLS = createWorkspaceTools();

/** `WorkspaceOpen`: a worktree for an accepted item, on its own branch. */
export const workspaceOpen: RegisteredTool = DEFAULT_WORKSPACE_TOOLS.workspaceOpen;
/** `WorkspaceCheck`: the declared checks on an item's worktree, in the sandbox. */
export const workspaceCheck: RegisteredTool = DEFAULT_WORKSPACE_TOOLS.workspaceCheck;
/** `WorkspacePublish`: an item's change as one pull request, after every gate. */
export const workspacePublish: RegisteredTool = DEFAULT_WORKSPACE_TOOLS.workspacePublish;
