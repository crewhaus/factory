/**
 * #400 — the guards on {@link findReplayableGrant}, the lookup that lets a
 * one-shot grant satisfy a MODEL-DRIVEN tool call.
 *
 * Grants are keyed on whole-input equality, which assumes the resumed run
 * re-issues a byte-identical call. It does not: resume re-drives the turn,
 * `sanitizeOrphanToolUses` has stripped the parked `tool_use` from the
 * replayed transcript, and the model generates the call fresh — so any
 * re-worded argument moved the hash, the lookup missed, and the run parked
 * again under a new id. Approve → regenerate → re-park, forever.
 *
 * These pin the conditions that keep the replay from becoming a standing
 * allow. The end-to-end behaviour (the approved input is what RUNS, the model
 * is told, the grant is consumed, policy still outranks it) lives beside the
 * G11 tests it corrects, in `approvals.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { findReplayableGrant } from "./index";

describe("#400 — the guards that keep a replay from becoming a standing allow", () => {
  const base = {
    id: "appr_0123456789abcdef",
    toolName: "notify",
    inputHash: "hash",
    input: { to: "peer", body: "approved" },
    runId: "run_parked",
    sessionId: "sess_a",
    surface: "headless",
    createdAt: "2026-08-12T00:00:00.000Z",
    decision: "grant" as const,
  };
  const where = { toolName: "notify", sessionId: "sess_a", runId: "run_now" };
  const listing = (...records: Array<Record<string, unknown>>) =>
    ({
      persist: async () => {},
      get: async () => null,
      resolve: async () => null,
      list: async () => records,
    }) as unknown as Parameters<typeof findReplayableGrant>[0];

  test("finds the operator's grant for this session + tool", async () => {
    expect((await findReplayableGrant(listing(base), where))?.id).toBe(base.id);
  });

  test("never crosses a SESSION — one conversation's grant is not another's", async () => {
    expect(
      await findReplayableGrant(listing({ ...base, sessionId: "sess_b" }), where),
    ).toBeUndefined();
  });

  test("never crosses a TOOL", async () => {
    expect(
      await findReplayableGrant(listing({ ...base, toolName: "other" }), where),
    ).toBeUndefined();
  });

  test("never spends a grant inside the run that parked it", async () => {
    // Otherwise one approval becomes a tool-wide licence for the turn: park,
    // get granted, then spend it on a second, different call in the same run.
    expect(
      await findReplayableGrant(listing({ ...base, runId: "run_now" }), where),
    ).toBeUndefined();
  });

  test("never reuses a consumed grant, and never honours a deny", async () => {
    expect(
      await findReplayableGrant(
        listing({ ...base, consumedAt: "2026-08-12T01:00:00.000Z" }),
        where,
      ),
    ).toBeUndefined();
    expect(
      await findReplayableGrant(listing({ ...base, decision: "deny" }), where),
    ).toBeUndefined();
  });

  test("refuses to guess when the record carries no input", async () => {
    // `PendingApproval.input` is optional and unvalidated, so a record from an
    // older or foreign writer has nothing to replay. Park, don't guess.
    const { input: _dropped, ...noInput } = base;
    expect(await findReplayableGrant(listing(noInput), where)).toBeUndefined();
  });

  test("a store with no `list` simply never replays (pre-#400 behaviour)", async () => {
    const minimal = {
      persist: async () => {},
      get: async () => null,
      resolve: async () => null,
    } as unknown as Parameters<typeof findReplayableGrant>[0];
    expect(await findReplayableGrant(minimal, where)).toBeUndefined();
  });

  test("newest grant wins when several are outstanding", async () => {
    const older = { ...base, id: "appr_1111111111111111", createdAt: "2026-08-11T00:00:00.000Z" };
    const newer = { ...base, id: "appr_2222222222222222", createdAt: "2026-08-12T12:00:00.000Z" };
    expect((await findReplayableGrant(listing(older, newer), where))?.id).toBe(newer.id);
  });

  test("a store whose list() throws degrades to parking, never to a crash", async () => {
    const broken = {
      persist: async () => {},
      get: async () => null,
      resolve: async () => null,
      list: async () => {
        throw new Error("disk gone");
      },
    } as unknown as Parameters<typeof findReplayableGrant>[0];
    expect(await findReplayableGrant(broken, where)).toBeUndefined();
  });
});
