/**
 * Every route, for every role and credential: the deny matrix.
 *
 * One Home with two harnesses, A and B, and a credential of every kind, each made through
 * access-control's own paths (the boot link, invites accepted through the sign-in route,
 * service tokens, scoped tokens): the owner's session, Home's own key, members of each role
 * on A, a member only on B, a service token that reads A, a scoped token for one run of A,
 * a scoped token whose service token was revoked, a personal-token shape, a tab-only
 * session on its own address and off it, a forwarded and a rebinding request with Home's
 * own key. Every route-table row is asked once by each, and the answer is exactly the one
 * the table and the role matrix say.
 *
 * Read-only mode is on for the whole matrix, so an allowed write is answered `read_only`
 * by the gate that runs after authorization: what is allowed is proven allowed, and no
 * write has an effect. The command ledgers are counted around every credential that is not
 * the owner's: a refused write writes no receipt.
 *
 * The expected outcome is computed from control-contract's role matrix, and a hand-written
 * table of sentinel rows checks that computation independently.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AccessSnapshot,
  type DomainChecker,
  type DomainRequest,
  authenticate,
  loadAccessSnapshot,
  mintScopedToken,
  openAccess,
  openSignIn,
} from "@crewhaus/access-control";
import { PERMISSION_DECLS, ROLES, ROLE_PERMISSIONS, type Role } from "@crewhaus/control-contract";
import { acceptInvite, acceptInviteTabOnly, bearer, signInFromBootLink } from "./__test__/browser";
import { type AccessView, type Caller, authorizeRequest, withholdPeople } from "./access";
import { makeFixtureHarness } from "./fixture";
import { matchRequest } from "./route-match";
import { ROUTE_BY_KEY, ROUTE_TABLE, type RouteRow } from "./route-table";
import { type TestServer, bootTestServer } from "./testkit";

// ---------------------------------------------------------------------------
// The Home every credential is made on
// ---------------------------------------------------------------------------

const RUN_OF_A = "run_0badcafe";

type Cred = {
  readonly name: string;
  readonly headers: Record<string, string>;
};

type World = {
  readonly t: TestServer;
  readonly a: string;
  readonly b: string;
  readonly aDir: string;
  readonly bDir: string;
  readonly owner: string;
  readonly creds: Readonly<Record<string, Cred>>;
  readonly principals: Readonly<Record<string, string>>;
};

let world: World;

function register(t: TestServer, dir: string): Promise<string> {
  return t
    .api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) })
    .then((res) => (res.body["entry"] as { id: string }).id);
}

function snapshotOf(t: TestServer): AccessSnapshot {
  const read = loadAccessSnapshot(t.hangarRoot);
  if (read.state !== "present") throw new Error(`access ${read.state}`);
  return read.snapshot;
}

const STAMP = "2026-11-11T00:00:00.000Z";

function harnessWithData(t: TestServer, name: string): string {
  return makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: name,
    sessions: [],
    approvals: [
      {
        id: name === "alpha" ? "appr_00000000000000a1" : "appr_00000000000000b1",
        toolName: "SendMessage",
        inputHash: `hash-${name}`,
        input: { channel: "ops", text: `${name} content quoted` },
        runId: "run_00000000000000a0",
        sessionId: "sess_00000000000000aa",
        surface: "daemon",
        createdAt: STAMP,
      },
    ],
    reviewQueue: [
      {
        schemaVersion: 1,
        id: `rev_quarantine_${name}_s1`,
        kind: "quarantine",
        sourceRef: { dataset: "smoke", sampleId: "s1" },
        ts: STAMP,
        status: "open",
        context: `${name} context quoted`,
      },
    ],
  });
}

async function makeWorld(): Promise<World> {
  const t = bootTestServer({ lanHost: "127.0.0.1" });
  const owner = await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
  const aDir = harnessWithData(t, "alpha");
  const bDir = harnessWithData(t, "bravo");
  const a = await register(t, aDir);
  const b = await register(t, bDir);
  const ownerId = snapshotOf(t).owner as string;
  const access = openAccess(t.hangarRoot, {
    harnesses: () => [
      { id: a, dir: aDir, groups: [] },
      { id: b, dir: bDir, groups: [] },
    ],
  });
  const as = { principal: ownerId };
  const invite = async (role: string, scope: string): Promise<string> => {
    const done = await access.createInvite(as, { role, scope });
    if (!done.ok) throw new Error(done.reason);
    return done.result.code;
  };
  const join = async (role: string, scope: string, name: string) =>
    acceptInvite(t.fetchRaw, await invite(role, scope), name);
  const maintainerA = await join("maintainer", `harness:${a}`, "Mae");
  const operatorA = await join("operator", `harness:${a}`, "Otto");
  const viewerA = await join("viewer", `harness:${a}`, "Vee");
  const memberB = await join("maintainer", `harness:${b}`, "Bea");
  const tab = await acceptInviteTabOnly(t.fetchRaw, await invite("viewer", "home"), "Tab");
  if (tab.status !== 200) throw new Error(`tab-only join answered ${tab.status}`);
  const tabOwner = await acceptInviteTabOnly(t.fetchRaw, await invite("owner", "home"), "Tabby");
  if (tabOwner.status !== 200) throw new Error(`tab-only owner join answered ${tabOwner.status}`);
  const mint = async (name: string, contentRead: boolean) => {
    const done = await access.mintServiceToken(as, {
      service: name,
      permissions: [],
      harnesses: [a],
      ...(contentRead ? { contentRead: true } : {}),
    });
    if (!done.ok) throw new Error(done.reason);
    return done.result;
  };
  const reader = await mint("reader", false);
  const portal = await mint("portal", true);
  const gone = await mint("gone", true);
  const scoped = async (credential: string) => {
    const done = await mintScopedToken(
      t.hangarRoot,
      { credential, refs: [`${a}/run/${RUN_OF_A}`], acts: ["run.events.read"] },
      { now: Date.now },
    );
    if (!done.ok) throw new Error(done.message);
    return done.token;
  };
  const scopedLive = await scoped(portal.token.id);
  const scopedGone = await scoped(gone.token.id);
  const revoked = await access.revoke(as, gone.token.id);
  if (!revoked.ok) throw new Error(revoked.reason);
  const port = t.server.port;
  const creds: Record<string, Cred> = {
    owner: { name: "owner", headers: bearer(owner.session) },
    bootstrap: { name: "bootstrap", headers: bearer(t.token) },
    maintainerA: { name: "maintainerA", headers: bearer(maintainerA.session) },
    operatorA: { name: "operatorA", headers: bearer(operatorA.session) },
    viewerA: { name: "viewerA", headers: bearer(viewerA.session) },
    memberB: { name: "memberB", headers: bearer(memberB.session) },
    service: { name: "service", headers: bearer(reader.secret) },
    scoped: { name: "scoped", headers: bearer(scopedLive) },
    scopedRevoked: { name: "scopedRevoked", headers: bearer(scopedGone) },
    personal: { name: "personal", headers: bearer(["chp", "_", "A".repeat(43)].join("")) },
    tabOnly: { name: "tabOnly", headers: bearer(tab.session) },
    tabOnlyOwner: { name: "tabOnlyOwner", headers: bearer(tabOwner.session) },
    tabOnlyElsewhere: {
      name: "tabOnlyElsewhere",
      headers: { ...bearer(tab.session), host: `localhost:${port}` },
    },
    forwardedBootstrap: {
      name: "forwardedBootstrap",
      headers: { ...bearer(t.token), "x-forwarded-for": "203.0.113.9" },
    },
    rebindingHost: {
      name: "rebindingHost",
      headers: { ...bearer(t.token), host: "rebind.example.test" },
    },
  };
  // On for the whole matrix: an allowed write is answered `read_only` and has no effect.
  const engaged = await t.api("/api/read-only", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  if (engaged.status !== 200) throw new Error(`read-only answered ${engaged.status}`);
  return {
    t,
    a,
    b,
    aDir,
    bDir,
    owner: ownerId,
    creds,
    principals: {
      maintainerA: maintainerA.answer["principal"] as string,
      memberB: memberB.answer["principal"] as string,
      service: reader.principal,
      portal: portal.principal,
      portalCredential: portal.token.id,
    },
  };
}

beforeAll(async () => {
  world = await makeWorld();
}, 60_000);

afterAll(async () => {
  await world?.t.stop();
});

// ---------------------------------------------------------------------------
// What each credential may do, from the role matrix
// ---------------------------------------------------------------------------

type Grants = { readonly home?: Role; readonly a?: Role; readonly b?: Role };

const ALLOW = "allow";
const rank = (role: Role | undefined): number => (role === undefined ? -1 : ROLES.indexOf(role));
const holds = (role: Role | undefined, permission: string): boolean =>
  role !== undefined && (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
const best = (...roles: (Role | undefined)[]): Role | undefined =>
  roles.reduce<Role | undefined>((top, role) => (rank(role) > rank(top) ? role : top), undefined);

/** A member's answer for a row asked about harness A. */
function memberOutcome(row: RouteRow, grants: Grants): string {
  if (row.permission === "public" || row.permission === "authenticated") return ALLOW;
  const refuse = "403 permission";
  const decl = PERMISSION_DECLS[row.permission as keyof typeof PERMISSION_DECLS];
  if (decl.scope === "home") {
    if (decl.floor === "none") return refuse;
    if (decl.floor === "viewer") return Object.values(grants).length > 0 ? ALLOW : refuse;
    return rank(grants.home) >= rank(decl.floor) ? ALLOW : refuse;
  }
  if (row.key === "runProof") return refuse; // no bundle: nothing to authorize against
  if (row.path.includes("/:id")) {
    return holds(best(grants.home, grants.a), row.permission) ? ALLOW : refuse;
  }
  return [grants.home, grants.a, grants.b].some((role) => holds(role, row.permission))
    ? ALLOW
    : refuse;
}

