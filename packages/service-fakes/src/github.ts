/**
 * `fakeGitHub`: an in-memory REST subset, attached through a client's `baseUrl`,
 * and real smart HTTP, attached as a git remote.
 *
 * Git traffic goes to the real `git http-backend` over a temporary bare
 * repository, so a clone and a push run the real protocol against the real
 * server half. REST state lives in memory and dies with `stop()`. Installation
 * tokens here are a plain issuer: nothing checks who asked.
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
};

export type FakeGitHub = FakeService & {
  readonly webhookSecret: string;
  /** Create a repository, and its bare repository on first git use. */
  addRepo(fullName: string): void;
  /** The remote URL for a repository. */
  gitUrl(fullName: string): string;
  /** Every mutating request: REST writes and pushes. Credentials masked. */
  writes(): readonly RecordedRequest[];
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
          return jsonResponse(200, rows);
        }
        if (method === "POST") {
          const number = repo.nextNumber++;
          const ref = String(body["head"] ?? "");
          const pull: Json = {
            id: ++nextId,
            number,
            state: "open",
            title: body["title"] ?? "",
            body: body["body"] ?? null,
            head: {
              ref: ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref,
              label: ref.includes(":") ? ref : `${repo.owner}:${ref}`,
            },
            base: { ref: body["base"] ?? "main" },
            merged: false,
            merged_at: null,
          };
          repo.pulls.set(number, pull);
          return jsonResponse(201, pull);
        }
        return notFound();
      }
      const pull = repo.pulls.get(Number(second));
      if (pull === undefined) return notFound();
      if (third === undefined && method === "GET") return jsonResponse(200, pull);
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
    if (head === "commits" && second !== undefined && third === "check-runs" && method === "GET") {
      const rows = repo.checks.filter((check) => check["head_sha"] === second);
      return jsonResponse(200, { total_count: rows.length, check_runs: rows });
    }
    return notFound();
  };

  const server = serveLoopback(async (req) => {
    const url = new URL(req.url);
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
      await server.stop();
      rmSync(gitRoot, { recursive: true, force: true });
    },
  };
}
