/**
 * `fakeGitHub`: an in-memory REST subset, attached through a client's `baseUrl`,
 * and real smart HTTP, attached as a git remote.
 *
 * Git traffic goes to the real `git http-backend` over a temporary bare
 * repository, so a clone and a push run the real protocol against the real
 * server half. REST state lives in memory and dies with `stop()`. Installation
 * tokens here are a plain issuer: nothing checks who asked.
 *
 * With `requireToken`, every REST request and every git request needs that token
 * (`Authorization: Bearer <token>` or `token <token>` on REST, HTTP basic with the
 * token as the password on git) and gets a 401 without it. A pull request's head SHA
 * is read from the bare repository; a second create for an open head is a 422; a
 * read of one pull request carries an ETag and answers 304 to a matching
 * `If-None-Match`. `interruptNextCreate` makes the next create land and then fail
 * its answer, by an error in the body or by never finishing it. `mergePull`,
 * `closePull`, `reopenPull` and `commitOnBranch` move the repository the way a
 * maintainer would.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RecordedRequest, recordRequest } from "./record";
import { type FakeService, assertLoopbackUrl, jsonResponse, serveLoopback } from "./serve";

export type FakeGitHubOptions = {
  /** Repositories that exist from the start, as `owner/name`. */
  readonly repos?: readonly string[];
  /** The webhook signing secret; generated at runtime when absent. */
  readonly webhookSecret?: string;
  /** The token every REST and git request must carry; absent, nothing is checked. */
  readonly requireToken?: string;
};

export type FakeGitHub = FakeService & {
  readonly webhookSecret: string;
  /** Create a repository, and its bare repository on first git use. */
  addRepo(fullName: string): void;
  /** The remote URL for a repository. */
  gitUrl(fullName: string): string;
  /** Every mutating request: REST writes and pushes. Credentials masked. */
  writes(): readonly RecordedRequest[];
  /** Every request's method and path, reads included, in order. */
  requests(): readonly string[];
  /** The SHA a branch points at, or `undefined` when it does not exist. */
  branchSha(fullName: string, branch: string): string | undefined;
  /**
   * The next pull request create lands, and then its answer fails: `error` sends the
   * 201 with its body cut off; `hang` never finishes the body until `stop()`.
   */
  interruptNextCreate(mode: "error" | "hang"): void;
  /**
   * Merge a pull request as a maintainer would: a merge commit on its base. With
   * `changeFirst`, a commit is added to its head first (merged with changes).
   */
  mergePull(
    fullName: string,
    number: number,
    opts?: { readonly changeFirst?: boolean },
  ): { readonly mergeSha: string; readonly headSha: string };
  closePull(fullName: string, number: number): void;
  reopenPull(fullName: string, number: number): void;
  /** Add an empty commit with `message` on a branch, and answer its SHA. */
  commitOnBranch(fullName: string, branch: string, message: string): string;
  /** The next `count` REST requests are answered 429, with a wait when one is given. */
  rateLimitNext(count: number, retryAfterSeconds?: number): void;
  /** Set a pull request's reviews, as `GET …/reviews` lists them; its own record moves too. */
  setReviews(
    fullName: string,
    number: number,
    reviews: readonly { readonly login: string; readonly state: string }[],
  ): void;
  deliverWebhook(
    receiverUrl: string,
    event: string,
    payload: unknown,
  ): Promise<{ readonly status: number; readonly body: string; readonly delivery: string }>;
};

