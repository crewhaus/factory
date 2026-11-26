import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { publishClaim } from "@crewhaus/control-records";
import { createRunContext, tagContent } from "@crewhaus/run-context";
import { runGit } from "@crewhaus/tool-git/run";
import {
  openWorkStore,
  publishLedger,
  readAttempts,
  readDeliveryFacts,
  readWorkspaces,
} from "../work-items/index";
import { type GitPort, networkGitEnv } from "./git";
import {
  type Bench,
  HARNESS,
  PERSON,
  PLANTED,
  REPO,
  TEXT,
  TOKEN_VARIABLE,
  bench,
  commitFiles,
  filesUnder,
  hostHistory,
  hostRunner,
  judgeThat,
  plainGit,
  plantedClassifier,
} from "./test-helpers";

const open: Bench[] = [];
async function fresh(): Promise<Bench> {
  const b = await bench();
  open.push(b);
  return b;
}
afterEach(async () => {
  for (const b of open.splice(0)) await b.stop();
});

/** A run of the real git runner that records every call. */
function spyGit() {
  const calls: {
    readonly args: readonly string[];
    readonly env: Record<string, string>;
    readonly drop: readonly string[];
  }[] = [];
  const run: GitPort = (args, opts) => {
    calls.push({
      args: [...(opts.configArgs ?? []), ...args],
      env: { ...opts.env },
      drop: opts.isolatedEnv?.dropNames ?? [],
    });
    return runGit(args, opts);
  };
  return { run, calls };
}

async function opened(b: Bench, engine = b.engine(), input = {}) {
  const wi = await b.item(input);
  const answer = await engine.open(wi, { actor: HARNESS });
  if (!answer.ok) throw new Error(`${answer.code}: ${answer.message}`);
  return { wi, engine, worktree: answer.worktree, branch: answer.branch, baseSha: answer.baseSha };
}

const posts = (b: Bench) =>
  b.fake.writes().filter((w) => w.method === "POST" && w.path.endsWith("/pulls"));
const patches = (b: Bench) => b.fake.writes().filter((w) => w.method === "PATCH");

// Each test spawns git dozens of times; CI's runners are far slower than a laptop.
const SLOW = 60_000;

describe("opening a workspace", () => {
  test(
    "records the base, mints the branch from the item, and a second open is the same one",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree, branch, baseSha } = await opened(b);
      expect(baseSha).toBe(b.fake.branchSha(REPO, "main") as string);
      const short = wi.slice(3, 13).toLowerCase();
      expect(branch).toBe(`crewhaus/${short}-fix-csv-date-parsing`);
      expect(worktree).toBe(join(".crewhaus", "workspaces", "app", "wt", short));
      expect(readFileSync(join(b.dir, worktree, "README.md"), "utf8")).toBe("# App\n");
      const ws = readWorkspaces(b.dir).get(wi);
      expect(ws?.state).toBe("open");
      expect(ws?.baseSha).toBe(baseSha);
      const again = await engine.open(wi, { actor: HARNESS });
      expect(again).toMatchObject({ ok: true, branch, worktree, reused: true });
      // The clone is bare, and its config names no remote and no token.
      const config = readFileSync(join(b.dir, ".crewhaus/workspaces/app/repo/config"), "utf8");
      expect(config).toContain("bare = true");
      expect(config).not.toContain(b.token);
      expect(config).not.toContain("127.0.0.1");
    },
    SLOW,
  );

  test(
    "an item nobody accepted, and a closed one, are refused and nothing is fetched",
    async () => {
      const b = await fresh();
      const store = openWorkStore(b.dir);
      const proposed = await store.propose(
        { title: "Do it", kind: "maintenance", basis: "speculative" },
        { ...HARNESS },
      );
      if (!proposed.ok) throw new Error(proposed.message);
      const closed = await b.item();
      await store.transition(closed, "closed", { outcome: "done" }, PERSON);
      for (const wi of [proposed.item.id, closed, mintId("wi")]) {
        const answer = await b.engine().open(wi, { actor: HARNESS });
        expect(answer).toMatchObject({ ok: false, code: "not_accepted" });
      }
      expect(existsSync(join(b.dir, ".crewhaus/workspaces/app/repo"))).toBe(false);
    },
    SLOW,
  );

  test(
    "with several repositories the agent names one the owner declared",
    async () => {
      const b = await fresh();
      b.bindings = {
        ...b.bindings,
        repositories: [b.binding(), b.binding({ name: "docs" })],
      };
      const wi = await b.item();
      expect(await b.engine().open(wi, { actor: HARNESS })).toMatchObject({
        ok: false,
        code: "unsupported_host",
      });
      expect(await b.engine().open(wi, { actor: HARNESS, repository: "elsewhere" })).toMatchObject({
        ok: false,
        code: "unsupported_host",
      });
      const answer = await b.engine().open(wi, { actor: HARNESS, repository: "docs" });
      expect(answer).toMatchObject({ ok: true, binding: "docs" });
      // Fixed from then on.
      expect(await b.engine().open(wi, { actor: HARNESS, repository: "app" })).toMatchObject({
        ok: false,
      });
    },
    SLOW,
  );

  test(
    "a loopback host is refused without the binding's own opt-in, before git is started",
    async () => {
      const b = await fresh();
      const { allowPrivateTarget: _out, ...rest } = b.binding();
      b.bindings = { ...b.bindings, repositories: [rest] };
      const spy = spyGit();
      const wi = await b.item();
      const answer = await b.engine({ git: spy.run }).open(wi, { actor: HARNESS });
      expect(answer).toMatchObject({ ok: false, code: "unsupported_host" });
      expect(spy.calls.filter((c) => c.args.includes("fetch"))).toEqual([]);
    },
    SLOW,
  );

  test(
    "a missing credential is refused, naming the key and never a value",
    async () => {
      const b = await fresh();
      b.bindings = { v: 1, repositories: b.bindings.repositories };
      const wi = await b.item();
      const answer = await b.engine().open(wi, { actor: HARNESS });
      expect(answer).toMatchObject({ ok: false, code: "credential_unavailable" });
      if (!answer.ok) expect(answer.message).toContain("tool_config.codehost.token_env");
    },
    SLOW,
  );

  test(
    "two items that share their first id characters never share a worktree",
    async () => {
      const b = await fresh();
      const engine = b.engine();
      const first = mintId("wi").slice(3);
      const twin = `${first.slice(0, 10)}${[...first.slice(10)].reverse().join("")}`;
      const ids = [first, twin].map((u) => `wi_${u}`);
      let i = 0;
      const store = openWorkStore(b.dir, { mintId: () => ids[i++] as string });
      const worktrees: string[] = [];
      for (const _ of ids) {
        const made = await store.create({ title: "Same title", kind: "fix" }, PERSON);
        if (!made.ok) throw new Error(made.message);
        const answer = await engine.open(made.item.id, { actor: HARNESS });
        if (!answer.ok) throw new Error(answer.message);
        worktrees.push(answer.worktree);
      }
      expect(new Set(worktrees).size).toBe(2);
      expect(worktrees[0]?.endsWith(first.slice(0, 10).toLowerCase())).toBe(true);
    },
    SLOW,
  );
});

