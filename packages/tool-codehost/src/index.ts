/**
 * `@crewhaus/tool-codehost` — GitHub and GitLab over their REST APIs, without
 * a model turn per request.
 *
 * An agent working on a repository spends most of its calls asking the same
 * questions: what does this PR touch, which check failed and why, what did
 * the reviewer say, is there budget left before the rate limit bites. Each of
 * those is a deterministic lookup with a stable answer, and each one here is
 * a single call that returns a normalised record instead of six kilobytes of
 * host JSON.
 *
 * Four commitments hold across the package.
 *
 *   1. **The token is a NAME, never a value.** `tokenEnv` names an
 *      environment variable; the token is read at call time, attached as a
 *      request header, and scrubbed out of every string on the way back. It
 *      is never placed in a path, a query string or a body, never logged, and
 *      never echoed in a result or an error — including the case where a
 *      caller pastes the token into `tokenEnv` itself, which is refused
 *      without repeating the value.
 *   2. **The gate is fail-closed.** An empty origin allow-list denies
 *      everything, including `api.github.com`. Every hop of every redirect is
 *      re-checked, the SSRF classification is numeric, and the token is
 *      dropped the moment a redirect crosses an origin. See `./net`.
 *   3. **Nothing runs unbounded.** Every call has a deadline — the name
 *      resolution included, since `node:dns` honours neither a timeout nor a
 *      signal on its own — every response is read under a byte cap that
 *      bounds memory, and every listing is bounded by a page cap as well.
 *   4. **Determinism.** Same inputs against the same world, same bytes out:
 *      listings are sorted explicitly, comparisons are locale-free, nothing
 *      is random, and no result carries a wall clock the caller did not ask
 *      for. The one deliberate exception is search, where the host's
 *      relevance order IS the answer — and that is an option, spelled out in
 *      the description.
 *
 * Both hosts are supported, but not identically, and the descriptions say so
 * rather than papering over it. GitLab has no equivalent of a GitHub Actions
 * check run's step list, no "request changes" review state, and no
 * `/rate_limit` endpoint; GitHub code search covers the default branch only.
 * A tool that overstates its coverage is worse than one that is narrow and
 * says so.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { OperativeArg, RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  type ApiResult,
  type CallCtx,
  apiList,
  apiRequest,
  baseUrlProblem,
  normalizeBaseUrl,
} from "./api";
import { excerptLog } from "./lib/logs";
import { rateHeadersFrom } from "./lib/page";
import {
  checkId,
  checkOwner,
  checkRef,
  checkSegment,
  encodePathRef,
  githubRepoPath,
  gitlabProjectPath,
  joinCommaList,
} from "./lib/refs";
import {
  type Rec,
  apiErrorMessage,
  asArray,
  asRec,
  clip,
  compact,
  isPullRequestEntry,
  normalizeCheckRun,
  normalizeComment,
  normalizeCommit,
  normalizeCommitStatus,
  normalizeFile,
  normalizeGitlabJob,
  normalizeIssue,
  normalizeJob,
  normalizePr,
  normalizeRelease,
  normalizeRepo,
  normalizeReview,
  normalizeWorkflowRun,
  num,
  str,
} from "./lib/shape";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  type HostKind,
  MAX_MAX_BYTES,
  MAX_TIMEOUT_MS,
  byString,
  describeFailure,
  json,
  redactorFor,
  resolveCodehostConfig,
  resolveToken,
  startDeadline,
} from "./net";

export {
  CodehostPermissionError,
  __setPrivateHostsAllowedForTest,
  _resetCodehostConfig,
  _setDnsLookup,
  _setRawFetch,
  canonicalizeOrigin,
  getCodehostConfig,
  registerCodehostConfig,
} from "./net";

// ---------------------------------------------------------------------------
// shared schema pieces
// ---------------------------------------------------------------------------

const hostSchema = z
  .enum(["github", "gitlab"])
  .optional()
  .describe("which API dialect to speak; defaults to the codehost tool_config host, else github");

const baseUrlSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "absolute API ROOT for a self-hosted instance, e.g. https://ghe.example.com/api/v3 or https://gitlab.example.com/api/v4; its origin must be allow-listed, and it may not carry a query string or a fragment because every request path is appended to it",
  );

const tokenEnvSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "NAME of the environment variable holding the API token — never the token itself, which is not accepted as an argument and is refused, unquoted, if one is passed here",
  );

const timeoutSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`milliseconds for the whole call, pagination included (default ${DEFAULT_TIMEOUT_MS})`);

const maxBytesSchema = z
  .number()
  .int()
  .min(1024)
  .max(MAX_MAX_BYTES)
  .optional()
  .describe(`per-response byte cap (default ${DEFAULT_MAX_BYTES}); the read is cut, not grown`);

const perPageSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("items per page requested from the host (default 50, host maximum 100)");

const maxPagesSchema = z
  .number()
  .int()
  .min(1)
  .max(20)
  .optional()
  .describe("how many pages to walk before stopping (default 3)");

const ownerSchema = z
  .string()
  .min(1)
  .describe("owner, organisation, or GitLab group path such as group/subgroup");

const repoSchema = z.string().min(1).describe("repository (GitLab: project) name");

/** The fields every tool that addresses a repository shares. */
const repoFields = {
  host: hostSchema,
  baseUrl: baseUrlSchema,
  tokenEnv: tokenEnvSchema,
  owner: ownerSchema,
  repo: repoSchema,
  timeoutMs: timeoutSchema,
  maxBytes: maxBytesSchema,
};

// No tool here declares a `justification` property of its own. The runtime
// INJECTS one, as a required field with its own wording, on every tool whose
// `requireJustification` is true — but only when the schema does not already
// declare it (`withJustificationField` in @crewhaus/tool-catalog). Declaring
// an optional one would take ownership of that contract and quietly make the
// intent gate optional, which is the opposite of what these flags are for.

type BaseInput = {
  readonly host?: HostKind;
  readonly baseUrl?: string;
  readonly tokenEnv?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
};

// ---------------------------------------------------------------------------
// the call scaffold
// ---------------------------------------------------------------------------

/**
 * Resolve config, token and deadline, run the body, and make sure nothing
 * leaves without passing the redactor.
 *
 * Every tool in this package is a `withCall` around a few requests. Putting
 * the deadline's `finally` and the redaction in one place is what keeps a
 * twenty-sixth tool from being the one that forgets either.
 */
async function withCall(
  input: BaseInput,
  ctx: ToolExecuteContext | undefined,
  run: (c: CallCtx) => Promise<string>,
): Promise<string> {
  const cfg = resolveCodehostConfig(ctx?.toolConfig);
  const host: HostKind = input.host ?? cfg.host ?? "github";
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? cfg.baseUrl ?? DEFAULT_BASE_URL[host]);
  // Checked before the token is read: a base URL that cannot address the API
  // is a mistake to report, not a reason to go looking for a secret.
  const baseProblem = baseUrlProblem(baseUrl);
  if (baseProblem !== null) return baseProblem;
  const token = resolveToken(input.tokenEnv ?? cfg.tokenEnv);
  if (!token.ok) return token.message;
  const redact = redactorFor(token.token);
  const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
  const call: CallCtx = {
    cfg,
    host,
    baseUrl,
    token: token.token,
    deadline,
    maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
    redact,
  };
  try {
    return redact(await run(call));
  } catch (err) {
    return redact(describeFailure(err, deadline));
  } finally {
    deadline.cancel();
  }
}

/** The repository's path prefix for this host, or a readable refusal. */
function repoPath(
  host: HostKind,
  owner: string,
  repo: string,
): { ok: true; path: string } | { ok: false; message: string } {
  const ownerRefusal = checkOwner(owner);
  if (ownerRefusal !== null) return { ok: false, message: ownerRefusal };
  const repoRefusal = checkSegment("repo", repo);
  if (repoRefusal !== null) return { ok: false, message: repoRefusal };
  return {
    ok: true,
    path:
      host === "github"
        ? githubRepoPath(owner, repo)
        : `/projects/${gitlabProjectPath(owner, repo)}`,
  };
}

/**
 * Why a response cannot be used, or `null` when it can.
 *
 * A non-2xx, a body that hit the cap before it could be parsed, and a body
 * that is not JSON are three different problems with three different fixes,
 * so they read differently.
 */
function bodyProblem(res: ApiResult, maxBytes: number): string | null {
  if (!res.ok) return apiErrorMessage(res.status, res.text);
  if (res.truncated) {
    return `the response body passed the ${maxBytes}-byte cap before it could be parsed — raise maxBytes, or narrow the request with a smaller perPage`;
  }
  if (res.json === undefined) {
    return `the host answered ${res.status} with a body that is not JSON (content-type: ${res.headers["content-type"] ?? "absent"})`;
  }
  return null;
}

function cmpValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return byString(a === undefined ? "" : String(a), b === undefined ? "" : String(b));
}

/** Sort a listing explicitly, so the host's ordering never decides the bytes. */
function sortRecords(items: Rec[], field: string, dir: "asc" | "desc", tiebreak?: string): Rec[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...items].sort((x, y) => {
    const primary = cmpValues(x[field], y[field]);
    if (primary !== 0) return sign * primary;
    if (tiebreak !== undefined) return sign * cmpValues(x[tiebreak], y[tiebreak]);
    return 0;
  });
}

/** A record with its keys in sorted order, so two identical maps serialise alike. */
function sortedCounts(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(counts).sort(byString)) out[key] = counts[key] as number;
  return out;
}

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "failed",
  "timed_out",
  "cancelled",
  "canceled",
  "action_required",
  "startup_failure",
  "error",
]);

