/**
 * The operator record admits `runs.create` and `runs.continue`: while it closes intake,
 * the gateway answers the verdict's code (503) before the SLO gate, the reservation,
 * the classification, the audit line and the handler. Every other method passes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryBudgetStore } from "@crewhaus/durable-state";
import { EXIT_CODES, RunFailedError } from "@crewhaus/errors";
import { ErrorCode } from "@crewhaus/gateway-protocol";
import { type Tenant, buildTenant } from "@crewhaus/tenancy";
import {
  PAUSED_RETRY_AFTER_SECONDS,
  PROTOCOL_VERSION,
  type RunEventSource,
  createGatewayServer,
  signJwt,
  statusFor,
} from "./index";

// Built from parts so no realistic-shaped credential literal lands in the repo.
const SECRET = ["admission", "test", "signing", "value"].join("-");

let tmp: string;
let harness: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gateway-admission-"));
  harness = join(tmp, "harness");
  mkdirSync(harness);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const OPERATOR = [".crewhaus", "run", "control", "operator.json"];

function writeOperator(body: Record<string, unknown>): void {
  mkdirSync(join(harness, ...OPERATOR.slice(0, -1)), { recursive: true });
  writeFileSync(
    join(harness, ...OPERATOR),
    `${JSON.stringify({ v: 1, rev: 1, desired: "running", ...body })}\n`,
  );
}
const operatorBytes = (): string => readFileSync(join(harness, ...OPERATOR), "utf8");

/** A budget store that counts reservations. */
function countingBudget(): { store: InMemoryBudgetStore; reserves: () => number } {
  const store = new InMemoryBudgetStore();
  let reserves = 0;
  const tryReserve = store.tryReserve.bind(store);
  store.tryReserve = (...args) => {
    reserves += 1;
    return tryReserve(...args);
  };
  return { store, reserves: () => reserves };
}

function admissionServer(over: Partial<Parameters<typeof createGatewayServer>[0]> = {}): {
  server: ReturnType<typeof createGatewayServer>;
  tenant: Tenant;
  handled: string[];
  reserves: () => number;
} {
  const tenant = buildTenant("tenant-a", { tenantsRoot: tmp });
  const handled: string[] = [];
  const budget = countingBudget();
  const server = createGatewayServer({
    jwtSecret: SECRET,
    tenantsRoot: tmp,
    harnessDir: harness,
    budgetStore: budget.store,
    tenantOverrides: { "tenant-a": tenant },
    handler: async ({ method }) => {
      handled.push(method);
      if (method === "runs.cancel") return { ok: true };
      if (method === "sessions.list") return { sessions: [] };
      if (method === "audit.tail") return { records: [] };
      return { runId: "run_x", sessionId: "sess_x", tenantId: "tenant-a" };
    },
    ...over,
  });
  return { server, tenant, handled, reserves: budget.reserves };
}

const bearer = (): string => signJwt({ tenant_id: "tenant-a" }, SECRET);
const envelope = (method: string, params: unknown) => ({
  protocol: PROTOCOL_VERSION,
  id: "1",
  method,
  params,
});
const CREATE = envelope("runs.create", { spec: "s", input: "hello" });
const CONTINUE = envelope("runs.continue", { sessionId: "sess_x", input: "again" });

async function auditCount(
  server: ReturnType<typeof createGatewayServer>,
  tenant: Tenant,
): Promise<number> {
  let n = 0;
  for await (const _ of (await server.getAuditLog(tenant)).read()) n += 1;
  return n;
}

