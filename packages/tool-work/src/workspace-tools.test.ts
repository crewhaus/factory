import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { isRunFailedError } from "@crewhaus/errors";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { createPendingApprovalStore } from "@crewhaus/session-store";
import { buildTenant, withTenant } from "@crewhaus/tenancy";
import * as main from "./index";
import { openWorkStore, readAttempts } from "./work-items/index";
import { createWorkspaceTools } from "./workspace-tools";
import {
  _resetWorkspaceBindings,
  bindWorkspaceRepositories,
  bindingsFileOf,
} from "./workspace/bindings";
import { OVER_LIMITS_TOOL } from "./workspace/limits";
import {
  type Bench,
  PERSON,
  bench,
  filesUnder,
  hostRunner,
  judgeThat,
} from "./workspace/test-helpers";

const benches: Bench[] = [];
const cwd = process.cwd();
afterEach(async () => {
  process.chdir(cwd);
  _resetWorkspaceBindings();
  for (const b of benches.splice(0)) await b.stop();
});

const SLOW = 60_000; // real git children and a loopback host

const MARKER = "PLANTED-INTENT-MARKER";

/** A harness booted as a bundle boots it: the registrar called in its own directory. */
async function booted(over: Record<string, unknown> = {}, binding = {}) {
  const b = await bench();
  benches.push(b);
  process.chdir(b.dir);
  bindWorkspaceRepositories({
    repositories: [b.binding(binding)],
    tokenEnv: b.bindings.tokenEnv,
    intent: { purpose: `${MARKER} keep it reliable` },
    ...over,
  });
  const judge = judgeThat("meets", false, `It fits ${MARKER}.`);
  const tools = createWorkspaceTools({
    harnessDir: b.dir,
    judge: judge.judge,
    checkRunner: hostRunner(),
    engine: { env: b.env },
  });
  return { b, tools, judge };
}

const call = (
  tool: { execute: (input: never, ctx?: never) => Promise<unknown> },
  input: Record<string, unknown>,
  ctx?: unknown,
): Promise<string> => tool.execute(input as never, ctx as never) as Promise<string>;

const bridge = (rc: RunContext, approvals?: unknown) => ({
  bridge: { runContext: rc, ...(approvals !== undefined ? { approvals } : {}) },
  runContext: rc,
});

describe("the tools' flags", () => {
  test("say what each one is", () => {
    const flags = [main.workspaceOpen, main.workspaceCheck, main.workspacePublish].map((t) => ({
      name: t.name,
      readOnly: t.readOnly,
      destructive: t.destructive,
      scope: t.scope,
      io: t.ioCapability,
      justify: t.requireJustification === true,
      fields: (t.operativeArgs ?? []).map((a) => `${a.field}:${a.kind}`),
      sandbox: t.requiresSandbox === true,
    }));
    expect(flags).toEqual([
      {
        name: "WorkspaceOpen",
        readOnly: false,
        destructive: false,
        scope: "external",
        io: "network",
        justify: false,
        fields: ["work:id"],
        sandbox: false,
      },
      {
        name: "WorkspaceCheck",
        readOnly: false,
        destructive: true,
        scope: "external",
        io: "process",
        justify: false,
        fields: ["work:id"],
        sandbox: false,
      },
      {
        name: "WorkspacePublish",
        readOnly: false,
        destructive: true,
        scope: "external",
        io: "network",
        justify: true,
        fields: ["work:id"],
        sandbox: false,
      },
    ]);
  });

  test(
    "a harness with no repositories says what to declare, and a tenant's run gets none of them",
    async () => {
      const b = await bench();
      benches.push(b);
      const tools = createWorkspaceTools({ harnessDir: b.dir, engine: { env: b.env } });
      const wi = await b.item();
      await expect(call(tools.workspaceOpen, { work: wi })).rejects.toThrow(
        /declares no repositories/,
      );
      const tenant = buildTenant("acme", { tenantsRoot: join(b.dir, "tenants") });
      for (const tool of [tools.workspaceOpen, tools.workspaceCheck, tools.workspacePublish]) {
        await expect(
          withTenant(tenant, () =>
            call(tool, { work: wi, title: "t", summary: "s" }),
          ) as Promise<string>,
        ).rejects.toThrow(/managed tenant/);
      }
      // Home's own runs reach them.
      const home = buildTenant(main.WORK_HOME_TENANT, { tenantsRoot: join(b.dir, "tenants") });
      await expect(
        withTenant(home, () => call(tools.workspaceOpen, { work: wi })) as Promise<string>,
      ).rejects.toThrow(/declares no repositories/);
    },
    SLOW,
  );
});

