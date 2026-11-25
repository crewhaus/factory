/**
 * The one pull request outcome tracker. It reads each delivered pull request from the code
 * host, records what it became (in review, merged, merged after a maintainer changed it,
 * closed, reopened, reverted) and moves the item with it: merged closes an open item as done,
 * closed without merging declines it, and a reopened pull request reopens an item this
 * tracker itself declined. An item a person moved is left where they put it, and only the
 * pull request's own line is written.
 *
 * What it reads is enums and ids: no text from the host reaches a model or a record.
 *
 * {@link syncOutcomes} polls (Home's tick), with an `If-None-Match` validator per pull
 * request and a back-off the host sets. {@link applyPullEvent} applies one webhook delivery,
 * once. Both go through the same step, so either may see a change first and the other finds
 * nothing to write. A process that stops between the record and the item's move is finished
 * by the next pass.
 */
import { join } from "node:path";
import { isId } from "@crewhaus/control-contract";
import { ensureDigestKey, keyedDigest, publishClaim } from "@crewhaus/control-records";
import {
  type CredentialProvider,
  assertCodehostOrigin,
  tokenEnvProvider,
} from "@crewhaus/tool-codehost/credentials";
import {
  type PullInfo,
  getPull,
  listBaseCommits,
  parseRepoName,
  pullInfoOf,
  pullReview,
  withPullsCall,
} from "@crewhaus/tool-codehost/pulls";
import { openForReadSync, writeFileSafe } from "@crewhaus/tool-safety/fs";
import {
  type FoldedAttempt,
  OUTCOME_ACTOR,
  OUTCOME_RULE,
  type OutcomeLine,
  PR_CLOSED_REASON,
  type WorkActor,
  openWorkStore,
  outcomesLedger,
  readAttempts,
  readOutcomes,
  readWorkspaces,
  workDirOf,
} from "../work-items/index";
import { type BindingsFile, type RepositoryBinding, readBindings } from "./bindings";
import { API_TIMEOUT_MS } from "./engine";
import { SHA_RE } from "./git";
import { appendOutcome } from "./records";

const TRACKER: WorkActor = { by: OUTCOME_ACTOR, via: "system", role: "system" };

/** How long after it ended a pull request is still looked at: for a revert, or a reopen. */
export const ENDED_WATCH_MS = 14 * 24 * 60 * 60 * 1000;
/** How long to wait when the host asks to wait and does not say how long; doubled each time. */
export const BACKOFF_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/** What the tracker keeps between passes, and may lose: validators and the host's back-off. */
type TrackerCache = {
  readonly v: 1;
  readonly etags: Readonly<Record<string, string>>;
  readonly notBefore?: number;
  readonly backoffs?: number;
};

function cacheRel(harnessDir: string): string {
  return join(workDirOf(harnessDir), "outcomes-cache.json");
}

function readCache(harnessDir: string): TrackerCache {
  const empty: TrackerCache = { v: 1, etags: {} };
  const read = openForReadSync(harnessDir, cacheRel(harnessDir), {
    maxBytes: 1024 * 1024,
    followLeafSymlink: false,
  });
  if (!read.ok) return empty;
  try {
    const body = JSON.parse(read.text) as TrackerCache;
    if (body.v !== 1 || typeof body.etags !== "object" || body.etags === null) return empty;
    return body;
  } catch {
    return empty;
  }
}

function writeCache(harnessDir: string, cache: TrackerCache): void {
  writeFileSafe(harnessDir, cacheRel(harnessDir), `${JSON.stringify(cache)}\n`, {
    overwrite: true,
    mode: 0o600,
  });
}

/** What the host says a pull request is, as the tracker records it. */
export type PullFacts = {
  readonly pr: number;
  readonly state: "open" | "merged" | "closed";
  readonly headSha?: string;
  readonly mergeSha?: string;
  readonly review?: "approved" | "changes-requested";
  readonly reverted?: boolean;
};

function factsOfPull(pull: PullInfo): PullFacts {
  return {
    pr: pull.number,
    state: pull.merged ? "merged" : pull.state,
    ...(SHA_RE.test(pull.headSha) ? { headSha: pull.headSha } : {}),
    ...(pull.mergeSha !== undefined && SHA_RE.test(pull.mergeSha)
      ? { mergeSha: pull.mergeSha }
      : {}),
  };
}