describe("while the operator paused intake", () => {
  test("runs.create and runs.continue answer paused, 503, retryAfter 30, and nothing runs", async () => {
    writeOperator({ intake: { paused: true } });
    const { server, tenant, handled, reserves } = admissionServer();
    for (const body of [CREATE, CONTINUE]) {
      const res = (await server.handle({ bearer: bearer(), body })) as {
        error: { code: string; message: string; data?: { retryAfter?: number } };
      };
      expect(res.error.code).toBe(ErrorCode.Paused);
      expect(res.error.message).toBe("Paused by its operator; this message was not processed.");
      expect(res.error.data).toEqual({ retryAfter: PAUSED_RETRY_AFTER_SECONDS });
      expect(statusFor(res.error.code)).toBe(503);
    }
    expect(PAUSED_RETRY_AFTER_SECONDS).toBe(30);
    expect(handled).toEqual([]);
    expect(reserves()).toBe(0);
    expect(await auditCount(server, tenant)).toBe(0);
  });

  test("a quiet pause says paused by its operator", async () => {
    writeOperator({ intake: { paused: true, notice: null } });
    const { server } = admissionServer();
    const res = (await server.handle({ bearer: bearer(), body: CREATE })) as {
      error: { code: string; message: string };
    };
    expect(res.error).toMatchObject({ code: "paused", message: "paused by its operator" });
  });

  test("over HTTP: status 503 with Retry-After: 30", async () => {
    writeOperator({ intake: { paused: true } });
    const { server } = admissionServer();
    const { port, close } = await server.listen(0, "127.0.0.1");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer()}`, "content-type": "application/json" },
        body: JSON.stringify(CREATE),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("30");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("paused");
    } finally {
      await close();
    }
  });

  test("cancel, sessions and audit reads reach the handler, and a subscribe opens", async () => {
    writeOperator({ intake: { paused: true } });
    const source: RunEventSource = { open: () => ({ replay: [], close: () => undefined }) };
    const { server, handled } = admissionServer({
      resolveRunEvents: () => source,
      closeGraceMs: 0,
    });
    for (const body of [
      envelope("runs.cancel", { runId: "run_x" }),
      envelope("sessions.list", {}),
      envelope("audit.tail", { tenantId: "tenant-a" }),
    ]) {
      const res = (await server.handle({ bearer: bearer(), body })) as { error?: unknown };
      expect(res.error).toBeUndefined();
    }
    expect(handled).toEqual(["runs.cancel", "sessions.list", "audit.tail"]);
    const sub = await server.subscribe({
      bearer: bearer(),
      body: envelope("runs.subscribe", { runId: "run_x" }),
    });
    expect(sub.status).toBe(200);
    await sub.body?.cancel();
  });
});

describe("while the operator disabled the harness", () => {
  test("runs.create answers disabled, 503, with no retryAfter and no Retry-After header", async () => {
    writeOperator({ deployment: { disabled: true } });
    const { server, handled, reserves } = admissionServer();
    const res = (await server.handle({ bearer: bearer(), body: CREATE })) as {
      error: { code: string; message: string; data?: unknown };
    };
    expect(res.error.code).toBe(ErrorCode.Disabled);
    expect(res.error.message).toBe("Disabled by its operator; this message was not processed.");
    expect("data" in res.error).toBe(false);
    expect(statusFor(res.error.code)).toBe(503);
    expect(handled).toEqual([]);
    expect(reserves()).toBe(0);

    const { port, close } = await server.listen(0, "127.0.0.1");
    try {
      const http = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer()}`, "content-type": "application/json" },
        body: JSON.stringify(CREATE),
      });
      expect(http.status).toBe(503);
      expect(http.headers.get("retry-after")).toBeNull();
    } finally {
      await close();
    }
  });
});

describe("the operator record and the SLO gate are independent", () => {
  test("open record, paused SLO gate: 429 budget_exceeded, as the SLO gate answers", async () => {
    const { server } = admissionServer({ intakeGate: () => ({ paused: true }) });
    const res = (await server.handle({ bearer: bearer(), body: CREATE })) as {
      error: { code: string };
    };
    expect(res.error.code).toBe("budget_exceeded");
    expect(statusFor(res.error.code)).toBe(429);
  });

  test("both paused answers paused; the SLO gate opening leaves it paused; the record is never written", async () => {
    writeOperator({ intake: { paused: true } });
    const before = operatorBytes();
    let sloPaused = true;
    let sloReads = 0;
    const { server } = admissionServer({
      intakeGate: () => {
        sloReads += 1;
        return { paused: sloPaused };
      },
    });
    const codeOf = async (): Promise<string> =>
      ((await server.handle({ bearer: bearer(), body: CREATE })) as { error: { code: string } })
        .error.code;
    expect(await codeOf()).toBe("paused");
    sloPaused = false;
    expect(await codeOf()).toBe("paused");
    // Refused before the SLO gate is consulted.
    expect(sloReads).toBe(0);
    expect(operatorBytes()).toBe(before);
  });
});

