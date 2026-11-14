/**
 * The route table is the console's route map plus the routes the map never names, one
 * row per method and path. These tests hold it to `routes.js` and to the server's M3
 * table, so a route added in one place and not the other fails here.
 */
import { describe, expect, test } from "bun:test";
import {
  COMMAND_KINDS,
  PERMISSIONS,
  PERMISSION_DECLS,
  SCOPED_ACTS,
  isCommandKind,
  isPermission,
} from "@crewhaus/control-contract";
import { M3_ROUTES, PARAM_GUARDS } from "./m3-routes";
import { matchRequest } from "./route-match";
import {
  OFF_MAP_KEYS,
  OFF_MAP_OUTSIDE_API,
  ROUTE_BY_KEY,
  ROUTE_TABLE,
  type RouteRow,
  badScopedRows,
  domainRowsWithoutRef,
  matchRoute,
} from "./route-table";

type RouteDef = { readonly method: string; readonly path: string; readonly group?: string };

async function loadRoutes(): Promise<Record<string, RouteDef>> {
  const url = new URL("../../hangar-ui/assets/js/routes.js", import.meta.url).href;
  const mod = (await import(url)) as { ROUTES: Record<string, RouteDef> };
  return mod.ROUTES;
}

const keysOf = (row: { key: string; aliases?: readonly string[] }) => [
  row.key,
  ...(row.aliases ?? []),
];