/** A service token that holds `h.read` on A and nothing else. */
function serviceOutcome(row: RouteRow): string {
  if (row.permission === "public" || row.permission === "authenticated") return ALLOW;
  if (row.key === "runProof") return "403 permission";
  return row.permission === "h.read" ? ALLOW : "403 permission";
}

function expected(row: RouteRow, cred: string): string {
  switch (cred) {
    case "owner":
      return row.key === "bootTicket" ? "403 owner_only" : ALLOW;
    case "bootstrap":
      return ALLOW;
    case "maintainerA":
      return memberOutcome(row, { a: "maintainer" });
    case "operatorA":
      return memberOutcome(row, { a: "operator" });
    case "viewerA":
      return memberOutcome(row, { a: "viewer" });
    case "memberB":
      return memberOutcome(row, { b: "maintainer" });
    case "service":
      return serviceOutcome(row);
    case "scoped":
      return row.key === "runEvents" ? ALLOW : "403 scoped";
    case "scopedRevoked":
    case "personal":
      return "401 credential_unknown";
    case "tabOnly":
      return row.permission === "home.settings.manage" || row.permission === "home.access.manage"
        ? "403 tab_only"
        : memberOutcome(row, { home: "viewer" });
    case "tabOnlyOwner":
      return row.permission === "home.settings.manage" || row.permission === "home.access.manage"
        ? "403 tab_only"
        : memberOutcome(row, { home: "owner" });
    case "tabOnlyElsewhere":
      return "403 tab_only";
    case "forwardedBootstrap":
      return "401 bootstrap_not_accepted_here";
    case "rebindingHost":
      return "421";
    default:
      throw new Error(`no model for ${cred}`);
  }
}

/**
 * The sentinels, written out by hand from the role table rather than computed: the
 * computed model above must agree with every one, and the server with the model.
 */
const SENTINELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  inspectRaw: {
    owner: ALLOW,
    bootstrap: ALLOW,
    maintainerA: "403 permission",
    operatorA: "403 permission",
    viewerA: "403 permission",
    service: "403 permission",
  },
  inspectStore: { owner: ALLOW, maintainerA: "403 permission", viewerA: "403 permission" },
  inspectEntry: { owner: ALLOW, maintainerA: "403 permission", viewerA: "403 permission" },
  discover: {
    owner: ALLOW,
    bootstrap: ALLOW,
    maintainerA: "403 permission",
    viewerA: "403 permission",
    tabOnly: "403 permission",
  },
  removeHarness: {
    owner: ALLOW,
    maintainerA: "403 permission",
    operatorA: "403 permission",
    memberB: "403 permission",
  },
  procStart: {
    owner: ALLOW,
    maintainerA: ALLOW,
    operatorA: ALLOW,
    viewerA: "403 permission",
    memberB: "403 permission",
    service: "403 permission",
    tabOnly: "403 permission",
  },
  setReadOnly: {
    owner: ALLOW,
    bootstrap: ALLOW,
    maintainerA: "403 permission",
    viewerA: "403 permission",
    tabOnly: "403 tab_only",
  },
  bootTicket: {
    bootstrap: ALLOW,
    owner: "403 owner_only",
    maintainerA: "403 permission",
    tabOnly: "403 tab_only",
  },
  session: { owner: ALLOW, viewerA: ALLOW, memberB: "403 permission", service: "403 permission" },
  harnesses: { viewerA: ALLOW, memberB: ALLOW, service: "403 permission", scoped: "403 scoped" },
  runEvents: { scoped: ALLOW, viewerA: ALLOW, service: "403 permission" },
  run: { scoped: "403 scoped", viewerA: ALLOW },
};

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

const MATRIX_ROWS = ROUTE_TABLE.filter((row) => !row.path.startsWith("/api/v1/auth/"));

function sampleFor(row: RouteRow, name: string, harness: string): string {
  if (name === "id") return harness;
  if (name === "runId") {
    return row.key === "run" || row.key === "runEvents" ? RUN_OF_A : "run_0123456789abcdef";
  }
  if (name === "optRunId") return "opt_0123456789abcdef";
  return "sample-1";
}

function pathFor(row: RouteRow, harness: string): string {
  return row.path.replace(/:([A-Za-z]+)/g, (_, name: string) => sampleFor(row, name, harness));
}

type Answer = { readonly status: number; readonly body: Record<string, unknown> };