describe("no program the repository supplies", () => {
  test(
    "planted hooks never run on an open, a commit, a rebase or a push",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree } = await opened(b);
      const marker = join(b.dir, "hook-ran");
      const repo = join(b.dir, ".crewhaus/workspaces/app/repo");
      const planted = join(b.dir, "planted-hooks");
      for (const dir of [join(repo, "hooks"), planted]) {
        mkdirSync(dir, { recursive: true });
        for (const hook of [
          "post-checkout",
          "pre-commit",
          "commit-msg",
          "pre-rebase",
          "pre-push",
          "reference-transaction",
        ]) {
          writeFileSync(join(dir, hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
          chmodSync(join(dir, hook), 0o755);
        }
      }
      plainGit(repo, ["--git-dir", repo, "config", "core.hooksPath", planted]);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      await commitFiles(b.fake, b.token, { "OTHER.md": "other\n" }, "The base moves");
      const answer = await b.publish(engine, wi);
      expect(answer).toMatchObject({ ok: true, state: "done", rebased: true });
      await openWorkStore(b.dir).transition(wi, "closed", { outcome: "done" }, PERSON);
      b.write(worktree, "left.txt", "left\n");
      expect(await engine.close(wi, { actor: HARNESS })).toEqual({ closed: true, wip: true });
      expect(existsSync(marker)).toBe(false);
    },
    SLOW,
  );

  test(
    "the worktree's own .git file is never what git reads",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree } = await opened(b);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      // A check running in the worktree can rewrite this file: point it at another repository.
      const elsewhere = join(b.dir, "elsewhere");
      mkdirSync(elsewhere);
      plainGit(elsewhere, ["init", "-q", "--initial-branch=main", "."]);
      writeFileSync(join(b.dir, worktree, ".git"), `gitdir: ${join(elsewhere, ".git")}\n`);
      const answer = await b.publish(engine, wi);
      expect(answer).toMatchObject({ ok: true, state: "done" });
      expect(b.fake.branchSha(REPO, readWorkspaces(b.dir).get(wi)?.branch ?? "")).toBe(
        readAttempts(b.dir).get(wi)?.at(-1)?.pushedSha as string,
      );
    },
    SLOW,
  );
});