/** The line these facts make, given the newest one: a merged pull request only becomes reverted. */
function outcomeLine(
  wi: string,
  facts: PullFacts,
  newest: OutcomeLine | undefined,
  pushed: string | undefined,
  at: string,
  delivery: string | undefined,
): OutcomeLine {
  const current = newest?.pr === facts.pr ? newest : undefined;
  const changed =
    facts.state === "merged" &&
    (current?.changed === true ||
      (pushed !== undefined && facts.headSha !== undefined && facts.headSha !== pushed));
  const review = facts.review ?? (facts.state === "open" ? undefined : current?.review);
  const mergeSha = facts.mergeSha ?? current?.mergeSha;
  return {
    v: 1,
    at,
    id: wi,
    pr: facts.pr,
    state: facts.reverted === true && current?.state === "merged" ? "reverted" : facts.state,
    ...(review !== undefined ? { review } : {}),
    ...(facts.headSha !== undefined ? { headSha: facts.headSha } : {}),
    ...(mergeSha !== undefined && facts.state === "merged" ? { mergeSha } : {}),
    ...(changed ? { changed: true as const } : {}),
    ...(facts.reverted === true ? { reverted: true as const } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
    by: OUTCOME_ACTOR,
  };
}

/** Whether a line says nothing the newest one does not. */
function saysTheSame(line: OutcomeLine, newest: OutcomeLine | undefined): boolean {
  if (newest === undefined || newest.pr !== line.pr) return false;
  // A merged or reverted pull request never goes back.
  if (newest.state === "reverted") return true;
  if (newest.state === "merged" && line.state !== "reverted") return true;
  return (
    newest.state === line.state &&
    newest.review === line.review &&
    newest.headSha === line.headSha &&
    newest.mergeSha === line.mergeSha
  );
}

/**
 * Move the item its outcome says to, when nobody moved it since: the newest outcome line is
 * the authority, and a move the tracker already made for it is not made twice.
 */
async function moveItem(harnessDir: string, wi: string, now: () => number): Promise<boolean> {
  const outcome = readOutcomes(harnessDir).get(wi);
  if (outcome === undefined) return false;
  const store = openWorkStore(harnessDir, { now });
  const read = store.get(wi);
  if ("ok" in read) return false;
  const { item } = read;
  // A move made at or after the outcome was recorded is this outcome's, or a person's after it.
  const movedSince = item.history.some(
    (l) => (l.event === "closed" || l.event === "reopened") && l.at >= outcome.at,
  );
  if (movedSince) return false;
  if (item.state === "open" && (outcome.state === "merged" || outcome.state === "reverted")) {
    return (await store.transition(wi, "closed", { outcome: "done" }, TRACKER, OUTCOME_RULE)).ok;
  }
  if (item.state === "open" && outcome.state === "closed") {
    return (
      await store.transition(
        wi,
        "closed",
        { outcome: "declined", reasonCode: PR_CLOSED_REASON },
        TRACKER,
        OUTCOME_RULE,
      )
    ).ok;
  }
  if (item.state === "closed" && outcome.state === "open") {
    const closedBy = [...item.history].reverse().find((l) => l.event === "closed");
    if (closedBy?.by === OUTCOME_ACTOR && closedBy.reasonCode === PR_CLOSED_REASON) {
      return (await store.transition(wi, "open", {}, TRACKER, OUTCOME_RULE)).ok;
    }
  }
  return false;
}

export type ApplyAnswer = { readonly wrote: boolean; readonly moved: boolean };

/** Record what the host says about one item's pull request, and move the item with it. */
async function applyFacts(
  harnessDir: string,
  wi: string,
  facts: PullFacts,
  attempts: readonly FoldedAttempt[],
  now: () => number,
  delivery?: string,
): Promise<ApplyAnswer> {
  const pushed = [...attempts]
    .reverse()
    .find((a) => a.pr === facts.pr && a.state === "done")?.headSha;
  const newestOf = (): OutcomeLine | undefined => readOutcomes(harnessDir).get(wi);
  const line = outcomeLine(wi, facts, newestOf(), pushed, new Date(now()).toISOString(), delivery);
  const wrote = await appendOutcome(
    harnessDir,
    line,
    (newest) => saysTheSame(line, newest),
    newestOf,
  );
  const moved = await moveItem(harnessDir, wi, now);
  return { wrote, moved };
}

export type SyncDeps = {
  readonly now?: () => number;
  readonly provider?: CredentialProvider;
  /** The harness's own environment: the files its daemon is started with. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly bindings?: BindingsFile;
  readonly signal?: AbortSignal;
  readonly apiTimeoutMs?: number;
};

export type SyncAnswer = {
  readonly checked: number;
  readonly wrote: number;
  readonly moved: number;
  /** The host asked to be left alone until then. */
  readonly waitUntil?: number;
  readonly problem?: string;
};

/** The pull request an item's newest finished attempt opened. */
function openedPull(attempts: readonly FoldedAttempt[]): FoldedAttempt | undefined {
  return [...attempts].reverse().find((a) => a.state === "done" && a.pr !== undefined);
}

/** One pass over every delivered pull request that can still change. */
export async function syncOutcomes(harnessDir: string, deps: SyncDeps = {}): Promise<SyncAnswer> {
  const now = deps.now ?? Date.now;
  const none = { checked: 0, wrote: 0, moved: 0 };
  const bindings = deps.bindings ?? readBindings(harnessDir);
  if (bindings === undefined) return none;
  const attempts = readAttempts(harnessDir);
  if (attempts.size === 0) return none;
  let cache = readCache(harnessDir);
  if (cache.notBefore !== undefined && now() < cache.notBefore) {
    return { ...none, waitUntil: cache.notBefore };
  }
  const workspaces = readWorkspaces(harnessDir);
  let checked = 0;
  let wrote = 0;
  let moved = 0;
  let problem: string | undefined;
  const etags: Record<string, string> = { ...cache.etags };
  const backOff = (retryAfterMs: number | undefined): SyncAnswer => {
    const backoffs = (cache.backoffs ?? 0) + 1;
    const wait =
      retryAfterMs ?? Math.min(BACKOFF_MS * 2 ** Math.min(backoffs - 1, 10), BACKOFF_MAX_MS);
    const waitUntil = now() + wait;
    writeCache(harnessDir, { v: 1, etags, notBefore: waitUntil, backoffs });
    return { checked, wrote, moved, waitUntil };
  };
  for (const [wi, list] of attempts) {
    const opened = openedPull(list);
    const pr = opened?.pr;
    if (opened === undefined || pr === undefined) continue;
    const outcome = readOutcomes(harnessDir).get(wi);
    const known = outcome?.pr === pr ? outcome : undefined;
    if (known?.state === "reverted") continue;
    // A move a stopped process left unmade.
    if (known !== undefined && (await moveItem(harnessDir, wi, now))) moved += 1;
    const binding = bindings.repositories.find((r) => r.name === workspaces.get(wi)?.binding);
    if (binding === undefined) continue;
    const merged = known?.state === "merged";
    // A pull request that ended is looked at for a while: a revert, or a reopen.
    if (
      known !== undefined &&
      known.state !== "open" &&
      now() - Date.parse(known.at) > ENDED_WATCH_MS
    ) {
      continue;
    }
    const host = await hostOf(binding, bindings, deps);
    if ("problem" in host) {
      problem = host.problem;
      continue;
    }
    const key = `${binding.repo}#${pr}`;
    checked += 1;
    const call = {
      apiBase: host.api,
      token: host.token,
      timeoutMs: deps.apiTimeoutMs ?? API_TIMEOUT_MS,
      allowLoopback: host.loopback,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    };
    const repo = host.repo;
    try {
      if (merged) {
        const mergeSha = known.mergeSha;
        if (mergeSha === undefined) continue;
        const commits = await withPullsCall(call, (c) =>
          listBaseCommits(c, repo, { sha: binding.base, since: opened.at }),
        );
        if (!commits.ok) {
          if (commits.rateLimited === true) return backOff(commits.retryAfterMs);
          problem = commits.message;
          continue;
        }
        const reverted = commits.commits.some((c) =>
          c.message.includes(`This reverts commit ${mergeSha}`),
        );
        if (!reverted) continue;
        const done = await applyFacts(
          harnessDir,
          wi,
          { pr, state: "merged", mergeSha, reverted: true },
          list,
          now,
        );
        if (done.wrote) wrote += 1;
        if (done.moved) moved += 1;
        continue;
      }
      const etag = etags[key];
      const answer = await withPullsCall(call, (c) =>
        getPull(c, repo, pr, etag !== undefined ? { etag } : {}),
      );
      if (!answer.ok) {
        if (answer.rateLimited === true) return backOff(answer.retryAfterMs);
        problem = answer.message;
        continue;
      }
      if ("notModified" in answer) continue;
      const facts = factsOfPull(answer.pull);
      let review: PullFacts["review"];
      let whole = true;
      if (facts.state === "open") {
        const reviews = await withPullsCall(call, (c) => pullReview(c, repo, pr));
        if (reviews.ok) {
          review = reviews.review;
        } else {
          if (reviews.rateLimited === true) return backOff(reviews.retryAfterMs);
          // Not read is not "no review": keep what is known, and ask for all of it next time.
          problem = reviews.message;
          review = known?.review;
          whole = false;
        }
      }
      const done = await applyFacts(
        harnessDir,
        wi,
        { ...facts, ...(review !== undefined ? { review } : {}) },
        list,
        now,
      );
      if (done.wrote) wrote += 1;
      if (done.moved) moved += 1;
      if (whole && answer.etag !== undefined) etags[key] = answer.etag;
      else Reflect.deleteProperty(etags, key);
    } catch (err) {
      problem = (err as Error).message;
    }
  }
  cache = { v: 1, etags };
  writeCache(harnessDir, cache);
  return { checked, wrote, moved, ...(problem !== undefined ? { problem } : {}) };
}

async function hostOf(
  binding: RepositoryBinding,
  bindings: BindingsFile,
  deps: SyncDeps,
): Promise<
  | {
      readonly api: string;
      readonly loopback: boolean;
      readonly token: string;
      readonly repo: NonNullable<ReturnType<typeof parseRepoName>>;
    }
  | { readonly problem: string }
> {
  const repo = parseRepoName(binding.repo);
  if (repo === undefined) return { problem: "a repository is owner/name" };
  try {
    const origin = await assertCodehostOrigin(binding.server.api, {
      allowLoopback: binding.allowPrivateTarget === true,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    const provider =
      deps.provider ??
      tokenEnvProvider({ tokenEnv: bindings.tokenEnv, env: deps.env ?? process.env });
    const credential = await provider({ origin: origin.origin, repo: binding.repo });
    if (!credential.ok) return { problem: credential.message };
    return { api: origin.origin, loopback: origin.loopback, token: credential.token, repo };
  } catch (err) {
    return { problem: (err as Error).message };
  }
}

/**
 * Apply one webhook delivery about a pull request, once: a claim named by a keyed digest of
 * its delivery id decides. The receiver checks the signature before it calls this. A payload
 * about a pull request nobody here opened does nothing.
 */
export async function applyPullEvent(
  harnessDir: string,
  deliveryId: string,
  payload: unknown,
  deps: { readonly now?: () => number; readonly bindings?: BindingsFile } = {},
): Promise<ApplyAnswer> {
  const nothing: ApplyAnswer = { wrote: false, moved: false };
  const now = deps.now ?? Date.now;
  if (typeof payload !== "object" || payload === null) return nothing;
  const body = payload as Record<string, unknown>;
  const pull = pullInfoOf(body["pull_request"]);
  const repository = (body["repository"] as Record<string, unknown> | undefined)?.["full_name"];
  if (pull === undefined || typeof repository !== "string") return nothing;
  if (typeof deliveryId !== "string" || deliveryId === "" || deliveryId.length > 200) {
    return nothing;
  }
  const bindings = deps.bindings ?? readBindings(harnessDir);
  const workspaces = readWorkspaces(harnessDir);
  for (const [wi, list] of readAttempts(harnessDir)) {
    if (!isId("wi", wi) || openedPull(list)?.pr !== pull.number) continue;
    const binding = bindings?.repositories.find((r) => r.name === workspaces.get(wi)?.binding);
    if (binding === undefined || binding.repo !== repository) continue;
    const key = await ensureDigestKey(harnessDir);
    if (key.state !== "present") return nothing;
    const digest = await keyedDigest(key.hmac, "work-delivery", [deliveryId]);
    const claimed = publishClaim(outcomesLedger(harnessDir), `work-delivery/${digest}`, {
      id: wi,
      at: new Date(now()).toISOString(),
    });
    if (!claimed.ok) return nothing;
    const review = reviewOf(body);
    const known = readOutcomes(harnessDir).get(wi);
    const facts = factsOfPull(pull);
    const kept = review ?? (known?.pr === facts.pr ? known.review : undefined);
    return applyFacts(
      harnessDir,
      wi,
      { ...facts, ...(kept !== undefined ? { review: kept } : {}) },
      list,
      now,
      digest,
    );
  }
  return nothing;
}

/** What a review event says, when the delivery is one. */
function reviewOf(body: Readonly<Record<string, unknown>>): PullFacts["review"] {
  const review = body["review"] as Record<string, unknown> | undefined;
  const state = typeof review?.["state"] === "string" ? review["state"].toLowerCase() : "";
  if (state === "approved") return "approved";
  if (state === "changes_requested") return "changes-requested";
  return undefined;
}
