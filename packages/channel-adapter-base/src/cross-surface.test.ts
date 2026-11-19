/**
 * The channel door under faults, and who may decide from it.
 *
 * - A channel daemon killed between answering a message `ok` and starting its turn: the
 *   control plane's recovery closes the run as not processed, holding no message text,
 *   and a live daemon's message is left alone.
 * - The same message delivered twice, in one process and across a restart over the same
 *   durable dedupe store, is recorded and handled once; the same click twice decides once.
 * - The deny matrix over Slack: members granted, linked and listed through access-control's
 *   own paths, each clicking Approve, Always allow and Deny on requests of every class.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAccessSetUp, localActorOf, openAccess } from "@crewhaus/access-control";
import { DECISION_CLASSES, mintRunId } from "@crewhaus/control-contract";
import {
  createApproverReader,
  defaultLeaseProbe,
  foldStates,
  readPage,
  readProposals,
  runsLedger,
} from "@crewhaus/control-records";
import { currentLocalIdentity, wireControl } from "@crewhaus/control-service";
import { createDedupStore } from "@crewhaus/durable-state";
import {
  type PendingApproval as StoredApproval,
  createPendingApprovalStore,
  hashApprovalInput,
} from "@crewhaus/session-store";
import {
  type ApprovalActionAdapter,
  type ApprovalInteraction,
  createApprovalActions,
  linkAnswer,
} from "./approval-actions";
import { createRuntimeBackedApprovalStore } from "./approvals";
import { handleInboundEvent } from "./inbound";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** Wait for an observable state, polling a bounded number of times. */
async function until(what: string, holds: () => boolean, tries = 2_000): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (holds()) return;
    await Bun.sleep(5);
  }
  throw new Error(`never held: ${what}`);
}