/** Counts by conclusion plus the names that failed — the part a caller acts on. */
function summarizeChecks(checks: Rec[]): Rec {
  const counts: Record<string, number> = {};
  const failing: string[] = [];
  for (const check of checks) {
    const conclusion =
      typeof check["conclusion"] === "string"
        ? check["conclusion"]
        : typeof check["status"] === "string"
          ? check["status"]
          : "unknown";
    counts[conclusion] = (counts[conclusion] ?? 0) + 1;
    if (FAILED_CONCLUSIONS.has(conclusion) && typeof check["name"] === "string") {
      failing.push(check["name"]);
    }
  }
  return {
    total: checks.length,
    byConclusion: sortedCounts(counts),
    failing: failing.sort(byString),
  };
}

/** Normalise a list of raw entries, dropping the ones that do not shape up. */
function mapDefined<T>(items: readonly unknown[], fn: (value: unknown) => T | undefined): T[] {
  const out: T[] = [];
  for (const item of items) {
    const mapped = fn(item);
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

/** A read tool: external boundary, no mutation, safe to run beside its siblings. */
function readTool<S extends z.ZodTypeAny>(def: {
  name: string;
  /** Required, so no tool here can leave a rule nothing to match. */
  operativeArgs: ReadonlyArray<OperativeArg>;
  description: string;
  inputSchema: S;
  execute: (input: z.infer<S>, ctx?: ToolExecuteContext) => Promise<string>;
}): RegisteredTool {
  return buildTool<z.infer<S>>({
    name: def.name,
    operativeArgs: def.operativeArgs,
    description: def.description,
    inputSchema: def.inputSchema as z.ZodType<z.infer<S>>,
    readOnly: true,
    concurrencySafe: true,
    scope: "external",
    ioCapability: "network",
    execute: def.execute,
  });
}

/**
 * A write tool: everything a read tool is, plus the two flags that matter for
 * something the world can see. Every write here posts under the token
 * owner's name in a place other people read, so `requireJustification` is not
 * optional on any of them.
 */
function writeTool<S extends z.ZodTypeAny>(def: {
  name: string;
  /** Required, so no tool here can leave a rule nothing to match. */
  operativeArgs: ReadonlyArray<OperativeArg>;
  description: string;
  inputSchema: S;
  execute: (input: z.infer<S>, ctx?: ToolExecuteContext) => Promise<string>;
}): RegisteredTool {
  return buildTool<z.infer<S>>({
    name: def.name,
    operativeArgs: def.operativeArgs,
    description: def.description,
    inputSchema: def.inputSchema as z.ZodType<z.infer<S>>,
    readOnly: false,
    destructive: true,
    requireJustification: true,
    concurrencySafe: false,
    scope: "external",
    ioCapability: "network",
    execute: def.execute,
  });
}

/** GitLab's spelling of the three PR states. */
function gitlabState(state: string): string {
  return state === "open" ? "opened" : state;
}

// ---------------------------------------------------------------------------
// pull requests — read
// ---------------------------------------------------------------------------

export const prList: RegisteredTool = readTool({
  name: "PrList",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    'List pull requests (GitLab: merge requests) with author, branches, labels, reviewers and state, filtered by state and branch. Use it to see what is open against a repository without spending a model turn per page, or to find the PR for a branch before acting on it. It returns the normalised record, not the host\'s full payload, and it does not fetch mergeability or check status — PrGet does that for one PR. On GitHub a state of "merged" is not a server-side filter, so the tool asks for closed PRs and keeps the merged ones, which means the page cap applies before the filter.',
  inputSchema: z.object({
    ...repoFields,
    state: z.enum(["open", "closed", "merged", "all"]).optional().describe("default open"),
    targetBranch: z.string().min(1).optional().describe("base branch to filter by"),
    sourceBranch: z.string().min(1).optional().describe("head branch to filter by"),
    author: z.string().min(1).optional().describe("filter by author handle (GitLab only)"),
    sort: z
      .enum(["number", "updated", "created"])
      .optional()
      .describe("client-side ordering, newest first (default number)"),
    perPage: perPageSchema,
    maxPages: maxPagesSchema,
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      for (const [field, value] of [
        ["targetBranch", input.targetBranch],
        ["sourceBranch", input.sourceBranch],
      ] as const) {
        if (value !== undefined) {
          const refusal = checkRef(field, value);
          if (refusal !== null) return refusal;
        }
      }
      const state = input.state ?? "open";
      const query: Record<string, string | number | undefined> =
        c.host === "github"
          ? {
              state: state === "merged" ? "closed" : state,
              base: input.targetBranch,
              head: input.sourceBranch,
            }
          : {
              state: gitlabState(state),
              target_branch: input.targetBranch,
              source_branch: input.sourceBranch,
              author_username: input.author,
            };
      const listing = await apiList(
        c,
        {
          method: "GET",
          path: `${target.path}${c.host === "github" ? "/pulls" : "/merge_requests"}`,
          query,
        },
        { perPage: input.perPage ?? 50, maxPages: input.maxPages ?? 3 },
      );
      const problem = bodyProblem(listing.last, c.maxBytes);
      if (problem !== null) return problem;

      let records = mapDefined(listing.items, (raw) => normalizePr(c.host, raw));
      if (state === "merged") records = records.filter((pr) => pr["state"] === "merged");
      const sort = input.sort ?? "number";
      const field = sort === "number" ? "number" : sort === "updated" ? "updatedAt" : "createdAt";
      return json({
        host: c.host,
        repo: `${input.owner}/${input.repo}`,
        state,
        count: records.length,
        pagesRead: listing.pages,
        morePages: listing.morePages,
        pullRequests: sortRecords(records, field, "desc", "number"),
      });
    }),
});

export const prGet: RegisteredTool = readTool({
  name: "PrGet",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    'Fetch one pull request in full: state, author, branches, labels, reviewers, mergeability and, unless turned off, a summary of the checks on its head commit. Use it before deciding whether a PR is ready to merge, or to see in one call why it is not. GitHub reports mergeability as null while it computes the merge commit, and that is returned as "computing" rather than folded into false, because treating the two alike closes perfectly mergeable PRs. The check summary is counts plus the failing names; WorkflowRunLogs is what names the failing step.',
  inputSchema: z.object({
    ...repoFields,
    number: z.number().int().positive().describe("PR number (GitLab: merge request iid)"),
    includeChecks: z
      .boolean()
      .optional()
      .describe("also summarise the checks on the head commit (default true, one extra request)"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const idRefusal = checkId("number", input.number);
      if (idRefusal !== null) return idRefusal;

      const path =
        c.host === "github"
          ? `${target.path}/pulls/${input.number}`
          : `${target.path}/merge_requests/${input.number}`;
      const res = await apiRequest(c, { method: "GET", path });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      const raw = asRec(res.json);
      const pr = normalizePr(c.host, res.json);
      if (pr === undefined || raw === undefined) {
        return `the host answered ${res.status} with something that is not a pull request record`;
      }

      let checks: Rec | undefined;
      if (input.includeChecks !== false && c.deadline.remaining() > 0) {
        checks = await checkSummaryFor(c, target.path, raw, pr);
      }
      return json({ host: c.host, repo: `${input.owner}/${input.repo}`, pullRequest: pr, checks });
    }),
});

/** The check summary for a PR's head, by whichever route the host offers. */
async function checkSummaryFor(
  c: CallCtx,
  base: string,
  raw: Rec,
  pr: Rec,
): Promise<Rec | undefined> {
  if (c.host === "github") {
    const sha = typeof pr["sha"] === "string" ? pr["sha"] : undefined;
    if (sha === undefined) return undefined;
    const res = await apiRequest(c, {
      method: "GET",
      path: `${base}/commits/${encodeURIComponent(sha)}/check-runs`,
      query: { per_page: 100 },
    });
    if (bodyProblem(res, c.maxBytes) !== null) return { unavailable: true };
    const runs = mapDefined(asArray(asRec(res.json)?.["check_runs"]), normalizeCheckRun);
    return summarizeChecks(runs);
  }
  const pipeline = asRec(raw["head_pipeline"]) ?? asRec(raw["pipeline"]);
  const pipelineId = num(pipeline, "id");
  if (pipelineId === undefined) return undefined;
  const res = await apiRequest(c, {
    method: "GET",
    path: `${base}/pipelines/${pipelineId}/jobs`,
    query: { per_page: 100 },
  });
  if (bodyProblem(res, c.maxBytes) !== null) {
    return { pipelineId, status: str(pipeline, "status"), unavailable: true };
  }
  const jobs = mapDefined(asArray(res.json), normalizeGitlabJob);
  return { pipelineId, status: str(pipeline, "status"), ...summarizeChecks(jobs) };
}

export const prFiles: RegisteredTool = readTool({
  name: "PrFiles",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    "List the files a pull request touches, each with its status, added and removed line counts and a length-capped patch. Use it to review a change, or to decide whether a PR is in scope, without fetching the whole diff into context. Files come back sorted by path and the patch of each is clipped to maxPatchChars. Two host limits are passed through rather than hidden: GitHub lists at most 300 files per PR and omits the patch for very large files, and GitLab states no line counts at all, so for GitLab they are counted from the diff and marked countsDerived.",
  inputSchema: z.object({
    ...repoFields,
    number: z.number().int().positive(),
    includePatch: z.boolean().optional().describe("default true"),
    maxFiles: z.number().int().min(1).max(300).optional().describe("default 100"),
    maxPatchChars: z
      .number()
      .int()
      .min(0)
      .max(40_000)
      .optional()
      .describe("characters kept per file patch (default 4000)"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const idRefusal = checkId("number", input.number);
      if (idRefusal !== null) return idRefusal;

      const maxFiles = input.maxFiles ?? 100;
      const perPage = Math.min(100, maxFiles);
      const path =
        c.host === "github"
          ? `${target.path}/pulls/${input.number}/files`
          : `${target.path}/merge_requests/${input.number}/diffs`;
      const listing = await apiList(
        c,
        { method: "GET", path },
        { perPage, maxPages: Math.max(1, Math.ceil(maxFiles / perPage)) },
      );
      const problem = bodyProblem(listing.last, c.maxBytes);
      if (problem !== null) return problem;

      const maxPatchChars = input.includePatch === false ? 0 : (input.maxPatchChars ?? 4000);
      const all = mapDefined(listing.items, (raw) => normalizeFile(c.host, raw, maxPatchChars));
      const sorted = sortRecords(all, "path", "asc");
      const kept = sorted.slice(0, maxFiles);
      let additions = 0;
      let deletions = 0;
      for (const file of sorted) {
        additions += typeof file["additions"] === "number" ? file["additions"] : 0;
        deletions += typeof file["deletions"] === "number" ? file["deletions"] : 0;
      }
      return json({
        host: c.host,
        repo: `${input.owner}/${input.repo}`,
        number: input.number,
        fileCount: sorted.length,
        returned: kept.length,
        truncatedByMaxFiles: kept.length < sorted.length,
        morePages: listing.morePages,
        additions,
        deletions,
        files: kept,
      });
    }),
});

export const prComments: RegisteredTool = readTool({
  name: "PrComments",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    'Read the conversation comments on a pull request, oldest first, with author, timestamp and a length-capped body. Use it to catch up on what has already been said before replying or acting. These are the discussion-thread comments only: the inline comments attached to lines of the diff belong to reviews and come back from PrReviews. On GitLab the endpoint also carries system notes ("changed the description", "added a label"), which are dropped unless includeSystem is set.',
  inputSchema: z.object({
    ...repoFields,
    number: z.number().int().positive(),
    includeSystem: z.boolean().optional().describe("GitLab only; default false"),
    maxComments: z.number().int().min(1).max(500).optional().describe("default 100"),
    maxBodyChars: z.number().int().min(0).max(20_000).optional().describe("default 2000"),
    perPage: perPageSchema,
    maxPages: maxPagesSchema,
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const idRefusal = checkId("number", input.number);
      if (idRefusal !== null) return idRefusal;

      const path =
        c.host === "github"
          ? `${target.path}/issues/${input.number}/comments`
          : `${target.path}/merge_requests/${input.number}/notes`;
      const query = c.host === "github" ? {} : { sort: "asc", order_by: "created_at" };
      const listing = await apiList(
        c,
        { method: "GET", path, query },
        { perPage: input.perPage ?? 50, maxPages: input.maxPages ?? 3 },
      );
      const problem = bodyProblem(listing.last, c.maxBytes);
      if (problem !== null) return problem;

      const maxBodyChars = input.maxBodyChars ?? 2000;
      let records = mapDefined(listing.items, (raw) => normalizeComment(c.host, raw, maxBodyChars));
      if (c.host === "gitlab" && input.includeSystem !== true) {
        records = records.filter((note) => note["system"] !== true);
      }
      const ordered = sortRecords(records, "createdAt", "asc", "id");
      const kept = ordered.slice(0, input.maxComments ?? 100);
      return json({
        host: c.host,
        repo: `${input.owner}/${input.repo}`,
        number: input.number,
        count: ordered.length,
        returned: kept.length,
        morePages: listing.morePages,
        comments: kept,
      });
    }),
});

export const prReviews: RegisteredTool = readTool({
  name: "PrReviews",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    'Read the reviews on a pull request — who approved, who requested changes, and the inline comment threads against the diff. Use it to find out what a reviewer actually objected to before pushing another commit. On GitHub the reviews and their line comments are both returned, threads grouped by their root comment and sorted by path. GitLab has no review object: approvals are reported as approved reviews and discussions as threads, and it has no "changes requested" state at all, so that state never appears for a GitLab project.',
  inputSchema: z.object({
    ...repoFields,
    number: z.number().int().positive(),
    includeThreads: z
      .boolean()
      .optional()
      .describe("also fetch inline comment threads (default true)"),
    maxBodyChars: z.number().int().min(0).max(20_000).optional().describe("default 2000"),
    perPage: perPageSchema,
    maxPages: maxPagesSchema,
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const idRefusal = checkId("number", input.number);
      if (idRefusal !== null) return idRefusal;
      const maxBodyChars = input.maxBodyChars ?? 2000;
      const pages = { perPage: input.perPage ?? 50, maxPages: input.maxPages ?? 3 };

      if (c.host === "gitlab") {
        const approvals = await apiRequest(c, {
          method: "GET",
          path: `${target.path}/merge_requests/${input.number}/approvals`,
        });
        const problem = bodyProblem(approvals, c.maxBytes);
        if (problem !== null) return problem;
        const approvalRec = asRec(approvals.json);
        const reviews: Rec[] = mapDefined(asArray(approvalRec?.["approved_by"]), (entry) => {
          const handleName = str(asRec(asRec(entry)?.["user"]), "username");
          return handleName === undefined
            ? undefined
            : ({ author: handleName, state: "approved" } as Rec);
        });
        let threads: Rec[] = [];
        if (input.includeThreads !== false) {
          const discussions = await apiList(
            c,
            { method: "GET", path: `${target.path}/merge_requests/${input.number}/discussions` },
            pages,
          );
          if (bodyProblem(discussions.last, c.maxBytes) === null) {
            threads = gitlabThreads(discussions.items, maxBodyChars);
          }
        }
        return json({
          host: c.host,
          repo: `${input.owner}/${input.repo}`,
          number: input.number,
          approvalsRequired: num(approvalRec, "approvals_required"),
          approvalsLeft: num(approvalRec, "approvals_left"),
          reviews: sortRecords(reviews, "author", "asc"),
          threads,
          note: "GitLab has no request-changes review state; only approvals and discussion threads exist",
        });
      }

      const listing = await apiList(
        c,
        { method: "GET", path: `${target.path}/pulls/${input.number}/reviews` },
        pages,
      );
      const problem = bodyProblem(listing.last, c.maxBytes);
      if (problem !== null) return problem;
      const reviews = sortRecords(
        mapDefined(listing.items, (raw) => normalizeReview(raw, maxBodyChars)),
        "submittedAt",
        "asc",
        "id",
      );
      let threads: Rec[] = [];
      if (input.includeThreads !== false && c.deadline.remaining() > 0) {
        const comments = await apiList(
          c,
          { method: "GET", path: `${target.path}/pulls/${input.number}/comments` },
          pages,
        );
        if (bodyProblem(comments.last, c.maxBytes) === null) {
          threads = githubThreads(
            mapDefined(comments.items, (raw) => normalizeComment("github", raw, maxBodyChars)),
          );
        }
      }
      return json({
        host: c.host,
        repo: `${input.owner}/${input.repo}`,
        number: input.number,
        reviewCount: reviews.length,
        reviews,
        threads,
      });
    }),
});

/** Group GitHub review comments into threads by their root comment. */
function githubThreads(comments: Rec[]): Rec[] {
  const roots = new Map<number, Rec[]>();
  const byId = new Map<number, Rec>();
  for (const comment of comments) {
    const id = comment["id"];
    if (typeof id === "number") byId.set(id, comment);
  }
  const rootOf = (comment: Rec): number => {
    let current = comment;
    for (let hop = 0; hop < 50; hop++) {
      const parent = current["inReplyTo"];
      if (typeof parent !== "number") break;
      const next = byId.get(parent);
      if (next === undefined) return parent;
      current = next;
    }
    return typeof current["id"] === "number" ? current["id"] : -1;
  };
  for (const comment of comments) {
    const root = rootOf(comment);
    const bucket = roots.get(root);
    if (bucket === undefined) roots.set(root, [comment]);
    else bucket.push(comment);
  }
  const threads: Rec[] = [];
  for (const [root, bucket] of roots) {
    const ordered = sortRecords(bucket, "id", "asc");
    const first = ordered[0] as Rec;
    threads.push(
      compact({
        rootId: root,
        path: first["path"],
        line: first["line"],
        commentCount: ordered.length,
        comments: ordered,
      }),
    );
  }
  return sortRecords(threads, "path", "asc", "rootId");
}

/** Group GitLab discussion notes into the same thread shape. */
function gitlabThreads(discussions: readonly unknown[], maxBodyChars: number): Rec[] {
  const threads: Rec[] = [];
  for (const entry of discussions) {
    const discussion = asRec(entry);
    if (discussion === undefined) continue;
    if (discussion["individual_note"] === true) continue;
    const notes = mapDefined(asArray(discussion["notes"]), (note) =>
      normalizeComment("gitlab", note, maxBodyChars),
    ).filter((note) => note["system"] !== true);
    if (notes.length === 0) continue;
    const first = notes[0] as Rec;
    threads.push(
      compact({
        rootId: str(discussion, "id"),
        path: first["path"],
        resolved: first["resolved"],
        commentCount: notes.length,
        comments: sortRecords(notes, "createdAt", "asc", "id"),
      }),
    );
  }
  return sortRecords(threads, "path", "asc", "rootId");
}

// ---------------------------------------------------------------------------
// issues — read
// ---------------------------------------------------------------------------

export const issueList: RegisteredTool = readTool({
  name: "IssueList",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    "List issues with their labels, assignees, milestone and comment counts, filtered by state, label and assignee. Use it to triage a backlog or to check whether something has already been reported before opening a duplicate. GitHub's issues endpoint also returns pull requests, which are filtered out here so a count of issues is a count of issues. Bodies are not included — IssueGet returns one issue with its body and comments. Both hosts take the label filter as one comma-separated string, so a label whose own name contains a comma is refused rather than silently filtered as two.",
  inputSchema: z.object({
    ...repoFields,
    state: z.enum(["open", "closed", "all"]).optional().describe("default open"),
    labels: z.array(z.string().min(1)).max(20).optional().describe("all of these labels"),
    assignee: z.string().min(1).optional(),
    sort: z
      .enum(["number", "updated", "created"])
      .optional()
      .describe("client-side ordering, newest first (default number)"),
    perPage: perPageSchema,
    maxPages: maxPagesSchema,
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const state = input.state ?? "open";
      let labelList: string | undefined;
      if (input.labels !== undefined) {
        const joined = joinCommaList("labels", input.labels);
        if (!joined.ok) return joined.message;
        labelList = joined.value;
      }
      const query =
        c.host === "github"
          ? { state, labels: labelList, assignee: input.assignee }
          : {
              state: gitlabState(state),
              labels: labelList,
              assignee_username: input.assignee,
            };
      const listing = await apiList(
        c,
        { method: "GET", path: `${target.path}/issues`, query },
        { perPage: input.perPage ?? 50, maxPages: input.maxPages ?? 3 },
      );
      const problem = bodyProblem(listing.last, c.maxBytes);
      if (problem !== null) return problem;

      const source =
        c.host === "github"
          ? listing.items.filter((raw) => !isPullRequestEntry(raw))
          : listing.items;
      const records = mapDefined(source, (raw) => normalizeIssue(c.host, raw));
      const sort = input.sort ?? "number";
      const field = sort === "number" ? "number" : sort === "updated" ? "updatedAt" : "createdAt";
      return json({
        host: c.host,
        repo: `${input.owner}/${input.repo}`,
        state,
        count: records.length,
        pullRequestsFiltered: listing.items.length - source.length,
        morePages: listing.morePages,
        issues: sortRecords(records, field, "desc", "number"),
      });
    }),
});

export const issueGet: RegisteredTool = readTool({
  name: "IssueGet",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    "Fetch one issue with its body, labels, assignees and, unless turned off, its comments oldest first. Use it to get the full context of a report in a single call rather than a list call followed by a comments call. Bodies and comments are clipped to maxBodyChars, which is stated in the result when it bites. On GitHub the same number addresses a pull request, and asking for one here returns the issue view of it, without the diff or the reviews.",
  inputSchema: z.object({
    ...repoFields,
    number: z.number().int().positive(),
    includeComments: z.boolean().optional().describe("default true"),
    maxComments: z.number().int().min(1).max(200).optional().describe("default 50"),
    maxBodyChars: z.number().int().min(0).max(40_000).optional().describe("default 4000"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const idRefusal = checkId("number", input.number);
      if (idRefusal !== null) return idRefusal;
      const maxBodyChars = input.maxBodyChars ?? 4000;

      const res = await apiRequest(c, {
        method: "GET",
        path: `${target.path}/issues/${input.number}`,
      });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      const raw = asRec(res.json);
      const issue = normalizeIssue(c.host, res.json);
      if (issue === undefined || raw === undefined) {
        return `the host answered ${res.status} with something that is not an issue record`;
      }
      issue["body"] = clip(str(raw, "body") ?? str(raw, "description"), maxBodyChars);

      let comments: Rec[] | undefined;
      if (input.includeComments !== false && c.deadline.remaining() > 0) {
        const path =
          c.host === "github"
            ? `${target.path}/issues/${input.number}/comments`
            : `${target.path}/issues/${input.number}/notes`;
        const listing = await apiList(
          c,
          {
            method: "GET",
            path,
            query: c.host === "github" ? {} : { sort: "asc", order_by: "created_at" },
          },
          { perPage: 100, maxPages: 2 },
        );
        if (bodyProblem(listing.last, c.maxBytes) === null) {
          const all = mapDefined(listing.items, (entry) =>
            normalizeComment(c.host, entry, maxBodyChars),
          ).filter((note) => note["system"] !== true);
          comments = sortRecords(all, "createdAt", "asc", "id").slice(0, input.maxComments ?? 50);
        }
      }
      return json({ host: c.host, repo: `${input.owner}/${input.repo}`, issue, comments });
    }),
});

// ---------------------------------------------------------------------------
// checks and CI — read
// ---------------------------------------------------------------------------

export const checkRuns: RegisteredTool = readTool({
  name: "CheckRuns",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    "List the check runs and commit statuses for a ref, with counts by conclusion and the failing ones named. Use it as the first call when a branch is red, to find out what failed before fetching any logs. For a failing GitHub Actions check the tool then asks for that job and names the step that failed, capped at a few jobs so one red commit cannot become dozens of requests. Non-Actions checks report only what their app published, and on GitLab this returns commit statuses and pipeline jobs, which carry no step list at all.",
  inputSchema: z.object({
    ...repoFields,
    ref: z.string().min(1).describe("branch, tag or commit sha"),
    includeFailingSteps: z
      .boolean()
      .optional()
      .describe("name the failing step of failing GitHub Actions checks (default true)"),
    maxStepLookups: z.number().int().min(0).max(10).optional().describe("default 5"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const refRefusal = checkRef("ref", input.ref);
      if (refRefusal !== null) return refRefusal;
      const ref = encodePathRef(input.ref);

      if (c.host === "gitlab") {
        const res = await apiRequest(c, {
          method: "GET",
          path: `${target.path}/repository/commits/${ref}/statuses`,
          query: { per_page: 100 },
        });
        const problem = bodyProblem(res, c.maxBytes);
        if (problem !== null) return problem;
        const checks = sortRecords(
          mapDefined(asArray(res.json), normalizeGitlabJob),
          "name",
          "asc",
        );
        return json({
          host: c.host,
          repo: `${input.owner}/${input.repo}`,
          ref: input.ref,
          ...summarizeChecks(checks),
          checks,
          note: "GitLab commit statuses carry no step list; WorkflowRunLogs reads a failing job's trace",
        });
      }

      const res = await apiRequest(c, {
        method: "GET",
        path: `${target.path}/commits/${ref}/check-runs`,
        query: { per_page: 100 },
      });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      const checks = mapDefined(asArray(asRec(res.json)?.["check_runs"]), normalizeCheckRun);

      const statuses = await apiRequest(c, {
        method: "GET",
        path: `${target.path}/commits/${ref}/status`,
        query: { per_page: 100 },
      });
      if (bodyProblem(statuses, c.maxBytes) === null) {
        checks.push(
          ...mapDefined(asArray(asRec(statuses.json)?.["statuses"]), normalizeCommitStatus),
        );
      }

      if (input.includeFailingSteps !== false) {
        const budget = input.maxStepLookups ?? 5;
        const failing = checks
          .filter(
            (check) =>
              typeof check["conclusion"] === "string" &&
              FAILED_CONCLUSIONS.has(check["conclusion"]) &&
              check["app"] === "github-actions" &&
              typeof check["id"] === "number",
          )
          .slice(0, budget);
        for (const check of failing) {
          if (c.deadline.remaining() <= 0) break;
          const job = await apiRequest(c, {
            method: "GET",
            path: `${target.path}/actions/jobs/${check["id"] as number}`,
          });
          if (bodyProblem(job, c.maxBytes) !== null) continue;
          const normalized = normalizeJob(job.json);
          if (normalized?.["failedSteps"] !== undefined) {
            check["failedSteps"] = normalized["failedSteps"];
          }
        }
      }
      const sorted = sortRecords(checks, "name", "asc", "id");
      return json({
        host: c.host,
        repo: `${input.owner}/${input.repo}`,
        ref: input.ref,
        ...summarizeChecks(sorted),
        checks: sorted,
      });
    }),
});

export const workflowRuns: RegisteredTool = readTool({
  name: "WorkflowRuns",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    "List CI runs for a branch or commit — GitHub Actions workflow runs, or GitLab pipelines — with status, conclusion, event and run number. Use it to find the run id that WorkflowRunLogs needs, or to see whether a branch has ever gone green. Runs come back newest id first and the listing is bounded by the page cap. It reports what the host recorded about each run and does not open any of them; a run's jobs and steps come from CheckRuns or WorkflowRunLogs.",
  inputSchema: z.object({
    ...repoFields,
    branch: z.string().min(1).optional(),
    sha: z.string().min(1).optional(),
    status: z
      .string()
      .min(1)
      .optional()
      .describe("host status filter, e.g. completed/failure on GitHub, failed on GitLab"),
    event: z.string().min(1).optional().describe("GitHub only, e.g. push or pull_request"),
    perPage: perPageSchema,
    maxPages: maxPagesSchema,
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      if (input.branch !== undefined) {
        const refusal = checkRef("branch", input.branch);
        if (refusal !== null) return refusal;
      }
      if (input.sha !== undefined) {
        const refusal = checkRef("sha", input.sha);
        if (refusal !== null) return refusal;
      }
      const query =
        c.host === "github"
          ? {
              branch: input.branch,
              head_sha: input.sha,
              status: input.status,
              event: input.event,
            }
          : { ref: input.branch, sha: input.sha, status: input.status };
      const listing = await apiList(
        c,
        {
          method: "GET",
          path: c.host === "github" ? `${target.path}/actions/runs` : `${target.path}/pipelines`,
          query,
        },
        { perPage: input.perPage ?? 30, maxPages: input.maxPages ?? 2 },
      );
      const problem = bodyProblem(listing.last, c.maxBytes);
      if (problem !== null) return problem;
      // GitHub wraps each page in `{ total_count, workflow_runs: [...] }`, so a
      // page arrives as one object; GitLab answers with a bare array.
      const source =
        c.host === "github"
          ? listing.items.flatMap((item) => asArray(asRec(item)?.["workflow_runs"]))
          : listing.items;
      const runs = sortRecords(
        mapDefined(source, (raw) => normalizeWorkflowRun(c.host, raw)),
        "id",
        "desc",
      );
      return json({
        host: c.host,
        repo: `${input.owner}/${input.repo}`,
        count: runs.length,
        morePages: listing.morePages,
        runs,
      });
    }),
});

export const workflowRunLogs: RegisteredTool = readTool({
  name: "WorkflowRunLogs",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    "Read a failed CI run's log and return the actionable part of it: the failing step, the first error line, the host's own error annotations and the tail. Use it instead of downloading a job log, which is routinely tens of thousands of lines of which a handful matter. Without a jobId the tool picks the run's first failed job. Two limits are worth knowing: GitHub serves job logs by redirecting to a storage origin, so that origin has to be allow-listed as well or the call is refused by name, and the log is read under a byte cap, so on a very long job the excerpt is drawn from the capped prefix.",
  inputSchema: z.object({
    ...repoFields,
    runId: z
      .number()
      .int()
      .positive()
      .describe("GitHub Actions run id, or GitLab pipeline id; ignored when jobId is given"),
    jobId: z.number().int().positive().optional().describe("read this job instead of choosing one"),
    maxLogBytes: z
      .number()
      .int()
      .min(1024)
      .max(MAX_MAX_BYTES)
      .optional()
      .describe("byte cap for the log body itself (default 2000000)"),
    tailLines: z.number().int().min(0).max(200).optional().describe("default 20"),
    maxErrorLines: z.number().int().min(0).max(200).optional().describe("default 20"),
    maxAnnotations: z.number().int().min(0).max(200).optional().describe("default 20"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const idRefusal = checkId("runId", input.runId);
      if (idRefusal !== null) return idRefusal;

      let jobId = input.jobId;
      let job: Rec | undefined;
      if (jobId === undefined) {
        const jobsPath =
          c.host === "github"
            ? `${target.path}/actions/runs/${input.runId}/jobs`
            : `${target.path}/pipelines/${input.runId}/jobs`;
        const res = await apiRequest(c, {
          method: "GET",
          path: jobsPath,
          query: c.host === "github" ? { per_page: 100, filter: "latest" } : { per_page: 100 },
        });
        const problem = bodyProblem(res, c.maxBytes);
        if (problem !== null) return problem;
        const raw = c.host === "github" ? asArray(asRec(res.json)?.["jobs"]) : asArray(res.json);
        const jobs = sortRecords(
          mapDefined(raw, c.host === "github" ? normalizeJob : normalizeGitlabJob),
          "id",
          "asc",
        );
        const failed = jobs.find(
          (entry) =>
            typeof entry["conclusion"] === "string" && FAILED_CONCLUSIONS.has(entry["conclusion"]),
        );
        job = failed ?? jobs[jobs.length - 1];
        const chosen = job?.["id"];
        if (typeof chosen !== "number") {
          return `run ${input.runId} reported ${jobs.length} jobs and none of them carries an id to read a log from`;
        }
        jobId = chosen;
      }

      const logPath =
        c.host === "github"
          ? `${target.path}/actions/jobs/${jobId}/logs`
          : `${target.path}/jobs/${jobId}/trace`;
      const log = await apiRequest(c, {
        method: "GET",
        path: logPath,
        accept: "text/plain",
        maxBytes: input.maxLogBytes ?? 2_000_000,
      });
      if (!log.ok) return apiErrorMessage(log.status, log.text);

      const excerpt = excerptLog(log.text, {
        tailLines: input.tailLines ?? 20,
        maxErrorLines: input.maxErrorLines ?? 20,
        maxAnnotations: input.maxAnnotations ?? 20,
      });
      return json({
        host: c.host,
        repo: `${input.owner}/${input.repo}`,
        runId: input.runId,
        jobId,
        job,
        logBytes: log.bytes,
        logChars: log.text.length,
        logTruncated: log.truncated,
        tokenDroppedAtRedirect: log.credentialsDropped,
        excerpt,
      });
    }),
});

// ---------------------------------------------------------------------------
// releases, repository, comparison — read
// ---------------------------------------------------------------------------

export const releaseList: RegisteredTool = readTool({
  name: "ReleaseList",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    'List a repository\'s releases with their tag, draft and prerelease flags and their assets. Use it to find what has shipped, or to check whether a version was ever published before cutting it again. Releases come back newest first by publication date and each asset carries its name, size and download URL. Drafts are only visible to a token that may see them, so an empty list can mean "none" or "none you can see".',
  inputSchema: z.object({
    ...repoFields,
    perPage: perPageSchema,
    maxPages: maxPagesSchema,
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const listing = await apiList(
        c,
        { method: "GET", path: `${target.path}/releases` },
        { perPage: input.perPage ?? 30, maxPages: input.maxPages ?? 2 },
      );
      const problem = bodyProblem(listing.last, c.maxBytes);
      if (problem !== null) return problem;
      const releases = mapDefined(listing.items, (raw) => normalizeRelease(c.host, raw));
      const sorted = sortRecords(
        releases,
        c.host === "github" ? "publishedAt" : "releasedAt",
        "desc",
        "tag",
      );
      return json({
        host: c.host,
        repo: `${input.owner}/${input.repo}`,
        count: sorted.length,
        morePages: listing.morePages,
        releases: sorted,
      });
    }),
});

export const releaseGet: RegisteredTool = readTool({
  name: "ReleaseGet",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    'Fetch one release by tag, or the latest one, with its notes and its assets. Use it to read what a version shipped with, or to get an asset\'s download URL. Release notes are clipped to maxBodyChars. GitHub has a real "latest" endpoint, which skips drafts and prereleases; GitLab has none, so with no tag the tool takes the first entry of the release listing instead and says so in the result.',
  inputSchema: z.object({
    ...repoFields,
    tag: z.string().min(1).optional().describe("tag name; omit for the latest release"),
    maxBodyChars: z.number().int().min(0).max(40_000).optional().describe("default 4000"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      if (input.tag !== undefined) {
        const refusal = checkRef("tag", input.tag);
        if (refusal !== null) return refusal;
      }
      const maxBodyChars = input.maxBodyChars ?? 4000;

      let raw: unknown;
      let latestVia = "host";
      if (input.tag !== undefined) {
        const path =
          c.host === "github"
            ? `${target.path}/releases/tags/${encodePathRef(input.tag)}`
            : `${target.path}/releases/${encodeURIComponent(input.tag)}`;
        const res = await apiRequest(c, { method: "GET", path });
        const problem = bodyProblem(res, c.maxBytes);
        if (problem !== null) return problem;
        raw = res.json;
      } else if (c.host === "github") {
        const res = await apiRequest(c, { method: "GET", path: `${target.path}/releases/latest` });
        const problem = bodyProblem(res, c.maxBytes);
        if (problem !== null) return problem;
        raw = res.json;
      } else {
        const res = await apiRequest(c, {
          method: "GET",
          path: `${target.path}/releases`,
          query: { per_page: 1, page: 1 },
        });
        const problem = bodyProblem(res, c.maxBytes);
        if (problem !== null) return problem;
        raw = asArray(res.json)[0];
        latestVia = "first entry of the release listing — GitLab has no latest endpoint";
        if (raw === undefined) return `no releases found for ${input.owner}/${input.repo}`;
      }

      const release = normalizeRelease(c.host, raw);
      if (release === undefined) return "the host answered with something that is not a release";
      release["notes"] = clip(
        str(asRec(raw), "body") ?? str(asRec(raw), "description"),
        maxBodyChars,
      );
      return json({
        host: c.host,
        repo: `${input.owner}/${input.repo}`,
        ...(input.tag === undefined ? { latestVia } : {}),
        release,
      });
    }),
});

export const repoGet: RegisteredTool = readTool({
  name: "RepoGet",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    "Fetch a repository's default branch, visibility, topics, size, archive state and counts. Use it before any other call that needs the default branch, or to check visibility before writing something a PrComment would publish. Topics come back sorted so the record is stable between calls. The size field is what the host reports — kilobytes on GitHub, bytes on GitLab when statistics are readable — and it is named accordingly rather than converted.",
  inputSchema: z.object({
    host: hostSchema,
    baseUrl: baseUrlSchema,
    tokenEnv: tokenEnvSchema,
    owner: ownerSchema,
    repo: repoSchema,
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const res = await apiRequest(c, {
        method: "GET",
        path: target.path,
        query: c.host === "gitlab" ? { statistics: true } : {},
      });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      const repo = normalizeRepo(c.host, res.json);
      if (repo === undefined) return "the host answered with something that is not a repository";
      return json({ host: c.host, repository: repo });
    }),
});

export const compareRefs: RegisteredTool = readTool({
  name: "CompareRefs",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    "Compare two refs and return the commits and files between them. Use it to see what a release tag adds over the last one, or what a branch has that main does not, without cloning anything. Commits come back oldest first and files sorted by path, with patches clipped to maxPatchChars. GitHub's compare endpoint returns at most 250 commits and 300 files and states ahead/behind counts; GitLab states neither count, so those fields are simply absent for a GitLab project rather than guessed.",
  inputSchema: z.object({
    ...repoFields,
    base: z.string().min(1).describe("the ref to compare from"),
    head: z.string().min(1).describe("the ref to compare to"),
    includeFiles: z.boolean().optional().describe("default true"),
    maxFiles: z.number().int().min(1).max(300).optional().describe("default 50"),
    maxCommits: z.number().int().min(1).max(250).optional().describe("default 100"),
    maxPatchChars: z.number().int().min(0).max(40_000).optional().describe("default 2000"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      for (const [field, value] of [
        ["base", input.base],
        ["head", input.head],
      ] as const) {
        const refusal = checkRef(field, value);
        if (refusal !== null) return refusal;
      }
      const path =
        c.host === "github"
          ? `${target.path}/compare/${encodePathRef(input.base)}...${encodePathRef(input.head)}`
          : `${target.path}/repository/compare`;
      const res = await apiRequest(c, {
        method: "GET",
        path,
        query: c.host === "github" ? {} : { from: input.base, to: input.head },
      });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      const raw = asRec(res.json);
      if (raw === undefined) return "the host answered with something that is not a comparison";

      const commits = mapDefined(asArray(raw["commits"]), (entry) =>
        normalizeCommit(c.host, entry),
      ).slice(0, input.maxCommits ?? 100);
      let files: Rec[] | undefined;
      if (input.includeFiles !== false) {
        const maxPatchChars = input.maxPatchChars ?? 2000;
        const source = c.host === "github" ? asArray(raw["files"]) : asArray(raw["diffs"]);
        files = sortRecords(
          mapDefined(source, (entry) => normalizeFile(c.host, entry, maxPatchChars)),
          "path",
          "asc",
        ).slice(0, input.maxFiles ?? 50);
      }
      return json({
        host: c.host,
        repo: `${input.owner}/${input.repo}`,
        base: input.base,
        head: input.head,
        status: str(raw, "status"),
        aheadBy: num(raw, "ahead_by"),
        behindBy: num(raw, "behind_by"),
        totalCommits: num(raw, "total_commits") ?? commits.length,
        commits,
        files,
      });
    }),
});

// ---------------------------------------------------------------------------
// search and quota — read
// ---------------------------------------------------------------------------

export const searchCode: RegisteredTool = readTool({
  name: "SearchCode",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    "Search the host's code index and return the matching paths, paginated. Use it to find where a symbol or string lives across repositories before reading any file. Results are in the host's relevance order by default, which is the answer being asked for; pass order \"path\" to sort them instead. Two host limits: GitHub's code search covers the default branch of indexed repositories only and needs a qualifier such as repo: or org: in the query, and GitLab's blob search is per-project here, so it requires owner and repo.",
  inputSchema: z.object({
    host: hostSchema,
    baseUrl: baseUrlSchema,
    tokenEnv: tokenEnvSchema,
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
    query: z.string().min(1).describe("the host's code-search query"),
    owner: z.string().min(1).optional().describe("required for GitLab"),
    repo: z.string().min(1).optional().describe("required for GitLab"),
    order: z.enum(["relevance", "path"]).optional().describe("default relevance"),
    perPage: perPageSchema,
    maxPages: maxPagesSchema,
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const pages = { perPage: input.perPage ?? 30, maxPages: input.maxPages ?? 1 };
      if (c.host === "gitlab") {
        if (input.owner === undefined || input.repo === undefined) {
          return "GitLab code search here is project-scoped: pass owner and repo (a group- or instance-wide blob search needs GitLab Advanced Search, which this tool does not use)";
        }
        const target = repoPath(c.host, input.owner, input.repo);
        if (!target.ok) return target.message;
        const listing = await apiList(
          c,
          {
            method: "GET",
            path: `${target.path}/search`,
            query: { scope: "blobs", search: input.query },
          },
          pages,
        );
        const problem = bodyProblem(listing.last, c.maxBytes);
        if (problem !== null) return problem;
        const matches = mapDefined(listing.items, (entry) => {
          const rec = asRec(entry);
          if (rec === undefined) return undefined;
          return compact({
            path: str(rec, "path"),
            ref: str(rec, "ref"),
            startLine: num(rec, "startline"),
            snippet: clip(str(rec, "data"), 500),
          });
        });
        const ordered =
          input.order === "path" ? sortRecords(matches, "path", "asc", "startLine") : matches;
        return json({
          host: c.host,
          count: ordered.length,
          morePages: listing.morePages,
          matches: ordered,
        });
      }

      const listing = await apiList(
        c,
        { method: "GET", path: "/search/code", query: { q: input.query } },
        pages,
      );
      const problem = bodyProblem(listing.last, c.maxBytes);
      if (problem !== null) return problem;
      const matches = mapDefined(
        listing.items.flatMap((item) => asArray(asRec(item)?.["items"])),
        (entry) => {
          const rec = asRec(entry);
          if (rec === undefined) return undefined;
          return compact({
            path: str(rec, "path"),
            repository: str(asRec(rec["repository"]), "full_name"),
            sha: str(rec, "sha"),
            url: str(rec, "html_url"),
          });
        },
      );
      const ordered =
        input.order === "path" ? sortRecords(matches, "path", "asc", "repository") : matches;
      return json({
        host: c.host,
        totalCount: num(asRec(listing.items[0]), "total_count"),
        count: ordered.length,
        morePages: listing.morePages,
        matches: ordered,
      });
    }),
});

export const searchIssues: RegisteredTool = readTool({
  name: "SearchIssues",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    'Search issues and pull requests across repositories and return them as normalised records. Use it to answer "has anyone reported this" or "what is assigned to me across the org" in one call. Results are in the host\'s relevance order by default; pass order "number" to sort them. GitHub\'s search syntax (is:open, repo:, label:) goes in the query verbatim and is not validated here, so a malformed query comes back as the host\'s own 422; on GitLab the search is scoped to a project when owner and repo are given and instance-wide otherwise.',
  inputSchema: z.object({
    host: hostSchema,
    baseUrl: baseUrlSchema,
    tokenEnv: tokenEnvSchema,
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
    query: z.string().min(1),
    owner: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    order: z.enum(["relevance", "number"]).optional().describe("default relevance"),
    perPage: perPageSchema,
    maxPages: maxPagesSchema,
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const pages = { perPage: input.perPage ?? 30, maxPages: input.maxPages ?? 1 };
      if (c.host === "gitlab") {
        let path = "/search";
        if (input.owner !== undefined && input.repo !== undefined) {
          const target = repoPath(c.host, input.owner, input.repo);
          if (!target.ok) return target.message;
          path = `${target.path}/search`;
        }
        const listing = await apiList(
          c,
          { method: "GET", path, query: { scope: "issues", search: input.query } },
          pages,
        );
        const problem = bodyProblem(listing.last, c.maxBytes);
        if (problem !== null) return problem;
        const issues = mapDefined(listing.items, (raw) => normalizeIssue("gitlab", raw));
        const ordered = input.order === "number" ? sortRecords(issues, "number", "desc") : issues;
        return json({
          host: c.host,
          count: ordered.length,
          morePages: listing.morePages,
          issues: ordered,
        });
      }

      const listing = await apiList(
        c,
        { method: "GET", path: "/search/issues", query: { q: input.query } },
        pages,
      );
      const problem = bodyProblem(listing.last, c.maxBytes);
      if (problem !== null) return problem;
      const raw = listing.items.flatMap((item) => asArray(asRec(item)?.["items"]));
      const issues = mapDefined(raw, (entry) => {
        const record = normalizeIssue("github", entry);
        if (record === undefined) return undefined;
        record["isPullRequest"] = isPullRequestEntry(entry);
        return record;
      });
      const ordered = input.order === "number" ? sortRecords(issues, "number", "desc") : issues;
      return json({
        host: c.host,
        totalCount: num(asRec(listing.items[0]), "total_count"),
        count: ordered.length,
        morePages: listing.morePages,
        issues: ordered,
      });
    }),
});

export const rateLimitStatus: RegisteredTool = readTool({
  name: "RateLimitStatus",
  operativeArgs: [],
  description:
    "Report how much API quota the token has left, per resource where the host publishes it. Use it before a fleet job starts a long walk, and between batches, so the job stops on purpose instead of hitting a 403 halfway through. GitHub answers with a real endpoint covering core, search, graphql and the rest; GitLab has no such endpoint, so the tool makes one cheap request and reads the RateLimit headers off it, which means a GitLab instance with rate limiting disabled honestly reports nothing. Reset times are the epoch seconds the host stated, echoed rather than converted.",
  inputSchema: z.object({
    host: hostSchema,
    baseUrl: baseUrlSchema,
    tokenEnv: tokenEnvSchema,
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      if (c.host === "gitlab") {
        const res = await apiRequest(c, { method: "GET", path: "/version" });
        if (!res.ok) return apiErrorMessage(res.status, res.text);
        const headers = rateHeadersFrom(res.headers);
        return json({
          host: c.host,
          source: "response headers",
          ...headers,
          ...(Object.keys(headers).length === 0
            ? {
                note: "this instance published no RateLimit headers — rate limiting may be disabled",
              }
            : {}),
        });
      }
      const res = await apiRequest(c, { method: "GET", path: "/rate_limit" });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      const resources = asRec(asRec(res.json)?.["resources"]) ?? {};
      const out: Rec = {};
      for (const key of Object.keys(resources).sort(byString)) {
        const entry = asRec(resources[key]);
        if (entry === undefined) continue;
        out[key] = compact({
          limit: num(entry, "limit"),
          remaining: num(entry, "remaining"),
          used: num(entry, "used"),
          resetAt: num(entry, "reset"),
        });
      }
      return json({ host: c.host, source: "rate_limit endpoint", resources: out });
    }),
});

// ---------------------------------------------------------------------------
// pull requests and issues — write
// ---------------------------------------------------------------------------

export const prCreate: RegisteredTool = writeTool({
  name: "PrCreate",
  operativeArgs: [{ field: "repo", kind: "recipient", within: "owner" }],
  description:
    "Open a pull request (GitLab: merge request) from one branch to another. Use it to propose a change the agent has already pushed. This is publicly visible under the token owner's name and it notifies subscribers, so it takes a justification and is not something to retry blindly: a second call with the same branches usually fails as a duplicate rather than creating a second PR. It does not push anything — the source branch must already exist on the host — and it cannot merge.",
  inputSchema: z.object({
    ...repoFields,
    title: z.string().min(1).max(400),
    sourceBranch: z
      .string()
      .min(1)
      .describe("the branch with the change; GitHub also accepts owner:branch"),
    targetBranch: z.string().min(1).describe("the branch to merge into"),
    body: z.string().max(60_000).optional().describe("the PR description"),
    draft: z.boolean().optional().describe("default false"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      for (const [field, value] of [
        ["sourceBranch", input.sourceBranch],
        ["targetBranch", input.targetBranch],
      ] as const) {
        const refusal = checkRef(field, value);
        if (refusal !== null) return refusal;
      }
      const res =
        c.host === "github"
          ? await apiRequest(c, {
              method: "POST",
              path: `${target.path}/pulls`,
              body: compact({
                title: input.title,
                head: input.sourceBranch,
                base: input.targetBranch,
                body: input.body,
                draft: input.draft ?? false,
              }),
            })
          : await apiRequest(c, {
              method: "POST",
              path: `${target.path}/merge_requests`,
              body: compact({
                title: input.title,
                source_branch: input.sourceBranch,
                target_branch: input.targetBranch,
                description: input.body,
              }),
            });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      return json({
        host: c.host,
        created: true,
        pullRequest: normalizePr(c.host, res.json),
      });
    }),
});

export const prUpdate: RegisteredTool = writeTool({
  name: "PrUpdate",
  operativeArgs: [{ field: "repo", kind: "recipient", within: "owner" }],
  description:
    "Change an open pull request: its title, body, target branch, state, labels or requested reviewers. Use it to retitle a PR, close one, or put the right labels and reviewers on it. Labels REPLACE the existing set rather than adding to it, which is the host's own semantics and the easy way to wipe labels by accident. Requested reviewers are GitHub-only here, because GitLab's API takes numeric user ids rather than handles; asking for them on a GitLab project is refused rather than silently skipped. Reopening a merged PR is not possible on either host, and this tool never merges one. On GitLab a label name containing a comma is refused, because the host reads the list as one comma-separated string.",
  inputSchema: z.object({
    ...repoFields,
    number: z.number().int().positive(),
    title: z.string().min(1).max(400).optional(),
    body: z.string().max(60_000).optional(),
    state: z.enum(["open", "closed"]).optional(),
    targetBranch: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).max(50).optional().describe("REPLACES the current labels"),
    reviewers: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe("GitHub only; handles to request"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const idRefusal = checkId("number", input.number);
      if (idRefusal !== null) return idRefusal;
      if (input.targetBranch !== undefined) {
        const refusal = checkRef("targetBranch", input.targetBranch);
        if (refusal !== null) return refusal;
      }
      if (input.reviewers !== undefined && c.host === "gitlab") {
        return "reviewers are not supported for GitLab here: its API takes numeric user ids rather than handles, and resolving a handle to an id is a separate lookup this tool does not make";
      }
      const applied: string[] = [];

      if (c.host === "gitlab") {
        let labelList: string | undefined;
        if (input.labels !== undefined) {
          const joined = joinCommaList("labels", [...input.labels].sort(byString));
          if (!joined.ok) return joined.message;
          labelList = joined.value;
        }
        const body = compact({
          title: input.title,
          description: input.body,
          target_branch: input.targetBranch,
          state_event:
            input.state === undefined ? undefined : input.state === "closed" ? "close" : "reopen",
          labels: labelList,
        });
        if (Object.keys(body).length === 0) return "nothing to update: pass at least one field";
        const res = await apiRequest(c, {
          method: "PUT",
          path: `${target.path}/merge_requests/${input.number}`,
          body,
        });
        const problem = bodyProblem(res, c.maxBytes);
        if (problem !== null) return problem;
        return json({
          host: c.host,
          updated: Object.keys(body).sort(byString),
          pullRequest: normalizePr(c.host, res.json),
        });
      }

      const core = compact({
        title: input.title,
        body: input.body,
        state: input.state,
        base: input.targetBranch,
      });
      let pr: Rec | undefined;
      if (Object.keys(core).length > 0) {
        const res = await apiRequest(c, {
          method: "PATCH",
          path: `${target.path}/pulls/${input.number}`,
          body: core,
        });
        const problem = bodyProblem(res, c.maxBytes);
        if (problem !== null) return problem;
        pr = normalizePr(c.host, res.json);
        applied.push(...Object.keys(core).sort(byString));
      }
      if (input.labels !== undefined) {
        const res = await apiRequest(c, {
          method: "PUT",
          path: `${target.path}/issues/${input.number}/labels`,
          body: { labels: input.labels },
        });
        if (!res.ok) {
          return json({
            host: c.host,
            updated: applied,
            failedAt: "labels",
            error: apiErrorMessage(res.status, res.text),
          });
        }
        applied.push("labels");
      }
      if (input.reviewers !== undefined) {
        const res = await apiRequest(c, {
          method: "POST",
          path: `${target.path}/pulls/${input.number}/requested_reviewers`,
          body: { reviewers: [...input.reviewers].sort(byString) },
        });
        if (!res.ok) {
          return json({
            host: c.host,
            updated: applied,
            failedAt: "reviewers",
            error: apiErrorMessage(res.status, res.text),
          });
        }
        applied.push("reviewers");
      }
      if (applied.length === 0) return "nothing to update: pass at least one field";
      return json({ host: c.host, updated: applied.sort(byString), pullRequest: pr });
    }),
});

export const prComment: RegisteredTool = writeTool({
  name: "PrComment",
  operativeArgs: [{ field: "repo", kind: "recipient", within: "owner" }],
  description:
    "Post a comment on a pull request's conversation. Use it to report what an automated run found, or to answer a reviewer. The comment is publicly visible under the token owner's name and notifies everyone subscribed to the PR, so it takes a justification; there is no dry-run and no edit-or-create, so calling it twice posts twice. It cannot comment on a specific line of the diff — that is a review comment, which this package does not write.",
  inputSchema: z.object({
    ...repoFields,
    number: z.number().int().positive(),
    body: z.string().min(1).max(60_000),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const idRefusal = checkId("number", input.number);
      if (idRefusal !== null) return idRefusal;
      const path =
        c.host === "github"
          ? `${target.path}/issues/${input.number}/comments`
          : `${target.path}/merge_requests/${input.number}/notes`;
      const res = await apiRequest(c, { method: "POST", path, body: { body: input.body } });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      return json({
        host: c.host,
        posted: true,
        comment: normalizeComment(c.host, res.json, 500),
      });
    }),
});

export const prReviewSubmit: RegisteredTool = writeTool({
  name: "PrReviewSubmit",
  operativeArgs: [{ field: "repo", kind: "recipient", within: "owner" }],
  description:
    "Submit a review on a pull request: approve, request changes, or comment. Use it to record an automated verdict where the team already looks for one. This is the most visible write in the package — an approval carries weight in branch protection — so it takes a justification and refuses anything it cannot do faithfully. On GitLab, approve maps to the approval endpoint and comment posts a note, but request-changes has no equivalent and is refused rather than downgraded to a comment that nobody would treat as blocking.",
  inputSchema: z.object({
    ...repoFields,
    number: z.number().int().positive(),
    event: z.enum(["approve", "request-changes", "comment"]),
    body: z.string().max(60_000).optional().describe("required for request-changes and comment"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const idRefusal = checkId("number", input.number);
      if (idRefusal !== null) return idRefusal;
      if (input.event !== "approve" && (input.body === undefined || input.body.trim() === "")) {
        return `event "${input.event}" needs a body — a review that says nothing is not a review`;
      }

      if (c.host === "gitlab") {
        if (input.event === "request-changes") {
          return "GitLab has no request-changes review state; post the objection with PrComment, or use approve, which this tool does support";
        }
        if (input.event === "comment") {
          const res = await apiRequest(c, {
            method: "POST",
            path: `${target.path}/merge_requests/${input.number}/notes`,
            body: { body: input.body },
          });
          const problem = bodyProblem(res, c.maxBytes);
          if (problem !== null) return problem;
          return json({ host: c.host, submitted: "comment", asNote: true });
        }
        const res = await apiRequest(c, {
          method: "POST",
          path: `${target.path}/merge_requests/${input.number}/approve`,
        });
        if (!res.ok) return apiErrorMessage(res.status, res.text);
        return json({ host: c.host, submitted: "approve" });
      }

      const event =
        input.event === "approve"
          ? "APPROVE"
          : input.event === "request-changes"
            ? "REQUEST_CHANGES"
            : "COMMENT";
      const res = await apiRequest(c, {
        method: "POST",
        path: `${target.path}/pulls/${input.number}/reviews`,
        body: compact({ event, body: input.body }),
      });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      return json({
        host: c.host,
        submitted: input.event,
        review: normalizeReview(res.json, 500),
      });
    }),
});

export const issueCreate: RegisteredTool = writeTool({
  name: "IssueCreate",
  operativeArgs: [{ field: "repo", kind: "recipient", within: "owner" }],
  description:
    "Open an issue with a title, body, labels and assignees. Use it to file what an automated run found somewhere the team will see it. The issue is publicly visible under the token owner's name and notifies watchers, so it takes a justification and has no deduplication: search first with SearchIssues if a repeat run could file the same thing twice. Labels that do not exist are created by GitHub and rejected by GitLab, which is the host's behaviour, not this tool's; on GitLab, where labels travel as one comma-separated string, a label name containing a comma is refused rather than split in two.",
  inputSchema: z.object({
    ...repoFields,
    title: z.string().min(1).max(400),
    body: z.string().max(60_000).optional(),
    labels: z.array(z.string().min(1)).max(50).optional(),
    assignees: z.array(z.string().min(1)).max(20).optional().describe("GitHub only"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      if (input.assignees !== undefined && c.host === "gitlab") {
        return "assignees are not supported for GitLab here: its API takes numeric user ids rather than handles";
      }
      const sortedLabels =
        input.labels === undefined ? undefined : [...input.labels].sort(byString);
      let body: Rec;
      if (c.host === "github") {
        body = compact({
          title: input.title,
          body: input.body,
          labels: sortedLabels,
          assignees:
            input.assignees === undefined ? undefined : [...input.assignees].sort(byString),
        });
      } else {
        let labelList: string | undefined;
        if (sortedLabels !== undefined) {
          const joined = joinCommaList("labels", sortedLabels);
          if (!joined.ok) return joined.message;
          labelList = joined.value;
        }
        body = compact({ title: input.title, description: input.body, labels: labelList });
      }
      const res = await apiRequest(c, { method: "POST", path: `${target.path}/issues`, body });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      return json({ host: c.host, created: true, issue: normalizeIssue(c.host, res.json) });
    }),
});

export const issueUpdate: RegisteredTool = writeTool({
  name: "IssueUpdate",
  operativeArgs: [{ field: "repo", kind: "recipient", within: "owner" }],
  description:
    'Change an issue: its title, body, state, labels or assignees. Use it to close what has been fixed or to relabel a triaged backlog. Labels REPLACE the existing set rather than adding to it, so a call that means to add one must send the whole list. Closing is as far as it goes: this package does not delete issues, and a closed issue can be reopened with state "open". On GitLab a label name containing a comma is refused, because the host reads the list as one comma-separated string.',
  inputSchema: z.object({
    ...repoFields,
    number: z.number().int().positive(),
    title: z.string().min(1).max(400).optional(),
    body: z.string().max(60_000).optional(),
    state: z.enum(["open", "closed"]).optional(),
    labels: z.array(z.string().min(1)).max(50).optional().describe("REPLACES the current labels"),
    assignees: z.array(z.string().min(1)).max(20).optional().describe("GitHub only; REPLACES"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const idRefusal = checkId("number", input.number);
      if (idRefusal !== null) return idRefusal;
      if (input.assignees !== undefined && c.host === "gitlab") {
        return "assignees are not supported for GitLab here: its API takes numeric user ids rather than handles";
      }
      const sortedLabels =
        input.labels === undefined ? undefined : [...input.labels].sort(byString);
      let body: Rec;
      if (c.host === "github") {
        body = compact({
          title: input.title,
          body: input.body,
          state: input.state,
          labels: sortedLabels,
          assignees:
            input.assignees === undefined ? undefined : [...input.assignees].sort(byString),
        });
      } else {
        let labelList: string | undefined;
        if (sortedLabels !== undefined) {
          const joined = joinCommaList("labels", sortedLabels);
          if (!joined.ok) return joined.message;
          labelList = joined.value;
        }
        body = compact({
          title: input.title,
          description: input.body,
          state_event:
            input.state === undefined ? undefined : input.state === "closed" ? "close" : "reopen",
          labels: labelList,
        });
      }
      if (Object.keys(body).length === 0) return "nothing to update: pass at least one field";
      const res = await apiRequest(c, {
        method: c.host === "github" ? "PATCH" : "PUT",
        path: `${target.path}/issues/${input.number}`,
        body,
      });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      return json({
        host: c.host,
        updated: Object.keys(body).sort(byString),
        issue: normalizeIssue(c.host, res.json),
      });
    }),
});

export const issueComment: RegisteredTool = writeTool({
  name: "IssueComment",
  operativeArgs: [{ field: "repo", kind: "recipient", within: "owner" }],
  description:
    "Post a comment on an issue. Use it to add a finding or a status update to an existing report. The comment is publicly visible under the token owner's name and notifies subscribers, so it takes a justification; it always creates a new comment, so a loop that calls it on every run will produce one comment per run. On GitHub an issue number and a PR number share a namespace, so this will comment on a pull request too — PrComment says so in its name.",
  inputSchema: z.object({
    ...repoFields,
    number: z.number().int().positive(),
    body: z.string().min(1).max(60_000),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const idRefusal = checkId("number", input.number);
      if (idRefusal !== null) return idRefusal;
      const path =
        c.host === "github"
          ? `${target.path}/issues/${input.number}/comments`
          : `${target.path}/issues/${input.number}/notes`;
      const res = await apiRequest(c, { method: "POST", path, body: { body: input.body } });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      return json({
        host: c.host,
        posted: true,
        comment: normalizeComment(c.host, res.json, 500),
      });
    }),
});

export const releaseCreate: RegisteredTool = writeTool({
  name: "ReleaseCreate",
  operativeArgs: [{ field: "repo", kind: "recipient", within: "owner" }],
  description:
    "Publish a release for an existing tag, with a name and notes. Use it as the last step of a release job once the tag is pushed. A published release is visible immediately and, on GitHub, notifies everyone watching releases, so it takes a justification; publishing over an existing tag fails rather than overwriting it. It does not create the tag and it does not upload assets — GitHub takes those on a separate upload origin that this package deliberately does not reach.",
  inputSchema: z.object({
    ...repoFields,
    tag: z.string().min(1).describe("an existing tag"),
    name: z.string().min(1).max(400).optional().describe("release title; defaults to the tag"),
    notes: z.string().max(120_000).optional(),
    draft: z.boolean().optional().describe("GitHub only; default false"),
    prerelease: z.boolean().optional().describe("GitHub only; default false"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const refusal = checkRef("tag", input.tag);
      if (refusal !== null) return refusal;
      const body =
        c.host === "github"
          ? compact({
              tag_name: input.tag,
              name: input.name ?? input.tag,
              body: input.notes,
              draft: input.draft ?? false,
              prerelease: input.prerelease ?? false,
            })
          : compact({
              tag_name: input.tag,
              name: input.name ?? input.tag,
              description: input.notes,
            });
      const res = await apiRequest(c, { method: "POST", path: `${target.path}/releases`, body });
      const problem = bodyProblem(res, c.maxBytes);
      if (problem !== null) return problem;
      return json({
        host: c.host,
        created: true,
        release: normalizeRelease(c.host, res.json),
      });
    }),
});

export const workflowRunRerun: RegisteredTool = writeTool({
  name: "WorkflowRunRerun",
  operativeArgs: [{ field: "repo", kind: "id", within: "owner" }],
  description:
    "Re-run a CI run, or just its failed jobs. Use it when a run failed for a reason already fixed elsewhere, or on a flake that a second attempt settles. It spends the repository's CI minutes and posts a new run under the token owner's name, so it takes a justification and is not a retry loop to leave unattended. failedOnly is GitHub's rerun-failed-jobs endpoint; GitLab's retry always re-runs the failed jobs of a pipeline, so the flag makes no difference there and the result says which behaviour applied.",
  inputSchema: z.object({
    ...repoFields,
    runId: z.number().int().positive().describe("GitHub Actions run id, or GitLab pipeline id"),
    failedOnly: z.boolean().optional().describe("GitHub only; default false"),
  }),
  execute: (input, ctx) =>
    withCall(input, ctx, async (c) => {
      const target = repoPath(c.host, input.owner, input.repo);
      if (!target.ok) return target.message;
      const idRefusal = checkId("runId", input.runId);
      if (idRefusal !== null) return idRefusal;
      if (c.host === "gitlab") {
        const res = await apiRequest(c, {
          method: "POST",
          path: `${target.path}/pipelines/${input.runId}/retry`,
        });
        const problem = bodyProblem(res, c.maxBytes);
        if (problem !== null) return problem;
        return json({
          host: c.host,
          rerun: "failed jobs (GitLab retry re-runs failed jobs only)",
          run: normalizeWorkflowRun(c.host, res.json),
        });
      }
      const failedOnly = input.failedOnly ?? false;
      const res = await apiRequest(c, {
        method: "POST",
        path: `${target.path}/actions/runs/${input.runId}/${failedOnly ? "rerun-failed-jobs" : "rerun"}`,
      });
      if (!res.ok) return apiErrorMessage(res.status, res.text);
      return json({
        host: c.host,
        runId: input.runId,
        rerun: failedOnly ? "failed jobs" : "whole run",
        status: res.status,
      });
    }),
});

/** Every tool this package registers, in the order a catalog should list them. */
export const CODEHOST_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  checkRuns,
  compareRefs,
  issueComment,
  issueCreate,
  issueGet,
  issueList,
  issueUpdate,
  prComment,
  prComments,
  prCreate,
  prFiles,
  prGet,
  prList,
  prReviewSubmit,
  prReviews,
  prUpdate,
  rateLimitStatus,
  releaseCreate,
  releaseGet,
  releaseList,
  repoGet,
  searchCode,
  searchIssues,
  workflowRunLogs,
  workflowRunRerun,
  workflowRuns,
]);
