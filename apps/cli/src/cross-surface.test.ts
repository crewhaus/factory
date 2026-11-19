/**
 * One run and one decision, the same on every surface: Home's versioned API, the CLI and
 * the Slack card. And the CLI's legs of the 0.8.x checks: an approvals record an 0.8.x
 * writer touched, a bundle 0.8.x compiled and a daemon built before the operator record.
 *
 * Home runs in this process, as `bootTestServer` boots it, with its owner signed in
 * through the boot link; the CLI verbs run as functions over the same roots.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAccess } from "@crewhaus/access-control";
import {
  type ApprovalActionAdapter,
  type ApprovalInteraction,
  HOME_REVIEW_PATH,
  createApprovalActions,
  createRuntimeBackedApprovalStore,
  postApprovalPrompt,
  whereDecided,
} from "@crewhaus/channel-adapter-base";
import { CANONICAL_RUN_ID_RE, EXIT_FOR_ERROR, mintRunId } from "@crewhaus/control-contract";
import {
  append,
  foldStates,
  readApproverProjection,
  readOperatorRecord,
  readPage,
  runsLedger,
} from "@crewhaus/control-records";
import { commandsLedgerOf, currentLocalIdentity } from "@crewhaus/control-service";
import { startHangarServer } from "@crewhaus/hangar-server";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { RUNFILE_VERSION } from "@crewhaus/harness-supervisor";
import {
  createPendingApprovalStore,
  foldReadOnly,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import { type V1Home, v1Home } from "../../../packages/hangar-server/src/__test__/v1-home";
import { runApprovalsCommand } from "./approvals-cmd";
import { directControl, harnessIdOf, liveHarnessDirs, runDaemonCommand } from "./daemon-cmd";
import { runRunsCommand } from "./runs-cmd";

const TEAM = "T0";
const USER = "U0";
const SUBJECT = `slack:${TEAM}:${USER}`;
const SESSION = "sess_00000000000000cc";
const BASE_URL = "https://home.example.test";

const scratch: string[] = [];
let home: V1Home;
let env: Record<string, string>;

beforeAll(async () => {
  home = await v1Home({
    apiRunLimits: { perHome: Number.MAX_SAFE_INTEGER, perHarness: Number.MAX_SAFE_INTEGER },
  });
  env = {
    CREWHAUS_HANGAR_ROOT: home.t.hangarRoot,
    CREWHAUS_REGISTRY_ROOT: home.t.registryRoot,
  };
  // The address the owner set for Home: the approver list carries it to the card.
  writeFileSync(
    join(home.t.hangarRoot, "settings.json"),
    JSON.stringify({ links: { baseUrl: BASE_URL } }),
  );
  const access = openAccess(home.t.hangarRoot, { harnesses: registered });
  const linked = await access.link(
    { principal: home.owner },
    { subject: SUBJECT, member: home.owner },
  );
  if (!linked.ok) throw new Error(linked.reason);
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

/** Every registered harness, as access-control's projection writer takes them. */
function registered() {
  return openHangarRegistry({ root: home.t.registryRoot, env: {} })
    .list()
    .map((e) => ({ id: e.id, dir: e.dir, groups: [...e.groups] }));
}

/** Write every registered harness's approver list, as `crewhaus access sync` does. */
async function sync(): Promise<void> {
  const done = await openAccess(home.t.hangarRoot, { harnesses: registered }).sync({
    principal: home.owner,
  });
  if (!done.ok) throw new Error(done.reason);
}

/** A cli harness with its own `crewhaus` on hand, so a run plans without one on PATH. */
async function cliHarness(name: string, approvals: unknown[] = []) {
  const h = await home.harness(name, { approvals });
  const bin = join(h.dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "crewhaus"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "crewhaus"), 0o755);
  return h;
}

/** Let the work a click queues off the request path run: counted event-loop turns. */
async function drain(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** The Slack door on one harness: the gateway's click handler over its own store. */
function slackDoor(dir: string) {
  const root = join(dir, ".crewhaus", "sessions");
  const bridge = createRuntimeBackedApprovalStore(createPendingApprovalStore({ rootDir: root }));
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
    watch: { onChange: () => undefined, close: () => undefined },
  });
  return {
    bridge,
    answers,
    resumed,
    click: (id: string, decision: "grant" | "deny" = "grant") =>
      actions.handle(
        { kind: "approval_action", approvalId: id, decision, userId: USER, teamId: TEAM },
        adapter,
      ),
    close: () => actions.close(),
  };
}

