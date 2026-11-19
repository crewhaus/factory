/**
 * The runtime area's budget operations (#516): the reads answer `{present, note, verb}`
 * and write nothing; a raise needs `h.budget.extend`, which a maintainer holds, an
 * operator does not and no service may; a raise for a period that is over answers 412;
 * and the raise reaches the fold and clears a used-up period's state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { OPERATIONS } from "@crewhaus/control-contract";
import {
  foldBudget,
  openBudgetLedger,
  periodOf,
  readBudgetState,
} from "@crewhaus/control-records/budget";
import { isCredentialKey } from "@crewhaus/spec-patch";
import { type V1Home, v1Home } from "../__test__/v1-home";
import { declaredBudgetPeriod } from "../budget";
import { HOME_AREAS, handlersOf } from "./areas";
import { compiledWithBudget, specTextOf } from "./budget";

const PERIOD = "budget:\n  usd: 5\n  period: {every: month, usd: 10}";

let home: V1Home;
let a: { id: string; dir: string };
let none: { id: string; dir: string };

beforeAll(async () => {
  home = await v1Home();
  a = await home.harness("spend-a", { specExtra: PERIOD });
  none = await home.harness("spend-none");
});
afterAll(async () => {
  await home?.t.stop();
});

/** Every file under a directory with its bytes: what "nothing changed" compares. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(path, readFileSync(path, "latin1"));
    }
  };
  walk(dir);
  return out;
}

const path = (h: string, tail = "") => `/api/v1/harnesses/${h}/budget${tail}`;

describe("the budget operations", () => {
  test("each has a handler, a permission and a twin, and no field reads as a credential", () => {
    const ops = OPERATIONS.filter((op) => op.id.startsWith("budget."));
    expect(ops.map((op) => op.id).sort()).toEqual([
      "budget.extend",
      "budget.get",
      "budget.periods",
    ]);
    const handlers = handlersOf(HOME_AREAS);
    for (const op of ops) {
      expect(handlers.has(op.id)).toBe(true);
      expect(op.permission).not.toBe("");
      expect(op.cliTwin).not.toBeNull();
    }
    for (const field of [
      "usd",
      "reasonCode",
      "expect",
      "periodId",
      "capUsdMicros",
      "extensionsUsdMicros",
      "spentUsdMicros",
      "reservedUsdMicros",
      "unknownCalls",
      "renewsAt",
      "exhausted",
    ]) {
      expect([field, isCredentialKey(field)]).toEqual([field, false]);
    }
  });

  test("without a period: present false, the reason and the verb; nothing written", async () => {
    const before = tree(none.dir);
    const res = await home.call("GET", path(none.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ present: false, verb: "crewhaus budget show" });
    expect(String(res.body["note"])).toContain("No spending limit");
    expect(tree(none.dir)).toEqual(before);
  });

  test("with a period: the fold and the closed periods, and every GET leaves the harness as it was", async () => {
    const before = tree(a.dir);
    const got = await home.call("GET", path(a.id));
    expect(got.status).toBe(200);
    expect(got.body["present"]).toBe(true);
    expect((got.body["fold"] as { capUsdMicros: number }).capUsdMicros).toBe(10_000_000);
    const history = await home.call("GET", path(a.id, "/periods"));
    expect(history.status).toBe(200);
    expect(history.body["present"]).toBe(false);
    expect(tree(a.dir)).toEqual(before);
  });

  test("an operator is refused needing h.budget.extend, and so is a service", async () => {
    const body = { usd: 5, reasonCode: "incident", expect: periodOf(def(), Date.now()).periodId };
    const operator = await home.member("Opal", "operator");
    const asOperator = await home.call("POST", path(a.id, "/extensions"), {
      body,
      secret: operator.secret,
    });
    expect(asOperator.status).toBe(403);
    expect((asOperator.body["error"] as { needs?: string }).needs).toBe("h.budget.extend");
    // No service is ever granted the permission, and one without it is refused.
    await expect(
      home.service("billing", [a.id], { permissions: ["h.budget.extend"] }),
    ).rejects.toThrow("can never hold h.budget.extend");
    const service = await home.service("billing", [a.id], { permissions: ["h.control"] });
    const asService = await home.call("POST", path(a.id, "/extensions"), {
      body,
      secret: service.secret,
    });
    expect(asService.status).toBe(403);
  });

  test("a raise for a period that is over answers 412 with the current one", async () => {
    const res = await home.call("POST", path(a.id, "/extensions"), {
      body: { usd: 5, reasonCode: "incident", expect: "month-2020-01-01" },
    });
    expect(res.status).toBe(412);
    const error = res.body["error"] as { code: string; current?: { periodId: string } };
    expect(error.code).toBe("precondition_failed");
    expect(error.current?.periodId).toBe(periodOf(def(), Date.now()).periodId);
  });

  test("a maintainer's raise reaches the fold and clears a used-up period", async () => {
    const now = Date.now();
    const ledger = openBudgetLedger(a.dir, def());
    await ledger.reserve({ id: "rsv_a", usdMicros: 10 });
    await ledger.settle({ id: "rsv_a", usdMicros: 10_000_000 });
    expect((await ledger.reserve({ id: "rsv_b", usdMicros: 10 })).admit).toBe(false);
    expect(readBudgetState(a.dir).state).toBe("present");
    const maintainer = await home.member("Mae", "maintainer");
    const res = await home.call("POST", path(a.id, "/extensions"), {
      body: { usd: 5, reasonCode: "planned-work", expect: periodOf(def(), now).periodId },
      secret: maintainer.secret,
    });
    expect(res.status).toBe(200);
    expect((res.body["receipt"] as { state: string }).state).toBe("succeeded");
    expect(foldBudget(a.dir, def(), Date.now()).extensionsUsdMicros).toBe(5_000_000);
    expect(readBudgetState(a.dir).state).toBe("absent");
  });

  test("a build older than spending periods answers unsupported, naming compile", () => {
    expect(compiledWithBudget("0.8.3")).toBe(false);
    expect(compiledWithBudget("0.9.0")).toBe(true);
    expect(compiledWithBudget("1.0.0")).toBe(true);
    expect(compiledWithBudget(undefined)).toBeUndefined();
  });
});

function def() {
  const found = declaredBudgetPeriod(specTextOf(a.dir));
  if (found === undefined) throw new Error("the fixture declares no period");
  return found;
}