describe("a delivery through the tools", () => {
  test(
    "open, check and publish; the intent reaches the judge and nothing else",
    async () => {
      const { b, tools, judge } = await booted({}, { checks: [["test", "-f", "README.md"]] });
      const wi = await b.item();
      const rc = createRunContext();
      const said: string[] = [];
      const opened = JSON.parse(await call(tools.workspaceOpen, { work: wi }, bridge(rc))) as {
        worktree: string;
        branch: string;
      };
      said.push(JSON.stringify(opened));
      b.write(opened.worktree, "src/dates.ts", "export const parse = 2;\n");
      const checked = await call(tools.workspaceCheck, { work: wi }, bridge(rc));
      said.push(checked);
      expect(JSON.parse(checked)).toEqual([
        {
          check: "test -f README.md",
          exit: 0,
          log: `.crewhaus/run/control/work/checks/${wi}/1-0.log`,
        },
      ]);
      const published = await call(
        tools.workspacePublish,
        { work: wi, title: "Fix the dates", summary: "ISO dates parse." },
        bridge(rc),
      );
      said.push(published);
      expect(JSON.parse(published)).toMatchObject({
        work: wi,
        attempt: 1,
        state: "done",
        pr: 1,
        verdict: { checks: "skipped", acceptance: "pass" },
      });
      expect(judge.asked[0]?.input).toContain(MARKER);
      for (const tool of [tools.workspaceOpen, tools.workspaceCheck, tools.workspacePublish]) {
        said.push(tool.description, JSON.stringify(tool.inputSchema));
      }
      for (const text of said) expect(text).not.toContain(MARKER);
      for (const w of b.hostWrites()) expect(JSON.stringify(w.body)).not.toContain(MARKER);
      expect(readFileSync(join(b.dir, bindingsFileOf(b.dir)), "utf8")).not.toContain(MARKER);
      // In the harness directory the judge's own words, in the owner's file, are the only place.
      const holding = filesUnder(join(b.dir, ".crewhaus"))
        .filter((p) => readFileSync(join(b.dir, ".crewhaus", p)).includes(MARKER))
        .map((p) => p.split("/").at(-1));
      expect(holding).toEqual(["1-acceptance.log"]);
    },
    SLOW,
  );

  test(
    "a refusal says the code and the verdict's words, never the judge's",
    async () => {
      const { b } = await booted();
      const wi = await b.item();
      const judge = judgeThat("does_not_meet", false, `Not for ${MARKER}.`);
      const tools = createWorkspaceTools({
        harnessDir: b.dir,
        judge: judge.judge,
        checkRunner: hostRunner(),
        engine: { env: b.env },
      });
      const opened = JSON.parse(await call(tools.workspaceOpen, { work: wi })) as {
        worktree: string;
      };
      b.write(opened.worktree, "src/dates.ts", "export const parse = 2;\n");
      const refused = await call(tools.workspacePublish, {
        work: wi,
        title: "Fix",
        summary: "Done.",
      }).then(
        () => "published",
        (err: Error) => err.message,
      );
      expect(refused).toContain("gate_failed");
      expect(refused).toContain("acceptance: fail");
      expect(refused).not.toContain(MARKER);
    },
    SLOW,
  );
});