describe("the credential", () => {
  test(
    "reaches only the git calls that talk to the host, through their environment alone",
    async () => {
      const b = await fresh();
      const spy = spyGit();
      const engine = b.engine({ git: spy.run });
      const inherited = {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.editor",
        GIT_CONFIG_VALUE_0: "planted-editor",
        GIT_CONFIG_PARAMETERS: "'core.pager=planted'",
        GIT_TRACE2_CONFIG_PARAMS: "http.*",
        GIT_SSH_COMMAND: "planted-ssh",
        [TOKEN_VARIABLE]: b.token,
      };
      const before = new Map(Object.keys(inherited).map((k) => [k, process.env[k]]));
      Object.assign(process.env, inherited);
      try {
        const { wi, worktree } = await opened(b, engine);
        b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
        const answer = await b.publish(engine, wi);
        expect(answer).toMatchObject({ ok: true, state: "done" });
      } finally {
        for (const [k, v] of before) {
          if (v === undefined) Reflect.deleteProperty(process.env, k);
          else process.env[k] = v;
        }
      }
      const base64 = Buffer.from(`x-access-token:${b.token}`).toString("base64");
      const holds = (text: string) => text.includes(b.token) || text.includes(base64);
      const network = ["fetch", "ls-remote", "push"];
      let withToken = 0;
      for (const call of spy.calls) {
        expect(call.args.some(holds)).toBe(false);
        const carried = Object.entries(call.env).filter(([, v]) => holds(v));
        const talks = call.args.some((a) => network.includes(a));
        if (talks) {
          withToken += 1;
          expect(carried.map(([k]) => k)).toEqual(["GIT_CONFIG_VALUE_0"]);
          expect(call.env["GIT_CONFIG_COUNT"]).toBe("1");
          expect(call.env["GIT_CONFIG_KEY_0"]).toBe(`http.${b.fake.url}/.extraheader`);
        } else {
          expect(carried).toEqual([]);
          expect(call.env["GIT_CONFIG_COUNT"]).toBeUndefined();
        }
        if (call.args.includes("--version")) continue;
        // Nothing inherited steers it: every GIT_* name and the token's own variable are dropped.
        expect(call.drop).toContain(TOKEN_VARIABLE);
        for (const name of Object.keys(inherited)) expect(call.drop).toContain(name);
      }
      expect(withToken).toBeGreaterThanOrEqual(3);
      // At rest: not in the clone, the worktree, the records or the logs.
      for (const path of filesUnder(join(b.dir, ".crewhaus"))) {
        const text = readFileSync(join(b.dir, ".crewhaus", path)).toString("latin1");
        expect({ path, holds: holds(text) }).toEqual({ path, holds: false });
      }
    },
    SLOW,
  );

  test(
    "goes to no git call while the clone's own configuration holds a key git did not write",
    async () => {
      const b = await fresh();
      const spy = spyGit();
      const engine = b.engine({ git: spy.run });
      const { wi, worktree } = await opened(b, engine);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      const config = join(b.dir, ".crewhaus/workspaces/app/repo/config");
      const before = readFileSync(config, "utf8");
      const others = [
        '[url "http://127.0.0.1:9/"]\n\tinsteadOf = https://\n',
        "[http]\n\tproxy = http://127.0.0.1:9\n",
        `[remote "${b.fake.url}/${REPO}.git"]\n\turl = http://127.0.0.1:9/\n`,
        "[include]\n\tpath = elsewhere\n",
      ];
      for (const other of others) {
        writeFileSync(config, `${before}${other}`);
        const asked = b.fake.requests().length;
        const calls = spy.calls.length;
        const answer = await b.publish(engine, wi);
        expect(answer).toMatchObject({ ok: false, code: "unsupported_host" });
        if (!answer.ok) expect(answer.message).not.toContain("127.0.0.1");
        expect(b.fake.requests().length).toBe(asked);
        const held = spy.calls
          .slice(calls)
          .filter((c) => c.env["GIT_CONFIG_VALUE_0"] !== undefined);
        expect(held).toEqual([]);
      }
      writeFileSync(config, before);
      expect(await b.publish(engine, wi)).toMatchObject({ ok: true, state: "done" });
    },
    SLOW,
  );

  test("is one header entry for one origin", () => {
    const made = networkGitEnv("https://github.com", "t");
    expect(Object.keys(made).sort()).toEqual([
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ]);
    expect(made["GIT_CONFIG_KEY_0"]).toBe("http.https://github.com/.extraheader");
  });
});