/** `crewhaus approvals <action> …`, as the CLI parses and runs it. */
async function approvals(action: string, words: readonly string[], json = true) {
  let stdout = "";
  let stderr = "";
  const positional = words.filter((w) => !w.startsWith("--"));
  const flags: Record<string, string | boolean> = {};
  const dirAt = words.indexOf("--dir");
  if (dirAt > -1) flags["dir"] = words[dirAt + 1] as string;
  if (json) flags["json"] = true;
  const identity = currentLocalIdentity();
  const code = await runApprovalsCommand(
    { positional: positional.filter((w) => w !== flags["dir"]), flags },
    action,
    {
      env,
      cwd: tmpdir(),
      identity,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      scopedSessionRoot: () => undefined,
      isTTY: () => false,
      ask: async () => "",
      control: directControl({ env, identity }),
      registryDirs: () => liveHarnessDirs({ env }),
      harnessIdOf: (dir) => harnessIdOf(dir, { env }),
    },
  );
  return { code, stdout, stderr };
}

const errorOf = (body: Record<string, unknown>) => body["error"] as Record<string, unknown>;

const recordOf = (dir: string, id: string) =>
  foldReadOnly(join(dir, ".crewhaus", "sessions")).records.find((r) => r.id === id);

function decided(dir: string, id: string): { claims: number; decides: number } {
  const root = join(dir, ".crewhaus", "sessions");
  const claim = join(root, "approvals.d", "claims", "decision", `${id}.json`);
  const log = join(root, "approvals.d", "decisions");
  const decides = (existsSync(log) ? readdirSync(log) : [])
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(log, name), "utf8").split("\n"))
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line["event"] === "decide" && line["decision"] === id);
  return { claims: existsSync(claim) ? 1 : 0, decides: decides.length };
}

const newestState = (dir: string, id: string) => {
  const fold = foldStates(runsLedger(dir));
  return fold.ok ? fold.objects.get(id)?.state : "unreadable";
};

// ---------------------------------------------------------------------------
// One id on every surface
// ---------------------------------------------------------------------------

