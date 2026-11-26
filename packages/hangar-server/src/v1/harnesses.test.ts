/**
 * The v1 overview rows count open decisions as Home's other surfaces do: a tool approval
 * parked in the harness's approvals file counts whether or not a decision log names it.
 * A row's attention counts include the Advisor's findings and carry no decide count when
 * the harness's approvals cannot be read; it names the purpose its spec declares, and one
 * harness's row says what the caller may do there.
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

describe("a harness's row", () => {
  test("its attention counts include the Advisor's findings Home gathered for it", async () => {
    const { advisorSnapshotRecord, advisorSnapshotRel } = await import("@crewhaus/attention");
    const { writeIndexRecord } = await import("@crewhaus/control-records");
    const h = await home.harness("advised");
    const before = await home.call("GET", `/api/v1/harnesses/${h.id}`);
    const counted = (body: Record<string, unknown>) =>
      (body["areas"] as Record<string, Record<string, Record<string, unknown>>> | undefined)?.[
        "attention"
      ]?.["attention"];
    expect(counted(before.body)?.["consider"]).toBe(0);
    const written = writeIndexRecord(
      home.t.hangarRoot,
      advisorSnapshotRel(h.id),
      advisorSnapshotRecord(new Date().toISOString(), [
        {
          id: "evals-none",
          severity: "suggestion",
          title: "No eval has run",
          detail: "",
          explain: "",
          guidance: "",
          screen: "evals",
          source: "evals",
          action: { kind: "link", label: "Open evals", cliTwin: null, jobKind: null },
          status: "open",
        },
      ] as never),
    );
    if (!written.ok) throw new Error(written.reason);
    const got = await home.call("GET", `/api/v1/harnesses/${h.id}`);
    expect(Number(counted(got.body)?.["consider"])).toBeGreaterThanOrEqual(1);
    const listed = await home.call("GET", "/api/v1/harnesses");
    const row = (listed.body["items"] as Array<Record<string, unknown>>).find(
      (r) => r["id"] === h.id,
    );
    expect(Number(counted(row ?? {})?.["consider"])).toBeGreaterThanOrEqual(1);
  });

  test.skipIf(process.platform === "win32")(
    "a harness whose approvals cannot be read has no decide count, never a zero",
    async () => {
      const { rmSync, symlinkSync, mkdtempSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const h = await home.harness("unreachable-approvals");
      const elsewhere = mkdtempSync(join(tmpdir(), "sessions-elsewhere-"));
      rmSync(join(h.dir, ".crewhaus", "sessions"), { recursive: true, force: true });
      symlinkSync(elsewhere, join(h.dir, ".crewhaus", "sessions"));
      try {
        const got = await home.call("GET", `/api/v1/harnesses/${h.id}`);
        expect(got.status).toBe(200);
        const counts = (
          got.body["areas"] as Record<string, Record<string, Record<string, unknown>>>
        )["attention"]?.["attention"];
        expect(counts?.["unreachable"]).toBe(true);
        expect(counts !== undefined && "decide" in counts).toBe(false);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    },
  );

  test("its purpose is the one its spec declares, and absent without one", async () => {
    const declared = await home.harness("with-purpose", {
      specExtra: "intent:\n  purpose: '  Answer support tickets within the hour.  '",
    });
    const none = await home.harness("without-purpose");
    const got = await home.call("GET", `/api/v1/harnesses/${declared.id}`);
    expect(got.body["purpose"]).toBe("Answer support tickets within the hour.");
    const bare = await home.call("GET", `/api/v1/harnesses/${none.id}`);
    expect("purpose" in bare.body).toBe(false);
    const listed = await home.call("GET", "/api/v1/harnesses");
    const row = (listed.body["items"] as Array<Record<string, unknown>>).find(
      (r) => r["id"] === declared.id,
    );
    expect(row?.["purpose"]).toBe("Answer support tickets within the hour.");
    expect(row !== undefined && "you" in row).toBe(false);
  });

  test("one harness says what the caller may do there, as Home's access records allow", async () => {
    const h = await home.harness("you-flags");
    const operator = await home.member("Oscar", "operator", { scope: `harness:${h.id}` });
    const viewer = await home.member("Vera", "viewer", { scope: `harness:${h.id}` });
    const asOperator = await home.call("GET", `/api/v1/harnesses/${h.id}`, {
      secret: operator.secret,
    });
    expect(asOperator.body["you"]).toEqual({
      control: true,
      deploy: false,
      retire: false,
      accessView: false,
      budgetExtend: false,
      delegationPropose: false,
    });
    const asViewer = await home.call("GET", `/api/v1/harnesses/${h.id}`, { secret: viewer.secret });
    expect(asViewer.body["you"]).toEqual({
      control: false,
      deploy: false,
      retire: false,
      accessView: false,
      budgetExtend: false,
      delegationPropose: false,
    });
    const asOwner = await home.call("GET", `/api/v1/harnesses/${h.id}`);
    expect((asOwner.body["you"] as Record<string, boolean>)["retire"]).toBe(true);
  }, 30_000); // two members' device sign-ins
});