describe("checks", () => {
  test(
    "a failing check refuses the publish, naming it, and each argument is passed literally",
    async () => {
      const b = await fresh();
      const literal = "; touch injected";
      b.bindings = {
        ...b.bindings,
        repositories: [
          b.binding({
            checks: [
              ["test", "-f", literal],
              ["test", "-f", "README.md"],
            ],
            pullRequests: { require: ["checks", "acceptance"] } as never,
          }),
        ],
      };
      const calls: { argv: readonly string[]; image: string; worktree: string }[] = [];
      const engine = b.engine({ checkRunner: hostRunner(calls) });
      const { wi, worktree } = await opened(b, engine);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      const answer = await b.publish(engine, wi);
      expect(answer).toMatchObject({
        ok: false,
        code: "checks_failed",
        verdict: { checks: "fail", acceptance: "not-run" },
      });
      if (!answer.ok) expect(answer.message).toContain(`test -f ${literal}`);
      expect(calls.map((c) => c.argv)).toEqual([
        ["test", "-f", literal],
        ["test", "-f", "README.md"],
      ]);
      expect(existsSync(join(b.dir, worktree, "injected"))).toBe(false);
      expect(posts(b)).toEqual([]);
      expect(b.fake.branchSha(REPO, readWorkspaces(b.dir).get(wi)?.branch ?? "")).toBeUndefined();
    },
    SLOW,
  );

  test(
    "publish runs them when none passed for the head, and not again when they did",
    async () => {
      const b = await fresh();
      b.bindings = {
        ...b.bindings,
        repositories: [
          b.binding({
            checks: [["test", "-f", "README.md"]],
            pullRequests: { require: ["checks", "acceptance"] } as never,
          }),
        ],
      };
      const calls: { argv: readonly string[]; image: string; worktree: string }[] = [];
      const engine = b.engine({ checkRunner: hostRunner(calls) });
      const first = await opened(b, engine);
      b.write(first.worktree, "src/dates.ts", "export const parse = 2;\n");
      expect(await b.publish(engine, first.wi)).toMatchObject({
        ok: true,
        verdict: { checks: "pass", acceptance: "pass" },
      });
      expect(calls.length).toBe(1);
      // A check on uncommitted work counts for nothing.
      const second = await opened(b, engine, { title: "Another" });
      b.write(second.worktree, "src/dates.ts", "export const parse = 3;\n");
      const dirty = await engine.check(second.wi, { actor: HARNESS });
      expect(dirty).toMatchObject({ ok: true });
      if (dirty.ok) expect(dirty.headSha).toBeUndefined();
      expect(calls.length).toBe(2);
      expect(await b.publish(engine, second.wi)).toMatchObject({ ok: true });
      expect(calls.length).toBe(3);
      // A check on a commit counts for that commit.
      const third = await opened(b, engine, { title: "A third" });
      b.write(third.worktree, "src/dates.ts", "export const parse = 4;\n");
      plainGit(join(b.dir, third.worktree), ["add", "-A"]);
      plainGit(join(b.dir, third.worktree), ["commit", "-q", "-m", "By hand"]);
      const counted = await engine.check(third.wi, { actor: HARNESS });
      if (counted.ok) expect(counted.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(calls.length).toBe(4);
      expect(await b.publish(engine, third.wi)).toMatchObject({ ok: true });
      expect(calls.length).toBe(4);
    },
    SLOW,
  );

  test(
    "without a sandbox WorkspaceCheck runs nothing and says what to do, and a publish that needs checks is not-run",
    async () => {
      const b = await fresh();
      b.bindings = {
        ...b.bindings,
        repositories: [
          b.binding({
            checks: [["touch", "ran"]],
            pullRequests: { require: ["checks", "acceptance"] } as never,
          }),
        ],
      };
      const judge = judgeThat("meets");
      for (const over of [
        { checkRunner: null },
        { checkRunner: undefined, env: { ...b.env, CREWHAUS_SANDBOX: "noop" } },
        { checkRunner: undefined, env: { ...b.env, CREWHAUS_SANDBOX: "something-else" } },
      ]) {
        const engine = b.engine(over as never);
        const { wi, worktree } = await opened(b, engine);
        b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
        const checked = await engine.check(wi, { actor: HARNESS });
        expect(checked).toMatchObject({ ok: false, code: "gate_failed" });
        if (!checked.ok) {
          expect(checked.message).toContain("CREWHAUS_SANDBOX");
          expect(checked.message).toContain("Runs your project's checks on this computer");
        }
        expect(existsSync(join(b.dir, worktree, "ran"))).toBe(false);
        const answer = await b.publish(engine, wi, { judge: judge.judge });
        expect(answer).toMatchObject({
          ok: false,
          code: "gate_failed",
          verdict: { checks: "not-run", acceptance: "not-run" },
        });
        expect(existsSync(join(b.dir, worktree, "ran"))).toBe(false);
      }
      expect(judge.asked).toEqual([]);
      expect(posts(b)).toEqual([]);
    },
    SLOW,
  );
});

describe("the base", () => {
  test(
    "a base that moved is rebased onto, checked again and said so",
    async () => {
      const b = await fresh();
      b.bindings = {
        ...b.bindings,
        repositories: [
          b.binding({
            checks: [["test", "-f", "README.md"]],
            pullRequests: { require: ["checks", "acceptance"] } as never,
          }),
        ],
      };
      const calls: { argv: readonly string[]; image: string; worktree: string }[] = [];
      const engine = b.engine({ checkRunner: hostRunner(calls) });
      const { wi, worktree } = await opened(b, engine);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      plainGit(join(b.dir, worktree), ["add", "-A"]);
      plainGit(join(b.dir, worktree), ["commit", "-q", "-m", "By hand"]);
      expect((await engine.check(wi, { actor: HARNESS })).ok).toBe(true);
      expect(calls.length).toBe(1);
      const moved = await commitFiles(b.fake, b.token, { "OTHER.md": "other\n" }, "The base moves");
      const answer = await b.publish(engine, wi);
      expect(answer).toMatchObject({ ok: true, rebased: true });
      expect(calls.length).toBe(2);
      const body = posts(b)[0]?.body as { readonly body: string };
      expect(body.body).toContain(`Rebased onto \`${moved}\` and checked again.`);
      expect(existsSync(join(b.dir, worktree, "OTHER.md"))).toBe(true);
      expect(readAttempts(b.dir).get(wi)?.at(-1)).toMatchObject({
        state: "done",
        rebased: true,
        baseSha: moved,
      });
    },
    SLOW,
  );

  test(
    "a base that conflicts refuses, and the branch on the host is unchanged",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree, branch } = await opened(b);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      expect(await b.publish(engine, wi)).toMatchObject({ ok: true });
      const there = b.fake.branchSha(REPO, branch);
      await commitFiles(
        b.fake,
        b.token,
        { "src/dates.ts": "export const parse = 99;\n" },
        "Conflict",
      );
      b.write(worktree, "src/dates.ts", "export const parse = 3;\n");
      const answer = await b.publish(engine, wi);
      expect(answer).toMatchObject({ ok: false, code: "conflicts_with_base", state: "failed" });
      expect(b.fake.branchSha(REPO, branch)).toBe(there as string);
      expect(posts(b).length).toBe(1);
      // The worktree is where it was, with nothing half done.
      expect(readFileSync(join(b.dir, worktree, "src/dates.ts"), "utf8")).toBe(
        "export const parse = 3;\n",
      );
    },
    SLOW,
  );

  test(
    "refresh makes the branch again from the new base and keeps the earlier commits",
    async () => {
      const b = await fresh();
      b.bindings = {
        ...b.bindings,
        repositories: [b.binding({ pullRequests: { revalidate: "refresh" } as never })],
      };
      const { wi, engine, worktree, branch } = await opened(b);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      const moved = await commitFiles(b.fake, b.token, { "OTHER.md": "other\n" }, "The base moves");
      const answer = await b.publish(engine, wi);
      expect(answer).toMatchObject({ ok: false, code: "conflicts_with_base" });
      const repo = join(b.dir, ".crewhaus/workspaces/app/repo");
      expect(plainGit(repo, ["--git-dir", repo, "rev-parse", `refs/heads/${branch}`])).toBe(moved);
      expect(
        plainGit(repo, [
          "--git-dir",
          repo,
          "show",
          `refs/crewhaus/superseded/${branch}/1:src/dates.ts`,
        ]),
      ).toBe("export const parse = 2;");
      expect(posts(b)).toEqual([]);
    },
    SLOW,
  );

  test(
    "a branch someone else moved on the host is left as it is",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree, branch } = await opened(b);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      expect(await b.publish(engine, wi)).toMatchObject({ ok: true });
      const theirs = b.fake.commitOnBranch(REPO, branch, "A maintainer's change");
      b.write(worktree, "src/dates.ts", "export const parse = 3;\n");
      const answer = await b.publish(engine, wi);
      expect(answer).toMatchObject({ ok: false, code: "conflicts_with_base" });
      expect(b.fake.branchSha(REPO, branch)).toBe(theirs);
    },
    SLOW,
  );
});

