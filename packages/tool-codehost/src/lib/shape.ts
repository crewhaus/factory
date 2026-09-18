/**
 * One record shape per concept, from two hosts that spell everything
 * differently.
 *
 * A caller should not have to know that a pull request is a `number` with a
 * `head.ref` on GitHub and an `iid` with a `source_branch` on GitLab, or that
 * one says `opened` where the other says `open`. Each normaliser here takes
 * the host's raw JSON and returns the same record either way, dropping
 * everything a reader would not use — a GitHub PR payload is roughly 6 KB of
 * JSON, of which about twenty fields carry the meaning.
 *
 * Everything is pure and defensive: the input is `unknown` shaped like a
 * record, every field is read through an accessor that returns `undefined`
 * rather than throwing, and a field the host omitted is omitted here too
 * rather than invented. A normaliser must never be the thing that crashes a
 * tool because an API added or dropped a key.
 */
import { byString } from "../net";

export type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// accessors
// ---------------------------------------------------------------------------

export function asRec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(rec: Rec | undefined, key: string): string | undefined {
  const value = rec?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function num(rec: Rec | undefined, key: string): number | undefined {
  const value = rec?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function bool(rec: Rec | undefined, key: string): boolean | undefined {
  const value = rec?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function sub(rec: Rec | undefined, key: string): Rec | undefined {
  return asRec(rec?.[key]);
}

/** Drop the keys whose value is `undefined`, so absent stays absent in JSON. */
export function compact<T extends Rec>(rec: T): Rec {
  const out: Rec = {};
  for (const key of Object.keys(rec)) {
    const value = rec[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Cut a string to `max` characters, marking it when something was dropped. */
export function clip(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[clipped ${text.length - max} chars]`;
}

// ---------------------------------------------------------------------------
// people, labels
// ---------------------------------------------------------------------------

/** A user's handle. GitHub calls it `login`, GitLab calls it `username`. */
export function handle(value: unknown): string | undefined {
  const rec = asRec(value);
  return str(rec, "login") ?? str(rec, "username");
}

function handles(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    const name = handle(entry);
    if (name !== undefined) out.push(name);
  }
  // Sorted: a reviewer list is a set, and the host's order for it is not
  // stable enough to be worth reproducing.
  return [...new Set(out)].sort(byString);
}

/** GitHub labels are objects with a `name`; GitLab labels are plain strings. */
export function labels(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    if (typeof entry === "string" && entry !== "") out.push(entry);
    else {
      const name = str(asRec(entry), "name");
      if (name !== undefined) out.push(name);
    }
  }
  return [...new Set(out)].sort(byString);
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

/** open | closed | merged — the three states both hosts agree exist. */
export function prState(host: "github" | "gitlab", raw: Rec): string {
  if (host === "gitlab") {
    const state = str(raw, "state") ?? "unknown";
    return state === "opened" ? "open" : state === "locked" ? "open" : state;
  }
  if (bool(raw, "merged") === true || str(raw, "merged_at") !== undefined) return "merged";
  return str(raw, "state") ?? "unknown";
}

/**
 * GitHub answers `mergeable: null` while it is still computing the merge
 * commit, which is a different thing from "this cannot be merged". It is
 * reported as `"computing"` rather than folded into `false`, because a fleet
 * job that treats the two alike will close a perfectly mergeable PR.
 */
function mergeability(host: "github" | "gitlab", raw: Rec): Rec {
  if (host === "github") {
    const mergeable = raw["mergeable"];
    return compact({
      mergeable: mergeable === null || mergeable === undefined ? "computing" : mergeable,
      mergeableState: str(raw, "mergeable_state"),
    });
  }
  const status = str(raw, "detailed_merge_status") ?? str(raw, "merge_status");
  return compact({
    mergeable:
      status === undefined ? "computing" : status === "can_be_merged" || status === "mergeable",
    mergeableState: status,
  });
}

export function normalizePr(host: "github" | "gitlab", value: unknown): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  if (host === "gitlab") {
    return compact({
      number: num(raw, "iid"),
      title: str(raw, "title"),
      state: prState(host, raw),
      draft: bool(raw, "draft") ?? bool(raw, "work_in_progress"),
      author: handle(raw["author"]),
      sourceBranch: str(raw, "source_branch"),
      targetBranch: str(raw, "target_branch"),
      labels: labels(raw["labels"]),
      reviewers: handles(raw["reviewers"]),
      assignees: handles(raw["assignees"]),
      createdAt: str(raw, "created_at"),
      updatedAt: str(raw, "updated_at"),
      mergedAt: str(raw, "merged_at"),
      closedAt: str(raw, "closed_at"),
      url: str(raw, "web_url"),
      ...mergeability(host, raw),
      hasConflicts: bool(raw, "has_conflicts"),
      sha: str(raw, "sha"),
    });
  }
  return compact({
    number: num(raw, "number"),
    title: str(raw, "title"),
    state: prState(host, raw),
    draft: bool(raw, "draft"),
    author: handle(raw["user"]),
    sourceBranch: str(sub(raw, "head"), "ref"),
    targetBranch: str(sub(raw, "base"), "ref"),
    labels: labels(raw["labels"]),
    reviewers: handles(raw["requested_reviewers"]),
    assignees: handles(raw["assignees"]),
    createdAt: str(raw, "created_at"),
    updatedAt: str(raw, "updated_at"),
    mergedAt: str(raw, "merged_at"),
    closedAt: str(raw, "closed_at"),
    url: str(raw, "html_url"),
    ...mergeability(host, raw),
    sha: str(sub(raw, "head"), "sha"),
    commits: num(raw, "commits"),
    additions: num(raw, "additions"),
    deletions: num(raw, "deletions"),
    changedFiles: num(raw, "changed_files"),
  });
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

/** True for a GitHub issues-endpoint entry that is really a pull request. */
export function isPullRequestEntry(value: unknown): boolean {
  const raw = asRec(value);
  return raw?.["pull_request"] !== undefined;
}

export function normalizeIssue(host: "github" | "gitlab", value: unknown): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  if (host === "gitlab") {
    return compact({
      number: num(raw, "iid"),
      title: str(raw, "title"),
      state: str(raw, "state") === "opened" ? "open" : str(raw, "state"),
      author: handle(raw["author"]),
      labels: labels(raw["labels"]),
      assignees: handles(raw["assignees"]),
      milestone: str(asRec(raw["milestone"]), "title"),
      comments: num(raw, "user_notes_count"),
      createdAt: str(raw, "created_at"),
      updatedAt: str(raw, "updated_at"),
      closedAt: str(raw, "closed_at"),
      url: str(raw, "web_url"),
    });
  }
  return compact({
    number: num(raw, "number"),
    title: str(raw, "title"),
    state: str(raw, "state"),
    stateReason: str(raw, "state_reason"),
    author: handle(raw["user"]),
    labels: labels(raw["labels"]),
    assignees: handles(raw["assignees"]),
    milestone: str(asRec(raw["milestone"]), "title"),
    comments: num(raw, "comments"),
    createdAt: str(raw, "created_at"),
    updatedAt: str(raw, "updated_at"),
    closedAt: str(raw, "closed_at"),
    url: str(raw, "html_url"),
  });
}

// ---------------------------------------------------------------------------
// comments and reviews
// ---------------------------------------------------------------------------

export function normalizeComment(
  host: "github" | "gitlab",
  value: unknown,
  maxBodyChars: number,
): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  if (host === "gitlab") {
    return compact({
      id: num(raw, "id"),
      author: handle(raw["author"]),
      body: clip(str(raw, "body"), maxBodyChars),
      createdAt: str(raw, "created_at"),
      updatedAt: str(raw, "updated_at"),
      system: bool(raw, "system"),
      resolvable: bool(raw, "resolvable"),
      resolved: bool(raw, "resolved"),
      path: str(asRec(raw["position"]), "new_path"),
    });
  }
  return compact({
    id: num(raw, "id"),
    author: handle(raw["user"]),
    body: clip(str(raw, "body"), maxBodyChars),
    createdAt: str(raw, "created_at"),
    updatedAt: str(raw, "updated_at"),
    url: str(raw, "html_url"),
    path: str(raw, "path"),
    line: num(raw, "line") ?? num(raw, "original_line"),
    inReplyTo: num(raw, "in_reply_to_id"),
    reviewId: num(raw, "pull_request_review_id"),
  });
}

/** approved | changes_requested | commented | dismissed | pending. */
export function normalizeReview(value: unknown, maxBodyChars: number): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  const state = str(raw, "state");
  return compact({
    id: num(raw, "id"),
    author: handle(raw["user"]),
    state: state === undefined ? undefined : state.toLowerCase(),
    body: clip(str(raw, "body"), maxBodyChars),
    submittedAt: str(raw, "submitted_at"),
    commitSha: str(raw, "commit_id"),
    url: str(raw, "html_url"),
  });
}

// ---------------------------------------------------------------------------
// checks and CI
// ---------------------------------------------------------------------------

export function normalizeCheckRun(value: unknown): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  return compact({
    id: num(raw, "id"),
    name: str(raw, "name"),
    status: str(raw, "status"),
    conclusion: str(raw, "conclusion"),
    startedAt: str(raw, "started_at"),
    completedAt: str(raw, "completed_at"),
    app: str(asRec(raw["app"]), "slug"),
    title: str(asRec(raw["output"]), "title"),
    summary: clip(str(asRec(raw["output"]), "summary"), 1000),
    url: str(raw, "html_url") ?? str(raw, "details_url"),
  });
}

/** A GitHub commit status (the older API), shaped like a check run. */
export function normalizeCommitStatus(value: unknown): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  const state = str(raw, "state");
  return compact({
    name: str(raw, "context"),
    status: state === "pending" ? "in_progress" : "completed",
    conclusion: state === "pending" ? undefined : state,
    summary: clip(str(raw, "description"), 500),
    url: str(raw, "target_url"),
    kind: "commit_status",
  });
}

/** A GitLab job or commit status, shaped like a check run. */
export function normalizeGitlabJob(value: unknown): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  const status = str(raw, "status");
  const finished = status === "success" || status === "failed" || status === "canceled";
  return compact({
    id: num(raw, "id"),
    name: str(raw, "name"),
    stage: str(raw, "stage"),
    status: finished ? "completed" : status,
    conclusion: finished ? status : undefined,
    startedAt: str(raw, "started_at"),
    completedAt: str(raw, "finished_at"),
    allowFailure: bool(raw, "allow_failure"),
    description: clip(str(raw, "description"), 500),
    // A pipeline job says `web_url`; a commit status says `target_url`. Both
    // shapes come through this function, so both spellings are read.
    url: str(raw, "web_url") ?? str(raw, "target_url"),
  });
}

export function normalizeWorkflowRun(host: "github" | "gitlab", value: unknown): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  if (host === "gitlab") {
    const status = str(raw, "status");
    const finished = status === "success" || status === "failed" || status === "canceled";
    return compact({
      id: num(raw, "id"),
      name: str(raw, "name") ?? str(raw, "source"),
      event: str(raw, "source"),
      status: finished ? "completed" : status,
      conclusion: finished ? status : undefined,
      branch: str(raw, "ref"),
      sha: str(raw, "sha"),
      createdAt: str(raw, "created_at"),
      updatedAt: str(raw, "updated_at"),
      url: str(raw, "web_url"),
    });
  }
  return compact({
    id: num(raw, "id"),
    name: str(raw, "name"),
    workflowId: num(raw, "workflow_id"),
    event: str(raw, "event"),
    status: str(raw, "status"),
    conclusion: str(raw, "conclusion"),
    branch: str(raw, "head_branch"),
    sha: str(raw, "head_sha"),
    runNumber: num(raw, "run_number"),
    attempt: num(raw, "run_attempt"),
    createdAt: str(raw, "created_at"),
    updatedAt: str(raw, "updated_at"),
    url: str(raw, "html_url"),
  });
}

/** A GitHub Actions job, with its steps reduced to the ones that failed. */
export function normalizeJob(value: unknown): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  const steps: Rec[] = [];
  for (const entry of asArray(raw["steps"])) {
    const step = asRec(entry);
    if (step === undefined) continue;
    const conclusion = str(step, "conclusion");
    if (conclusion === "failure" || conclusion === "cancelled" || conclusion === "timed_out") {
      steps.push(
        compact({
          number: num(step, "number"),
          name: str(step, "name"),
          conclusion,
        }),
      );
    }
  }
  return compact({
    id: num(raw, "id"),
    name: str(raw, "name"),
    status: str(raw, "status"),
    conclusion: str(raw, "conclusion"),
    startedAt: str(raw, "started_at"),
    completedAt: str(raw, "completed_at"),
    url: str(raw, "html_url"),
    failedSteps: steps.length > 0 ? steps : undefined,
  });
}

// ---------------------------------------------------------------------------
// releases, repositories, diffs
// ---------------------------------------------------------------------------

export function normalizeRelease(host: "github" | "gitlab", value: unknown): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  if (host === "gitlab") {
    const links = asRec(raw["assets"]);
    const assets: Rec[] = [];
    for (const entry of asArray(links?.["links"])) {
      const asset = asRec(entry);
      if (asset === undefined) continue;
      assets.push(compact({ name: str(asset, "name"), url: str(asset, "url") }));
    }
    assets.sort((a, b) => byString(String(a["name"] ?? ""), String(b["name"] ?? "")));
    return compact({
      tag: str(raw, "tag_name"),
      name: str(raw, "name"),
      createdAt: str(raw, "created_at"),
      releasedAt: str(raw, "released_at"),
      author: handle(raw["author"]),
      url: str(asRec(raw["_links"]), "self"),
      assets,
    });
  }
  const assets: Rec[] = [];
  for (const entry of asArray(raw["assets"])) {
    const asset = asRec(entry);
    if (asset === undefined) continue;
    assets.push(
      compact({
        name: str(asset, "name"),
        sizeBytes: num(asset, "size"),
        downloadCount: num(asset, "download_count"),
        contentType: str(asset, "content_type"),
        url: str(asset, "browser_download_url"),
      }),
    );
  }
  assets.sort((a, b) => byString(String(a["name"] ?? ""), String(b["name"] ?? "")));
  return compact({
    id: num(raw, "id"),
    tag: str(raw, "tag_name"),
    name: str(raw, "name"),
    draft: bool(raw, "draft"),
    prerelease: bool(raw, "prerelease"),
    author: handle(raw["author"]),
    createdAt: str(raw, "created_at"),
    publishedAt: str(raw, "published_at"),
    url: str(raw, "html_url"),
    assets,
  });
}

export function normalizeRepo(host: "github" | "gitlab", value: unknown): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  if (host === "gitlab") {
    const statistics = asRec(raw["statistics"]);
    return compact({
      fullName: str(raw, "path_with_namespace"),
      description: clip(str(raw, "description"), 500),
      defaultBranch: str(raw, "default_branch"),
      visibility: str(raw, "visibility"),
      topics: labels(raw["topics"] ?? raw["tag_list"]),
      archived: bool(raw, "archived"),
      fork: raw["forked_from_project"] !== undefined ? true : undefined,
      sizeBytes: num(statistics, "repository_size"),
      openIssues: num(raw, "open_issues_count"),
      stars: num(raw, "star_count"),
      forks: num(raw, "forks_count"),
      createdAt: str(raw, "created_at"),
      url: str(raw, "web_url"),
    });
  }
  return compact({
    fullName: str(raw, "full_name"),
    description: clip(str(raw, "description"), 500),
    defaultBranch: str(raw, "default_branch"),
    visibility: str(raw, "visibility") ?? (bool(raw, "private") === true ? "private" : "public"),
    topics: labels(raw["topics"]),
    archived: bool(raw, "archived"),
    disabled: bool(raw, "disabled"),
    fork: bool(raw, "fork"),
    language: str(raw, "language"),
    sizeKb: num(raw, "size"),
    openIssues: num(raw, "open_issues_count"),
    stars: num(raw, "stargazers_count"),
    forks: num(raw, "forks_count"),
    license: str(asRec(raw["license"]), "spdx_id"),
    createdAt: str(raw, "created_at"),
    pushedAt: str(raw, "pushed_at"),
    url: str(raw, "html_url"),
  });
}

/**
 * Added and removed line counts derived from a unified diff.
 *
 * GitHub states them; GitLab does not, so for GitLab they are counted here.
 * `+++`/`---` file headers are excluded — counting them would add one to
 * every file in the diff.
 */
export function diffCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

export function normalizeFile(
  host: "github" | "gitlab",
  value: unknown,
  maxPatchChars: number,
): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  if (host === "gitlab") {
    const patch = str(raw, "diff") ?? "";
    const counts = diffCounts(patch);
    const status = bool(raw, "new_file")
      ? "added"
      : bool(raw, "deleted_file")
        ? "removed"
        : bool(raw, "renamed_file")
          ? "renamed"
          : "modified";
    return compact({
      path: str(raw, "new_path") ?? str(raw, "old_path"),
      previousPath: bool(raw, "renamed_file") ? str(raw, "old_path") : undefined,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      countsDerived: true,
      // A cap of zero means the caller asked for no patch at all, so the key
      // is absent rather than present and empty.
      patch: patch === "" || maxPatchChars <= 0 ? undefined : clip(patch, maxPatchChars),
    });
  }
  return compact({
    path: str(raw, "filename"),
    previousPath: str(raw, "previous_filename"),
    status: str(raw, "status"),
    additions: num(raw, "additions"),
    deletions: num(raw, "deletions"),
    changes: num(raw, "changes"),
    patch: maxPatchChars <= 0 ? undefined : clip(str(raw, "patch"), maxPatchChars),
  });
}

export function normalizeCommit(host: "github" | "gitlab", value: unknown): Rec | undefined {
  const raw = asRec(value);
  if (raw === undefined) return undefined;
  if (host === "gitlab") {
    return compact({
      sha: str(raw, "id"),
      title: str(raw, "title"),
      author: str(raw, "author_name"),
      authoredAt: str(raw, "authored_date"),
      url: str(raw, "web_url"),
    });
  }
  const commit = asRec(raw["commit"]);
  const message = str(commit, "message") ?? "";
  return compact({
    sha: str(raw, "sha"),
    title: message === "" ? undefined : (message.split("\n")[0] as string),
    author: handle(raw["author"]) ?? str(asRec(commit?.["author"]), "name"),
    authoredAt: str(asRec(commit?.["author"]), "date"),
    url: str(raw, "html_url"),
  });
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/**
 * The human-readable part of a failed API response.
 *
 * Both hosts answer a 4xx with JSON, but not the same JSON: GitHub sends
 * `{message, errors[]}`, GitLab sends `{message}` or `{error}` and sometimes
 * a map of field → problems. Anything unrecognised falls back to a clipped
 * prefix of the body, because a caller debugging a 422 needs to see what the
 * host actually said.
 */
export function apiErrorMessage(status: number, text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return `HTTP ${status} with an empty body`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return `HTTP ${status}: ${clip(trimmed, 500) as string}`;
  }
  const rec = asRec(parsed);
  if (rec === undefined) return `HTTP ${status}: ${clip(trimmed, 500) as string}`;

  const parts: string[] = [];
  const message = rec["message"];
  if (typeof message === "string") parts.push(message);
  else if (message !== undefined) parts.push(JSON.stringify(message));
  const error = str(rec, "error");
  if (error !== undefined) parts.push(error);
  const description = str(rec, "error_description");
  if (description !== undefined) parts.push(description);

  const details: string[] = [];
  for (const entry of asArray(rec["errors"])) {
    if (typeof entry === "string") details.push(entry);
    else {
      const detail = asRec(entry);
      const field = str(detail, "field") ?? str(detail, "resource");
      const code = str(detail, "code") ?? str(detail, "message");
      if (field !== undefined || code !== undefined) {
        details.push([field, code].filter((x) => x !== undefined).join(": "));
      }
    }
  }
  if (details.length > 0) parts.push(`(${details.sort(byString).join("; ")})`);
  if (parts.length === 0) return `HTTP ${status}: ${clip(trimmed, 500) as string}`;
  return `HTTP ${status}: ${clip(parts.join(" "), 700) as string}`;
}
