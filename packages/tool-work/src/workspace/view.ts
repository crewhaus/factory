/**
 * Workspaces and publish attempts as a reader sees them. Reads only: the records are folded
 * without a lock, and the check logs and the acceptance check's reasons are read only for a
 * caller who may read content.
 */
import type {
  WorkPrView,
  WorkPublishView,
  WorkspaceCheckView,
  WorkspaceSummaryView,
  WorkspaceView,
} from "@crewhaus/control-contract";
import {
  type FoldedAttempt,
  type FoldedWorkspace,
  type OutcomeLine,
  readAttempts,
  readOutcomes,
  readWorkspaces,
} from "../work-items/index";
import type { BindingsFile } from "./bindings";
import { checkName } from "./checks";
import { readCheckFile } from "./records";

/** The most of one log or reasons file a view carries, its end kept. */
const VIEW_TEXT_MAX = 16 * 1024;

export function attemptView(a: FoldedAttempt): WorkPublishView {
  return {
    id: a.id,
    attempt: a.attempt,
    state: a.state,
    at: a.at,
    ...(a.branch !== undefined ? { branch: a.branch } : {}),
    ...(a.baseSha !== undefined ? { baseSha: a.baseSha } : {}),
    ...(a.headSha !== undefined ? { headSha: a.headSha } : {}),
    ...(a.pr !== undefined ? { pr: a.pr } : {}),
    ...(a.code !== undefined ? { code: a.code } : {}),
    ...(a.files !== undefined ? { files: a.files } : {}),
    ...(a.lines !== undefined ? { lines: a.lines } : {}),
    ...(a.verdict !== undefined ? { verdict: a.verdict } : {}),
    ...(a.rebased === true ? { rebased: true as const } : {}),
  };
}

function outcomeView(o: OutcomeLine): WorkPrView {
  return {
    pr: o.pr,
    state: o.state,
    at: o.at,
    ...(o.review !== undefined ? { review: o.review } : {}),
    ...(o.changed === true ? { changed: true as const } : {}),
    ...(o.reverted === true ? { reverted: true as const } : {}),
  };
}

/** The pull request an item has, and what the tracker last said of it. */
function pullOf(
  attempts: readonly FoldedAttempt[],
  outcome: OutcomeLine | undefined,
): WorkPrView | undefined {
  const opened = [...attempts].reverse().find((a) => a.state === "done" && a.pr !== undefined);
  if (outcome !== undefined && (opened === undefined || outcome.pr === opened.pr)) {
    return outcomeView(outcome);
  }
  return opened?.pr === undefined ? undefined : { pr: opened.pr, state: "open", at: opened.at };
}

function summaryOf(
  ws: FoldedWorkspace,
  attempts: readonly FoldedAttempt[],
  outcome: OutcomeLine | undefined,
): WorkspaceSummaryView {
  const newest = attempts.at(-1);
  const pull = pullOf(attempts, outcome);
  return {
    work: ws.id,
    binding: ws.binding,
    branch: ws.branch,
    state: ws.state,
    ...(ws.baseSha !== undefined ? { baseSha: ws.baseSha } : {}),
    ...(newest !== undefined ? { publish: newest.state } : {}),
    ...(pull !== undefined ? { pr: pull.pr, prState: pull.state, outcome: pull } : {}),
  };
}

/** Every workspace of a harness, newest first. */
export function workspaceSummaries(harnessDir: string): readonly WorkspaceSummaryView[] {
  const attempts = readAttempts(harnessDir);
  const outcomes = readOutcomes(harnessDir);
  return [...readWorkspaces(harnessDir).values()]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1))
    .map((ws) => summaryOf(ws, attempts.get(ws.id) ?? [], outcomes.get(ws.id)));
}

function tail(text: string): string {
  return text.length <= VIEW_TEXT_MAX ? text : `…${text.slice(text.length - VIEW_TEXT_MAX)}`;
}

/** One item's workspace, or `undefined` when it has none. */
export function workspaceView(
  harnessDir: string,
  wi: string,
  opts: { readonly content: boolean; readonly bindings?: BindingsFile },
): WorkspaceView | undefined {
  const ws = readWorkspaces(harnessDir).get(wi);
  if (ws === undefined) return undefined;
  const attempts = readAttempts(harnessDir).get(wi) ?? [];
  const outcome = readOutcomes(harnessDir).get(wi);
  const newest = attempts.at(-1);
  const headSha = newest?.headSha ?? ws.headSha;
  const recorded = headSha === undefined ? undefined : ws.results.get(headSha);
  const declared = opts.bindings?.repositories.find((r) => r.name === ws.binding)?.checks ?? [];
  const checks: WorkspaceCheckView[] | undefined = recorded?.map((r) => {
    const argv = declared[r.k];
    return {
      name: argv === undefined ? `check ${r.k + 1}` : checkName(argv),
      exit: r.exit,
      passed: r.exit === 0,
    };
  });
  const attemptNumber = newest?.attempt ?? 1;
  const logs = !opts.content
    ? undefined
    : (recorded ?? []).flatMap((r, i) => {
        const text =
          readCheckFile(harnessDir, wi, `${attemptNumber}-${r.k}.log`) ??
          readCheckFile(harnessDir, wi, `${attemptNumber + 1}-${r.k}.log`);
        return text === undefined
          ? []
          : [{ name: checks?.[i]?.name ?? `check ${r.k + 1}`, text: tail(text) }];
      });
  const reasons =
    opts.content && newest?.reasons !== undefined
      ? readCheckFile(harnessDir, wi, newest.reasons)
      : undefined;
  return {
    ...summaryOf(ws, attempts, outcome),
    ...(headSha !== undefined ? { headSha } : {}),
    ...(ws.wip !== undefined ? { wip: ws.wip } : {}),
    ...(checks !== undefined ? { checks } : {}),
    attempts: attempts.map(attemptView),
    ...(reasons !== undefined ? { reasons: tail(reasons) } : {}),
    ...(logs !== undefined && logs.length > 0 ? { logs } : {}),
    ...(opts.content ? {} : { hidden: ["content" as const] }),
  };
}