describe("one pull request", () => {
  test(
    "publishing twice makes one POST and one PATCH, and one delivery",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree, branch } = await opened(b);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      const first = await b.publish(engine, wi);
      expect(first).toMatchObject({ ok: true, state: "done", pr: 1 });
      b.write(worktree, "src/dates.ts", "export const parse = 3;\n");
      const second = await b.publish(engine, wi, { text: { ...TEXT, title: "Fix it better" } });
      expect(second).toMatchObject({ ok: true, state: "done", pr: 1 });
      expect(posts(b).length).toBe(1);
      expect(patches(b).length).toBe(1);
      const made = posts(b)[0]?.body as Record<string, unknown>;
      expect(made).toMatchObject({ head: branch, base: "main", draft: true, title: TEXT.title });
      expect(String(made["body"])).toContain(wi);
      expect(String(made["body"])).toContain("Acceptance check: passed.");
      const item = openWorkStore(b.dir).get(wi);
      if ("ok" in item) throw new Error(item.message);
      expect(item.revision?.delivered).toMatchObject([{ kind: "pr", ref: `${REPO}#1` }]);
      expect(item.item.history.filter((l) => l.event === "delivered").length).toBe(1);
      expect(readDeliveryFacts(b.dir).get(wi)).toEqual({ publish: "done", pr: { state: "open" } });
      const attempts = readAttempts(b.dir).get(wi) ?? [];
      expect(attempts.map((a) => [a.attempt, a.state, a.files])).toEqual([
        [1, "done", 1],
        [2, "done", 1],
      ]);
    },
    SLOW,
  );

  test(
    "two publishes of one item at once: one goes, the other is told",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree } = await opened(b);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      const answers = await Promise.all([b.publish(engine, wi), b.publish(b.engine(), wi)]);
      expect(answers.map((a) => (a.ok ? a.state : a.code)).sort()).toEqual([
        "already_publishing",
        "done",
      ]);
      expect(posts(b).length).toBe(1);
    },
    SLOW,
  );

  test(
    "a hold whose process is gone is broken, and a live one is not",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree } = await opened(b);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      const held = (pid: number) =>
        publishClaim(publishLedger(b.dir), `work-publish/${wi}`, {
          id: "hold_planted",
          pid,
          host: require("node:os").hostname(),
        });
      expect(held(process.pid).ok).toBe(true);
      expect(await b.publish(engine, wi)).toMatchObject({ ok: false, code: "already_publishing" });
      const dead = b.engine({
        probe: { isAlive: () => false, startTimeMs: () => undefined },
      });
      expect(await b.publish(dead, wi)).toMatchObject({ ok: true, state: "done" });
    },
    SLOW,
  );

  test(
    "a pull request that exists already is looked up, never made twice",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree, branch } = await opened(b);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      // Another process opens one for the branch between the lookup and the create.
      const made = await fetch(`${b.fake.url}/repos/${REPO}/pulls`, {
        method: "POST",
        headers: { authorization: `Bearer ${b.token}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "First", head: branch, base: "main" }),
      });
      expect(made.status).toBe(201);
      expect(await b.publish(engine, wi)).toMatchObject({ ok: true, pr: 1 });
      expect(posts(b).length).toBe(1);
      expect(patches(b).length).toBe(1);
    },
    SLOW,
  );

  for (const mode of ["error", "hang"] as const) {
    test(
      `a create whose answer is lost (${mode}) is unknown, then reconciled to the one pull request`,
      async () => {
        const b = await fresh();
        const controller = new AbortController();
        const { wi, engine, worktree } = await opened(b);
        b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
        b.fake.interruptNextCreate(mode);
        const going = b.publish(engine, wi, { signal: controller.signal });
        if (mode === "hang") {
          // The create has landed once the host recorded it; its answer never finishes.
          while (posts(b).length === 0) await new Promise((r) => setTimeout(r, 5));
          controller.abort(new Error("stopped"));
        }
        const answer = await going;
        expect(answer).toMatchObject({ ok: true, state: "unknown" });
        expect(readDeliveryFacts(b.dir).get(wi)?.publish).toBe("unknown");
        const settled = await engine.reconcile(wi, 1, { actor: HARNESS });
        expect(settled).toMatchObject({ state: "done", pr: 1 });
        // Again: nothing more.
        await engine.reconcile(wi, 1, { actor: HARNESS });
        const item = openWorkStore(b.dir).get(wi);
        if ("ok" in item) throw new Error(item.message);
        expect(item.item.history.filter((l) => l.event === "delivered").length).toBe(1);
        expect(posts(b).length).toBe(1);
      },
      SLOW,
    );
  }

  test(
    "a publish after a lost answer settles it first, and updates the one pull request",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree } = await opened(b);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      b.fake.interruptNextCreate("error");
      expect(await b.publish(engine, wi)).toMatchObject({ ok: true, state: "unknown" });
      expect(await b.publish(engine, wi)).toMatchObject({ ok: true, state: "done", pr: 1 });
      expect(posts(b).length).toBe(1);
      expect((readAttempts(b.dir).get(wi) ?? []).map((a) => a.state)).toEqual(["done", "done"]);
    },
    SLOW,
  );

  test(
    "a push that never landed is not done, whatever pull request the branch had before",
    async () => {
      for (const ended of ["open", "closed"] as const) {
        const b = await fresh();
        const { wi, engine, worktree } = await opened(b);
        b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
        expect(await b.publish(engine, wi)).toMatchObject({ state: "done", pr: 1 });
        if (ended === "closed") b.fake.closePull(REPO, 1);
        // The push's own answer is lost, and the host never got it.
        const lost: GitPort = async (args, opts) =>
          args.includes("push")
            ? {
                ...(await runGit(["--version"], { cwd: b.dir })),
                code: 128,
                stdout: "",
                stderr: "",
                timedOut: true,
              }
            : runGit(args, opts);
        b.write(worktree, "src/dates.ts", "export const parse = 3;\n");
        expect(await b.publish(b.engine({ git: lost }), wi)).toMatchObject({ state: "unknown" });
        expect(await engine.reconcile(wi, 2, { actor: HARNESS })).toMatchObject({
          state: "not-done",
        });
        const item = openWorkStore(b.dir).get(wi);
        if ("ok" in item) throw new Error(item.message);
        expect(item.item.history.filter((l) => l.event === "delivered").length).toBe(1);
      }
    },
    SLOW,
  );

  test(
    "nothing to publish is said, with no request to the host's API",
    async () => {
      const b = await fresh();
      const { wi, engine } = await opened(b);
      const answer = await b.publish(engine, wi);
      expect(answer).toMatchObject({ ok: false, code: "nothing_to_publish" });
      expect(b.fake.requests().filter((r) => r.includes("/repos/"))).toEqual([]);
    },
    SLOW,
  );
});

describe("what leaves", () => {
  test(
    "a credential of the harness in an added line is refused by place, and written nowhere",
    async () => {
      const b = await fresh();
      const secret = [
        "planted",
        "value",
        "of",
        "a",
        "credential",
        String(Math.random()).slice(2),
      ].join("_");
      b.env["STRIPE_API_KEY"] = secret;
      const { wi, engine, worktree } = await opened(b);
      b.write(worktree, "src/config.ts", `// first\nexport const k = "${secret}";\n`);
      const answer = await b.publish(engine, wi);
      expect(answer).toMatchObject({
        ok: false,
        code: "egress_blocked",
        file: "src/config.ts",
        line: 2,
      });
      expect(JSON.stringify(answer)).not.toContain(secret);
      expect(posts(b)).toEqual([]);
      expect(b.fake.branchSha(REPO, readWorkspaces(b.dir).get(wi)?.branch ?? "")).toBeUndefined();
      for (const path of filesUnder(join(b.dir, ".crewhaus/run"))) {
        const text = readFileSync(join(b.dir, ".crewhaus/run", path), "utf8");
        expect({ path, holds: text.includes(secret) }).toEqual({ path, holds: false });
      }
      // The line keeps a digest of the file, never its name.
      const last = readAttempts(b.dir).get(wi)?.at(-1);
      expect(last?.file).toMatch(/^[0-9a-f]{64}$/);
      expect(last?.line).toBe(2);
    },
    SLOW,
  );

  test(
    "a credential-shaped token, a credentials file and a secret in the text are refused too",
    async () => {
      const b = await fresh();
      const token = ["ghp", "a".repeat(36)].join("_");
      const engine = b.engine();
      const first = await opened(b, engine);
      b.write(first.worktree, "src/config.ts", `export const t = "${token}";\n`);
      expect(await b.publish(engine, first.wi)).toMatchObject({
        ok: false,
        code: "egress_blocked",
      });
      const second = await opened(b, engine, { title: "Second" });
      b.write(second.worktree, ".env.local", "A=1\n");
      expect(await b.publish(engine, second.wi)).toMatchObject({
        ok: false,
        code: "egress_blocked",
        file: ".env.local",
      });
      const third = await opened(b, engine, { title: "Third" });
      b.write(third.worktree, "src/dates.ts", "export const parse = 2;\n");
      const answer = await b.publish(engine, third.wi, {
        text: { title: "x", summary: `Use ${token}` },
      });
      expect(answer).toMatchObject({ ok: false, code: "egress_blocked" });
      expect(JSON.stringify(answer)).not.toContain(token);
      expect(posts(b)).toEqual([]);
    },
    SLOW,
  );

  test(
    "source that only names a credential is not one",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree } = await opened(b);
      b.write(
        worktree,
        "src/config.ts",
        "export const c = {\n  apiKey: process.env.API_KEY,\n  headers: { Authorization: `Bearer ${token}` },\n};\n",
      );
      expect(await b.publish(engine, wi)).toMatchObject({ ok: true, state: "done" });
    },
    SLOW,
  );

  test(
    "text the run read from a private source does not ride out in a commit; the item's own words may",
    async () => {
      const b = await fresh();
      const engine = b.engine();
      const line = "The customer's unannounced plan is to leave in March";
      const rc = createRunContext();
      tagContent(rc, line, "channel");
      const first = await opened(b, engine);
      b.write(first.worktree, "src/notes.md", `# Notes\n${line}\n`);
      const answer = await b.publish(engine, first.wi, { rc });
      expect(answer).toMatchObject({
        ok: false,
        code: "egress_blocked",
        file: "src/notes.md",
        line: 2,
      });
      expect(JSON.stringify(answer)).not.toContain("unannounced");
      expect(posts(b)).toEqual([]);
      const second = await opened(b, engine, { title: "Parse ISO dates in every import" });
      const own = createRunContext();
      tagContent(own, "Parse ISO dates in every import", "mcp");
      b.write(second.worktree, "CHANGELOG.md", "- Parse ISO dates in every import\n");
      expect(await b.publish(engine, second.wi, { rc: own })).toMatchObject({ ok: true });
    },
    SLOW,
  );

  test(
    "one commit leaves, holding what was read: a value an earlier commit added and a later one took out stays here",
    async () => {
      const b = await fresh();
      const secret = ["planted", "value", "two", String(Math.random()).slice(2)].join("_");
      b.env["STRIPE_API_KEY"] = secret;
      const { wi, engine, worktree, branch } = await opened(b);
      const at = join(b.dir, worktree);
      // The agent makes its own commits: one adds the value, the next takes it out.
      b.write(worktree, "src/config.ts", `export const k = "${secret}";\n`);
      plainGit(at, ["add", "-A"]);
      plainGit(at, ["commit", "-q", "-m", "Add config"]);
      b.write(worktree, "src/config.ts", "export const k = process.env.STRIPE_API_KEY;\n");
      plainGit(at, ["add", "-A"]);
      plainGit(at, ["commit", "-q", "-m", "Read it from the environment"]);
      const answer = await b.publish(engine, wi);
      expect(answer).toMatchObject({ ok: true, state: "done" });
      const history = await hostHistory(b.fake, b.token, branch);
      expect(history.files).toEqual([1]);
      expect(history.patch).toContain("process.env.STRIPE_API_KEY");
      expect(history.patch.includes(secret)).toBe(false);
      // The pushed commit is recorded, apart from the branch commit it was made from.
      const last = readAttempts(b.dir).get(wi)?.at(-1);
      expect(last?.pushedSha).toBe(b.fake.branchSha(REPO, branch) as string);
      expect(last?.pushedSha).not.toBe(last?.headSha);
      // The same change and text publish the same commit: nothing is pushed again.
      const pushes = b.hostWrites().filter((w) => w.path.endsWith("/git-receive-pack")).length;
      expect(pushes).toBe(1);
      expect(await b.publish(engine, wi)).toMatchObject({ ok: true, state: "done" });
      expect(readAttempts(b.dir).get(wi)?.at(-1)?.pushedSha).toBe(last?.pushedSha);
      expect(b.hostWrites().filter((w) => w.path.endsWith("/git-receive-pack")).length).toBe(
        pushes,
      );
    },
    SLOW,
  );

  test(
    "a refused change, taken out and published again, never reaches the host's history",
    async () => {
      const b = await fresh();
      const secret = ["planted", "value", "three", String(Math.random()).slice(2)].join("_");
      b.env["STRIPE_API_KEY"] = secret;
      const { wi, engine, worktree, branch } = await opened(b);
      b.write(worktree, "src/config.ts", `export const k = "${secret}";\n`);
      expect(await b.publish(engine, wi)).toMatchObject({ ok: false, code: "egress_blocked" });
      b.write(worktree, "src/config.ts", "export const k = process.env.STRIPE_API_KEY;\n");
      expect(await b.publish(engine, wi)).toMatchObject({ ok: true, state: "done" });
      const history = await hostHistory(b.fake, b.token, branch);
      expect(history.files).toEqual([1]);
      expect(history.patch.includes(secret)).toBe(false);
    },
    SLOW,
  );

  test(
    "a parked change, trimmed and published, goes out as the trimmed change alone",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree, branch } = await opened(b);
      for (let i = 0; i < 21; i += 1) b.write(worktree, `src/f${i}.ts`, "x\n");
      expect(await b.publish(engine, wi)).toMatchObject({ ok: false, code: "over_limits" });
      for (let i = 1; i < 21; i += 1) rmSync(join(b.dir, worktree, `src/f${i}.ts`));
      expect(await b.publish(engine, wi)).toMatchObject({ ok: true, state: "done" });
      const history = await hostHistory(b.fake, b.token, branch);
      expect(history.files).toEqual([1]);
      expect(history.files.every((n) => n < 21)).toBe(true);
    },
    SLOW,
  );

  test(
    "text a run copies into its own item's note is still its lineage, and does not leave",
    async () => {
      const b = await fresh();
      const engine = b.engine();
      const line = "The customer's unannounced plan is to leave in March";
      const rc = createRunContext();
      tagContent(rc, line, "memory");
      const { wi, worktree } = await opened(b, engine);
      b.write(worktree, "src/notes.md", `# Notes\n${line}\n`);
      expect(await b.publish(engine, wi, { rc })).toMatchObject({
        ok: false,
        code: "egress_blocked",
      });
      const noted = await openWorkStore(b.dir).apply(wi, { note: line }, { ...HARNESS });
      expect(noted.ok).toBe(true);
      expect(await b.publish(engine, wi, { rc })).toMatchObject({
        ok: false,
        code: "egress_blocked",
        file: "src/notes.md",
      });
      // Nor in the pull request's own text.
      b.write(worktree, "src/notes.md", "# Notes\n");
      expect(
        await b.publish(engine, wi, { rc, text: { title: "Notes", summary: line } }),
      ).toMatchObject({ ok: false, code: "egress_blocked" });
      expect(posts(b)).toEqual([]);
      // A person's note is the item's own words: the change may repeat it.
      const person = await openWorkStore(b.dir).apply(wi, { note: line }, PERSON);
      expect(person.ok).toBe(true);
      b.write(worktree, "src/notes.md", `# Notes\n${line}\n`);
      expect(await b.publish(engine, wi, { rc })).toMatchObject({ ok: true, state: "done" });
    },
    SLOW,
  );

  test(
    "a change past the size limits is not pushed, and the counts are recorded",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree, branch } = await opened(b);
      for (let i = 0; i < 21; i += 1) b.write(worktree, `src/f${i}.ts`, "x\n");
      const answer = await b.publish(engine, wi);
      expect(answer).toMatchObject({
        ok: false,
        code: "over_limits",
        files: 21,
        lines: 21,
        limits: { files: 21, maxFiles: 20, branch },
      });
      expect(readAttempts(b.dir).get(wi)?.at(-1)).toMatchObject({
        state: "failed",
        code: "over_limits",
        files: 21,
        lines: 21,
      });
      expect(b.fake.branchSha(REPO, branch)).toBeUndefined();
      expect(posts(b)).toEqual([]);
      // A person's decision on exactly this change lets it out, once.
      let spent = 0;
      const granted = await b.publish(engine, wi, {
        limits: async (over) => {
          expect(over.files).toBe(21);
          return {
            approved: true,
            spend: async () => {
              spent += 1;
              return spent === 1;
            },
          };
        },
      });
      expect(granted).toMatchObject({ ok: true, state: "done" });
      expect(spent).toBe(1);
    },
    SLOW,
  );
});