describe("a change past the size limits", () => {
  async function tooBig() {
    const set = await booted({}, { pullRequests: { maxFiles: 1 } });
    const wi = await set.b.item();
    const opened = JSON.parse(await call(set.tools.workspaceOpen, { work: wi })) as {
      worktree: string;
    };
    for (const name of ["a", "b", "c"]) set.b.write(opened.worktree, `src/${name}.ts`, "x\n");
    const store = createPendingApprovalStore({ rootDir: join(set.b.dir, ".crewhaus", "sessions") });
    const notified: string[] = [];
    const approvals = {
      store,
      surface: "daemon",
      notify: async (a: { id: string }) => {
        notified.push(a.id);
      },
    };
    const publish = (rc: RunContext) =>
      call(
        set.tools.workspacePublish,
        { work: wi, title: "Fix", summary: "Done." },
        bridge(rc, approvals),
      );
    return { ...set, wi, store, approvals, publish, notified };
  }

  test(
    "parks the run with the counts; a grant lets exactly that change out, once, to the run that asked",
    async () => {
      const t = await tooBig();
      const rc = createRunContext({ workItem: t.wi });
      const parked = await t.publish(rc).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(isRunFailedError(parked)).toBe(true);
      const pending = (await t.store.list())[0];
      expect(pending).toMatchObject({
        toolName: OVER_LIMITS_TOOL,
        requiredClass: "maintainer",
        input: { work: t.wi, files: 3, lines: 3, max_files: 1 },
        binding: { resumeScope: `work:${t.wi}`, runId: rc.runId, workItem: t.wi },
      });
      expect(t.notified).toEqual([pending?.id as string]);
      expect(t.b.hostWrites()).toEqual([]);
      // Asked again before it is decided: the same request.
      await expect(t.publish(rc)).rejects.toThrow();
      expect((await t.store.list()).length).toBe(1);
      await t.store.resolve(pending?.id as string, "grant", "max", { via: "cli" });
      // A run nobody started for it does not spend it.
      const other = createRunContext({ workItem: t.wi });
      await expect(t.publish(other)).rejects.toThrow(/over_limits/);
      expect(t.b.hostWrites()).toEqual([]);
      const done = JSON.parse(await t.publish(rc)) as { state: string; pr: number };
      expect(done).toMatchObject({ state: "done", pr: 1 });
      const spent = (await t.store.list()).find((a) => a.id === pending?.id);
      expect(spent?.consumedAt === undefined).toBe(false);
      // A larger change is a new decision.
      const ws = readAttempts(t.b.dir).get(t.wi)?.at(-1);
      expect(ws?.state).toBe("done");
    },
    SLOW,
  );

  test(
    "a decision that turns it down says so",
    async () => {
      const t = await tooBig();
      const rc = createRunContext({ workItem: t.wi });
      await expect(t.publish(rc)).rejects.toThrow();
      const pending = (await t.store.list())[0];
      await t.store.resolve(pending?.id as string, "deny", "max", { via: "cli" });
      const refused = await t.publish(rc).then(
        () => undefined,
        (err: unknown) => err as Error,
      );
      expect(isRunFailedError(refused)).toBe(false);
      expect(refused?.message).toContain("turned this change's size down");
      expect(t.b.hostWrites()).toEqual([]);
    },
    SLOW,
  );

  test(
    "with nowhere to ask, it is refused with the counts and nothing is pushed",
    async () => {
      const t = await tooBig();
      await expect(
        call(
          t.tools.workspacePublish,
          { work: t.wi, title: "Fix", summary: "Done." },
          bridge(createRunContext()),
        ),
      ).rejects.toThrow(/over_limits: The change is 3 files/);
      expect(t.b.hostWrites()).toEqual([]);
      const item = openWorkStore(t.b.dir).get(t.wi);
      expect("ok" in item ? undefined : item.item.state).toBe("open");
      await openWorkStore(t.b.dir).transition(t.wi, "closed", { outcome: "done" }, PERSON);
    },
    SLOW,
  );
});
