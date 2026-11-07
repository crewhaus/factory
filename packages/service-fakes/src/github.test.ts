import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeGitHub, type FakeGitHubOptions, fakeGitHub } from "./github";

const fakes: FakeGitHub[] = [];
const dirs: string[] = [];
const receivers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  while (fakes.length > 0) await (fakes.pop() as FakeGitHub).stop();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  while (receivers.length > 0) await receivers.pop()?.stop(true);
});

function start(opts: FakeGitHubOptions = {}): FakeGitHub {
  const fake = fakeGitHub(opts);
  fakes.push(fake);
  return fake;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-github-test-"));
  dirs.push(dir);
  return dir;
}

const api = (fake: FakeGitHub, method: string, path: string, body?: unknown) =>
  fetch(`${fake.url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

/**
 * The real git, with nothing from this machine's configuration. Async, always:
 * the fake serves from this process, so a sync spawn would block the very event
 * loop the child is waiting on.
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(
    ["git", "-c", "user.name=fake", "-c", "user.email=fake@example.invalid", ...args],
    {
      cwd,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]}: ${stderr}`);
  return stdout;
}

describe("the REST subset", () => {
  test("a repository reads back, and one that was never made is a 404", async () => {
    const fake = start({ repos: ["acme/widgets"] });
    const repo = (await (await api(fake, "GET", "/repos/acme/widgets")).json()) as Record<
      string,
      unknown
    >;
    expect(repo["full_name"]).toBe("acme/widgets");
    expect(repo["default_branch"]).toBe("main");
    expect(repo["clone_url"]).toBe(fake.gitUrl("acme/widgets"));
    const missing = await api(fake, "GET", "/repos/acme/nope");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { message: string }).message).toBe("Not Found");
  });

  test("a pull is created, read, listed by head, and merged once", async () => {
    const fake = start({ repos: ["acme/widgets"] });
    const created = await api(fake, "POST", "/repos/acme/widgets/pulls", {
      title: "T",
      head: "feature",
      base: "main",
    });
    expect(created.status).toBe(201);
    const pull = (await created.json()) as { number: number; state: string };
    expect(pull.state).toBe("open");

    const read = await api(fake, "GET", `/repos/acme/widgets/pulls/${pull.number}`);
    expect(((await read.json()) as { title: string }).title).toBe("T");

    const byHead = await api(fake, "GET", "/repos/acme/widgets/pulls?head=acme:feature");
    expect(((await byHead.json()) as unknown[]).length).toBe(1);
    const otherHead = await api(fake, "GET", "/repos/acme/widgets/pulls?head=acme:other");
    expect(((await otherHead.json()) as unknown[]).length).toBe(0);

    const merged = await api(fake, "PUT", `/repos/acme/widgets/pulls/${pull.number}/merge`, {});
    expect(merged.status).toBe(200);
    expect(((await merged.json()) as { merged: boolean }).merged).toBe(true);
    const again = await api(fake, "PUT", `/repos/acme/widgets/pulls/${pull.number}/merge`, {});
    expect(again.status).toBe(405);

    const open = await api(fake, "GET", "/repos/acme/widgets/pulls?head=acme:feature");
    expect(((await open.json()) as unknown[]).length).toBe(0);
    const all = await api(fake, "GET", "/repos/acme/widgets/pulls?head=acme:feature&state=all");
    expect(((await all.json()) as unknown[]).length).toBe(1);
  });

  test("issues and comments, sharing a number space with pulls", async () => {
    const fake = start({ repos: ["acme/widgets"] });
    await api(fake, "POST", "/repos/acme/widgets/pulls", { title: "P", head: "h" });
    const issue = (await (
      await api(fake, "POST", "/repos/acme/widgets/issues", { title: "I" })
    ).json()) as { number: number };
    expect(issue.number).toBe(2);
    const comment = await api(fake, "POST", "/repos/acme/widgets/issues/2/comments", {
      body: "hello",
    });
    expect(comment.status).toBe(201);
    const list = await api(fake, "GET", "/repos/acme/widgets/issues/2/comments");
    expect(((await list.json()) as Array<{ body: string }>)[0]?.body).toBe("hello");
    const onPull = await api(fake, "POST", "/repos/acme/widgets/issues/1/comments", { body: "x" });
    expect(onPull.status).toBe(201);
    const none = await api(fake, "POST", "/repos/acme/widgets/issues/99/comments", { body: "x" });
    expect(none.status).toBe(404);
  });

  test("a check run is listed by its commit", async () => {
    const fake = start({ repos: ["acme/widgets"] });
    const sha = "a".repeat(40);
    await api(fake, "POST", "/repos/acme/widgets/check-runs", {
      name: "ci",
      head_sha: sha,
      status: "completed",
      conclusion: "success",
    });
    const res = await api(fake, "GET", `/repos/acme/widgets/commits/${sha}/check-runs`);
    const parsed = (await res.json()) as {
      total_count: number;
      check_runs: Array<{ conclusion: string }>;
    };
    expect(parsed.total_count).toBe(1);
    expect(parsed.check_runs[0]?.conclusion).toBe("success");
  });

  test("an installation token is issued, a different one each time", async () => {
    const fake = start();
    const ask = async () =>
      (await (await api(fake, "POST", "/app/installations/1/access_tokens", {})).json()) as {
        token: string;
        expires_at: string;
      };
    const [a, b] = [await ask(), await ask()];
    expect(a.token).not.toBe(b.token);
    expect(a.expires_at).toBeTruthy();
  });

  test("writes() lists every mutating request and no read, with credentials masked", async () => {
    const fake = start({ repos: ["acme/widgets"] });
    const planted = ["not", "real"].join("-");
    await api(fake, "GET", "/repos/acme/widgets");
    await fetch(`${fake.url}/repos/acme/widgets/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `token ${planted}` },
      body: JSON.stringify({ title: "I", token: planted }),
    });
    const writes = fake.writes();
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(["POST /repos/acme/widgets/issues"]);
    expect(JSON.stringify(writes)).not.toContain(planted);
  });
});

describe("smart HTTP, through the real git", () => {
  test("a clone and a push round-trip, and the push is a recorded write", async () => {
    const fake = start({ repos: ["acme/widgets"] });
    const work = tempDir();
    await git(work, "clone", "--quiet", fake.gitUrl("acme/widgets"), "one");
    const one = join(work, "one");
    await git(one, "checkout", "--quiet", "-b", "main");
    writeFileSync(join(one, "hello.txt"), "hello\n");
    await git(one, "add", "hello.txt");
    await git(one, "commit", "--quiet", "-m", "first");
    await git(one, "push", "--quiet", "origin", "main");

    await git(work, "clone", "--quiet", fake.gitUrl("acme/widgets"), "two");
    expect(existsSync(join(work, "two", "hello.txt"))).toBe(true);
    expect((await git(join(work, "two"), "log", "--format=%s")).trim()).toBe("first");
    expect(fake.writes().map((w) => w.path)).toEqual(["/acme/widgets.git/git-receive-pack"]);
  }, 20_000); // several real git children

  test("a gzip request body reaches the backend as the same request", async () => {
    const fake = start({ repos: ["acme/widgets"] });
    const work = tempDir();
    await git(work, "clone", "--quiet", fake.gitUrl("acme/widgets"), "one");
    const one = join(work, "one");
    await git(one, "checkout", "--quiet", "-b", "main");
    writeFileSync(join(one, "f"), "x\n");
    await git(one, "add", "f");
    await git(one, "commit", "--quiet", "-m", "first");
    await git(one, "push", "--quiet", "origin", "main");
    const sha = (await git(one, "rev-parse", "HEAD")).trim();

    // A protocol v0 fetch request, as a client would frame it.
    const pkt = (line: string): string =>
      `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    const request = `${pkt(`want ${sha} no-progress\n`)}0000${pkt("done\n")}`;
    const res = await fetch(`${fake.gitUrl("acme/widgets")}/git-upload-pack`, {
      method: "POST",
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        "content-encoding": "gzip",
      },
      body: Bun.gzipSync(new TextEncoder().encode(request)),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
    const bytes = Buffer.from(await res.arrayBuffer());
    // The pack is what a gzip body that was not decoded could never produce.
    expect(bytes.includes(Buffer.from("PACK"))).toBe(true);
    // An upload-pack POST reads; only the push above is a write.
    expect(fake.writes()).toHaveLength(1);
  }, 20_000); // several real git children

  test("a repository nobody made is a 404 to git too", async () => {
    const fake = start();
    const res = await fetch(`${fake.url}/acme/nope.git/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(404);
  });
});

describe("webhooks", () => {
  test("a delivery carries its event, its id and a signature that recomputes", async () => {
    const fake = start();
    const received: Array<{ headers: Headers; body: string }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      development: false,
      fetch: async (req) => {
        received.push({ headers: req.headers, body: await req.text() });
        return new Response("ok");
      },
    });
    receivers.push(server);
    const result = await fake.deliverWebhook(`http://127.0.0.1:${server.port}/hook`, "push", {
      ref: "refs/heads/main",
    });
    expect(result.status).toBe(200);
    const first = received[0];
    expect(first?.headers.get("x-github-event")).toBe("push");
    expect(first?.headers.get("x-github-delivery")).toBe(result.delivery);
    const expected = createHmac("sha256", fake.webhookSecret)
      .update(first?.body ?? "")
      .digest("hex");
    expect(first?.headers.get("x-hub-signature-256")).toBe(`sha256=${expected}`);
  });

  test("a delivery refuses a receiver off this machine", async () => {
    const fake = start();
    await expect(fake.deliverWebhook("https://example.invalid/x", "push", {})).rejects.toThrow(
      "loopback",
    );
  });
});
