/**
 * The deny matrix again, with effects on: the decision, run and control operations of the
 * versioned API asked for real by every kind of credential, each refusal proven effect-free
 * by counting what it would have written, and each allowed call proven to act exactly once.
 *
 * Also here: a decision on a harness whose approver list names another Home is refused on
 * every door, by every member, and nothing is decided; and the routes that carry a harness
 * permission but name no harness act only where the caller holds it.
 *
 * The expected allow or deny is computed from control-contract's role matrix and its
 * permission declarations, never written out by hand.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
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
import { mintScopedToken, openAccess } from "@crewhaus/access-control";
import {
  OPERATIONS,
  PERMISSION_DECLS,
  ROLE_PERMISSIONS,
  type Role,
  mintRunId,
} from "@crewhaus/control-contract";
import { append, foldStates, readOperatorRecord, runsLedger } from "@crewhaus/control-records";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { foldReadOnly } from "@crewhaus/session-store";
import { type V1Home, v1Home } from "../__test__/v1-home";
import { makeFixtureHarness } from "../fixture";
import { ROUTE_TABLE } from "../route-table";

const STAMP = new Date(Date.now() - 60_000).toISOString();
const errorOf = (body: Record<string, unknown>) =>
  (typeof body["error"] === "object" && body["error"] !== null ? body["error"] : body) as Record<
    string,
    unknown
  >;

function approval(id: string) {
  return {
    id,
    toolName: "SendMessage",
    inputHash: `hash-${id}`,
    input: { channel: "ops", text: `content of ${id}` },
    runId: "run_00000000000000a0",
    sessionId: "sess_00000000000000aa",
    surface: "daemon",
    createdAt: STAMP,
  };
}

/** An approval id, `appr_` and 16 hex digits, from a small number. */
const apprId = (n: number) => `appr_${n.toString(16).padStart(16, "0")}`;

function entries(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return [];
  }
}

/** The claim files of one kind (`decision`, `supersede`, `consume`) under a session root. */
function claimFiles(root: string, kind: string): string[] {
  return entries(join(root, "approvals.d", "claims", kind)).filter((name) =>
    name.endsWith(".json"),
  );
}

/** What deciding leaves under a session root: claim files and `decide` log lines. */
function decisionFiles(root: string): { claims: number; supersedes: number; decides: number } {
  const log = join(root, "approvals.d", "decisions");
  const decides = entries(log)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(log, name), "utf8").split("\n"))
    .filter((line) => line !== "" && (JSON.parse(line) as { event?: string }).event === "decide");
  return {
    claims: claimFiles(root, "decision").length,
    supersedes: claimFiles(root, "supersede").length,
    decides: decides.length,
  };
}

/** Every receipt line in a command ledger (a harness's, or Home's own). */
function receiptLines(dir: string): Record<string, unknown>[] {
  const at = join(dir, ".crewhaus", "run", "control", "commands");
  const own = join(dir, "control", "commands");
  const where = existsSync(at) ? at : own;
  if (!existsSync(where)) return [];
  return readdirSync(where)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => readFileSync(join(where, name), "utf8").split("\n"))
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The receipts written since `before` lines, grouped by id: each id's states in order. */
function receiptsSince(dir: string, before: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of receiptLines(dir).slice(before)) {
    const id = String(row["id"]);
    out.set(id, [...(out.get(id) ?? []), String(row["state"])]);
  }
  return out;
}

/** A harness with its own `crewhaus` on hand, so a cli run plans without one on PATH. */
async function cliHarness(home: V1Home, name: string, approvals: unknown[] = []) {
  const h = await home.harness(name, { approvals });
  const bin = join(h.dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "crewhaus"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "crewhaus"), 0o755);
  return h;
}

const runState = (dir: string, runId: string) => {
  const fold = foldStates(runsLedger(dir));
  return fold.ok ? fold.objects.get(runId)?.state : "unreadable";
};

const runRows = (dir: string, runId: string) => {
  const fold = foldStates(runsLedger(dir));
  return fold.ok ? (fold.objects.get(runId) === undefined ? 0 : 1) : -1;
};

// ---------------------------------------------------------------------------
// One Home, its credentials, and the role model
// ---------------------------------------------------------------------------