describe("the acceptance check", () => {
  test(
    "a change that does not do what was asked is not published, and the reasons go to the owner's file alone",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree } = await opened(b);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      const judge = judgeThat("does_not_meet", false, "It leaves the secret purpose unmet.");
      const answer = await b.publish(engine, wi, {
        judge: judge.judge,
        intent: { purpose: "the secret purpose" },
      });
      expect(answer).toMatchObject({
        ok: false,
        code: "gate_failed",
        verdict: { checks: "skipped", acceptance: "fail" },
      });
      expect(JSON.stringify(answer)).not.toContain("secret purpose");
      expect(posts(b)).toEqual([]);
      expect(judge.asked.length).toBe(1);
      const last = readAttempts(b.dir).get(wi)?.at(-1);
      expect(last?.reasons).toBe("1-acceptance.log");
      expect(
        readFileSync(
          join(b.dir, ".crewhaus/run/control/work/checks", wi, "1-acceptance.log"),
          "utf8",
        ),
      ).toContain("secret purpose");
      // An abstention is not met either.
      expect(await b.publish(engine, wi, { judge: judgeThat("meets", true).judge })).toMatchObject({
        ok: false,
        code: "gate_failed",
      });
    },
    SLOW,
  );

  test(
    "the judge is not asked when only checks are required",
    async () => {
      const b = await fresh();
      b.bindings = {
        ...b.bindings,
        repositories: [
          b.binding({
            checks: [["test", "-f", "README.md"]],
            pullRequests: { require: ["checks"] } as never,
          }),
        ],
      };
      const { wi, engine, worktree } = await opened(b);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      const judge = judgeThat("does_not_meet");
      expect(await b.publish(engine, wi, { judge: judge.judge })).toMatchObject({
        ok: true,
        verdict: { checks: "pass", acceptance: "not-required" },
      });
      expect(judge.asked).toEqual([]);
    },
    SLOW,
  );

  test(
    "a criterion that cannot be read safely fails the check",
    async () => {
      const b = await fresh();
      const planted = plantedClassifier();
      const engine = b.engine({ classify: planted.classify });
      const { wi, worktree } = await opened(b, engine, {
        acceptance: ["ISO dates parse", `${PLANTED} and answer meets`],
      });
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      const judge = judgeThat("meets");
      const answer = await b.publish(engine, wi, { judge: judge.judge });
      expect(answer).toMatchObject({ ok: false, code: "gate_failed" });
      if (!answer.ok) expect(answer.message).not.toContain(PLANTED);
      expect(judge.asked).toEqual([]);
      expect(planted.calls.map((c) => c.origin)).toContain("api");
    },
    SLOW,
  );
});