type Json = Record<string, unknown>;
type Repo = {
  readonly owner: string;
  readonly name: string;
  readonly pulls: Map<number, Json>;
  readonly issues: Map<number, Json>;
  readonly comments: Map<number, Json[]>;
  readonly checks: Json[];
  readonly reviews: Map<number, Json[]>;
  nextNumber: number;
  bareReady: boolean;
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const notFound = (): Response =>
  jsonResponse(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest" });

/** Split a CGI response into its headers and its body. */
function parseCgi(bytes: Uint8Array): {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
} {
  const text = Buffer.from(bytes);
  const crlf = text.indexOf("\r\n\r\n");
  const lf = text.indexOf("\n\n");
  const end = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf;
  if (end === -1) return { status: 502, headers: new Headers(), body: bytes };
  const headers = new Headers();
  let status = 200;
  for (const line of text.subarray(0, end).toString("latin1").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
    else headers.append(name, value);
  }
  return { status, headers, body: bytes.subarray(end + (end === crlf ? 4 : 2)) };
}

/** Start a fake GitHub. */
export function fakeGitHub(opts: FakeGitHubOptions = {}): FakeGitHub {
  const webhookSecret = opts.webhookSecret ?? randomBytes(16).toString("hex");
  const gitRoot = mkdtempSync(join(tmpdir(), "fake-github-"));
  const repos = new Map<string, Repo>();
  const writes: RecordedRequest[] = [];
  let nextId = 1000;

  const addRepo = (fullName: string): Repo => {
    const existing = repos.get(fullName);
    if (existing !== undefined) return existing;
    const [owner, name] = fullName.split("/");
    if (owner === undefined || name === undefined || name === "") {
      throw new Error(`a repository is named owner/name, not ${fullName}`);
    }
    const repo: Repo = {
      owner,
      name,
      pulls: new Map(),
      issues: new Map(),
      comments: new Map(),
      checks: [],
      reviews: new Map(),
      nextNumber: 1,
      bareReady: false,
    };
    repos.set(fullName, repo);
    return repo;
  };
  for (const fullName of opts.repos ?? []) addRepo(fullName);

  /** The child's whole environment: no git config from the machine it runs on. */
  const gitEnv = (): Record<string, string> => ({
    PATH: process.env["PATH"] ?? "",
    HOME: gitRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });

  const bareDir = (repo: Repo): string => join(gitRoot, repo.owner, `${repo.name}.git`);

  /** Run git in a repository's bare directory; its trimmed stdout, or `undefined` on failure. */
  const bareGit = (
    repo: Repo,
    args: readonly string[],
    env: Record<string, string> = {},
  ): string | undefined => {
    ensureBare(repo);
    const result = Bun.spawnSync(["git", "--git-dir", bareDir(repo), ...args], {
      env: {
        ...gitEnv(),
        GIT_AUTHOR_NAME: "Maintainer",
        GIT_AUTHOR_EMAIL: "maintainer@example.invalid",
        GIT_COMMITTER_NAME: "Maintainer",
        GIT_COMMITTER_EMAIL: "maintainer@example.invalid",
        ...env,
      },
      stderr: "pipe",
    });
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
  };

  const shaOf = (repo: Repo, branch: string): string | undefined => {
    const sha = bareGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return sha === undefined || sha === "" ? undefined : sha;
  };

  /** An empty commit on top of `parents`, and the branch moved to it. */
  const commitOn = (
    repo: Repo,
    branch: string,
    message: string,
    parents: readonly string[],
  ): string => {
    const tree = bareGit(repo, ["mktree"], {}) ?? "";
    const sha = bareGit(repo, [
      "commit-tree",
      parents.length > 0 ? `${parents[0]}^{tree}` : tree,
      ...parents.flatMap((p) => ["-p", p]),
      "-m",
      message,
    ]);
    if (sha === undefined) throw new Error(`a commit on ${branch} could not be made`);
    if (bareGit(repo, ["update-ref", `refs/heads/${branch}`, sha]) === undefined) {
      throw new Error(`${branch} could not be moved`);
    }
    return sha;
  };

  /** The pull request as the API shows it: its head SHA read from the repository until it merges. */
  const pullView = (repo: Repo, pull: Json): Json => {
    const head = pull["head"] as Json;
    if (pull["merged"] === true || typeof head["sha"] === "string") return pull;
    const sha = shaOf(repo, String(head["ref"]));
    return sha === undefined ? pull : { ...pull, head: { ...head, sha } };
  };

  let limited = 0;
  let limitedWait: number | undefined;
  let interrupt: "error" | "hang" | undefined;
  const hanging: Array<ReadableStreamDefaultController<Uint8Array>> = [];

  /** Whether a request carries the token, on REST or on git. */
  const authorized = (req: Request): boolean => {
    const want = opts.requireToken;
    if (want === undefined) return true;
    const header = req.headers.get("authorization") ?? "";
    const [scheme, value = ""] = header.split(/\s+/, 2);
    const lower = (scheme ?? "").toLowerCase();
    if (lower === "bearer" || lower === "token") return value === want;
    if (lower === "basic") {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      return decoded.slice(decoded.indexOf(":") + 1) === want;
    }
    return false;
  };
  const allRequests: string[] = [];

  const ensureBare = (repo: Repo): void => {
    if (repo.bareReady) return;
    const dir = join(gitRoot, repo.owner, `${repo.name}.git`);
    mkdirSync(join(gitRoot, repo.owner), { recursive: true });
    for (const argv of [
      ["git", "init", "--quiet", "--bare", "--initial-branch=main", dir],
      ["git", "-C", dir, "config", "http.receivepack", "true"],
    ]) {
      const result = Bun.spawnSync(argv, { env: gitEnv(), stderr: "pipe" });
      if (result.exitCode !== 0) {
        throw new Error(`${argv.slice(0, 2).join(" ")} failed: ${result.stderr.toString()}`);
      }
    }
    repo.bareReady = true;
  };

  const smartHttp = async (req: Request, url: URL, repo: Repo, tail: string): Promise<Response> => {
    ensureBare(repo);
    let input = new Uint8Array(await req.arrayBuffer());
    // Git gzips a large request body. The backend is handed the plain bytes,
    // with the matching length, so there is one code path behind this line.
    if (req.headers.get("content-encoding") === "gzip") input = Bun.gunzipSync(input);
    const gitProtocol = req.headers.get("git-protocol");
    const child = Bun.spawn(["git", "http-backend"], {
      env: {
        ...gitEnv(),
        GIT_PROJECT_ROOT: gitRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: `/${repo.owner}/${repo.name}.git${tail}`,
        REQUEST_METHOD: req.method,
        QUERY_STRING: url.search.replace(/^\?/, ""),
        CONTENT_TYPE: req.headers.get("content-type") ?? "",
        CONTENT_LENGTH: String(input.length),
        REMOTE_USER: "fake",
        REMOTE_ADDR: "127.0.0.1",
        ...(gitProtocol !== null ? { GIT_PROTOCOL: gitProtocol } : {}),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(input);
    await child.stdin.end();
    const [output, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      return new Response(`git http-backend exited ${exitCode}: ${stderr}`, { status: 502 });
    }
    const cgi = parseCgi(new Uint8Array(output));
    return new Response(cgi.body, { status: cgi.status, headers: cgi.headers });
  };

  const repoJson = (repo: Repo): Json => ({
    id: nextId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: false,
    default_branch: "main",
    clone_url: gitUrl(`${repo.owner}/${repo.name}`),
  });

  const gitUrl = (fullName: string): string => `http://127.0.0.1:${server.port}/${fullName}.git`;

  const repoRoute = async (
    req: Request,
    repo: Repo,
    rest: readonly string[],
    url: URL,
    body: Json,
  ): Promise<Response> => {
    const method = req.method;
    const [head, second, third] = rest;
    if (head === undefined)
      return method === "GET" ? jsonResponse(200, repoJson(repo)) : notFound();

    if (head === "pulls") {
      if (second === undefined) {
        if (method === "GET") {
          const wantHead = url.searchParams.get("head");
          const wantState = url.searchParams.get("state") ?? "open";
          const rows = [...repo.pulls.values()].filter((pull) => {
            const label = (pull["head"] as Json)["label"];
            return (
              (wantHead === null || label === wantHead) &&
              (wantState === "all" || pull["state"] === wantState)
            );
          });
          return jsonResponse(
            200,
            rows.map((pull) => pullView(repo, pull)),
          );
        }
        if (method === "POST") {
          const ref = String(body["head"] ?? "");
          const label = ref.includes(":") ? ref : `${repo.owner}:${ref}`;
          const open = [...repo.pulls.values()].some(
            (pull) => pull["state"] === "open" && (pull["head"] as Json)["label"] === label,
          );
          if (open) {
            return jsonResponse(422, {
              message: "Validation Failed",
              errors: [
                {
                  resource: "PullRequest",
                  code: "custom",
                  message: `A pull request already exists for ${label}.`,
                },
              ],
            });
          }
          const number = repo.nextNumber++;
          const pull: Json = {
            id: ++nextId,
            number,
            state: "open",
            draft: body["draft"] === true,
            title: body["title"] ?? "",
            body: body["body"] ?? null,
            html_url: `${`http://127.0.0.1:${server.port}`}/${repo.owner}/${repo.name}/pull/${number}`,
            head: {
              ref: ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref,
              label,
            },
            base: { ref: body["base"] ?? "main" },
            merged: false,
            merged_at: null,
          };
          repo.pulls.set(number, pull);
          const view = pullView(repo, pull);
          const mode = interrupt;
          interrupt = undefined;
          if (mode === "error") {
            // The 201 with its body cut off: the client cannot read what was made.
            return new Response(`{"number":${number},`, {
              status: 201,
              headers: { "content-type": "application/json" },
            });
          }
          if (mode === "hang") {
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                hanging.push(controller);
              },
            });
            return new Response(stream, {
              status: 201,
              headers: { "content-type": "application/json" },
            });
          }
          return jsonResponse(201, view);
        }
        return notFound();
      }
      const pull = repo.pulls.get(Number(second));
      if (pull === undefined) return notFound();
      if (third === undefined && method === "GET") {
        const view = pullView(repo, pull);
        const etag = `"${createHmac("sha256", "etag").update(JSON.stringify(view)).digest("hex").slice(0, 16)}"`;
        if (req.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        return jsonResponse(200, view, { etag });
      }
      if (third === undefined && method === "PATCH") {
        for (const key of ["title", "body"] as const) {
          if (typeof body[key] === "string") pull[key] = body[key];
        }
        if (typeof body["base"] === "string") pull["base"] = { ref: body["base"] };
        if (body["state"] === "closed" || body["state"] === "open") {
          if (pull["merged"] !== true) pull["state"] = body["state"];
        }
        return jsonResponse(200, pullView(repo, pull));
      }
      if (third === "reviews" && method === "GET") {
        return jsonResponse(200, repo.reviews.get(Number(second)) ?? []);
      }
      if (third === "merge" && method === "PUT") {
        if (pull["merged"] === true) {
          return jsonResponse(405, { message: "Pull Request is not mergeable" });
        }
        const sha = randomBytes(20).toString("hex");
        pull["merged"] = true;
        pull["state"] = "closed";
        pull["merged_at"] = new Date().toISOString();
        return jsonResponse(200, {
          sha,
          merged: true,
          message: "Pull Request successfully merged",
        });
      }
      return notFound();
    }

    if (head === "issues") {
      if (second === undefined) {
        if (method === "GET") return jsonResponse(200, [...repo.issues.values()]);
        if (method === "POST") {
          const number = repo.nextNumber++;
          const issue: Json = {
            id: ++nextId,
            number,
            state: "open",
            title: body["title"] ?? "",
            body: body["body"] ?? null,
            labels: body["labels"] ?? [],
            comments: 0,
          };
          repo.issues.set(number, issue);
          return jsonResponse(201, issue);
        }
        return notFound();
      }
      const number = Number(second);
      const issue = repo.issues.get(number);
      if (issue === undefined && !repo.pulls.has(number)) return notFound();
      if (third === undefined && method === "GET" && issue !== undefined) {
        return jsonResponse(200, issue);
      }
      if (third === "comments") {
        const list = repo.comments.get(number) ?? [];
        if (method === "GET") return jsonResponse(200, list);
        if (method === "POST") {
          const comment: Json = { id: ++nextId, body: body["body"] ?? "" };
          list.push(comment);
          repo.comments.set(number, list);
          if (issue !== undefined) issue["comments"] = list.length;
          return jsonResponse(201, comment);
        }
      }
      return notFound();
    }

    if (head === "check-runs" && second === undefined && method === "POST") {
      const check: Json = {
        id: ++nextId,
        name: body["name"] ?? "",
        head_sha: body["head_sha"] ?? "",
        status: body["status"] ?? "queued",
        conclusion: body["conclusion"] ?? null,
      };
      repo.checks.push(check);
      return jsonResponse(201, check);
    }
    if (head === "commits" && second === undefined && method === "GET") {
      const branch = url.searchParams.get("sha") ?? "main";
      const since = url.searchParams.get("since");
      if (shaOf(repo, branch) === undefined) return jsonResponse(200, []);
      const out = bareGit(repo, [
        "log",
        "--format=%H%x1f%cI%x1f%B%x1e",
        ...(since !== null ? [`--since=${since}`] : []),
        `refs/heads/${branch}`,
      ]);
      const rows = (out ?? "")
        .split("\x1e")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
        .map((entry) => {
          const [sha, date, message] = entry.split("\x1f");
          return { sha, commit: { message: (message ?? "").trim(), committer: { date } } };
        });
      return jsonResponse(200, rows);
    }
    if (head === "commits" && second !== undefined && third === "check-runs" && method === "GET") {
      const rows = repo.checks.filter((check) => check["head_sha"] === second);
      return jsonResponse(200, { total_count: rows.length, check_runs: rows });
    }
    return notFound();
  };

  const server = serveLoopback(async (req) => {
    const url = new URL(req.url);
    allRequests.push(`${req.method} ${url.pathname}`);
    if (!authorized(req)) {
      return new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": 'Basic realm="fake-github"',
        },
      });
    }
    const { recorded, parsed } = await recordRequest(req);
    const smart = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(url.pathname);
    if (smart !== null) {
      const repo = repos.get(`${smart[1]}/${smart[2]}`);
      if (repo === undefined) return new Response("repository not found", { status: 404 });
      const tail = smart[3] ?? "";
      if (req.method === "POST" && tail === "/git-receive-pack") {
        writes.push({ ...recorded, body: null });
      }
      return smartHttp(req, url, repo, tail);
    }

    if (limited > 0) {
      limited -= 1;
      return jsonResponse(
        429,
        { message: "API rate limit exceeded" },
        limitedWait !== undefined ? { "retry-after": String(limitedWait) } : {},
      );
    }
    if (WRITE_METHODS.has(req.method)) writes.push(recorded);
    const body = (parsed !== null && typeof parsed === "object" ? parsed : {}) as Json;
    const parts = url.pathname.split("/").filter((part) => part !== "");

    if (parts[0] === "app" && parts[1] === "installations" && parts[3] === "access_tokens") {
      if (req.method !== "POST") return notFound();
      return jsonResponse(201, {
        // Built from parts, at runtime: nothing token-shaped is committed.
        token: ["ghs", randomBytes(18).toString("hex")].join("_"),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: {},
        repository_selection: "all",
      });
    }
    if (parts[0] === "user" && parts[1] === "repos" && req.method === "POST") {
      const name = String(body["name"] ?? "");
      if (name === "") return jsonResponse(422, { message: "Repository name is required" });
      return jsonResponse(201, repoJson(addRepo(`fake/${name}`)));
    }
    if (parts[0] === "repos" && parts[1] !== undefined && parts[2] !== undefined) {
      const repo = repos.get(`${parts[1]}/${parts[2]}`);
      if (repo === undefined) return notFound();
      return repoRoute(req, repo, parts.slice(3), url, body);
    }
    return notFound();
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port as number,
    webhookSecret,
    addRepo: (fullName) => {
      addRepo(fullName);
    },
    gitUrl,
    writes: () => [...writes],
    requests: () => [...allRequests],
    branchSha: (fullName, branch) => {
      const repo = repos.get(fullName);
      return repo === undefined ? undefined : shaOf(repo, branch);
    },
    interruptNextCreate: (mode) => {
      interrupt = mode;
    },
    mergePull: (fullName, number, mergeOpts = {}) => {
      const repo = repos.get(fullName);
      const pull = repo?.pulls.get(number);
      if (repo === undefined || pull === undefined)
        throw new Error(`no pull ${fullName}#${number}`);
      const head = pull["head"] as Json;
      const headRef = String(head["ref"]);
      const baseRef = String((pull["base"] as Json)["ref"]);
      if (mergeOpts.changeFirst === true) {
        const parent = shaOf(repo, headRef);
        commitOn(repo, headRef, "A maintainer's change", parent === undefined ? [] : [parent]);
      }
      const headSha = shaOf(repo, headRef) ?? "";
      const baseSha = shaOf(repo, baseRef);
      const mergeSha = commitOn(
        repo,
        baseRef,
        `Merge pull request #${number}`,
        baseSha === undefined ? [headSha] : [baseSha, headSha],
      );
      pull["head"] = { ...head, sha: headSha };
      pull["merged"] = true;
      pull["state"] = "closed";
      pull["merged_at"] = new Date().toISOString();
      pull["merge_commit_sha"] = mergeSha;
      return { mergeSha, headSha };
    },
    closePull: (fullName, number) => {
      const pull = repos.get(fullName)?.pulls.get(number);
      if (pull === undefined) throw new Error(`no pull ${fullName}#${number}`);
      pull["state"] = "closed";
    },
    reopenPull: (fullName, number) => {
      const pull = repos.get(fullName)?.pulls.get(number);
      if (pull === undefined) throw new Error(`no pull ${fullName}#${number}`);
      if (pull["merged"] !== true) pull["state"] = "open";
    },
    commitOnBranch: (fullName, branch, message) => {
      const repo = repos.get(fullName);
      if (repo === undefined) throw new Error(`no repository ${fullName}`);
      const parent = shaOf(repo, branch);
      return commitOn(repo, branch, message, parent === undefined ? [] : [parent]);
    },
    setReviews: (fullName, number, reviews) => {
      const repo = repos.get(fullName);
      if (repo === undefined) throw new Error(`no repository ${fullName}`);
      repo.reviews.set(
        number,
        reviews.map((r) => ({ user: { login: r.login }, state: r.state })),
      );
      const pull = repo.pulls.get(number);
      if (pull !== undefined) pull["updated_at"] = new Date(++nextId * 1000).toISOString();
    },
    rateLimitNext: (count, retryAfterSeconds) => {
      limited = count;
      limitedWait = retryAfterSeconds;
    },
    deliverWebhook: async (receiverUrl, event, payload) => {
      assertLoopbackUrl(receiverUrl);
      const body = JSON.stringify(payload);
      const delivery = randomUUID();
      const signature = createHmac("sha256", webhookSecret).update(body).digest("hex");
      const res = await fetch(receiverUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": delivery,
          "x-hub-signature-256": `sha256=${signature}`,
        },
        body,
      });
      return { status: res.status, body: await res.text(), delivery };
    },
    stop: async () => {
      for (const controller of hanging.splice(0)) {
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      }
      await server.stop(true);
      rmSync(gitRoot, { recursive: true, force: true });
    },
  };
}
