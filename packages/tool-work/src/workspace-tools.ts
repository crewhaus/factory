/**
 * The workspace tools: `WorkspaceOpen`, `WorkspaceCheck` and `WorkspacePublish`. A harness
 * whose spec lists them and declares `repositories:` delivers an accepted work item as one
 * pull request from an isolated checkout (`./workspace`).
 *
 * | Tool | readOnly | destructive | scope · io | justify | What |
 * |---|---|---|---|---|---|
 * | `WorkspaceOpen` | no | no | external · network | no | a worktree for an accepted item, on its own branch |
 * | `WorkspaceCheck` | no | yes | external · process | no | the declared checks, in the sandbox |
 * | `WorkspacePublish` | no | yes | external · network | yes | the change as a pull request, after every gate |
 *
 * The destination is never the model's: the repository, its base and the branch prefix come
 * from the active build, and the branch is minted from the item. `WorkspaceCheck` runs a
 * project's own code over changes a model wrote, so it runs in the sandbox and is refused
 * without one. A publish past the binding's size limits waits for a person, with the counts.
 *
 * What the agent gets back from a publish is the verdict as a word. The judge's reasons, and
 * the intent it may quote, go to the owner's file alone.
 */
import { resolve } from "node:path";
import { isId, parseRef } from "@crewhaus/control-contract";
import { readApproverProjection, readHarnessIdentity } from "@crewhaus/control-records";
import { EXIT_CODES, RunFailedError } from "@crewhaus/errors";
import type { RunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { inManagedTenant } from "./tenant";
import { workDirOf } from "./work-items/index";
import type { AcceptanceJudge } from "./workspace/acceptance";
import {
  acceptanceIntent,
  acceptanceJudgeConfig,
  activeBindings,
  assertHarnessCwd,
} from "./workspace/bindings";
import type { CheckRunner } from "./workspace/checks";
import {
  type EngineActor,
  type EngineDeps,
  type WorkspaceEngine,
  type WorkspaceRefusal,
  createWorkspaceEngine,
} from "./workspace/engine";
import { createAcceptanceJudge } from "./workspace/judge";
import {
  type OverLimitsApprovals,
  overLimitsPort,
  raiseOverLimits,
  spenderOf,
} from "./workspace/limits";
import { CONCERNS_MAX, CONCERN_MAX, SUMMARY_MAX, TITLE_MAX } from "./workspace/pr-body";

export class WorkspaceToolError extends Error {
  override readonly name = "WorkspaceToolError";
}

function assertHarnessTenant(): void {
  if (inManagedTenant()) {
    throw new WorkspaceToolError("Workspaces are not available to a managed tenant's runs.");
  }
}

export type WorkspaceToolsDeps = {
  /** The harness directory; default `process.cwd()` when a call runs. */
  readonly harnessDir?: string;
  /** The judge; default the model the spec names, over `@crewhaus/eval-judge`. */
  readonly judge?: AcceptanceJudge;
  /** What runs a check; default the configured sandbox, `null` for none. */
  readonly checkRunner?: CheckRunner | null;
  /** The engine's other ports, for a test. */
  readonly engine?: Partial<EngineDeps>;
  readonly now?: () => number;
};

function runContextOf(ctx: ToolExecuteContext | undefined): RunContext | undefined {
  if (ctx?.runContext !== undefined) return ctx.runContext;
  return (ctx?.bridge as { runContext?: RunContext } | undefined)?.runContext;
}

/** The run's approval seam, when it parks headless asks. */
function approvalsOf(ctx: ToolExecuteContext | undefined): OverLimitsApprovals | undefined {
  const bridge = ctx?.bridge as
    | { readonly approvals?: OverLimitsApprovals; readonly askMode?: "pause" | "deny" }
    | undefined;
  if (bridge?.approvals === undefined || bridge.askMode === "deny") return undefined;
  return bridge.approvals;
}

function workIdOf(raw: string): string {
  if (isId("wi", raw)) return raw;
  const parsed = parseRef(raw);
  if (!("error" in parsed) && parsed.kind === "work") return parsed.id;
  throw new WorkspaceToolError(`"${raw}" is not a work item: name it as wi_…`);
}

function actorOf(rc: RunContext | undefined): EngineActor {
  const run = rc?.runId;
  return {
    by: "sys:runtime",
    via: "tool",
    role: "harness",
    ...(run !== undefined && /^run_[a-z0-9]{26}$/i.test(run) ? { run } : {}),
  };
}

/** Home's page for an item, when this harness has an identity and a Home that says where it is. */
export function homeLinkFor(harnessDir: string): (wi: string) => string | undefined {
  return (wi) => {
    try {
      const identity = readHarnessIdentity(harnessDir);
      const home = readApproverProjection(harnessDir);
      if (identity.state !== "present" || home.state !== "present") return undefined;
      const base = home.projection.homeUrl;
      return base === undefined
        ? undefined
        : `${base}/#/h/${identity.identity.id}/work/items/${wi}`;
    } catch {
      return undefined;
    }
  };
}

function nameOf(harnessDir: string): string | undefined {
  try {
    const identity = readHarnessIdentity(harnessDir);
    return identity.state === "present" ? identity.identity.slug : undefined;
  } catch {
    return undefined;
  }
}

function fail(refusal: WorkspaceRefusal): never {
  const verdict =
    refusal.verdict === undefined
      ? ""
      : ` (checks: ${refusal.verdict.checks}, acceptance: ${refusal.verdict.acceptance})`;
  throw new WorkspaceToolError(`${refusal.code}: ${refusal.message}${verdict}`);
}

const workField = z.string().min(1).max(200).describe("The work item, wi_….");

const openInput = z
  .object({
    work: workField,
    repository: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/)
      .optional()
      .describe("Which declared repository, when the harness declares several."),
  })
  .strict();