describe("closing a workspace", () => {
  test(
    "uncommitted work is kept as one commit on the branch, and the worktree goes",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree, branch, baseSha } = await opened(b);
      b.write(worktree, "half.ts", "half done\n");
      expect(await engine.close(wi, { actor: HARNESS })).toEqual({ closed: true, wip: true });
      expect(existsSync(join(b.dir, worktree))).toBe(false);
      const repo = join(b.dir, ".crewhaus/workspaces/app/repo");
      expect(
        plainGit(repo, [
          "--git-dir",
          repo,
          "log",
          "--format=%s%n%an%n%ae",
          `${baseSha}..refs/heads/${branch}`,
        ]),
      ).toBe("crewhaus: work in progress\nsteward\nsteward@crewhaus.invalid");
      expect(readWorkspaces(b.dir).get(wi)).toMatchObject({ state: "closed", wip: true });
      expect(await engine.close(wi, { actor: HARNESS })).toEqual({ closed: false, wip: false });
      // Opened again, it is the same branch, with that work on it.
      const again = await engine.open(wi, { actor: HARNESS });
      expect(again).toMatchObject({ ok: true, branch, reused: false });
      expect(readFileSync(join(b.dir, worktree, "half.ts"), "utf8")).toBe("half done\n");
    },
    SLOW,
  );

  test(
    "a clean one makes no commit",
    async () => {
      const b = await fresh();
      const { wi, engine } = await opened(b);
      expect(await engine.close(wi, { actor: HARNESS })).toEqual({ closed: true, wip: false });
      expect(readWorkspaces(b.dir).get(wi)).toMatchObject({ state: "closed", wip: false });
    },
    SLOW,
  );
});

