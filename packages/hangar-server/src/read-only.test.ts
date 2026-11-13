/**
 * HM-187 — read-only mode.
 *
 * The point of this suite is the sentence "a UI-only toggle is decoration":
 * the refusals below come from the SERVER, on routes no button was clicked
 * on, including one M3 route picked at random from the dispatch table so the
 * guard is proven to sit ahead of the whole surface rather than beside the
 * handful of writes someone remembered.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import { M3_ROUTES } from "./m3-routes";
import { ROUTE_BY_KEY, ROUTE_TABLE, type RouteRow } from "./route-table";
import { READ_ONLY_EXEMPT, isReadOnlyRefused, readOnlyExempt, readOnlyRefusal } from "./settings";
import { bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");

describe("isReadOnlyRefused", () => {
  const row = (key: string) => ROUTE_BY_KEY.get(key) as RouteRow;

  test("it decides by the row's receipt: what changes something is refused, what reads is answered", () => {
    expect(isReadOnlyRefused(row("harnesses"))).toBe(false);
    expect(isReadOnlyRefused(row("addHarness"))).toBe(true);
    expect(isReadOnlyRefused(row("setPin"))).toBe(true);
    expect(isReadOnlyRefused(row("removeHarness"))).toBe(true);
    // A POST that only reads writes no receipt, so it is answered.
    for (const key of ["memoryRecall", "evalPlan", "specDiff", "datasetVerify", "bootTicket"]) {
      expect(`${key}:${isReadOnlyRefused(row(key))}`).toBe(`${key}:false`);
    }
    // The toggle itself, by its exact template.
    expect(isReadOnlyRefused(row("setReadOnly"))).toBe(false);
    expect(READ_ONLY_EXEMPT).toEqual(new Set(["PUT /api/read-only"]));
  });

  test("every row that writes a receipt is refused, except the toggle, and every other row answers", () => {
    for (const r of ROUTE_TABLE) {
      const expected = r.receipt !== "none" && r.key !== "setReadOnly";
      expect(`${r.key}:${isReadOnlyRefused(r)}`).toBe(`${r.key}:${expected}`);
    }
  });

  test("the answered list is derived from the table: every non-GET row that writes no receipt", () => {
    const exempt = readOnlyExempt();
    expect(exempt).toContain("POST /api/h/:id/memory/recall");
    expect(exempt).toContain("PUT /api/read-only");
    expect(exempt).not.toContain("POST /api/scan");
    expect(exempt).toEqual(
      ROUTE_TABLE.filter(
        (r) => r.method !== "GET" && (r.receipt === "none" || r.key === "setReadOnly"),
      )
        .map((r) => `${r.method} ${r.path}`)
        .sort(),
    );
  });

  test("the refusal names the mode and the way out", () => {
    const body = readOnlyRefusal("POST", "/api/scan");
    expect(body["code"]).toBe("read_only");
    expect(String(body["remedy"])).toContain("read-only");
    expect(READ_ONLY_EXEMPT.size).toBeLessThanOrEqual(4);
  });
});

describe("the server refuses mutating requests while engaged", () => {
  test("every write 403s — registry, process control, and an M3 route alike — while reads keep answering", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = join(t.harnessesRoot, "demoed");
      makeFixtureHarness(dir, { specName: "demoed" });
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (added.body["entry"] as { id: string }).id;

      const engaged = await t.api("/api/read-only", {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
      expect(engaged.status).toBe(200);
      expect(engaged.body["enabled"]).toBe(true);
      expect(t.server.readOnly()).toBe(true);

      const writes: ReadonlyArray<readonly [string, string, unknown]> = [
        ["POST", "/api/scan", {}],
        ["POST", "/api/harnesses", { dir }],
        ["PUT", `/api/h/${id}/pin`, { pinned: true }],
        ["POST", `/api/h/${id}/proc/start`, {}],
        ["POST", `/api/h/${id}/jobs`, { kind: "doctor" }],
        ["DELETE", `/api/h/${id}`, undefined],
        ["PUT", "/api/notifications", { mutedGroups: [] }],
      ];
      for (const [method, path, body] of writes) {
        const res = await t.api(path, {
          method,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        expect(`${method} ${path}:${res.status}`).toBe(`${method} ${path}:403`);
        expect(res.body["code"]).toBe("read_only");
      }

      // …and one M3 write, straight out of the dispatch table: the guard is
      // ahead of the table, not sprinkled through the handlers.
      const m3Write = M3_ROUTES.find((r) => r.method === "POST" && r.path.includes(":id"));
      expect(m3Write).toBeDefined();
      const m3Path = (m3Write?.path ?? "")
        .replace(/:id/g, id)
        .replace(/:[A-Za-z][A-Za-z0-9]*/g, "x");
      const m3 = await t.api(m3Path, { method: "POST", body: "{}" });
      expect(m3.status).toBe(403);

      // Reads are untouched.
      expect((await t.api("/api/harnesses")).status).toBe(200);
      expect((await t.api(`/api/h/${id}`)).status).toBe(200);
      expect((await t.api("/api/activity")).status).toBe(200);

      // …and the entry the DELETE would have removed is still registered.
      expect((await t.api(`/api/h/${id}`)).body["missing"]).toBe(false);

      const lifted = await t.api("/api/read-only", {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      });
      expect(lifted.body["enabled"]).toBe(false);
      expect((await t.api("/api/scan", { method: "POST", body: "{}" })).status).toBe(200);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a manager started with the mode LOCKED refuses the un-toggle and names the restart", async () => {
    const t = bootTestServer({ now: () => NOW, readOnlyLocked: true });
    try {
      const state = await t.api("/api/read-only");
      expect(state.body["enabled"]).toBe(true);
      expect(state.body["locked"]).toBe(true);

      const attempt = await t.api("/api/read-only", {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      });
      expect(attempt.status).toBe(409);
      expect(attempt.body["reason"]).toBe("locked");
      expect(String(attempt.body["remedy"])).toContain("restart");
      expect(t.server.readOnly()).toBe(true);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("the mode survives a restart of the manager (it is persisted settings, not a flag)", async () => {
    const first = bootTestServer({ now: () => NOW });
    const hangarRoot = first.hangarRoot;
    const registryRoot = first.registryRoot;
    try {
      await first.api("/api/read-only", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    } finally {
      await first.server.stop();
    }
    // A second manager over the SAME hangar root reads the same settings.
    const { startHangarServer } = await import("./server");
    const second = startHangarServer({ port: 0, root: hangarRoot, registryRoot, noAuth: true });
    try {
      expect(second.readOnly()).toBe(true);
      const res = await fetch(`${second.url}/api/scan`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      expect(res.status).toBe(403);
    } finally {
      await second.stop();
      await first.stop();
    }
  }, 20_000);
});

describe("the boot flag is a posture, not a preference", () => {
  test("--read-only engages this process but is NOT persisted for the next one", async () => {
    const first = bootTestServer({ now: () => NOW, readOnly: true });
    const hangarRoot = first.hangarRoot;
    const registryRoot = first.registryRoot;
    try {
      expect(first.server.readOnly()).toBe(true);
      expect((await first.api("/api/scan", { method: "POST", body: "{}" })).status).toBe(403);
    } finally {
      await first.server.stop();
    }
    // A plain restart over the SAME hangar root is writable again: a demo
    // posture must not survive as a mystery.
    const { startHangarServer } = await import("./server");
    const second = startHangarServer({ port: 0, root: hangarRoot, registryRoot, noAuth: true });
    try {
      expect(second.readOnly()).toBe(false);
      const res = await fetch(`${second.url}/api/scan`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      expect(res.status).toBe(200);
    } finally {
      await second.stop();
      await first.stop();
    }
  }, 20_000);

  test("an explicit toggle during a --read-only session takes effect immediately", async () => {
    const t = bootTestServer({ now: () => NOW, readOnly: true });
    try {
      expect(t.server.readOnly()).toBe(true);
      await t.api("/api/read-only", { method: "PUT", body: JSON.stringify({ enabled: false }) });
      expect(t.server.readOnly()).toBe(false);
      expect((await t.api("/api/scan", { method: "POST", body: "{}" })).status).toBe(200);
    } finally {
      await t.stop();
    }
  }, 20_000);
});

describe("the read-only refusal names the remedy that actually applies", () => {
  // Two modes, two remedies. Naming the wrong one sends an operator to
  // restart a manager they could have toggled over the wire — or to toggle
  // one that will refuse the toggle.
  test("an unlocked refusal offers the toggle; a locked one demands the restart", () => {
    const unlocked = readOnlyRefusal("POST", "/api/h/x/proc/start", false);
    expect(String(unlocked["remedy"])).toContain("PUT /api/read-only");
    expect(String(unlocked["remedy"])).not.toContain("restart");
    expect(unlocked["locked"]).toBe(false);

    const locked = readOnlyRefusal("POST", "/api/h/x/proc/start", true);
    expect(String(locked["remedy"])).toContain("--read-only-locked");
    expect(String(locked["remedy"])).toContain("restart");
    expect(locked["locked"]).toBe(true);
  });
});