/** Let the work queued off the request path run: event-loop turns, counted, never a clock. */
async function drain(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

function rowsOf(dir: string): Record<string, unknown>[] {
  return readPage(runsLedger(dir), { limit: 1000 })
    .items.map((item) => ({ ...item.record }))
    .reverse();
}

const stateOf = (dir: string, id: string) => {
  const fold = foldStates(runsLedger(dir));
  return fold.ok ? fold.objects.get(id)?.state : "unreadable";
};

/** The control plane, wired as a head wires it, with the real lease probe. */
function controlPlane(harness: string) {
  return wireControl(
    {
      hangarRoot: tempDir("cross-surface-home-"),
      harnessDirOf: () => harness,
      harnessDirs: () => [harness],
      supervisorFor: () => undefined,
      drainRequest: () => async () => undefined,
      identity: currentLocalIdentity(),
      now: Date.now,
      probe: defaultLeaseProbe,
      host: hostname(),
      onWarn: () => undefined,
    },
    { mode: "direct" },
  );
}

const MESSAGE_TEXT = ["plans", "for", "the", "launch"].join(" ");

function inbound(key: string) {
  return {
    idempotencyKey: key,
    workspaceId: "T0",
    channelId: "C0",
    userId: "U0",
    ts: "1731900000.000100",
    // The gateway's parsed event carries the text; nothing on record may.
    text: MESSAGE_TEXT,
  };
}

// ---------------------------------------------------------------------------
// [FC-2], the channel half
// ---------------------------------------------------------------------------

describe("a channel daemon that dies between answering ok and starting the turn", () => {
  test("[FC-2] recovery closes the message's run as not processed, once; it holds no message text", async () => {
    const dir = tempDir("channel-dies-");
    const marker = join(dir, "answered");
    const script = join(tempDir("channel-dies-child-"), "daemon.ts");
    writeFileSync(
      script,
      [
        `import { handleInboundEvent } from ${JSON.stringify(join(import.meta.dir, "inbound.ts"))};`,
        'import { writeFileSync } from "node:fs";',
        "const [dir, marker, event] = process.argv.slice(2);",
        "const res = await handleInboundEvent(JSON.parse(event), { id: 'slack' }, {",
        "  harnessDir: dir,",
        "  dedup: { remember: async () => false },",
        // The turn never returns: the process is killed in it.
        "  sessionRouter: { handle: () => new Promise(() => undefined) },",
        "});",
        "writeFileSync(marker, await res.text());",
        "setInterval(() => undefined, 60_000);",
      ].join("\n"),
    );
    const child = Bun.spawn(
      [process.execPath, script, dir, marker, JSON.stringify(inbound("Ev-dies"))],
      { env: { PATH: process.env["PATH"] ?? "" }, stdout: "ignore", stderr: "pipe" },
    );
    try {
      await until("the platform is answered ok", () => existsSync(marker));
      expect(readFileSync(marker, "utf8")).toBe("ok");
      const rows = rowsOf(dir);
      expect(rows.map((row) => row["state"])).toEqual(["queued", "preparing"]);
      const run = String(rows[0]?.["id"]);
      expect((rows[1]?.["holder"] as Record<string, unknown>)["pid"]).toBe(child.pid);
      child.kill("SIGKILL");
      await child.exited;

      const control = controlPlane(dir);
      const first = await control.commands.recover({ harness: dir });
      expect(first.runsInterrupted).toBe(1);
      expect(rowsOf(dir).at(-1)).toMatchObject({
        id: run,
        state: "interrupted",
        reason: "not-processed",
        by: "sys:reconcile",
      });
      expect(JSON.stringify(rowsOf(dir))).not.toContain(MESSAGE_TEXT);
      // A second recovery writes nothing.
      const written = rowsOf(dir).length;
      const second = await control.commands.recover({ harness: dir });
      expect(second.runsInterrupted).toBeUndefined();
      expect(rowsOf(dir)).toHaveLength(written);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 20_000); // a child process that is killed

  test("a daemon still alive in its turn keeps the message's run open", async () => {
    const dir = tempDir("channel-lives-");
    const res = await handleInboundEvent(
      inbound("Ev-lives"),
      { id: "slack" },
      {
        harnessDir: dir,
        dedup: { remember: async () => false },
        sessionRouter: { handle: () => new Promise<void>(() => undefined) },
      },
    );
    expect(await res.text()).toBe("ok");
    const run = String(rowsOf(dir)[0]?.["id"]);
    const counts = await controlPlane(dir).commands.recover({ harness: dir });
    expect(counts.runsInterrupted).toBeUndefined();
    expect(stateOf(dir, run)).toBe("preparing");
  });
});

// ---------------------------------------------------------------------------
// [FC-4]
// ---------------------------------------------------------------------------

describe("the same Slack delivery twice", () => {
  test("[FC-4] one message delivered twice, in one process and after a restart, is recorded and handled once", async () => {
    const dir = tempDir("channel-dup-");
    const db = join(tempDir("channel-dedup-"), "dedup.sqlite");
    const handled: string[] = [];
    const daemon = () => {
      // A daemon's own wiring: `CREWHAUS_DEDUP_STORE=sqlite:<path>`.
      const dedup = createDedupStore(`sqlite:${db}`);
      return {
        dedup,
        deliver: () =>
          handleInboundEvent(
            inbound("Ev-dup-1"),
            { id: "slack" },
            {
              harnessDir: dir,
              dedup,
              sessionRouter: {
                async handle(event) {
                  handled.push(event.idempotencyKey);
                },
              },
            },
          ).then((res) => res.text()),
      };
    };
    const first = daemon();
    expect(await first.deliver()).toBe("ok");
    expect(await first.deliver()).toBe("duplicate");
    await drain();
    await first.dedup.close?.();
    // A restart: fresh deps over the same harness, a fresh store over the same file.
    const second = daemon();
    expect(await second.deliver()).toBe("duplicate");
    await drain();
    await second.dedup.close?.();
    expect(handled).toEqual(["Ev-dup-1"]);
    const rows = rowsOf(dir);
    const runs = new Set(rows.map((row) => row["id"]));
    expect(runs.size).toBe(1);
    expect(rows.filter((row) => row["state"] === "queued")).toHaveLength(1);
    expect(rows.filter((row) => row["state"] === "preparing")).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(MESSAGE_TEXT);
  });

  test("[FC-4] the same click delivered twice, and again after a restart, decides once and resumes once", async () => {
    const h = await governedHarness();
    const member = await h.member("Clem", "owner-linked");
    const id = await h.park("operator", "notes/dup.md");
    const before = h.decisionFiles();
    const first = h.clicks();
    expect((await first.click(member.user, id, "grant")).status).toBe(200);
    expect((await first.click(member.user, id, "grant")).status).toBe(200);
    await drain();
    first.close();
    const second = h.clicks();
    expect((await second.click(member.user, id, "grant")).status).toBe(200);
    await drain();
    second.close();
    const after = h.decisionFiles();
    expect(after.claims - before.claims).toBe(1);
    expect(after.decides - before.decides).toBe(1);
    expect([...first.resumed, ...second.resumed]).toEqual([id]);
    expect(second.answers).toEqual(["Already granted in Slack."]);
  });
});

// ---------------------------------------------------------------------------
// The deny matrix over Slack
// ---------------------------------------------------------------------------

const TEAM = "T0";
type Clicker = { readonly user: string; readonly team?: string; readonly principal?: string };

/**
 * A harness under one temp Home: members granted and linked through access-control, the
 * approver list written by `sync`, a real store, and the gateway's click handler.
 */
async function governedHarness() {
  const home = tempDir("slack-matrix-home-");
  const dir = tempDir("slack-matrix-harness-");
  const id = `hrn_${Bun.hash(dir).toString(16).padStart(16, "0").slice(0, 16)}`;
  const set = await ensureAccessSetUp(home, {
    localActor: localActorOf(currentLocalIdentity()),
  });
  if (!set.ok) throw new Error(set.reason);
  const owner = set.result.owner;
  const access = openAccess(home, { harnesses: () => [{ id, dir, groups: [] }] });
  const as = { principal: owner };
  const sync = async () => {
    const done = await access.sync(as);
    if (!done.ok) throw new Error(done.reason);
  };
  const root = join(dir, ".crewhaus", "sessions");
  const runtime = createPendingApprovalStore({ rootDir: root });
  const bridge = createRuntimeBackedApprovalStore(runtime);
  let users = 0;
  const entriesOf = (at: string): string[] => {
    try {
      return readdirSync(at, { recursive: true }) as string[];
    } catch {
      return [];
    }
  };
  return {
    dir,
    owner,
    access,
    sync,
    /**
     * A member with `role`, linked to a Slack user of their own; `owner-linked` links the
     * owner. The list is written again.
     */
    async member(name: string, role: string): Promise<Clicker & { principal: string }> {
      users += 1;
      const user = `U${users}`;
      let principal = owner;
      if (role !== "owner-linked") {
        const granted = await access.grant(as, { member: name, create: true, role, scope: "home" });
        if (!granted.ok) throw new Error(granted.reason);
        principal = granted.result.principal;
      }
      const linked = await access.link(as, { subject: `slack:${TEAM}:${user}`, member: principal });
      if (!linked.ok) throw new Error(linked.reason);
      await sync();
      return { user, team: TEAM, principal };
    },
    /** A request of `requiredClass` for a call a standing rule can name. */
    async park(requiredClass: string, path: string): Promise<string> {
      const input = { path };
      const record = {
        id: `appr_${Bun.hash(`${dir}:${path}:${requiredClass}`).toString(16).padStart(16, "0").slice(0, 16)}`,
        toolName: "Write",
        inputHash: hashApprovalInput("Write", input),
        input,
        runId: mintRunId(),
        sessionId: "sess_00000000000000aa",
        surface: "channel",
        createdAt: new Date().toISOString(),
        requiredClass,
      } as StoredApproval;
      await runtime.persist(record);
      return record.id;
    },
    /** What deciding leaves: decision claims, `decide` lines, the settings file, proposals and rules. */
    decisionFiles() {
      const log = join(root, "approvals.d", "decisions");
      const decides = entriesOf(log)
        .filter((name) => name.endsWith(".jsonl"))
        .flatMap((name) => readFileSync(join(log, name), "utf8").split("\n"))
        .filter((line) => line !== "")
        .filter((line) => (JSON.parse(line) as { event?: string }).event === "decide").length;
      const settingsFile = join(dir, ".crewhaus", "settings.json");
      const rulesFile = join(dir, ".crewhaus", "run", "control", "standing-rules.jsonl");
      const proposals = readProposals(dir);
      return {
        claims: entriesOf(join(root, "approvals.d", "claims", "decision")).length,
        decides,
        settings: existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "",
        rules: existsSync(rulesFile)
          ? readFileSync(rulesFile, "utf8")
              .split("\n")
              .filter((l) => l !== "").length
          : 0,
        proposals: proposals.state === "present" ? proposals.rows.length : 0,
      };
    },
    record: async (approval: string) => (await runtime.list()).find((a) => a.id === approval),
    /** The gateway's click handler: a fresh one is a daemon restart. */
    clicks() {
      const answers: string[] = [];
      const resumed: string[] = [];
      const adapter: ApprovalActionAdapter<ApprovalInteraction> = {
        id: "slack",
        parseInteraction: () => undefined,
        async ackApproval() {},
        async answerInteraction(args) {
          answers.push(args.text);
        },
      };
      const actions = createApprovalActions({
        approvals: bridge,
        adapters: new Map([["slack", adapter]]),
        sessionRouter: {
          async resumeApproval(a: { id: string }) {
            resumed.push(a.id);
          },
        },
        harnessDir: dir,
        // Read fresh every time: the list changes under a posted card.
        approvers: createApproverReader({ now: () => Number.NaN }),
        watch: { onChange: () => undefined, close: () => undefined },
      });
      return {
        answers,
        resumed,
        click: (
          user: string,
          approval: string,
          decision: "grant" | "deny",
          o: { always?: boolean; team?: string | null } = {},
        ) =>
          actions.handle(
            {
              kind: "approval_action",
              approvalId: approval,
              decision,
              userId: user,
              ...(o.team === null ? {} : { teamId: o.team ?? TEAM }),
              ...(o.always === true ? { always: true } : {}),
            },
            adapter,
          ),
        close: () => actions.close(),
      };
    },
  };
}

describe("the deny matrix over Slack", () => {
  const ACTIONS = ["approve", "always", "deny"] as const;
  /** How far a class reaches, in the contract's own order. */
  const reach = (cls: string | undefined) =>
    cls === undefined ? -1 : (DECISION_CLASSES as readonly string[]).indexOf(cls);

  test("each clicker decides exactly what its class reaches, and every refusal leaves nothing", async () => {
    const h = await governedHarness();
    const owner = await h.member("Owner", "owner-linked");
    const viewer = await h.member("Vic", "viewer");
    const operator = await h.member("Opal", "operator");
    const maintainer = await h.member("Mae", "maintainer");
    const unlinkedLater = await h.member("Lin", "operator");
    const removedLater = await h.member("Rem", "maintainer");
    type Row = {
      readonly name: string;
      readonly clicker: Clicker;
      readonly team?: string | null;
      /** The class the clicker decides as, when it decides at all. */
      readonly decides?: string;
      readonly answer: "link" | "refusal";
    };
    const rows: Row[] = [
      { name: "unlinked", clicker: { user: "U-nobody" }, answer: "link" },
      { name: "no workspace id", clicker: owner, team: null, answer: "link" },
      // The approver list names only those who may decide, so a viewer's link is not on it.
      { name: "linked viewer", clicker: viewer, answer: "link" },
      { name: "linked operator", clicker: operator, decides: "operator", answer: "refusal" },
      { name: "linked maintainer", clicker: maintainer, decides: "maintainer", answer: "refusal" },
      { name: "linked owner", clicker: owner, decides: "owner", answer: "refusal" },
      { name: "link removed", clicker: unlinkedLater, answer: "link" },
      { name: "member removed", clicker: removedLater, answer: "link" },
    ];
    // Every card is up before anything changes.
    const cards = new Map<string, string>();
    let n = 0;
    for (const row of rows) {
      for (const cls of DECISION_CLASSES) {
        for (const action of ACTIONS) {
          n += 1;
          cards.set(`${row.name}|${cls}|${action}`, await h.park(cls, `notes/c${n}.md`));
        }
      }
    }
    // Then the link is ended, and the other member removed, each written by `sync`.
    const links = await h.access.load();
    if (links.state !== "present") throw new Error(links.state);
    const linkId = links.snapshot.links.find(
      (l) => l.principal === unlinkedLater.principal && l.state === "active",
    )?.id;
    if (linkId === undefined) throw new Error("no link to end");
    const unlinked = await h.access.unlink({ principal: h.owner }, linkId);
    if (!unlinked.ok) throw new Error(unlinked.reason);
    const removed = await h.access.removeMember(
      { principal: h.owner },
      removedLater.principal as string,
    );
    if (!removed.ok) throw new Error(removed.reason);
    await h.sync();

    const door = h.clicks();
    const wrong: string[] = [];
    let cells = 0;
    let allowed = 0;
    try {
      for (const row of rows) {
        for (const cls of DECISION_CLASSES) {
          for (const action of ACTIONS) {
            cells += 1;
            const cell = `${row.name} ${action} on ${cls}`;
            const id = cards.get(`${row.name}|${cls}|${action}`) as string;
            const before = h.decisionFiles();
            const answered = door.answers.length;
            const resumed = door.resumed.length;
            const res = await door.click(
              row.clicker.user,
              id,
              action === "deny" ? "deny" : "grant",
              {
                ...(action === "always" ? { always: true } : {}),
                ...(row.team !== undefined ? { team: row.team } : {}),
              },
            );
            if (res.status !== 200) wrong.push(`${cell}: status ${res.status}`);
            await drain();
            const after = h.decisionFiles();
            const record = await h.record(id);
            const may = reach(row.decides) >= reach(cls);
            const got = {
              claims: after.claims - before.claims,
              decides: after.decides - before.decides,
              settings: after.settings !== before.settings,
              rules: after.rules - before.rules,
              proposals: after.proposals - before.proposals,
              resumed: door.resumed.length - resumed,
              decision: record?.decision ?? "pending",
            };
            const want = !may
              ? {
                  claims: 0,
                  decides: 0,
                  settings: false,
                  rules: 0,
                  proposals: 0,
                  resumed: 0,
                  decision: "pending",
                }
              : action === "deny"
                ? {
                    claims: 1,
                    decides: 1,
                    settings: false,
                    rules: 0,
                    proposals: 0,
                    resumed: 0,
                    decision: "deny",
                  }
                : action === "always" && row.decides === "owner"
                  ? {
                      claims: 1,
                      decides: 1,
                      settings: true,
                      rules: 1,
                      proposals: 0,
                      resumed: 1,
                      decision: "grant",
                    }
                  : action === "always"
                    ? {
                        claims: 1,
                        decides: 1,
                        settings: false,
                        rules: 0,
                        proposals: 1,
                        resumed: 1,
                        decision: "grant",
                      }
                    : {
                        claims: 1,
                        decides: 1,
                        settings: false,
                        rules: 0,
                        proposals: 0,
                        resumed: 1,
                        decision: "grant",
                      };
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              wrong.push(`${cell}: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
            }
            const heard = door.answers.slice(answered);
            if (may) {
              allowed += 1;
              const stored = (
                await createPendingApprovalStore({
                  rootDir: join(h.dir, ".crewhaus", "sessions"),
                }).list()
              ).find((a) => a.id === id);
              if (stored?.decidedByPrincipal !== row.clicker.principal) {
                wrong.push(`${cell}: decided by ${stored?.decidedByPrincipal}`);
              }
              if (stored?.decidedBy !== "slack" || stored.decidedVia !== "slack") {
                wrong.push(`${cell}: decidedBy ${stored?.decidedBy} via ${stored?.decidedVia}`);
              }
              if (heard.length !== 0) wrong.push(`${cell}: heard ${JSON.stringify(heard)}`);
            } else if (row.answer === "link") {
              const subject = row.team === null ? undefined : `slack:${TEAM}:${row.clicker.user}`;
              if (JSON.stringify(heard) !== JSON.stringify([linkAnswer(subject)])) {
                wrong.push(`${cell}: heard ${JSON.stringify(heard)}`);
              }
            } else if (
              heard.length !== 1 ||
              !/^Needs (an operator|a maintainer|the owner)\.$/.test(heard[0] as string)
            ) {
              wrong.push(`${cell}: heard ${JSON.stringify(heard)}`);
            }
          }
        }
      }
    } finally {
      door.close();
    }
    expect(wrong).toEqual([]);
    // A matrix that shrinks fails here.
    expect(cells).toBe(rows.length * DECISION_CLASSES.length * ACTIONS.length);
    expect(cells).toBe(72);
    // Not hollow: operator 1 class, maintainer 2, owner 3, each by three actions.
    expect(allowed).toBe((1 + 2 + 3) * ACTIONS.length);
  }, 120_000); // five members granted, linked and listed, then 72 clicks, each under the store's lock
});