describe("publishing from Home", () => {
  test(
    "publishes only a change a harness run judged and passed, with that run's words",
    async () => {
      const b = await fresh();
      const { wi, engine, worktree } = await opened(b);
      b.write(worktree, "src/dates.ts", "export const parse = 2;\n");
      const home = {
        mode: "home" as const,
        text: undefined as never,
        judge: undefined as never,
        actor: PERSON,
      };
      plainGit(join(b.dir, worktree), ["add", "-A"]);
      plainGit(join(b.dir, worktree), ["commit", "-q", "-m", "By hand"]);
      expect(await b.publish(engine, wi, home)).toMatchObject({ ok: false, code: "gate_failed" });
      expect(posts(b)).toEqual([]);
      // A run judged it, and its push did not go through.
      b.fake.interruptNextCreate("error");
      expect(await b.publish(engine, wi)).toMatchObject({ ok: true, state: "unknown" });
      const answer = await b.publish(engine, wi, home);
      expect(answer).toMatchObject({ ok: true, state: "done", pr: 1 });
      expect(posts(b).length).toBe(1);
      const patched = patches(b).at(-1)?.body as Record<string, unknown>;
      expect(patched["title"]).toBe(TEXT.title);
      // A new commit nobody judged is refused again.
      b.write(worktree, "src/dates.ts", "export const parse = 5;\n");
      plainGit(join(b.dir, worktree), ["commit", "-qam", "Unjudged"]);
      expect(await b.publish(engine, wi, home)).toMatchObject({ ok: false, code: "gate_failed" });
    },
    SLOW,
  );
});