let home: V1Home;

beforeAll(async () => {
  // A run's fake job never exits, so the default caps would fill.
  home = await v1Home({
    apiRunLimits: { perHome: Number.MAX_SAFE_INTEGER, perHarness: Number.MAX_SAFE_INTEGER },
  });
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

const ALLOW = "allow";
const holds = (role: Role, permission: string): boolean =>
  (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
const floorOf = (permission: string) =>
  PERMISSION_DECLS[permission as keyof typeof PERMISSION_DECLS].floor;

/** What a credential is, as the role model reads it. */
type Model =
  | { readonly kind: "owner" }
  | {
      readonly kind: "member";
      readonly role: Role;
      readonly on: "home" | "elsewhere";
      readonly readOnly?: true;
    }
  | { readonly kind: "service"; readonly permissions: readonly string[] }
  | { readonly kind: "scoped" };

type Credential = {
  readonly name: string;
  readonly model: Model;
  readonly secret: string;
  readonly principal: string;
};

/** The choke point's answer, from the role matrix and the permission declarations. */
function chokeOf(op: { readonly permission: string }, model: Model): string {
  switch (model.kind) {
    case "owner":
      return ALLOW;
    case "member":
      // A read-only personal token carries only what a viewer may do.
      if (model.readOnly === true && floorOf(op.permission) !== "viewer") return "403 permission";
      // A grant on another harness covers nothing here.
      if (model.on === "elsewhere") return "403 permission";
      return holds(model.role, op.permission) ? ALLOW : "403 permission";
    case "service":
      return op.permission === "h.read" || model.permissions.includes(op.permission)
        ? ALLOW
        : "403 permission";
    case "scoped":
      return "403 scoped";
  }
}

/**
 * The decision service's answer past the choke point: a service decides only what an
 * operator may, so an operation that needs a maintainer or above is refused it there.
 */
function serviceLayerOf(op: { readonly qualifiers: readonly string[] }, model: Model): string {
  return model.kind === "service" && op.qualifiers.includes("maintainer-or-above")
    ? "403 decider"
    : ALLOW;
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const OPS = [
  "decisions.resolve",
  "decisions.supersede",
  "decisions.defer",
  "runs.create",
  "runs.cancel",
  "controls.pause",
] as const;
type OpId = (typeof OPS)[number];

describe("the versioned API's decision, run and control operations, with effects on", () => {
  test("every credential acts exactly once where the role matrix allows it, and leaves nothing where it does not", async () => {
    const ops = OPS.map((id) => {
      const op = OPERATIONS.find((o) => o.id === id);
      if (op === undefined) throw new Error(`no operation ${id}`);
      return op;
    });
    // The credential kinds, each minted through access-control's own paths.
    const other = await home.harness("matrix-elsewhere");
    const names = [
      "owner",
      "maintainer",
      "operator",
      "viewer",
      "readOnlyMaintainer",
      "elsewhereMaintainer",
      "reader",
      "worker",
      "scoped",
    ] as const;
    const approvalsFor = (offset: number) => names.map((_, k) => approval(apprId(offset + k + 1)));
    const dec = await home.harness("matrix-decisions", {
      approvals: [...approvalsFor(0x100), ...approvalsFor(0x200), ...approvalsFor(0x300)],
    });
    const runs = await cliHarness(home, "matrix-runs");
    const pause = await home.harness("matrix-pause");
    const covered = [dec.id, runs.id, pause.id];
    const scopedRun = mintRunId();
    const member = async (
      name: string,
      role: Role,
      o: { readOnly?: boolean; scope?: string } = {},
    ) => home.member(name, role, o);
    const portal = await home.service("matrix-portal", covered, { contentRead: true });
    const scoped = await mintScopedToken(
      home.t.hangarRoot,
      {
        credential: portal.credential,
        refs: [`${runs.id}/run/${scopedRun}`],
        acts: ["run.events.read"],
      },
      { now: Date.now },
    );
    if (!scoped.ok) throw new Error(scoped.message);
    const minted = {
      maintainer: await member("Mae", "maintainer"),
      operator: await member("Otto", "operator"),
      viewer: await member("Vee", "viewer"),
      readOnlyMaintainer: await member("Rae", "maintainer", { readOnly: true }),
      elsewhereMaintainer: await member("Bea", "maintainer", { scope: `harness:${other.id}` }),
      reader: await home.service("matrix-reader", covered),
      worker: await home.service("matrix-worker", covered, {
        permissions: ["h.decision.resolve", "h.control", "h.run.submit"],
      }),
    };
    const creds: Credential[] = [
      { name: "owner", model: { kind: "owner" }, secret: home.session, principal: home.owner },
      ...(
        [
          ["maintainer", { kind: "member", role: "maintainer", on: "home" }],
          ["operator", { kind: "member", role: "operator", on: "home" }],
          ["viewer", { kind: "member", role: "viewer", on: "home" }],
          [
            "readOnlyMaintainer",
            { kind: "member", role: "maintainer", on: "home", readOnly: true },
          ],
          ["elsewhereMaintainer", { kind: "member", role: "maintainer", on: "elsewhere" }],
          ["reader", { kind: "service", permissions: [] }],
          [
            "worker",
            { kind: "service", permissions: ["h.decision.resolve", "h.control", "h.run.submit"] },
          ],
        ] as const
      ).map(([name, model]) => ({
        name,
        model: model as Model,
        secret: minted[name].secret,
        principal: minted[name].principal,
      })),
      { name: "scoped", model: { kind: "scoped" }, secret: scoped.token, principal: "" },
    ];
    expect(creds.map((c) => c.name)).toEqual([...names]);

    // One cancellable run per credential, started by nobody in particular.
    const cancelRuns = new Map<string, string>();
    for (const cred of creds) {
      const id = mintRunId();
      append(runsLedger(runs.dir), {
        id,
        state: "queued",
        at: new Date().toISOString(),
        trigger: { kind: "api" },
      });
      cancelRuns.set(cred.name, id);
    }

    const sessions = join(dec.dir, ".crewhaus", "sessions");
    const recordOf = (id: string) => foldReadOnly(sessions).records.find((r) => r.id === id);
    const ledgers = () =>
      [dec.dir, runs.dir, pause.dir, other.dir, home.t.hangarRoot].reduce(
        (n, dir) => n + receiptLines(dir).length,
        0,
      );
    const offsetOf: Record<string, number> = {
      "decisions.resolve": 0x100,
      "decisions.supersede": 0x200,
      "decisions.defer": 0x300,
    };
    const until = new Date(Date.now() + 86_400_000).toISOString();
    let cells = 0;
    let allowed = 0;
    let refused = 0;
    const wrong: string[] = [];
    for (const op of ops) {
      for (const [k, cred] of creds.entries()) {
        cells += 1;
        const choke = chokeOf(op, cred.model);
        const want = choke === ALLOW ? serviceLayerOf(op, cred.model) : choke;
        const target = apprId((offsetOf[op.id] ?? 0) + k + 1);
        const path = (() => {
          switch (op.id as OpId) {
            case "decisions.resolve":
            case "decisions.supersede":
            case "decisions.defer":
              return `/api/v1/decisions/${dec.id}/decision/${target}/${op.id.split(".")[1]}`;
            case "runs.create":
              return `/api/v1/harnesses/${runs.id}/runs`;
            case "runs.cancel":
              return `/api/v1/runs/${cancelRuns.get(cred.name)}/cancel`;
            case "controls.pause":
              return `/api/v1/harnesses/${pause.id}/controls/pause`;
          }
        })();
        const body = (() => {
          switch (op.id as OpId) {
            case "decisions.resolve":
              return { choice: "grant" };
            case "decisions.supersede":
              return { reason: "other" };
            case "decisions.defer":
              return { until, reason: "scheduled" };
            case "runs.create":
              return { input: "x" };
            default:
              return {};
          }
        })();
        // What each operation would change, before.
        const files = decisionFiles(sessions);
        const runsBefore = foldStates(runsLedger(runs.dir));
        const runCount = runsBefore.ok ? runsBefore.objects.size : -1;
        const operator = readOperatorRecord(pause.dir);
        const rev = operator.state === "present" ? operator.record.rev : 0;
        const ledgerBefore = ledgers();
        const harnessDir = op.id.startsWith("decisions.")
          ? dec.dir
          : op.id === "controls.pause"
            ? pause.dir
            : runs.dir;
        const harnessReceipts = receiptLines(harnessDir).length;

        const res = await home.call("POST", path, {
          body,
          secret: cred.secret,
          headers: { "Idempotency-Key": `matrix-${op.id}-${cred.name}` },
        });
        const error = errorOf(res.body);
        const got =
          res.status >= 200 && res.status < 300
            ? ALLOW
            : res.status === 403
              ? `403 ${String(error["reason"])}`
              : `${res.status} ${String(error["reason"] ?? error["code"])}`;
        const cell = `${op.id} as ${cred.name}`;
        if (got !== want) wrong.push(`${cell}: ${got} (want ${want})`);

        // The effect, counted.
        const after = decisionFiles(sessions);
        const runsAfter = foldStates(runsLedger(runs.dir));
        const runCountAfter = runsAfter.ok ? runsAfter.objects.size : -1;
        const operatorAfter = readOperatorRecord(pause.dir);
        const revAfter = operatorAfter.state === "present" ? operatorAfter.record.rev : 0;
        const record = op.id.startsWith("decisions.") ? recordOf(target) : undefined;
        const effect = (() => {
          switch (op.id as OpId) {
            case "decisions.resolve":
              return `claims+${after.claims - files.claims} decides+${after.decides - files.decides} decision=${record?.decision}`;
            case "decisions.supersede":
              return `claims+${after.claims - files.claims} supersedes+${after.supersedes - files.supersedes} superseded=${record?.supersededBy !== undefined}`;
            case "decisions.defer":
              return `claims+${after.claims - files.claims} decides+${after.decides - files.decides} deferred=${record?.deferredUntil !== undefined}`;
            case "runs.create":
              return `runs+${runCountAfter - runCount}`;
            case "runs.cancel":
              return `cancelled=${runState(runs.dir, cancelRuns.get(cred.name) as string) === "cancelled"}`;
            case "controls.pause":
              return `rev+${revAfter - rev}${
                revAfter > rev && operatorAfter.state === "present"
                  ? ` by=${operatorAfter.record.intake?.by === cred.principal}`
                  : ""
              }`;
          }
        })();
        const effectWant = (() => {
          const on = want === ALLOW;
          switch (op.id as OpId) {
            case "decisions.resolve":
              return on
                ? "claims+1 decides+1 decision=grant"
                : "claims+0 decides+0 decision=undefined";
            case "decisions.supersede":
              return on
                ? "claims+0 supersedes+1 superseded=true"
                : "claims+0 supersedes+0 superseded=false";
            case "decisions.defer":
              return `claims+0 decides+0 deferred=${on}`;
            case "runs.create":
              return on ? "runs+1" : "runs+0";
            case "runs.cancel":
              return `cancelled=${on}`;
            case "controls.pause":
              return on ? "rev+1 by=true" : "rev+0";
          }
        })();
        if (effect !== effectWant) wrong.push(`${cell}: effect ${effect} (want ${effectWant})`);

        // Receipts: none for a refusal at the choke point; exactly one, rejected, for one the
        // decision service made; one that succeeded for an allowed call.
        const written = receiptsSince(harnessDir, harnessReceipts);
        const receipts = [...written.values()].map((states) => states[states.length - 1]);
        const receiptsWant = choke !== ALLOW ? [] : want === ALLOW ? ["succeeded"] : ["rejected"];
        if (op.id === "runs.create" && want === ALLOW) {
          // A start's receipt is accepted until its job reports; one receipt either way.
          if (written.size !== 1) wrong.push(`${cell}: ${written.size} receipts (want 1)`);
        } else if (JSON.stringify(receipts) !== JSON.stringify(receiptsWant)) {
          wrong.push(
            `${cell}: receipts ${JSON.stringify(receipts)} (want ${JSON.stringify(receiptsWant)})`,
          );
        }
        if (choke !== ALLOW && ledgers() !== ledgerBefore) {
          wrong.push(`${cell}: a refusal at the choke point wrote a receipt`);
        }
        if (want === ALLOW) allowed += 1;
        else refused += 1;
      }
    }
    expect(wrong).toEqual([]);
    // A matrix that shrinks fails here: every operation, by every credential.
    expect(cells).toBe(OPS.length * names.length);
    expect(cells).toBe(54);
    // Not hollow: both sides are exercised on every operation.
    expect(allowed).toBeGreaterThanOrEqual(OPS.length * 2);
    expect(refused).toBeGreaterThanOrEqual(OPS.length * 4);
  }, 120_000); // nine credentials minted through device sign-in, then 54 writes through a live server
});

// ---------------------------------------------------------------------------
// A harness whose approver list names another Home
// ---------------------------------------------------------------------------

describe("a decision on a harness whose approver list names another Home is refused on every door, and nothing is decided", () => {
  const P1 = "appr_00000000000059a1";
  const P2 = "appr_00000000000059a2";
  const REFUSAL = "Sign in to Home, or ask its owner.";

  /** Write the harness's approver list, as Home's access sync writes it, naming `accessRoot`. */
  function writeApprovers(dir: string, harness: string, operator: string, accessRoot: string) {
    const control = join(dir, ".crewhaus", "run", "control");
    mkdirSync(control, { recursive: true });
    writeFileSync(
      join(control, "approvers.json"),
      `${JSON.stringify({
        v: 1,
        epoch: 1,
        generatedAt: new Date().toISOString(),
        harness,
        owner: home.owner,
        governedSince: new Date(Date.now() - 86_400_000).toISOString(),
        members: [{ principal: operator, decide: "operator" }],
        links: [],
        accessRoot,
      })}\n`,
    );
  }

  test("the owner's session and an operator's personal token: 403, one rejected receipt, no decision and no claim", async () => {
    const h = await home.harness("foreign-root", { approvals: [approval(P1), approval(P2)] });
    const operator = await home.member("Opal", "operator");
    const another = realpathSync(mkdtempSync(join(tmpdir(), "another-home-")));
    try {
      writeApprovers(h.dir, h.id, operator.principal, another);
      const sessions = join(h.dir, ".crewhaus", "sessions");
      const asks = [
        {
          door: "resolve",
          kind: "decisions.resolve",
          path: `/api/v1/decisions/${h.id}/decision/${P1}/resolve`,
          body: { choice: "grant" },
        },
        {
          door: "supersede",
          kind: "decisions.supersede",
          path: `/api/v1/decisions/${h.id}/decision/${P1}/supersede`,
          body: { reason: "other" },
        },
        {
          door: "grant",
          kind: "decisions.resolve",
          path: `/api/h/${h.id}/approvals/${P1}/grant`,
          body: {},
        },
      ] as const;
      const callers = [
        { who: "owner", secret: home.session },
        { who: "operator", secret: operator.secret },
      ];
      let asked = 0;
      for (const caller of callers) {
        for (const ask of asks) {
          const before = receiptLines(h.dir).length;
          const res = await home.call("POST", ask.path, { body: ask.body, secret: caller.secret });
          const where = `${caller.who} ${ask.door}`;
          expect(`${where}: ${res.status}`).toBe(`${where}: 403`);
          expect(JSON.stringify(res.body)).toContain(REFUSAL);
          const written = [...receiptsSince(h.dir, before).entries()];
          expect(`${where}: ${written.length}`).toBe(`${where}: 1`);
          const [id, states] = written[0] as [string, string[]];
          expect(`${where}: ${states[states.length - 1]}`).toBe(`${where}: rejected`);
          const row = receiptLines(h.dir).find((r) => r["id"] === id);
          expect(row?.["kind"]).toBe(ask.kind);
          const folded = foldReadOnly(sessions);
          expect(folded.records[0]?.decision).toBeUndefined();
          expect(folded.records[0]?.supersededBy).toBeUndefined();
          expect(claimFiles(sessions, "decision")).toEqual([]);
          expect(claimFiles(sessions, "supersede")).toEqual([]);
          asked += 1;
        }
      }
      expect(asked).toBe(6);

      // The same owner's grants once the list names this Home: the refusal was the root.
      writeApprovers(h.dir, h.id, operator.principal, realpathSync(home.t.hangarRoot));
      // Past the approver list's one-second cache, on a faked clock.
      const realNow = Date.now.bind(Date);
      const clock = spyOn(Date, "now").mockImplementation(() => realNow() + 2_000);
      try {
        const v1 = await home.call("POST", `/api/v1/decisions/${h.id}/decision/${P1}/resolve`, {
          body: { choice: "grant" },
        });
        expect(v1.status).toBe(200);
        const legacy = await home.call("POST", `/api/h/${h.id}/approvals/${P2}/grant`, {
          body: {},
        });
        expect(legacy.status).toBe(200);
      } finally {
        clock.mockRestore();
      }
      const folded = foldReadOnly(sessions);
      expect(folded.records.find((r) => r.id === P1)?.decision).toBe("grant");
      expect(folded.records.find((r) => r.id === P2)?.decision).toBe("grant");
      expect(claimFiles(sessions, "decision").sort()).toEqual([`${P1}.json`, `${P2}.json`]);
    } finally {
      rmSync(another, { recursive: true, force: true });
    }
  }, 30_000); // a member's device sign-in and eight decisions through a live server
});

// ---------------------------------------------------------------------------
// The routes with a harness permission and no harness in their path
// ---------------------------------------------------------------------------

describe("a route about several harnesses acts only where the caller holds its permission", () => {
  const FLEET_ROWS = ROUTE_TABLE.filter(
    (row) => row.permission.startsWith("h.") && !row.path.includes(":id"),
  );
  const STUB = ["c0ntrol", "test", "bearer", "0123456789abcdef"].join("-");
  const SESSION_A = "sess_00000000000a11a1";
  const SESSION_B = "sess_00000000000b22b2";
  const SESSION_NONE = "sess_0000000000000ee0";

  function writeProof(dir: string, spec: string, session: string): void {
    const at = join(dir, ".crewhaus", "proofs", spec, session);
    mkdirSync(at, { recursive: true });
    writeFileSync(
      join(at, "turn-1.json"),
      `${JSON.stringify({
        version: 1,
        level: "grounded",
        verdict: "pass",
        score: 1,
        threshold: 1,
        achieved: "grounded",
        claims: [],
        claimCount: 0,
        met: 0,
        unmet: 0,
        assumptions: 0,
        sources: 0,
        judgeWaived: 0,
        retryIndex: 0,
        createdAt: STAMP,
        bundleHash: "a".repeat(64),
      })}\n`,
    );
  }

  test("the rows are the route table's own: five", () => {
    expect(FLEET_ROWS.map((row) => row.key).sort()).toEqual(
      ["credentialsSetAcross", "groupProc", "mcpCatalog", "runProof", "wizardTemplates"].sort(),
    );
  });

  test("a member who holds them on B only acts on B alone, and reads nothing of A", async () => {
    const daemon = (name: string) =>
      makeFixtureHarness(join(home.t.harnessesRoot, name), {
        specName: name,
        target: "channel",
        controlToken: STUB,
        bundle: { entry: "daemon.ts" },
      });
    const register = async (dir: string) =>
      (
        (await home.t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) }))
          .body["entry"] as { id: string }
      ).id;
    const aDir = daemon("fleet-alpha");
    const bDir = daemon("fleet-bravo");
    const a = await register(aDir);
    const b = await register(bDir);
    writeProof(aDir, "fleet-alpha", SESSION_A);
    writeProof(bDir, "fleet-bravo", SESSION_B);
    const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
    expect((await home.t.api("/api/registry/groups", post({ name: "pair" }))).status).toBe(201);
    const registry = openHangarRegistry({ root: home.t.registryRoot, env: {} });
    for (const id of [a, b]) {
      const set = await home.t.api(`/api/h/${id}/groups`, {
        method: "PUT",
        body: JSON.stringify({ groups: ["pair"] }),
      });
      expect(set.status).toBe(200);
      expect(registry.adopt(id, home.owner)).toBeDefined();
    }
    // One reads A as a viewer; the other has nothing on A at all.
    const viewing = await home.member("Wren", "maintainer", { scope: `harness:${b}` });
    const viewerGrant = await openAccess(home.t.hangarRoot).grant(
      { principal: home.owner },
      { member: viewing.principal, role: "viewer", scope: `harness:${a}` },
    );
    if (!viewerGrant.ok) throw new Error(viewerGrant.reason);
    const blind = await home.member("Yan", "maintainer", { scope: `harness:${b}` });
    const envOf = (dir: string) =>
      existsSync(join(dir, ".env")) ? readFileSync(join(dir, ".env"), "utf8") : "";
    const spawnedIn = (dir: string) =>
      (home.t.ops?.children ?? []).filter((c) => c.request.cwd === dir).length;

    // groupProc: a walk over {A, B} acts on B only.
    const startedB = spawnedIn(bDir);
    const viewed = await home.call("POST", "/api/registry/groups/pair/proc/start", {
      body: {},
      secret: viewing.secret,
    });
    expect([200, 207]).toContain(viewed.status);
    const viewedMembers = (viewed.body["result"] as { members: Record<string, unknown>[] }).members;
    expect(viewedMembers.find((m) => m["id"] === a)).toMatchObject({
      skipped: true,
      reason: "forbidden",
    });
    expect(viewedMembers.find((m) => m["id"] === b)?.["skipped"]).not.toBe(true);
    expect(spawnedIn(bDir)).toBe(startedB + 1);
    const plan = await home.call("GET", "/api/registry/groups/pair/proc/stop", {
      secret: blind.secret,
    });
    expect(plan.status).toBe(200);
    const planned = (plan.body["plan"] as { members: { id: string }[] }).members.map((m) => m.id);
    expect(planned).toEqual([b]);
    const blindWalk = await home.call("POST", "/api/registry/groups/pair/proc/stop", {
      body: {},
      secret: blind.secret,
    });
    expect([200, 207, 409]).toContain(blindWalk.status);
    expect(JSON.stringify(blindWalk.body)).not.toContain(a);
    // Nothing was ever started or signalled on A.
    expect(spawnedIn(aDir)).toBe(0);

    // credentialsSetAcross: naming A is 403 and writes nothing to A's env; B alone is written.
    for (const who of [viewing, blind]) {
      const across = await home.call("POST", "/api/credentials/set", {
        body: {
          key: "FLEET_NOTE",
          value: "plain-value",
          harnessIds: [a, b],
          confirmName: "FLEET_NOTE",
        },
        secret: who.secret,
      });
      expect(across.status).toBe(403);
      expect(errorOf(across.body)["needs"] ?? across.body["needs"]).toBe("h.secrets.write");
      expect(envOf(aDir)).not.toContain("FLEET_NOTE");
      expect(envOf(bDir)).not.toContain("FLEET_NOTE");
    }
    const onlyB = await home.call("POST", "/api/credentials/set", {
      body: { key: "FLEET_NOTE", value: "plain-value", harnessIds: [b], confirmName: "FLEET_NOTE" },
      secret: blind.secret,
    });
    expect(onlyB.status).toBe(200);
    expect(readFileSync(join(bDir, ".env"), "utf8")).toContain("FLEET_NOTE");
    expect(envOf(aDir)).not.toContain("FLEET_NOTE");

    // runProof: A's session answers exactly as a session that is not there; B's is served.
    const proofA = await home.call("GET", `/api/runs/${SESSION_A}/proof`, { secret: blind.secret });
    const proofNone = await home.call("GET", `/api/runs/${SESSION_NONE}/proof`, {
      secret: blind.secret,
    });
    expect(proofA.status).toBe(proofNone.status);
    expect(proofA.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(proofA.body)).toBe(JSON.stringify(proofNone.body));
    expect(JSON.stringify(proofA.body)).not.toContain(a);
    const proofB = await home.call("GET", `/api/runs/${SESSION_B}/proof`, { secret: blind.secret });
    expect(proofB.status).toBe(200);

    // The two catalogs: answered, and nothing of A in them.
    for (const path of ["/api/builders/templates", "/api/builders/mcp-catalog"]) {
      const res = await home.call("GET", path, { secret: blind.secret });
      expect(`${path}: ${res.status}`).toBe(`${path}: 200`);
      const text = JSON.stringify(res.body);
      for (const leak of [a, aDir, "fleet-alpha"]) {
        expect(`${path}: ${text.includes(leak)}`).toBe(`${path}: false`);
      }
    }
  }, 60_000); // two members' device sign-ins and a group walk through a live server
});
