/**
 * `@crewhaus/tool-codehost/pulls`: a GitHub repository's pull requests for a caller
 * outside the tools, over the same `apiRequest` every tool here uses (the token as a
 * header only, the byte cap, the origin allow-list, the SSRF check on every hop, the
 * redactor on the way back). The steward workspace engine publishes through it.
 *
 * - {@link findPullByHead}, {@link createPull}, {@link updatePull}, {@link getPull},
 *   {@link pullReview} and {@link listBaseCommits} each take a {@link CallCtx}, which
 *   {@link withPullsCall} builds for one API origin alone.
 * - A second create for one head answers `{exists: true}`: the 422 GitHub sends then is
 *   an answer, and the caller looks the pull request up.
 * - `getPull` sends an `If-None-Match` validator and answers `notModified` on a 304; a
 *   403 with no requests left, or a 429, answers `rateLimited` with the wait the host
 *   asked for.
 *
 * `PrCreate`, `PrUpdate` and `PrGet` make their GitHub requests through
 * {@link postPull}, {@link patchPull} and {@link fetchPull}, so the tools and this module
 * send the same requests.
 */
import { type ApiResult, type CallCtx, apiRequest, normalizeBaseUrl } from "./api";
import {
  CodehostPermissionError,
  buildCodehostConfig,
  canonicalizeOrigin,
  redactorFor,
  startDeadline,
} from "./net";

/** A GitHub repository, `owner/name`. */
export type RepoName = { readonly owner: string; readonly name: string };

const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** `owner/name` as a repository, or `undefined` when it is not one. */
export function parseRepoName(text: string): RepoName | undefined {
  const [owner, name, ...rest] = text.split("/");
  if (rest.length > 0 || owner === undefined || name === undefined) return undefined;
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || name === "." || name === "..") {
    return undefined;
  }
  return { owner, name };
}