describe("one run and one decision, the same in Home, the CLI and Slack", () => {
  test("a run started through Home and parked on a decision reads the same everywhere, and a Slack approval is Home's", async () => {
    const h = await cliHarness("triad");
    await sync();
    const created = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "Brief." },
    });
    expect(created.status).toBe(202);
    const runId = String((created.body["run"] as Record<string, unknown>)["id"]);
    expect(CANONICAL_RUN_ID_RE.test(runId)).toBe(true);

    // The runtime's part, through the real writers: the run starts, its top-level loop
    // parks on a decision, and the run waits with it.
    const ledger = runsLedger(h.dir);
    const execution = "run_00000000000000e1";
    const at = () => new Date().toISOString();
    const row = (id: string, state: string, more: Record<string, unknown> = {}) => {
      const written = append(ledger, { id, state, at: at(), trigger: { kind: "api" }, ...more });
      if (!written.ok) throw new Error(written.reason);
    };
    if (newestState(h.dir, runId) === "queued") row(runId, "preparing", { execution });
    row(runId, "running", { execution });
    const loop = mintRunId();
    row(loop, "running", {
      parent: runId,
      session: SESSION,
      resumeScope: `run:${runId}`,
      execution,
    });
    row(loop, "waiting-for-approval");
    row(runId, "waiting-for-approval", { execution });
    const approval = generateApprovalId();
    const input = { path: "notes/triad.md" };
    const store = createPendingApprovalStore({ rootDir: join(h.dir, ".crewhaus", "sessions") });
    await store.persist({
      id: approval,
      toolName: "Write",
      inputHash: hashApprovalInput("Write", input),
      // Small enough for the card to show in full, so an Approve there can decide it.
      input,
      runId: loop,
      sessionId: SESSION,
      surface: "single-turn",
      createdAt: at(),
      binding: { runId: loop, resumeScope: `run:${runId}` },
    } as Parameters<typeof store.persist>[0]);

    // The run: Home, its ref, and `crewhaus runs show`.
    const got = await home.call("GET", `/api/v1/runs/${runId}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: runId, state: "waiting-for-approval" });
    const ref = await home.call("GET", `/api/v1/refs/${h.id}/run/${runId}`);
    expect(ref.status).toBe(200);
    expect(JSON.stringify(ref.body)).toContain(runId);
    const shown = await runRunsCommand(["show", runId, "--harness", h.dir, "--json"], {
      env,
      cwd: h.dir,
    });
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.lines.join("\n"))).toMatchObject({
      id: runId,
      state: "waiting-for-approval",
    });

    // The decision: Home names the loop's run, which is the API run's child.
    const decision = await home.call("GET", `/api/v1/decisions/${h.id}/decision/${approval}`);
    expect(decision.status).toBe(200);
    expect(decision.body).toMatchObject({ id: approval, runId: loop, state: "pending" });
    // Its ref resolves to that run, in this harness, waiting on the decision; and the run
    // ledger records it as the API run's child.
    const loopRef = await home.call("GET", `/api/v1/refs/${h.id}/run/${loop}`);
    expect(loopRef.status).toBe(200);
    expect(loopRef.body).toMatchObject({ kind: "run", href: `/#/i/${h.id}/run/${loop}` });
    const child = await home.call("GET", `/api/v1/runs/${loop}`);
    expect(child.body).toMatchObject({ id: loop, state: "waiting-for-approval", harness: h.id });
    const loopRows = readPage(ledger, { limit: 100 })
      .items.map((item) => item.record)
      .filter((r) => r["id"] === loop);
    expect(loopRows.some((r) => r["parent"] === runId)).toBe(true);

    // The card the daemon posts for it names the same request, and where to review it.
    const slack = slackDoor(h.dir);
    try {
      const pending = await slack.bridge.get(approval);
      if (pending === null) throw new Error("the card has no request");
      const cards: Record<string, unknown>[] = [];
      await postApprovalPrompt({
        pending,
        sendText: async () => undefined,
        postInteractive: async (card) => {
          cards.push(card as unknown as Record<string, unknown>);
          return {};
        },
        harnessDir: h.dir,
      });
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ approvalId: approval, toolName: "Write", fitsCard: true });
      const projection = readApproverProjection(h.dir);
      expect(projection.state === "present" && projection.projection.homeUrl).toBe(BASE_URL);
      expect(cards[0]?.["review"]).toEqual({ url: `${BASE_URL}${HOME_REVIEW_PATH}` });

      // The owner, linked to Slack, approves on the card.
      expect((await slack.click(approval)).status).toBe(200);
      await drain();
      expect(slack.resumed).toEqual([approval]);
    } finally {
      slack.close();
    }
    const after = await home.call("GET", `/api/v1/decisions/${h.id}/decision/${approval}`);
    expect(after.body).toMatchObject({
      state: "granted",
      decision: "grant",
      decidedByPrincipal: home.owner,
    });
    // A second decider in Home hears it was decided in Slack.
    const again = await home.call(
      "POST",
      `/api/v1/decisions/${h.id}/decision/${approval}/resolve`,
      { body: { choice: "deny" } },
    );
    expect(again.status).toBe(409);
    expect(errorOf(again.body)["current"]).toMatchObject({ decision: "grant", surface: "slack" });
    // The record names the member, never a Slack id.
    const record = recordOf(h.dir, approval);
    expect(record).toMatchObject({ decidedVia: "slack", decidedByPrincipal: home.owner });
    const sessionsText = readdirSync(join(h.dir, ".crewhaus", "sessions"), { recursive: true })
      .map((name) => join(h.dir, ".crewhaus", "sessions", String(name)))
      .filter((path) => path.endsWith(".jsonl") || path.endsWith(".json"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(sessionsText).not.toContain(USER);
    expect(sessionsText).not.toContain(SUBJECT);

    // The runtime resumes: the loop and the run run again, and every surface agrees.
    row(loop, "running");
    row(runId, "running", { execution });
    const resumed = await home.call("GET", `/api/v1/runs/${runId}`);
    const shownAgain = await runRunsCommand(["show", runId, "--harness", h.dir, "--json"], {
      env,
      cwd: h.dir,
    });
    expect(resumed.body["state"]).toBe("running");
    expect(JSON.parse(shownAgain.lines.join("\n"))["state"]).toBe("running");
  }, 30_000); // a live Home, a run, and a decision through three surfaces
});