const checkInput = z.object({ work: workField }).strict();

const publishInput = z
  .object({
    work: workField,
    title: z.string().min(1).max(TITLE_MAX).describe("The pull request's title: what changes."),
    summary: z
      .string()
      .min(1)
      .max(SUMMARY_MAX)
      .describe("What changed and why, for the person who reviews it."),
    concerns: z
      .array(z.string().min(1).max(CONCERN_MAX))
      .max(CONCERNS_MAX)
      .optional()
      .describe("Anything you are unsure of, one line each."),
  })
  .strict();

/** How much of a failing check's output the agent reads back. */
const OUTPUT_TAIL = 4000;

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL ? text : `…${text.slice(text.length - OUTPUT_TAIL)}`;
}

/** Build the three tools over one harness. Tests pass their own ports. */
export function createWorkspaceTools(deps: WorkspaceToolsDeps = {}): {
  readonly workspaceOpen: RegisteredTool;
  readonly workspaceCheck: RegisteredTool;
  readonly workspacePublish: RegisteredTool;
} {
  const engineOf = (): { readonly engine: WorkspaceEngine; readonly dir: string } => {
    assertHarnessTenant();
    const dir = resolve(deps.harnessDir ?? process.cwd());
    assertHarnessCwd(dir);
    const name = nameOf(dir);
    const engine = createWorkspaceEngine({
      harnessDir: dir,
      bindings: activeBindings,
      ...(name !== undefined ? { name } : {}),
      homeLink: homeLinkFor(dir),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.checkRunner !== undefined ? { checkRunner: deps.checkRunner } : {}),
      ...deps.engine,
    });
    return { engine, dir };
  };
  const signalOf = (ctx: ToolExecuteContext | undefined) =>
    ctx?.signal !== undefined ? { signal: ctx.signal } : {};

  const workspaceOpen = buildTool({
    name: "WorkspaceOpen",
    description:
      "Open a workspace for an accepted work item: a fresh checkout of the declared repository on the item's own branch. Returns the worktree's path, relative to the harness directory; read and edit the files there, and leave its git data alone. Opening it again returns the same worktree and branch. An item nobody accepted is refused.",
    inputSchema: openInput,
    readOnly: false,
    destructive: false,
    scope: "external",
    ioCapability: "network",
    operativeArgs: [{ field: "work", kind: "id" }],
    execute: async (input, ctx) => {
      const { engine } = engineOf();
      const wi = workIdOf(input.work);
      const answer = await engine.open(wi, {
        actor: actorOf(runContextOf(ctx)),
        ...(input.repository !== undefined ? { repository: input.repository } : {}),
        ...signalOf(ctx),
      });
      if (!answer.ok) fail(answer);
      return JSON.stringify({
        work: wi,
        branch: answer.branch,
        baseSha: answer.baseSha,
        worktree: answer.worktree,
      });
    },
  });

  const workspaceCheck = buildTool({
    name: "WorkspaceCheck",
    description:
      "Run the repository's declared checks on an item's worktree, in the sandbox, and return each one's exit status and where its log is. A failing check's last output is included. Without a sandbox the call is refused and nothing runs. You cannot choose the commands.",
    inputSchema: checkInput,
    readOnly: false,
    destructive: true,
    scope: "external",
    ioCapability: "process",
    operativeArgs: [{ field: "work", kind: "id" }],
    execute: async (input, ctx) => {
      const { engine, dir } = engineOf();
      const wi = workIdOf(input.work);
      const answer = await engine.check(wi, {
        actor: actorOf(runContextOf(ctx)),
        ...signalOf(ctx),
      });
      if (!answer.ok) fail(answer);
      if (answer.results.length === 0) return "This repository declares no checks.";
      return JSON.stringify(
        answer.results.map((r) => ({
          check: r.check,
          exit: r.exit,
          log: `${workDirOf(dir)}/checks/${wi}/${r.log}`,
          ...(r.exit !== 0 ? { output: tail(r.output) } : {}),
        })),
      );
    },
  });

  const workspacePublish = buildTool({
    name: "WorkspacePublish",
    description:
      "Publish an item's change as a pull request: commits what the worktree holds, brings it onto the current base, runs the checks, checks what would leave for credentials, has the change judged against what was asked, then pushes the branch and opens the pull request or updates the one it has. Any step that refuses stops it, and nothing is published. Publishing again updates the same pull request. A change past the repository's size limits waits for a person.",
    inputSchema: publishInput,
    readOnly: false,
    destructive: true,
    requireJustification: true,
    scope: "external",
    ioCapability: "network",
    operativeArgs: [{ field: "work", kind: "id" }],
    execute: async (input, ctx) => {
      const { engine, dir } = engineOf();
      const rc = runContextOf(ctx);
      const wi = workIdOf(input.work);
      const approvals = approvalsOf(ctx);
      const config = acceptanceJudgeConfig();
      const intent = acceptanceIntent();
      const judge =
        deps.judge ??
        createAcceptanceJudge({
          ...(config !== undefined ? { config } : {}),
          ...(rc !== undefined ? { rc } : {}),
        });
      const answer = await engine.publish({
        wi,
        mode: "harness",
        actor: actorOf(rc),
        text: {
          title: input.title,
          summary: input.summary,
          ...(input.concerns !== undefined ? { concerns: input.concerns } : {}),
        },
        judge,
        ...(intent !== undefined ? { intent } : {}),
        ...(rc !== undefined ? { rc } : {}),
        ...(approvals !== undefined && rc !== undefined
          ? { limits: overLimitsPort(dir, approvals, spenderOf(dir, rc)) }
          : {}),
        ...signalOf(ctx),
      });
      if (!answer.ok) {
        if (answer.limits !== undefined && approvals !== undefined && rc !== undefined) {
          const raised = await raiseOverLimits(dir, approvals, answer.limits, rc);
          if (raised.state === "denied") {
            throw new WorkspaceToolError(
              `over_limits: a person turned this change's size down (${raised.id}). Make it smaller, then publish.`,
            );
          }
          throw new RunFailedError({
            class: "approval_pending",
            title: "awaiting a decision on a change's size",
            detail: `${answer.message} The run is parked as approval ${raised.id}.`,
            remediation: `grant or deny approval ${raised.id} out of band (e.g. \`crewhaus approvals grant ${raised.id}\`), then resume the run: \`crewhaus runs resume ${rc.sessionId}\``,
            exitCode: EXIT_CODES.approval_pending,
          });
        }
        fail(answer);
      }
      return JSON.stringify({
        work: wi,
        attempt: answer.attempt,
        state: answer.state,
        ...(answer.pr !== undefined ? { pr: answer.pr } : {}),
        verdict: { checks: answer.verdict.checks, acceptance: answer.verdict.acceptance },
        ...(answer.rebased ? { rebased: true } : {}),
        ...(answer.state === "unknown"
          ? {
              note: "The code host did not confirm the pull request. It is looked up before anything is tried again.",
            }
          : {}),
      });
    },
  });

  return { workspaceOpen, workspaceCheck, workspacePublish };
}