function repoPathOf(repo: RepoName): string {
  if (parseRepoName(`${repo.owner}/${repo.name}`) === undefined) {
    throw new CodehostPermissionError("a repository is owner/name");
  }
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** The request `PrCreate` makes on GitHub: `POST <repo>/pulls`. */
export function postPull(
  c: CallCtx,
  repoPath: string,
  body: Readonly<Record<string, unknown>>,
): Promise<ApiResult> {
  return apiRequest(c, { method: "POST", path: `${repoPath}/pulls`, body });
}

/** The request `PrUpdate` makes on GitHub for its core fields: `PATCH <repo>/pulls/<n>`. */
export function patchPull(
  c: CallCtx,
  repoPath: string,
  number: number,
  body: Readonly<Record<string, unknown>>,
): Promise<ApiResult> {
  return apiRequest(c, { method: "PATCH", path: `${repoPath}/pulls/${number}`, body });
}

/** The request `PrGet` makes on GitHub: `GET <repo>/pulls/<n>`. */
export function fetchPull(
  c: CallCtx,
  repoPath: string,
  number: number,
  ifNoneMatch?: string,
): Promise<ApiResult> {
  return apiRequest(c, {
    method: "GET",
    path: `${repoPath}/pulls/${number}`,
    ...(ifNoneMatch !== undefined ? { ifNoneMatch } : {}),
  });
}

/** A pull request, as a caller decides on it. */
export type PullInfo = {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly draft: boolean;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly mergeSha?: string;
  readonly mergedAt?: string;
  readonly url?: string;
};

/** A request the host refused, or one that could not be read. */
export type PullFailure = {
  readonly ok: false;
  readonly status: number;
  readonly message: string;
  /** The host asked the caller to wait: a 429, or a 403 with no requests left. */
  readonly rateLimited?: true;
  /** How long it asked to wait, when it said. */
  readonly retryAfterMs?: number;
};

type Rec = Readonly<Record<string, unknown>>;

function rec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function str(r: Rec | undefined, key: string): string | undefined {
  const value = r?.[key];
  return typeof value === "string" ? value : undefined;
}

/** A pull request record, or `undefined` when the answer is not one. */
export function pullInfoOf(raw: unknown): PullInfo | undefined {
  const r = rec(raw);
  const number = r?.["number"];
  const head = rec(r?.["head"]);
  const base = rec(r?.["base"]);
  const state = str(r, "state");
  const headRef = str(head, "ref");
  const headSha = str(head, "sha");
  const baseRef = str(base, "ref");
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    (state !== "open" && state !== "closed") ||
    headRef === undefined ||
    headSha === undefined ||
    baseRef === undefined
  ) {
    return undefined;
  }
  const mergedAt = str(r, "merged_at");
  const mergeSha = str(r, "merge_commit_sha");
  const url = str(r, "html_url");
  return {
    number,
    state,
    merged: r?.["merged"] === true || mergedAt !== undefined,
    draft: r?.["draft"] === true,
    headRef,
    headSha,
    baseRef,
    ...(mergeSha !== undefined ? { mergeSha } : {}),
    ...(mergedAt !== undefined ? { mergedAt } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

function failure(res: ApiResult, what: string): PullFailure {
  const remaining = res.headers["x-ratelimit-remaining"];
  const limited = res.status === 429 || (res.status === 403 && remaining === "0");
  const retryAfter = Number.parseInt(res.headers["retry-after"] ?? "", 10);
  return {
    ok: false,
    status: res.status,
    message: `${what}: the host answered ${res.status}`,
    ...(limited ? { rateLimited: true as const } : {}),
    ...(limited && Number.isFinite(retryAfter) && retryAfter >= 0
      ? { retryAfterMs: retryAfter * 1000 }
      : {}),
  };
}

/**
 * The pull request whose head is `branch` in `repo` itself (not a fork), open or closed:
 * `GET <repo>/pulls?head=<owner>:<branch>&state=all`. `pull` is absent when there is none.
 */
export async function findPullByHead(
  c: CallCtx,
  repo: RepoName,
  branch: string,
): Promise<{ readonly ok: true; readonly pull?: PullInfo } | PullFailure> {
  const res = await apiRequest(c, {
    method: "GET",
    path: `${repoPathOf(repo)}/pulls`,
    query: { head: `${repo.owner}:${branch}`, state: "all", per_page: 10 },
  });
  if (!res.ok) return failure(res, "listing pull requests");
  const list = Array.isArray(res.json) ? res.json : [];
  const pulls = list
    .map(pullInfoOf)
    .filter((p): p is PullInfo => p !== undefined && p.headRef === branch)
    .sort((a, b) => b.number - a.number);
  const open = pulls.find((p) => p.state === "open");
  const pull = open ?? pulls[0];
  return pull === undefined ? { ok: true } : { ok: true, pull };
}

/** Open a pull request. A second one for the same head answers `{exists: true}`. */
export async function createPull(
  c: CallCtx,
  repo: RepoName,
  input: {
    readonly title: string;
    readonly head: string;
    readonly base: string;
    readonly body: string;
    readonly draft: boolean;
  },
): Promise<
  | { readonly ok: true; readonly pull: PullInfo }
  | { readonly ok: false; readonly exists: true }
  | PullFailure
> {
  const res = await postPull(c, repoPathOf(repo), {
    title: input.title,
    head: input.head,
    base: input.base,
    body: input.body,
    draft: input.draft,
  });
  if (res.status === 422 && /already exists/i.test(res.text)) return { ok: false, exists: true };
  if (!res.ok) return failure(res, "opening the pull request");
  const pull = pullInfoOf(res.json);
  return pull === undefined
    ? { ok: false, status: res.status, message: "the host's answer is not a pull request" }
    : { ok: true, pull };
}

/** Change a pull request's title, body, base or state. */
export async function updatePull(
  c: CallCtx,
  repo: RepoName,
  number: number,
  input: {
    readonly title?: string;
    readonly body?: string;
    readonly base?: string;
    readonly state?: "open" | "closed";
  },
): Promise<{ readonly ok: true; readonly pull: PullInfo } | PullFailure> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) if (value !== undefined) body[key] = value;
  const res = await patchPull(c, repoPathOf(repo), number, body);
  if (!res.ok) return failure(res, "updating the pull request");
  const pull = pullInfoOf(res.json);
  return pull === undefined
    ? { ok: false, status: res.status, message: "the host's answer is not a pull request" }
    : { ok: true, pull };
}

/** One pull request, or `notModified` when the validator still holds. */
export async function getPull(
  c: CallCtx,
  repo: RepoName,
  number: number,
  opts: { readonly etag?: string } = {},
): Promise<
  | { readonly ok: true; readonly notModified: true }
  | { readonly ok: true; readonly pull: PullInfo; readonly etag?: string }
  | PullFailure
> {
  const res = await fetchPull(c, repoPathOf(repo), number, opts.etag);
  if (res.status === 304) return { ok: true, notModified: true };
  if (!res.ok) return failure(res, "reading the pull request");
  const pull = pullInfoOf(res.json);
  if (pull === undefined) {
    return { ok: false, status: res.status, message: "the host's answer is not a pull request" };
  }
  const etag = res.headers["etag"];
  return { ok: true, pull, ...(etag !== undefined ? { etag } : {}) };
}

/**
 * Where a pull request's reviews stand: `changes-requested` when any reviewer's latest
 * review asks for changes, else `approved` when one approved, else nothing to say.
 */
export async function pullReview(
  c: CallCtx,
  repo: RepoName,
  number: number,
): Promise<
  { readonly ok: true; readonly review?: "approved" | "changes-requested" } | PullFailure
> {
  const res = await apiRequest(c, {
    method: "GET",
    path: `${repoPathOf(repo)}/pulls/${number}/reviews`,
    query: { per_page: 100 },
  });
  if (!res.ok) return failure(res, "reading the reviews");
  const latest = new Map<string, string>();
  for (const raw of Array.isArray(res.json) ? res.json : []) {
    const r = rec(raw);
    const who = str(rec(r?.["user"]), "login");
    const state = str(r, "state");
    if (who === undefined || (state !== "APPROVED" && state !== "CHANGES_REQUESTED")) continue;
    latest.set(who, state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return { ok: true, review: "changes-requested" };
  if (states.includes("APPROVED")) return { ok: true, review: "approved" };
  return { ok: true };
}

/** One commit on a branch: its SHA and its message. */
export type CommitLine = { readonly sha: string; readonly message: string };

/** The newest commits on `sha` (a branch) since a time: `GET <repo>/commits?sha&since`. */
export async function listBaseCommits(
  c: CallCtx,
  repo: RepoName,
  opts: { readonly sha: string; readonly since?: string },
): Promise<{ readonly ok: true; readonly commits: readonly CommitLine[] } | PullFailure> {
  const res = await apiRequest(c, {
    method: "GET",
    path: `${repoPathOf(repo)}/commits`,
    query: {
      sha: opts.sha,
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      per_page: 100,
    },
  });
  if (!res.ok) return failure(res, "listing commits");
  const commits: CommitLine[] = [];
  for (const raw of Array.isArray(res.json) ? res.json : []) {
    const r = rec(raw);
    const sha = str(r, "sha");
    const message = str(rec(r?.["commit"]), "message");
    if (sha !== undefined && message !== undefined) commits.push({ sha, message });
  }
  return { ok: true, commits };
}

/** What {@link withPullsCall} needs: one API origin, its token and how long the call may take. */
export type PullsCallOptions = {
  /** The API root, such as `https://api.github.com`. Its origin is the only one allowed. */
  readonly apiBase: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** The binding declared its host private: admit a loopback host, and only that. */
  readonly allowLoopback?: boolean;
  readonly maxBytes?: number;
};

/**
 * Run `fn` with a call context for one GitHub API origin: the allow-list holds that origin
 * alone, the token goes to it alone, and the deadline is cancelled when `fn` ends.
 */
export async function withPullsCall<T>(
  opts: PullsCallOptions,
  fn: (c: CallCtx) => Promise<T>,
): Promise<T> {
  const baseUrl = normalizeBaseUrl(opts.apiBase);
  const origin = canonicalizeOrigin(baseUrl);
  const deadline = startDeadline(opts.timeoutMs, opts.signal);
  const c: CallCtx = {
    cfg: buildCodehostConfig({ allowedOrigins: [origin], host: "github" }),
    host: "github",
    baseUrl,
    token: opts.token,
    tokenOrigin: origin,
    deadline,
    maxBytes: opts.maxBytes ?? 1024 * 1024,
    redact: redactorFor(opts.token),
    ...(opts.allowLoopback === true ? { allowLoopback: true as const } : {}),
  };
  try {
    return await fn(c);
  } finally {
    deadline.cancel();
  }
}