describe("the route table", () => {
  test("every console route has exactly one row, under its key, method and path", async () => {
    const routes = await loadRoutes();
    expect(Object.keys(routes)).toHaveLength(267);
    for (const [key, route] of Object.entries(routes)) {
      const row = ROUTE_BY_KEY.get(key);
      if (row === undefined) throw new Error(`no row for ${key}`);
      expect(`${key} ${row.method} ${row.path}`).toBe(`${key} ${route.method} ${route.path}`);
    }
    const allKeys = ROUTE_TABLE.flatMap(keysOf);
    expect(new Set(allKeys).size).toBe(allKeys.length);
    expect(allKeys).toHaveLength(267 + OFF_MAP_KEYS.length);
    const pairs = ROUTE_TABLE.map((row) => `${row.method} ${row.path}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  test("every row is a console route or a named off-map one", async () => {
    const routes = await loadRoutes();
    for (const key of ROUTE_TABLE.flatMap(keysOf)) {
      expect(Object.hasOwn(routes, key) || OFF_MAP_KEYS.includes(key)).toBe(true);
    }
    for (const key of OFF_MAP_KEYS) {
      expect(Object.hasOwn(routes, key)).toBe(false);
      expect(ROUTE_BY_KEY.has(key)).toBe(true);
    }
    expect(OFF_MAP_KEYS).toEqual([
      "setGroupsAll",
      "removeGroup",
      "scanRoots",
      "removeScanRoot",
      "fleetCosts",
      "runProof",
    ]);
    expect(OFF_MAP_OUTSIDE_API.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /healthz",
      "GET /boot/:nonce",
    ]);
  });

  test("the server's M3 table is inside it", () => {
    expect(M3_ROUTES.length).toBeGreaterThanOrEqual(150);
    for (const route of M3_ROUTES) {
      const row = ROUTE_BY_KEY.get(route.key);
      expect(`${row?.method} ${row?.path}`).toBe(`${route.method} ${route.path}`);
    }
  });

  test("every permission is one the contract composes, or public or authenticated", () => {
    const known = new Set<string>([...PERMISSIONS, "public", "authenticated"]);
    const unknown = ROUTE_TABLE.filter((row) => !known.has(row.permission)).map((row) => row.key);
    expect(unknown).toEqual([]);
  });

  test("every read writes nothing, and a write that writes nothing says why", () => {
    for (const row of ROUTE_TABLE) {
      if (row.method === "GET") {
        expect(`${row.key}:${row.receipt}`).toBe(`${row.key}:none`);
        expect(row.kind).toBeUndefined();
      } else if (row.receipt === "none") {
        expect(row.noReceiptReason?.length ?? 0).toBeGreaterThan(5);
      }
    }
    const reads = ROUTE_TABLE.filter((row) => row.method !== "GET" && row.receipt === "none");
    expect(reads.map((row) => row.key).sort()).toEqual(
      [
        "auditVerify",
        "authAcceptInvite",
        "authExchange",
        "authRefresh",
        "authSession",
        "authSignOut",
        "bootTicket",
        "datasetAudit",
        "datasetLint",
        "datasetVerify",
        "evalPlan",
        "justificationPreflight",
        "memoryRecall",
        "securityCorpusCheck",
        "specDiff",
        "thredzTraverse",
        "thredzViewExecute",
      ].sort(),
    );
  });

  test("a harness receipt names its harness; Home-level writes go to Home's ledger", () => {
    for (const row of ROUTE_TABLE.filter((r) => r.receipt === "harness")) {
      expect(`${row.key}:${row.path.includes("/:id")}`).toBe(`${row.key}:true`);
    }
    for (const row of ROUTE_TABLE.filter((r) => r.receipt !== "none" && !r.path.includes("/:id"))) {
      expect(`${row.key}:${row.receipt}`).toBe(`${row.key}:workspace`);
    }
    const registryEdits = ["setHidden", "setGroups", "setTags", "setPin", "setNotes", "relocate"];
    for (const key of [...registryEdits, "removeHarness"]) {
      expect(ROUTE_BY_KEY.get(key)?.receipt).toBe("workspace");
    }
  });

  test("a receipt's kind is a core kind with the row's permission, or the row's own legacy kind", () => {
    const core = ROUTE_TABLE.filter(
      (row) => row.kind !== undefined && !row.kind.startsWith("legacy."),
    );
    expect(core.map((row) => `${row.key}=${row.kind}`).sort()).toEqual(
      [
        "controlDrain=controls.drain",
        "denyApproval=decisions.resolve",
        "deploymentActivate=deployments.activate",
        "grantApproval=decisions.resolve",
        "procDrain=controls.drain",
        "procRestart=controls.restart",
        "procStart=controls.start",
        "procStop=controls.stop",
      ].sort(),
    );
    const kinds = COMMAND_KINDS as Readonly<Record<string, { permission: string }>>;
    for (const row of core) {
      expect(kinds[row.kind as string]?.permission).toBe(row.permission);
    }
    for (const row of ROUTE_TABLE.filter((r) => r.kind?.startsWith("legacy."))) {
      expect(row.kind).toBe(`legacy.${row.key}`);
      expect(isCommandKind(row.kind)).toBe(true);
      expect(row.idempotent).toBe(row.method === "PUT" || row.method === "DELETE");
    }
    for (const row of ROUTE_TABLE.filter((r) => r.receipt !== "none")) {
      expect(row.kind).toBeDefined();
    }
  });

  test("the legacy kinds are a closed list: one per receipted route without a core kind", () => {
    const legacy = ROUTE_TABLE.flatMap((row) =>
      row.kind?.startsWith("legacy.") === true ? [row.kind] : [],
    );
    expect(new Set(legacy).size).toBe(legacy.length);
    expect(legacy.length).toBe(ROUTE_TABLE.filter((row) => row.receipt !== "none").length - 8);
    expect(legacy.length).toBeGreaterThanOrEqual(100);
  });

  test("a CLI twin is a core kind's own, and nothing else has one", () => {
    const kinds = COMMAND_KINDS as Readonly<Record<string, { cliTwin: unknown }>>;
    for (const row of ROUTE_TABLE) {
      if (row.kind !== undefined && !row.kind.startsWith("legacy.")) {
        expect(row.cliTwin).toEqual(kinds[row.kind]?.cliTwin as never);
        expect(row.cliTwin).not.toBeNull();
      } else {
        expect(row.cliTwin).toBeNull();
      }
    }
  });

  test("job routes are writes, and credential writes name their secret fields", () => {
    const jobs = ROUTE_TABLE.filter((row) => row.dispatch === "job");
    expect(jobs.length).toBeGreaterThanOrEqual(30);
    for (const row of jobs) expect(row.receipt).toBe("harness");
    expect(ROUTE_BY_KEY.get("submitJob")?.dispatch).toBe("job");
    expect(ROUTE_BY_KEY.get("evalLaunch")?.dispatch).toBe("job");
    expect(ROUTE_BY_KEY.get("envSet")?.secretFields).toEqual(["value"]);
    expect(ROUTE_BY_KEY.get("credentialsSetAcross")?.secretFields).toEqual(["value"]);
    expect(ROUTE_BY_KEY.get("mcpConnectorWrite")?.secretFields).toEqual(["env", "headers"]);
  });

  test("matchRoute finds each row for a path of its own, literal before parameter", () => {
    for (const row of ROUTE_TABLE) {
      const segments = row.path
        .split("/")
        .filter((s) => s !== "")
        .map((s) => (s === ":id" ? "hrn_0123456789abcdef" : s.startsWith(":") ? "sample-1" : s));
      expect(`${row.method} ${row.path} -> ${matchRoute(row.method, segments)?.row.key}`).toBe(
        `${row.method} ${row.path} -> ${row.key}`,
      );
    }
    const evals = ["api", "h", "hrn_0123456789abcdef", "evals", "matrix"];
    expect(matchRoute("GET", evals)?.row.key).toBe("evalMatrix");
    expect(matchRoute("GET", [...evals.slice(0, 4), "run_0123456789abcdef"])?.row.key).toBe(
      "evalRun",
    );
    expect(matchRoute("GET", ["api", "nowhere"])).toBeUndefined();
    expect(matchRoute("PATCH", ["api", "version"])).toBeUndefined();
    expect(matchRoute("GET", evals, (row) => row.key !== "evalMatrix")?.row.key).toBe("evalRun");
  });

  test("every row whose permission is a domain's names the object it is about", () => {
    expect(domainRowsWithoutRef(ROUTE_TABLE)).toEqual([]);
    const planted: RouteRow = {
      key: "plantedPerson",
      method: "GET",
      path: "/api/people/:psn",
      permission: "people.derived.read",
      qualifiers: [],
      receipt: "none",
      cliTwin: null,
    };
    expect(domainRowsWithoutRef([...ROUTE_TABLE, planted])).toEqual(["plantedPerson"]);
    expect(
      domainRowsWithoutRef([...ROUTE_TABLE, { ...planted, ref: { kind: "person", param: "psn" } }]),
    ).toEqual([]);
  });

  test("a decision row's receipt names the decision, by a parameter of its own path", () => {
    const resolving = ROUTE_TABLE.filter((row) => row.kind === "decisions.resolve");
    expect(resolving.map((row) => row.key).sort()).toEqual(["denyApproval", "grantApproval"]);
    for (const row of resolving) {
      expect(row.receiptRef).toEqual({ kind: "decision", param: "apprId" });
    }
    const named = ROUTE_TABLE.filter((row) => row.receiptRef !== undefined);
    expect(named.length).toBeGreaterThanOrEqual(2);
    for (const row of named) {
      expect([row.key, row.path.split("/").includes(`:${row.receiptRef?.param}`)]).toEqual([
        row.key,
        true,
      ]);
      expect([row.key, row.receipt]).toEqual([row.key, "harness"]);
    }
  });

  test("a scoped act is one of the closed list, on a GET that names its run", () => {
    expect(badScopedRows(ROUTE_TABLE)).toEqual([]);
    const scoped = ROUTE_TABLE.filter((row) => row.scopedAct !== undefined);
    expect(scoped.map((row) => `${row.key}=${row.scopedAct}`).sort()).toEqual([
      "run=run.result.read",
      "runEvents=run.events.read",
    ]);
    for (const row of scoped) {
      expect((SCOPED_ACTS as readonly string[]).includes(row.scopedAct as string)).toBe(true);
      expect(row.ref).toEqual({ kind: "run", param: "runId" });
    }
    const run = ROUTE_BY_KEY.get("run") as RouteRow;
    expect(badScopedRows([{ ...run, key: "w", method: "POST" }])).toEqual(["w"]);
    expect(badScopedRows([{ ...run, key: "n", scopedAct: "run.events.write" }])).toEqual(["n"]);
    const { ref: _ref, ...noRef } = run;
    expect(badScopedRows([{ ...noRef, key: "r" }])).toEqual(["r"]);
  });

  test("the rows that carry a harness permission and name no harness are computed, not copied", () => {
    const fleet = ROUTE_TABLE.filter(
      (row) =>
        !row.path.includes("/:id") &&
        isPermission(row.permission) &&
        PERMISSION_DECLS[row.permission].scope === "harness",
    ).map((row) => row.key);
    expect(fleet.sort()).toEqual(
      ["credentialsSetAcross", "groupProc", "mcpCatalog", "runProof", "wizardTemplates"].sort(),
    );
  });

  test("the one matcher finds every row for a path of its own, as the receipts middleware does", () => {
    const sample = (name: string): string => {
      if (name === "id") return "hrn_0123456789abcdef";
      if (name === "runId") return "run_0123456789abcdef";
      if (name === "optRunId") return "opt_0123456789abcdef";
      return "sample-1";
    };
    for (const row of ROUTE_TABLE) {
      const segments = row.path
        .split("/")
        .filter((s) => s !== "")
        .map((s) => (s.startsWith(":") ? sample(s.slice(1)) : s));
      const guard = Object.entries(PARAM_GUARDS).find(
        ([name, ok]) => row.path.includes(`:${name}`) && !ok(sample(name)),
      );
      if (guard !== undefined) continue;
      expect(`${row.method} ${row.path} -> ${matchRequest(row.method, segments)?.row.key}`).toBe(
        `${row.method} ${row.path} -> ${row.key}`,
      );
    }
    expect(matchRequest("GET", ["api", "nope"])).toBeUndefined();
    expect(matchRequest("GET", ["api", "v1", "nope"])).toBeUndefined();
    expect(matchRequest("GET", ["api"])).toBeUndefined();
    expect(matchRequest("HEAD", ["api", "harnesses"])).toBeUndefined();
    expect(matchRequest("OPTIONS", ["api", "harnesses"])).toBeUndefined();
    expect(matchRequest("PATCH", ["api", "harnesses"])).toBeUndefined();
  });
});
