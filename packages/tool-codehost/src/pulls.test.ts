/**
 * `./pulls` against a real server on 127.0.0.1, reached through `CallCtx.allowLoopback`:
 * a create and its duplicate, the lookup by head, an update, a conditional read, the
 * reviews, the base branch's commits, and a rate limit. The tools' own tests run
 * unchanged, which is what holds their GitHub requests to the ones these send.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { __setPrivateHostsAllowedForTest } from "./net";
import {
  createPull,
  findPullByHead,
  getPull,
  listBaseCommits,
  parseRepoName,
  pullReview,
  updatePull,
  withPullsCall,
} from "./pulls";

const TOKEN = ["fake", "pulls", "token"].join("-");
const REPO = { owner: "acme", name: "app" };
const SHA = "b".repeat(40);

type Pull = {
  number: number;
  state: string;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  merged: boolean;
};

let server: ReturnType<typeof Bun.serve>;
let pulls: Pull[] = [];
let limited = false;
const requests: string[] = [];

beforeAll(() => {
  __setPrivateHostsAllowedForTest(false);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}${url.search}`);
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      if (limited) {
        return new Response("{}", {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "retry-after": "60",
          },
        });
      }
      const base = "/repos/acme/app";
      if (req.method === "POST" && url.pathname === `${base}/pulls`) {
        const body = (await req.json()) as Record<string, string>;
        if (pulls.some((p) => p.head.ref === body["head"] && p.state === "open")) {
          return Response.json(
            {
              message: "Validation Failed",
              errors: [{ message: "A pull request already exists for acme:x." }],
            },
            { status: 422 },
          );
        }
        const pull: Pull = {
          number: pulls.length + 1,
          state: "open",
          title: body["title"] ?? "",
          body: body["body"] ?? "",
          head: { ref: body["head"] ?? "", sha: SHA },
          base: { ref: body["base"] ?? "" },
          merged: false,
        };
        pulls.push(pull);
        return Response.json(pull, { status: 201 });
      }
      if (req.method === "GET" && url.pathname === `${base}/pulls`) {
        const head = url.searchParams.get("head")?.split(":")[1];
        return Response.json(pulls.filter((p) => p.head.ref === head));
      }
      const one = /^\/repos\/acme\/app\/pulls\/(\d+)(\/reviews)?$/.exec(url.pathname);
      const pull = one !== null ? pulls[Number(one[1]) - 1] : undefined;
      if (one !== null && pull === undefined) return Response.json({}, { status: 404 });
      if (pull !== undefined && one?.[2] === "/reviews") {
        return Response.json([
          { user: { login: "ana" }, state: "APPROVED" },
          { user: { login: "bo" }, state: "CHANGES_REQUESTED" },
          { user: { login: "bo" }, state: "COMMENTED" },
        ]);
      }
      if (pull !== undefined && req.method === "PATCH") {
        Object.assign(pull, (await req.json()) as object);
        return Response.json(pull);
      }
      if (pull !== undefined && req.method === "GET") {
        const etag = `"v${pull.title.length}"`;
        if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
        return Response.json(pull, { headers: { etag } });
      }
      if (req.method === "GET" && url.pathname === `${base}/commits`) {
        return Response.json([
          { sha: "c".repeat(40), commit: { message: `Revert "x"\n\nThis reverts commit ${SHA}.` } },
        ]);
      }
      return Response.json({}, { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  pulls = [];
  limited = false;
  requests.length = 0;
});

function call<T>(fn: Parameters<typeof withPullsCall<T>>[1]): Promise<T> {
  return withPullsCall(
    {
      apiBase: `http://127.0.0.1:${server.port}`,
      token: TOKEN,
      timeoutMs: 10_000,
      allowLoopback: true,
    },
    fn,
  );
}

const INPUT = { title: "Fix", head: "crewhaus/x", base: "main", body: "Body.", draft: true };

describe("pull requests", () => {
  test("create, then a duplicate answers exists, and the lookup by head finds the one", async () => {
    const made = await call((c) => createPull(c, REPO, INPUT));
    expect(made).toMatchObject({
      ok: true,
      pull: { number: 1, headRef: "crewhaus/x", headSha: SHA },
    });
    expect(await call((c) => createPull(c, REPO, INPUT))).toEqual({ ok: false, exists: true });
    const found = await call((c) => findPullByHead(c, REPO, "crewhaus/x"));
    expect(found).toMatchObject({ ok: true, pull: { number: 1 } });
    expect(requests).toContain(
      "GET /repos/acme/app/pulls?head=acme%3Acrewhaus%2Fx&per_page=10&state=all",
    );
    expect(await call((c) => findPullByHead(c, REPO, "crewhaus/none"))).toEqual({ ok: true });
  });

  test("an update, a conditional read that answers 304, and the reviews", async () => {
    await call((c) => createPull(c, REPO, INPUT));
    const updated = await call((c) => updatePull(c, REPO, 1, { title: "Fix it", body: "New." }));
    expect(updated).toMatchObject({ ok: true, pull: { number: 1 } });
    const first = await call((c) => getPull(c, REPO, 1));
    if (!first.ok || "notModified" in first) throw new Error("expected a pull request");
    expect(first.etag).toBe('"v6"');
    expect(await call((c) => getPull(c, REPO, 1, { etag: first.etag as string }))).toEqual({
      ok: true,
      notModified: true,
    });
    expect(await call((c) => pullReview(c, REPO, 1))).toEqual({
      ok: true,
      review: "changes-requested",
    });
  });

  test("the base branch's commits, with their messages", async () => {
    const answer = await call((c) =>
      listBaseCommits(c, REPO, { sha: "main", since: "2026-11-01T00:00:00Z" }),
    );
    expect(answer).toMatchObject({ ok: true, commits: [{ sha: "c".repeat(40) }] });
    if (answer.ok) expect(answer.commits[0]?.message).toContain(`This reverts commit ${SHA}`);
  });

  test("a rate limit answers rateLimited with the wait the host asked for", async () => {
    limited = true;
    expect(await call((c) => getPull(c, REPO, 1))).toMatchObject({
      ok: false,
      status: 403,
      rateLimited: true,
      retryAfterMs: 60_000,
    });
  });

  test("a repository is owner/name", () => {
    expect(parseRepoName("acme/app")).toEqual(REPO);
    for (const bad of ["acme", "acme/app/x", "../app", "acme/..", "acme/a b"]) {
      expect(parseRepoName(bad)).toBeUndefined();
    }
  });
});