// ---------------------------------------------------------------------------
// 0.8.x against the CLI
// ---------------------------------------------------------------------------

describe("the CLI meets 0.8.x writers, bundles and daemons", () => {
  test("an approval granted in Home, then an 0.8.x flip and compaction: `crewhaus approvals` still shows it granted by the owner in Home", async () => {
    const id = "appr_00000000000d1c01";
    const h = await home.harness("cli-old-writer", {
      approvals: [
        {
          id,
          toolName: "SendMessage",
          inputHash: `hash-${id}`,
          input: { channel: "ops", text: "short" },
          runId: "run_00000000000000a0",
          sessionId: SESSION,
          surface: "daemon",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    // Granted in Home before the 0.8.x writer touched the file.
    const granted = await home.call("POST", `/api/v1/decisions/${h.id}/decision/${id}/resolve`, {
      body: { choice: "grant" },
    });
    expect(granted.status).toBe(200);
    const file = join(h.dir, ".crewhaus", "sessions", "approvals.jsonl");
    const flip = { ...JSON.parse(readFileSync(file, "utf8").split("\n")[0] as string) };
    appendFileSync(
      file,
      `${JSON.stringify({ ...flip, decision: "deny", decidedBy: "eve", decidedAt: new Date().toISOString() })}\n`,
    );
    const byId = new Map<string, string>();
    for (const line of readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "")) {
      byId.set(String((JSON.parse(line) as Record<string, unknown>)["id"]), line);
    }
    writeFileSync(file, `${[...byId.values()].join("\n")}\n`);
    const before = decided(h.dir, id);

    const shown = await approvals("show", [id, "--dir", h.dir]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      id,
      decision: "grant",
      decidedVia: "home",
      decidedByPrincipal: home.owner,
    });
    const listed = await approvals("list", ["--dir", h.dir]);
    expect(listed.code).toBe(0);
    const rows = JSON.parse(listed.stdout) as Record<string, unknown>[] | Record<string, unknown>;
    const items = Array.isArray(rows)
      ? rows
      : ((rows["items"] ?? rows["approvals"]) as Record<string, unknown>[]);
    expect(items.find((r) => r["id"] === id)).toMatchObject({ decision: "grant" });
    // Nothing new is decided by reading it.
    expect(decided(h.dir, id)).toEqual(before);
  }, 20_000);

  test("a crew bundle compiled by 0.8.3: `crewhaus runs create` refuses it with `crewhaus compile` and writes no run", async () => {
    const h = await home.harness("cli-old-bundle", { target: "crew" });
    mkdirSync(join(h.dir, "dist"), { recursive: true });
    writeFileSync(join(h.dir, "dist", "daemon.ts"), "// bundle\n");
    writeFileSync(
      join(h.dir, "dist", "package.json"),
      JSON.stringify({
        name: "crewhaus-compiled-bundle",
        crewhaus: { specHash: "x", compiledWith: "0.8.3" },
      }),
    );
    const input = join(tempDir("cli-old-bundle-"), "input.txt");
    writeFileSync(input, "Brief.");
    const control = directControl({ env, cwd: h.dir });
    const out = await runRunsCommand(["create", h.dir, "--input-file", input, "--json"], {
      env,
      cwd: h.dir,
      control: () => control,
      home: () => ({}),
    });
    // `unsupported`'s exit, and the verb that fixes it, as Home's 501 names it.
    expect(out.exitCode).toBe(EXIT_FOR_ERROR.unsupported);
    const text = out.lines.join("\n");
    expect(text).toContain("older than 0.9.0");
    expect(text).toContain("crewhaus compile");
    expect(readPage(runsLedger(h.dir), { limit: 10 }).items).toEqual([]);
  });

  test("a daemon built before the operator record: a pause is recorded, said to be not enforced, and kept", async () => {
    const h = await home.harness("cli-old-daemon", { target: "channel" });
    // A live daemon whose control port answers 404 to the reload route.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    });
    try {
      const run = join(h.dir, ".crewhaus", "run");
      mkdirSync(run, { recursive: true });
      writeFileSync(join(run, "control-token"), `${["t0k3n", "for", "test"].join("-")}\n`, {
        mode: 0o600,
      });
      writeFileSync(
        join(run, "daemon.json"),
        JSON.stringify({
          v: RUNFILE_VERSION,
          pid: process.pid,
          pidStartTimeMs: Date.now() - process.uptime() * 1000,
          argvFingerprint: "f",
          controlPort: server.port,
          entry: "daemon.ts",
          bundleDir: join(h.dir, "dist"),
          runId: "run_00000000000000d3",
          startedAt: new Date().toISOString(),
          managerVersion: "0.8.3",
        }),
      );
      const out = await runDaemonCommand(["pause", h.dir], { env, cwd: h.dir });
      expect(out.exitCode).toBe(0);
      expect(out.lines.join("\n")).toContain(
        "Recorded, not enforced: this build predates pause. Recompile to apply it.",
      );
      const fold = foldStates(commandsLedgerOf(h.dir));
      if (!fold.ok) throw new Error(fold.reason);
      const pause = [...fold.objects.values()].find((o) => o.record["kind"] === "controls.pause");
      expect(pause?.state).toBe("succeeded");
      expect(pause?.record["effects"]).toContainEqual({
        kind: "daemon",
        status: "skipped",
        note: "recorded, not enforced: rebuild to apply it",
      });
      const operator = readOperatorRecord.refresh(h.dir);
      expect(operator.state === "present" && operator.record.intake?.paused).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The CLI without Home
// ---------------------------------------------------------------------------

// Last in this file: it stops the Home the other tests share.
describe("a decision made with the CLI while Home is stopped", () => {
  test("Home, once it boots, answers it granted with the CLI, and a Slack click on its card decides nothing", async () => {
    const id = "appr_00000000000c5001";
    const h = await home.harness("cli-alone", {
      approvals: [
        {
          id,
          toolName: "SendMessage",
          inputHash: `hash-${id}`,
          input: { channel: "ops", text: "short" },
          runId: "run_00000000000000a0",
          sessionId: SESSION,
          surface: "daemon",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await sync();
    await home.t.server.stop();
    const granted = await approvals("grant", [id, "--dir", h.dir]);
    expect(granted.code).toBe(0);
    expect(recordOf(h.dir, id)).toMatchObject({ decision: "grant", decidedVia: "cli" });
    const again = startHangarServer({
      port: 0,
      root: home.t.hangarRoot,
      registryRoot: home.t.registryRoot,
      env: { CREWHAUS_WATCHME_ROOT: join(home.t.workspace, "watchme") },
      onWarn: () => undefined,
    });
    try {
      await again.ready;
      const call = (method: string, path: string, body?: unknown) =>
        fetch(`${again.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${again.token}`,
            "content-type": "application/json",
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }).then(async (res) => ({
          status: res.status,
          body: (await res.json()) as Record<string, unknown>,
        }));
      const got = await call("GET", `/api/v1/decisions/${h.id}/decision/${id}`);
      expect(got.status).toBe(200);
      expect(got.body).toMatchObject({ decision: "grant", decidedByPrincipal: home.owner });
      const second = await call("POST", `/api/v1/decisions/${h.id}/decision/${id}/resolve`, {
        choice: "deny",
      });
      expect(second.status).toBe(409);
      expect(errorOf(second.body)["current"]).toMatchObject({ decision: "grant", surface: "cli" });
      const before = decided(h.dir, id);
      const slack = slackDoor(h.dir);
      try {
        expect((await slack.click(id, "deny")).status).toBe(200);
        await drain();
        expect(slack.answers).toEqual([`Already granted ${whereDecided("cli")}.`]);
        expect(slack.resumed).toEqual([]);
      } finally {
        slack.close();
      }
      expect(decided(h.dir, id)).toEqual(before);
      expect(before).toEqual({ claims: 1, decides: 1 });
    } finally {
      await again.stop();
    }
  }, 30_000); // a second Home booted over the same roots
});
