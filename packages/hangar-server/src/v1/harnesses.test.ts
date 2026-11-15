/**
 * The v1 overview rows count open decisions as Home's other surfaces do: a tool approval
 * parked in the harness's approvals file counts whether or not a decision log names it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type V1Home, v1Home } from "../__test__/v1-home";

let home: V1Home;

beforeAll(async () => {
  home = await v1Home();
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

const AT = "2026-11-14T00:00:00.000Z";

describe("a harness's open decisions", () => {
  test("an approval only the approvals file records counts on harnesses.get and harnesses.list", async () => {
    const h = await home.harness("open-decisions", {
      approvals: [
        {
          id: "appr_00000000000000c1",
          toolName: "SendMessage",
          inputHash: "hash-1",
          input: { channel: "ops", text: "ship it" },
          runId: "run_00000000000000c0",
          sessionId: "sess_00000000000000cc",
          surface: "daemon",
          createdAt: AT,
        },
      ],
    });
    const legacy = await home.call("GET", "/api/harnesses");
    const row = (legacy.body["harnesses"] as Array<Record<string, unknown>>).find(
      (r) => r["id"] === h.id,
    );
    expect(row?.["pendingApprovals"]).toBe(1);
    const got = await home.call("GET", `/api/v1/harnesses/${h.id}`);
    expect(got.status).toBe(200);
    expect(got.body["openDecisions"]).toBe(1);
    const listed = await home.call("GET", "/api/v1/harnesses");
    const item = (listed.body["items"] as Array<Record<string, unknown>>).find(
      (r) => r["id"] === h.id,
    );
    expect(item?.["openDecisions"]).toBe(row?.["pendingApprovals"]);
  });

  test("a harness with nothing parked has none", async () => {
    const h = await home.harness("no-decisions");
    const got = await home.call("GET", `/api/v1/harnesses/${h.id}`);
    expect(got.body["openDecisions"]).toBe(0);
  });
});