async function ask(t: TestServer, row: RouteRow, cred: Cred, harness: string): Promise<Answer> {
  const res = await t.fetchRaw(pathFor(row, harness), {
    method: row.method,
    headers: { "content-type": "application/json", ...cred.headers },
    ...(row.method === "GET" ? {} : { body: "{}" }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { text };
  }
  return { status: res.status, body };
}

/** What the server's answer says, in the model's words. */
function outcomeOf(row: RouteRow, answer: Answer): string {
  const { status, body } = answer;
  if (status === 421) return "421";
  if (status === 401) return `401 ${String(body["reason"])}`;
  if (status === 403 && body["code"] === "read_only") return ALLOW;
  if (status === 403 && ["permission", "scoped", "tab_only"].includes(String(body["reason"]))) {
    return `403 ${String(body["reason"])}`;
  }
  if (status === 403 && body["reason"] === "owner_only") return "403 owner_only";
  // The handler ran: whatever it answered, the choke point allowed the request.
  return ALLOW;
}

function ledgerLines(dir: string): number {
  const at = join(dir, ".crewhaus", "run", "control", "commands");
  if (!existsSync(at)) return 0;
  return readdirSync(at)
    .filter((name) => name.endsWith(".jsonl"))
    .reduce(
      (n, name) =>
        n +
        readFileSync(join(at, name), "utf8")
          .split("\n")
          .filter((l) => l !== "").length,
      0,
    );
}

function allLedgers(): number {
  return ledgerLines(world.aDir) + ledgerLines(world.bDir) + ledgerLines(world.t.hangarRoot);
}

const CREDS = [
  "owner",
  "bootstrap",
  "maintainerA",
  "operatorA",
  "viewerA",
  "memberB",
  "service",
  "scoped",
  "scopedRevoked",
  "personal",
  "tabOnly",
  "tabOnlyOwner",
  "tabOnlyElsewhere",
  "forwardedBootstrap",
  "rebindingHost",
] as const;

describe("the deny matrix: every route, for every role and credential", () => {
  test("the hand-written sentinels and the role-matrix model agree", () => {
    let checked = 0;
    for (const [key, byCred] of Object.entries(SENTINELS)) {
      const row = ROUTE_BY_KEY.get(key) as RouteRow;
      expect(row).toBeDefined();
      for (const [cred, outcome] of Object.entries(byCred)) {
        expect(`${key} as ${cred}: ${expected(row, cred)}`).toBe(`${key} as ${cred}: ${outcome}`);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(45);
  });

  test("every request this matrix makes matches its own row", () => {
    expect(MATRIX_ROWS.length).toBeGreaterThanOrEqual(260);
    for (const row of MATRIX_ROWS) {
      const segments = pathFor(row, "hrn_0123456789abcdef")
        .split("/")
        .filter((s) => s !== "");
      expect(`${row.key} -> ${matchRequest(row.method, segments)?.row.key}`).toBe(
        `${row.key} -> ${row.key}`,
      );
    }
  });

  for (const cred of CREDS) {
    test(`as ${cred}: every row is answered exactly as the role table says`, async () => {
      const { t, a } = world;
      const before = allLedgers();
      const wrong: string[] = [];
      for (const row of MATRIX_ROWS) {
        const answer = await ask(t, row, world.creds[cred] as Cred, a);
        const got = outcomeOf(row, answer);
        const want = expected(row, cred);
        if (got !== want) wrong.push(`${row.key} ${row.method} ${row.path}: ${got} (want ${want})`);
        if (got === ALLOW) {
          // Read-only mode decides by effect: a row that writes a receipt is refused after
          // authorization, and one that only reads is answered, whatever its method.
          const gated = row.receipt !== "none" && row.key !== "setReadOnly";
          const answered = answer.status === 403 && answer.body["code"] === "read_only";
          if (gated !== answered) wrong.push(`${row.key}: read-only gate ${answered}`);
        }
        if (got === "403 permission") {
          // In the route's envelope, naming what is missing, never a permission id up front.
          expect(answer.body["code"]).toBe("forbidden");
          expect(answer.body["needs"]).toBe(row.permission);
          expect(String(answer.body["error"])).not.toContain(row.permission);
        }
      }
      expect(wrong).toEqual([]);
      // Nothing it was refused, and nothing read-only answered, left a receipt or an effect.
      if (cred !== "owner" && cred !== "bootstrap") expect(allLedgers()).toBe(before);
    }, 120_000); // ~260 requests through a live server, each with its handler where allowed
  }

  test("a forwarded, a rebinding and a remote use of Home's own key are refused on every row", async () => {
    const { t } = world;
    const signIn = openSignIn(t.hangarRoot, { localActor: "local:tester@test-host" });
    for (const row of MATRIX_ROWS) {
      const url = `http://127.0.0.1:${t.server.port}${pathFor(row, world.a)}`;
      const remote = await authenticate(
        new Request(url, { method: row.method, headers: bearer(t.token) }),
        { address: "192.168.1.40", listener: "tcp" },
        {},
        { signIn, bootToken: t.token },
      );
      expect(remote.kind === "refused" && `${row.key}:${remote.reason}`).toBe(
        `${row.key}:bootstrap_not_accepted_here`,
      );
    }
  });
});

describe("a scoped token reads only its own run, from Home's own pages", () => {
  test("a page on another origin is refused, and Home's own origin is answered", async () => {
    const { t, a, creds } = world;
    const path = `/api/h/${a}/runs/${RUN_OF_A}/events`;
    const scoped = (creds["scoped"] as Cred).headers;
    const foreign = await t.fetchRaw(path, {
      headers: { ...scoped, origin: "https://elsewhere.example.test" },
    });
    expect([foreign.status, ((await foreign.json()) as Record<string, unknown>)["reason"]]).toEqual(
      [403, "scoped"],
    );
    const own = await t.fetchRaw(path, {
      headers: { ...scoped, origin: `http://127.0.0.1:${t.server.port}` },
    });
    // Past the choke point: the handler answers (the run id is not a supervisor run).
    expect(own.status).toBe(400);
    // Another run of the same harness is not this token's.
    const other = await t.fetchRaw(`/api/h/${a}/runs/run_0badcaff/events`, { headers: scoped });
    expect(other.status).toBe(403);
  });

  test("it reads no more on a row than its service may: the row's own permission is checked too", async () => {
    const { t, a, owner } = world;
    const access = openAccess(t.hangarRoot);
    const reader = await access.mintServiceToken(
      { principal: owner },
      { service: "results-only", permissions: [], harnesses: [a] },
    );
    if (!reader.ok) throw new Error(reader.reason);
    const minted = await mintScopedToken(
      t.hangarRoot,
      {
        credential: reader.result.token.id,
        refs: [`${a}/run/${RUN_OF_A}`],
        acts: ["run.result.read"],
      },
      { now: Date.now },
    );
    if (!minted.ok) throw new Error(minted.message);
    // The run row needs content access, which this service does not hold.
    const res = await t.fetchRaw(`/api/h/${a}/runs/${RUN_OF_A}`, { headers: bearer(minted.token) });
    expect([res.status, ((await res.json()) as Record<string, unknown>)["reason"]]).toEqual([
      403,
      "scoped",
    ]);
  });
});

describe("a trusted proxy's identities", () => {
  test("an unlinked identity and one that disagrees with the bearer are refused on every row", async () => {
    const secret = ["proxy", "secret", "for", "matrix"].join("-");
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
    ).toString("hex");
    const t = bootTestServer({
      prepare: ({ hangarRoot }) =>
        writeFileSync(
          join(hangarRoot, "settings.json"),
          JSON.stringify({
            access: {
              trustedProxy: {
                header: "X-Auth-User",
                hosts: [],
                peers: ["127.0.0.0/8"],
                secretDigest: digest,
              },
            },
          }),
        ),
    });
    try {
      const owner = await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
      const ownerId = snapshotOf(t).owner as string;
      const linked = await openAccess(t.hangarRoot).link(
        { principal: ownerId },
        { subject: "proxy:x-auth-user:ana@example.test", member: "Ana", create: true },
      );
      if (!linked.ok) throw new Error(linked.reason);
      const proxied = (user: string, extra: Record<string, string> = {}): Cred => ({
        name: user,
        headers: { "x-auth-user": user, "crewhaus-proxy-secret": secret, ...extra },
      });
      const unlinked = proxied("stranger@example.test");
      const mismatch = proxied("ana@example.test", bearer(owner.session));
      const wrong: string[] = [];
      for (const row of MATRIX_ROWS) {
        const a = await ask(t, row, unlinked, "hrn_0123456789abcdef");
        if (`${a.status} ${a.body["reason"]}` !== "403 not_invited")
          wrong.push(`${row.key} unlinked`);
        const m = await ask(t, row, mismatch, "hrn_0123456789abcdef");
        if (`${m.status} ${m.body["reason"]}` !== "401 identity_mismatch")
          wrong.push(`${row.key} mismatch`);
      }
      expect(wrong).toEqual([]);
    } finally {
      await t.stop();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Undeclared means unreachable
// ---------------------------------------------------------------------------

describe("a path or method no row declares", () => {
  test("is 404 for the owner and Home's own key alike, and no handler answers it", async () => {
    const { t, creds } = world;
    // An unregistered harness: its handler would answer "no such harness".
    const ghost = "hrn_ffffffffffffffff";
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/api/nope"],
      ["GET", "/api/v1/nope"],
      ["GET", "/api"],
      ["PATCH", "/api/harnesses"],
      ["DELETE", "/api/scan"],
      ["HEAD", "/api/harnesses"],
      ["OPTIONS", "/api/version"],
      ["PATCH", `/api/h/${ghost}`],
      ["GET", `/api/h/${ghost}/nope`],
      ["POST", "/api/runs/sess_00000000000000aa/proof"],
    ];
    for (const cred of [creds["owner"], creds["bootstrap"]] as Cred[]) {
      for (const [method, path] of cases) {
        const res = await t.fetchRaw(path, { method, headers: cred.headers });
        expect(`${cred.name} ${method} ${path}: ${res.status}`).toBe(
          `${cred.name} ${method} ${path}: 404`,
        );
        if (method !== "HEAD") {
          const body = (await res.json()) as Record<string, unknown>;
          expect(body["error"]).toBe("not found");
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Fleet folds: a member of B sees nothing of A
// ---------------------------------------------------------------------------

describe("a harness the caller may not see, and one that is not there", () => {
  test("answer alike for a member, and 404 for the owner", async () => {
    const { t, creds } = world;
    const ghost = "hrn_fffffffffffffffe";
    const asB = await t.fetchRaw(`/api/h/${ghost}`, {
      headers: (creds["memberB"] as Cred).headers,
    });
    const onA = await t.fetchRaw(`/api/h/${world.a}`, {
      headers: (creds["memberB"] as Cred).headers,
    });
    expect([asB.status, onA.status]).toEqual([403, 403]);
    const bodies = [
      (await asB.json()) as Record<string, unknown>,
      (await onA.json()) as Record<string, unknown>,
    ];
    expect(bodies[0]).toEqual(bodies[1]);
    const asOwner = await t.fetchRaw(`/api/h/${ghost}`, {
      headers: (creds["owner"] as Cred).headers,
    });
    expect(asOwner.status).toBe(404);
  });

  // The proof route names no harness in its path: the choke point decides it on the harness
  // `?harness=` names, or on the one holding the run's bundle, and the handler reads that
  // same harness with no check of its own. A change that makes them read different values
  // fails here.
  test("the proof route, for a run with a bundle: decided and answered on one harness", async () => {
    const { t, a, b, aDir, creds } = world;
    // A run of A's with a bundle, under its own id so no matrix row reads it.
    const sess = "sess_00000000000c13b1";
    const marker = "Alpha's refund window is 14 days.";
    const at = join(aDir, ".crewhaus", "proofs", "alpha", sess);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "turn-1.json"), `${JSON.stringify(proofBundle(marker), null, 2)}\n`);
    const ghost = "hrn_fffffffffffffffe";
    const get = async (who: string, query: string) => {
      const res = await t.fetchRaw(`/api/runs/${sess}/proof${query}`, {
        headers: (creds[who] as Cred).headers,
      });
      const text = await res.text();
      return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
    };

    // memberB may not read A. Scoped to A, unscoped, and scoped to an id Home does not
    // have, it hears the refusal one of its own `:id` routes gives on A.
    const onA = await get("memberB", `?harness=${a}`);
    const unscoped = await get("memberB", "");
    const onGhost = await get("memberB", `?harness=${ghost}`);
    const onARow = await t.fetchRaw(`/api/h/${a}/sessions/${sess}`, {
      headers: (creds["memberB"] as Cred).headers,
    });
    expect([onA.status, unscoped.status, onGhost.status, onARow.status]).toEqual([
      403, 403, 403, 403,
    ]);
    const refusal = (await onARow.json()) as Record<string, unknown>;
    expect(refusal["needs"]).toBe("h.read.content");
    for (const answer of [onA, unscoped, onGhost]) expect(answer.body).toEqual(refusal);
    // The owner, who sees every harness, hears that the id is not there.
    expect((await get("owner", `?harness=${ghost}`)).status).toBe(404);

    // A member who reads A's content gets A's bundle, scoped and unscoped.
    for (const query of [`?harness=${a}`, ""]) {
      const answer = await get("viewerA", query);
      expect(answer.status).toBe(200);
      const rows = answer.body["bundles"] as Array<Record<string, unknown>>;
      expect(rows.map((r) => r["harnessId"])).toEqual([a]);
      expect(answer.text).toContain(marker);
    }

    // memberB scoped to its own harness is answered from B alone, which holds no bundle.
    const onB = await get("memberB", `?harness=${b}`);
    expect(onB.status).toBe(404);
    for (const leak of [marker, a, aDir]) expect(onB.text).not.toContain(leak);
    // Naming both, in either order, is decided and answered on the same one of them.
    for (const query of [`?harness=${b}&harness=${a}`, `?harness=${a}&harness=${b}`]) {
      const both = await get("memberB", query);
      expect([403, 404]).toContain(both.status);
      for (const leak of [marker, aDir]) expect(both.text).not.toContain(leak);
    }

    // A token that reads A but not its content is refused, and so is a run's scoped link.
    const service = await get("service", `?harness=${a}`);
    expect([service.status, service.body["reason"]]).toEqual([403, "permission"]);
    const scoped = await get("scoped", `?harness=${a}`);
    expect([scoped.status, scoped.body["reason"]]).toEqual([403, "scoped"]);
  });
});

/** A persisted proof bundle as the gate writes it (provability's `ProofBundle`). */
function proofBundle(claim: string): Record<string, unknown> {
  const hash = `sha256:${"ab".repeat(32)}`;
  return {
    version: 1,
    level: "grounded",
    verdict: "pass",
    score: 1,
    threshold: 1,
    achieved: "grounded",
    claims: [
      {
        index: 0,
        text: claim,
        line: 1,
        status: "met",
        best: "grounded",
        bindings: [
          {
            ref: "[1]",
            kind: "source",
            rung: "grounded",
            ok: true,
            origin: "https://acme.example/policy",
            sha256: hash,
            excerpt: "Customers may request a refund within 14 days.",
          },
        ],
      },
    ],
    claimCount: 1,
    met: 1,
    unmet: 0,
    assumptions: 0,
    sources: 1,
    judgeWaived: 0,
    retryIndex: 0,
    createdAt: "2026-10-21T12:00:00.000Z",
    bundleHash: hash,
  };
}

describe("fleet folds count and quote only what the caller may read", () => {
  const FILTERED = ROUTE_TABLE.filter(
    (row) => row.qualifiers.includes("filtered") && row.method === "GET",
  );

  test("every filtered row is a fleet read", () => {
    expect(FILTERED.map((row) => row.key).sort()).toEqual(
      [
        "activity",
        "advisorFleet",
        "approvals",
        "credentialsMatrix",
        "feedbackFleet",
        "fleetCosts",
        "fleetHealth",
        "groupProcPlan",
        "groups",
        "harnesses",
        "jobs",
        "notifications",
        "onboarding",
        "plugins",
        "pluginPane",
        "readOnly",
        "review",
        "runProof",
        "search",
        "thredzGlobal",
      ].sort(),
    );
  });

  test("a member of B sees no row, count or snippet of A on any filtered row", async () => {
    const { t, a, b, creds } = world;
    const asB = creds["memberB"] as Cred;
    const asOwner = creds["owner"] as Cred;
    // The owner searches first, so the search index holds A's entries before B asks.
    expect((await t.fetchRaw("/api/search?q=a", { headers: asOwner.headers })).status).toBe(200);
    let sawB = 0;
    for (const row of FILTERED) {
      const path = row.key === "search" ? "/api/search?q=a" : pathFor(row, b);
      const res = await t.fetchRaw(path, { headers: asB.headers });
      const text = await res.text();
      expect(`${row.key}: ${text.includes(a)}`).toBe(`${row.key}: false`);
      expect(`${row.key}: ${text.includes("alpha")}`).toBe(`${row.key}: false`);
      if (text.includes(b)) sawB += 1;
    }
    // The member does see B where it has data, so the folds are not simply empty.
    expect(sawB).toBeGreaterThanOrEqual(4);
    const listed = (await t
      .fetchRaw("/api/harnesses", { headers: asB.headers })
      .then((r) => r.json())) as { harnesses: Array<{ id: string }> };
    expect(listed.harnesses.map((h) => h.id)).toEqual([b]);
    const onboarding = (await t
      .fetchRaw("/api/onboarding", { headers: asB.headers })
      .then((r) => r.json())) as Record<string, unknown>;
    const all = (await t
      .fetchRaw("/api/onboarding", { headers: asOwner.headers })
      .then((r) => r.json())) as Record<string, unknown>;
    expect(JSON.stringify(onboarding)).not.toBe(JSON.stringify(all));
    const inbox = (await t
      .fetchRaw("/api/approvals", { headers: asB.headers })
      .then((r) => r.json())) as { approvals: Array<{ harnessId: string }>; pending: number };
    expect(inbox.approvals.map((r) => r.harnessId)).toEqual([b]);
    expect(inbox.pending).toBe(1);
  });

  test("a reader without content access sees that an input exists, not what it says", async () => {
    const { t, a, creds, owner } = world;
    // A service that reads the fleet and A, but not A's content.
    const minted = await openAccess(t.hangarRoot).mintServiceToken(
      { principal: owner },
      { service: "fleet-reader", permissions: ["home.read"], harnesses: [a] },
    );
    if (!minted.ok) throw new Error(minted.reason);
    const reader = bearer(minted.result.secret);
    const inbox = (await t
      .fetchRaw("/api/approvals", { headers: reader })
      .then((r) => r.json())) as { approvals: Array<Record<string, unknown>> };
    expect(inbox.approvals.map((r) => r["harnessId"])).toEqual([a]);
    expect(inbox.approvals[0]?.["input"]).toBeNull();
    expect(inbox.approvals[0]?.["inputWithheld"]).toBe(true);
    expect(JSON.stringify(inbox)).not.toContain("alpha content quoted");
    const review = (await t.fetchRaw("/api/review", { headers: reader }).then((r) => r.json())) as {
      items: Array<Record<string, unknown>>;
    };
    expect(review.items[0]?.["context"]).toBeNull();
    expect(review.items[0]?.["contextWithheld"]).toBe(true);
    // A viewer of A reads both.
    const asViewer = (await t
      .fetchRaw("/api/approvals", { headers: (creds["viewerA"] as Cred).headers })
      .then((r) => r.json())) as { approvals: Array<Record<string, unknown>> };
    expect(asViewer.approvals[0]?.["input"]).toEqual({
      channel: "ops",
      text: "alpha content quoted",
    });
  });
});

// ---------------------------------------------------------------------------
// The people predicate, at every filtered fold's exit
// ---------------------------------------------------------------------------

describe("an item about people is released only by a people domain", () => {
  const PERSON = "home/person/psn_01jc0000000000000000000001";

  test("with no people domain, a marked item is withheld and the answer says so", () => {
    const body = {
      items: [{ id: "x", sensitivity: "people", ref: PERSON }, { id: "y" }],
      open: 2,
    };
    expect(withholdPeople(body, () => false)).toEqual({
      items: [{ id: "y" }],
      open: 2,
      hidden: ["people"],
    });
    expect(withholdPeople({ items: [{ id: "y" }] }, () => false)).toEqual({ items: [{ id: "y" }] });
  });

  test("at the server: a planted review item is withheld, then released by a registered checker", async () => {
    const seen: DomainRequest[] = [];
    let allow = false;
    const people: DomainChecker = (request) => {
      seen.push(request);
      return allow && request.ref !== undefined
        ? { allow: true, grant: "planted-people-rule" }
        : { allow: false, needs: request.permission, role: null };
    };
    const t = bootTestServer({ domains: { people } });
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "people"), {
        specName: "people",
        sessions: [],
        reviewQueue: [
          {
            schemaVersion: 1,
            id: "rev_quarantine_people_s1",
            kind: "quarantine",
            sourceRef: { dataset: "smoke", sampleId: "s1" },
            ts: STAMP,
            status: "open",
            sensitivity: "people",
            ref: PERSON,
          },
        ],
      });
      await register(t, dir);
      const owner = await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
      const first = (await t
        .fetchRaw("/api/review", { headers: bearer(owner.session) })
        .then((r) => r.json())) as Record<string, unknown>;
      expect(first["items"]).toEqual([]);
      expect(first["hidden"]).toEqual(["people"]);
      allow = true;
      const second = (await t
        .fetchRaw("/api/review", { headers: bearer(owner.session) })
        .then((r) => r.json())) as Record<string, unknown>;
      expect((second["items"] as unknown[]).length).toBe(1);
      expect(second["hidden"]).toBeUndefined();
      expect(seen.length).toBeGreaterThanOrEqual(2);
      for (const request of seen) {
        expect(request.permission).toBe("people.derived.read");
        expect(request.ref).toEqual({ kind: "person", id: "psn_01jc0000000000000000000001" });
      }
      // Home's own key is the owner for every core permission, and for no domain's.
      const asKey = (await t.api("/api/review")).body;
      expect(asKey["hidden"]).toEqual(["people"]);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a scoped token reads nothing once its time is up", () => {
    const snapshot = snapshotOf(world.t);
    const exp = Date.parse("2026-11-11T00:15:00.000Z");
    const viewAt = (now: number): AccessView => ({
      read: { state: "present", snapshot },
      now,
      domains: new Map(),
      groupsOf: (id) => (id === world.a || id === world.b ? [] : undefined),
      harnessIds: () => [world.a, world.b],
    });
    const caller: Caller = {
      principal: world.principals["portal"] as string,
      actor: {
        principal: world.principals["portal"] as string,
        credential: world.principals["portalCredential"] as string,
      },
      via: "scoped",
      scoped: { refs: [`${world.a}/run/${RUN_OF_A}`], acts: ["run.events.read"], exp },
    };
    const row = ROUTE_BY_KEY.get("runEvents") as RouteRow;
    const params = { id: world.a, runId: RUN_OF_A };
    expect(authorizeRequest({ row, params, caller, view: viewAt(exp - 1) }).allow).toBe(true);
    const ended = authorizeRequest({ row, params, caller, view: viewAt(exp) });
    expect(ended.allow).toBe(false);
    expect(ended.allow === false ? ended.refusal.reason : undefined).toBe("scoped");
  });

  test("the choke point hands a domain row's object ref to its checker, every time", () => {
    const calls: DomainRequest[] = [];
    const checker: DomainChecker = (request) => {
      calls.push(request);
      return request.ref === undefined
        ? { allow: false, needs: request.permission, role: null }
        : { allow: true, grant: "per-person" };
    };
    const snapshot = snapshotOf(world.t);
    const view: AccessView = {
      read: { state: "present", snapshot },
      now: Date.now(),
      domains: new Map([["people", checker]]),
      groupsOf: () => undefined,
      harnessIds: () => [],
    };
    const caller: Caller = {
      principal: world.owner,
      actor: { principal: world.owner },
      via: "session",
    };
    const row: RouteRow = {
      key: "plantedPerson",
      method: "GET",
      path: "/api/people/:psn",
      permission: "people.derived.read",
      qualifiers: [],
      receipt: "none",
      cliTwin: null,
      ref: { kind: "person", param: "psn" },
    };
    const params = { psn: "psn_01jc0000000000000000000001" };
    expect(authorizeRequest({ row, params, caller, view }).allow).toBe(true);
    const { ref: _ref, ...unnamed } = row;
    expect(authorizeRequest({ row: unnamed, params, caller, view }).allow).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.ref).toEqual({ kind: "person", id: params.psn });
    expect(Object.hasOwn(calls[1] as object, "ref")).toBe(false);
    // Home's own key holds no domain permission, so its checker is never asked.
    const key: Caller = { principal: world.owner, actor: null, via: "bootstrap" };
    expect(authorizeRequest({ row, params, caller: key, view }).allow).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The versioned API: every served operation, through the same choke point
// ---------------------------------------------------------------------------

describe("the versioned API: every served operation, for every role and credential", () => {
  type V1Cred = (typeof CREDS)[number] | "personalA" | "personalReadOnlyA";
  const V1_CREDS: readonly V1Cred[] = [...CREDS, "personalA", "personalReadOnlyA"];
  const extra: Record<string, Cred> = {};

  beforeAll(async () => {
    const { openDeviceRequests } = await import("@crewhaus/access-control");
    const devices = openDeviceRequests(world.t.hangarRoot);
    const collect = async (readOnly: boolean): Promise<string> => {
      const start = await devices.start({ ...(readOnly ? { readOnly: true } : {}) });
      if (!start.ok) throw new Error(start.reason);
      const decided = await devices.decide({
        caller: world.principals["maintainerA"] as string,
        code: start.userCode,
        choice: "allow",
      });
      if (!decided.ok) throw new Error(decided.reason);
      const polled = await devices.poll(start.pollRef);
      if (!polled.ok || polled.state !== "allowed") throw new Error("no personal token");
      return polled.secret;
    };
    extra["personalA"] = { name: "personalA", headers: bearer(await collect(false)) };
    extra["personalReadOnlyA"] = {
      name: "personalReadOnlyA",
      headers: bearer(await collect(true)),
    };
  }, 30_000);

  const credOf = (name: V1Cred): Cred => (world.creds[name] ?? extra[name]) as Cred;

  /** The served operations: a handler answers each. */
  async function servedOps() {
    const { OPERATIONS } = await import("@crewhaus/control-contract");
    const { HOME_AREAS, handlersOf } = await import("./v1/areas");
    const handlers = handlersOf(HOME_AREAS);
    return OPERATIONS.filter((op) => handlers.has(op.id));
  }

  const ULID_SAMPLE = "01m76e6f05hp514w9j4v3qymka";
  function v1PathOf(path: string): string {
    return path.replace(/\{(\w+)\}/g, (_m, name: string) => {
      if (name === "h") return world.a;
      if (name === "ref") return `${world.a}/decision/appr_00000000000000a1`;
      return `${name}_${ULID_SAMPLE}`;
    });
  }

  const DEVICE_APPROVAL = new Set(["auth.device.lookup", "auth.device.decide"]);
  const NOT_FROM_A_TOKEN = new Set(["home.access.manage", "home.settings.manage"]);

  /** The choke point's answer for one operation, from the role matrix. */
  function v1Expected(
    op: { id: string; permission: string; path: string; qualifiers: readonly string[] },
    cred: V1Cred,
  ): string {
    const row = {
      key: op.id,
      permission: op.permission,
      path: op.path.replace("{h}", ":id"),
    } as RouteRow;
    const selfRow = op.qualifiers.includes("self") && op.id.startsWith("access.");
    const isPublic = op.permission === "public";
    const device = DEVICE_APPROVAL.has(op.id);
    const harnessAbout = op.path.includes("{h}") || op.path.includes("{ref}");
    const cmdRow = op.path.includes("{cmd}");
    const member = (
      grants: Grants,
      opts: { personal?: boolean; readOnly?: boolean } = {},
    ): string => {
      if (isPublic) return ALLOW;
      if (device && opts.personal === true) return "403 session_required";
      if (op.permission === "authenticated") return ALLOW;
      const decl = PERMISSION_DECLS[op.permission as keyof typeof PERMISSION_DECLS];
      const capped = (permission: string): boolean =>
        opts.personal === true &&
        (NOT_FROM_A_TOKEN.has(permission) ||
          (opts.readOnly === true &&
            PERMISSION_DECLS[permission as keyof typeof PERMISSION_DECLS].floor !== "viewer"));
      const refuse = "403 permission";
      if (decl.scope === "home") {
        const held = !capped(op.permission) && memberOutcome(row, grants) === ALLOW;
        if (held) return ALLOW;
        // One's own tokens, links and devices: any live grant covers them.
        if (selfRow && Object.values(grants).length > 0) return ALLOW;
        return refuse;
      }
      if (capped(op.permission)) return refuse;
      if (cmdRow) return refuse; // names no receipt this Home has: nothing to authorize against
      if (harnessAbout) return holds(best(grants.home, grants.a), op.permission) ? ALLOW : refuse;
      return [grants.home, grants.a, grants.b].some((role) => holds(role, op.permission))
        ? ALLOW
        : refuse;
    };
    switch (cred) {
      case "owner":
      case "bootstrap":
        return ALLOW;
      case "maintainerA":
        return member({ a: "maintainer" });
      case "operatorA":
        return member({ a: "operator" });
      case "viewerA":
        return member({ a: "viewer" });
      case "memberB":
        return member({ b: "maintainer" });
      case "personalA":
        return member({ a: "maintainer" }, { personal: true });
      case "personalReadOnlyA":
        return member({ a: "maintainer" }, { personal: true, readOnly: true });
      case "service": {
        if (isPublic) return ALLOW;
        if (device) return "403 session_required";
        if (op.permission === "authenticated") return ALLOW;
        if (cmdRow) return "403 permission";
        return op.permission === "h.read" && harnessAbout ? ALLOW : "403 permission";
      }
      case "scoped":
        return isPublic ? ALLOW : "403 scoped";
      case "scopedRevoked":
      case "personal":
        return "401 credential_unknown";
      case "tabOnly":
      case "tabOnlyOwner": {
        if (isPublic) return ALLOW;
        if (NOT_FROM_A_TOKEN.has(op.permission)) return "403 tab_only";
        if (device) return "403 session_required";
        if (op.permission === "authenticated") return ALLOW;
        return member(cred === "tabOnly" ? { home: "viewer" } : { home: "owner" });
      }
      case "tabOnlyElsewhere":
        return "403 tab_only";
      case "forwardedBootstrap":
        return "401 bootstrap_not_accepted_here";
      case "rebindingHost":
        return "421";
      default:
        throw new Error(`no model for ${cred}`);
    }
  }

  function v1OutcomeOf(answer: Answer): string {
    const { status, body } = answer;
    if (status === 421) return "421";
    const error =
      typeof body["error"] === "object" && body["error"] !== null
        ? (body["error"] as Record<string, unknown>)
        : undefined;
    const reason = String(error?.["reason"] ?? body["reason"]);
    if (status === 401) return `401 ${reason}`;
    if (status === 403 && body["code"] === "read_only") return ALLOW;
    if (
      status === 403 &&
      ["permission", "scoped", "tab_only", "session_required"].includes(reason)
    ) {
      return `403 ${reason}`;
    }
    return ALLOW;
  }

  test("the model agrees with hand-written sentinels", async () => {
    const ops = await servedOps();
    const op = (id: string) => ops.find((o) => o.id === id) as (typeof ops)[number];
    const sentinels: Record<string, Partial<Record<V1Cred, string>>> = {
      "controls.pause": {
        operatorA: ALLOW,
        viewerA: "403 permission",
        personalA: ALLOW,
        personalReadOnlyA: "403 permission",
      },
      "access.members.list": {
        owner: ALLOW,
        maintainerA: "403 permission",
        personalA: "403 permission",
      },
      "access.tokens.list": {
        viewerA: ALLOW,
        personalReadOnlyA: ALLOW,
        service: "403 permission",
        tabOnly: "403 tab_only",
      },
      "auth.device.decide": {
        owner: ALLOW,
        maintainerA: ALLOW,
        personalA: "403 session_required",
        service: "403 session_required",
        tabOnly: "403 session_required",
        scoped: "403 scoped",
      },
      "harnesses.get": {
        viewerA: ALLOW,
        memberB: "403 permission",
        service: ALLOW,
        personalReadOnlyA: ALLOW,
      },
      "meta.discover": { scoped: ALLOW, personal: "401 credential_unknown" },
    };
    let checked = 0;
    for (const [id, byCred] of Object.entries(sentinels)) {
      for (const [cred, outcome] of Object.entries(byCred)) {
        expect(`${id} as ${cred}: ${v1Expected(op(id), cred as V1Cred)}`).toBe(
          `${id} as ${cred}: ${outcome}`,
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  for (const cred of V1_CREDS) {
    test(`as ${cred}: every served operation is answered as the role table says`, async () => {
      const ops = await servedOps();
      expect(ops.length).toBeGreaterThanOrEqual(45);
      const wrong: string[] = [];
      for (const op of ops) {
        const res = await world.t.fetchRaw(v1PathOf(op.path), {
          method: op.method,
          headers: { "content-type": "application/json", ...credOf(cred).headers },
          ...(op.method === "GET" ? {} : { body: "{}" }),
        });
        const text = await res.text();
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          body = { text };
        }
        const got = v1OutcomeOf({ status: res.status, body });
        const want = v1Expected(op, cred);
        if (got !== want) wrong.push(`${op.id} ${op.method} ${op.path}: ${got} (want ${want})`);
      }
      expect(wrong).toEqual([]);
    }, 120_000); // ~50 requests through a live server
  }

  test("a personal token may revoke only itself", async () => {
    const { v1Home } = await import("./__test__/v1-home");
    const home = await v1Home();
    try {
      const sam = await home.member("Sam", "viewer");
      const ana = await home.member("Ana", "viewer");
      const other = await home.call("POST", `/api/v1/access/tokens/${ana.credential}/revoke`, {
        body: {},
        secret: sam.secret,
      });
      expect(other.status).toBe(404);
      const own = await home.call("POST", `/api/v1/access/tokens/${sam.credential}/revoke`, {
        body: {},
        secret: sam.secret,
      });
      expect(own.status).toBe(200);
      const after = await home.call("GET", "/api/v1/me", { secret: sam.secret });
      expect(after.status).toBe(401);
      expect((await home.call("GET", "/api/v1/me", { secret: ana.secret })).status).toBe(200);
    } finally {
      await home.t.stop();
    }
  }, 30_000);
});