describe("a loop the runtime refused at its start", () => {
  test("a RunFailedError of class paused or disabled maps to that code, not internal_error", async () => {
    for (const [cls, retry] of [
      ["paused", { retryAfter: 30 }],
      ["disabled", undefined],
    ] as const) {
      const { server } = admissionServer({
        handler: async () => {
          throw new RunFailedError({
            class: cls,
            title: `${cls} by its operator`,
            detail: "the notice",
            exitCode: EXIT_CODES[cls],
          });
        },
      });
      const res = (await server.handle({ bearer: bearer(), body: CREATE })) as {
        error: { code: string; message: string; data?: unknown };
      };
      expect(res.error.code).toBe(cls);
      expect(res.error.message).toBe("the notice");
      expect(res.error.data).toEqual(retry);
    }
  });

  test("the same shape from another copy of @crewhaus/errors maps the same way", async () => {
    const { server } = admissionServer({
      handler: async () => {
        throw Object.assign(new Error("run stopped"), {
          name: "RunFailedError",
          report: { class: "paused", title: "t", detail: "d", exitCode: 39 },
        });
      },
    });
    const res = (await server.handle({ bearer: bearer(), body: CREATE })) as {
      error: { code: string };
    };
    expect(res.error.code).toBe("paused");
  });
});

describe("while the harness's budget period is used up", () => {
  const writeBudgetState = (renewsAt: string): void => {
    mkdirSync(join(harness, ".crewhaus", "run", "control"), { recursive: true });
    writeFileSync(
      join(harness, ".crewhaus", "run", "control", "budget-state.json"),
      `${JSON.stringify({ v: 1, periodId: "month-2026-11-01", exhaustedAt: "2026-11-18T00:00:00.000Z", renewsAt })}\n`,
    );
  };

  test("runs.create answers budget_exceeded, 429, retryAfter to renewal (never the pause default), and nothing runs", async () => {
    const renewsIn = 7_200;
    writeBudgetState(new Date(Date.now() + renewsIn * 1000).toISOString());
    const { server, handled, reserves } = admissionServer();
    const res = (await server.handle({ bearer: bearer(), body: CREATE })) as {
      error: { code: string; message: string; data?: { retryAfter?: number } };
    };
    expect(res.error.code).toBe(ErrorCode.BudgetExceeded);
    expect(statusFor(res.error.code)).toBe(429);
    expect(res.error.message).toContain("budget for this period is used up");
    const retry = res.error.data?.retryAfter ?? 0;
    expect(retry).toBeGreaterThan(PAUSED_RETRY_AFTER_SECONDS);
    expect(retry).toBeLessThanOrEqual(renewsIn);
    expect(handled).toEqual([]);
    expect(reserves()).toBe(0);
  });

  test("a renewed period is open again, with no write", async () => {
    writeBudgetState(new Date(Date.now() - 1000).toISOString());
    const { server, handled } = admissionServer();
    await server.handle({ bearer: bearer(), body: CREATE });
    expect(handled).toEqual(["runs.create"]);
  });

  test("a run's own budget stop answers budget_exceeded, not retryable, with no retryAfter", async () => {
    const { server } = admissionServer({
      handler: async () => {
        throw new RunFailedError({
          class: "crewhaus_budget",
          title: "budget reached",
          detail: "$0.0010 spent ≥ $0.0010 cap",
          exitCode: EXIT_CODES.crewhaus_budget,
        });
      },
    });
    const res = (await server.handle({ bearer: bearer(), body: CREATE })) as {
      error: { code: string; data?: unknown };
    };
    expect(res.error.code).toBe(ErrorCode.BudgetExceeded);
    expect(statusFor(res.error.code)).toBe(429);
    expect(res.error.data).toEqual({ retryable: false });
  });
});
