import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import {
  type ApproverProjection,
  type DecisionRecordView,
  type VerifyConsumer,
  mintId,
  verifyDecision,
} from "@crewhaus/control-contract";
import { type ApproverRead, createApproverReader } from "./approvers";
import { _setIoTapForTest } from "./io";
import { controlFile, jsonLine, plant, removeTempDirs, tempDir } from "./test-helpers";

afterEach(() => _setIoTapForTest(undefined));
afterAll(removeTempDirs);

const OWNER = mintId("prn");
const MEMBER = mintId("prn");
const STRANGER = mintId("prn");
const PROJECTION: ApproverProjection = {
  v: 1,
  epoch: 4,
  generatedAt: "2026-11-07T00:00:00.000Z",
  harness: "hrn_0123456789abcdef",
  owner: OWNER,
  governedSince: "2026-11-01T00:00:00.000Z",
  members: [{ principal: MEMBER, decide: "operator" }],
  links: [{ external: "github:12345", principal: MEMBER }],
};

function reader(): (dir: string) => ApproverRead {
  let t = 0;
  return createApproverReader({
    now: () => {
      t += 10_000;
      return t;
    },
  });
}

function harnessWith(body: unknown): string {
  const root = tempDir();
  plant(controlFile(root, "approvers.json"), jsonLine(body));
  return root;
}

const UNREADABLE: Readonly<Record<string, (root: string) => void>> = {
  empty: (root) => plant(controlFile(root, "approvers.json"), ""),
  torn: (root) => plant(controlFile(root, "approvers.json"), '{"v":1,"epoch"'),
  "bad JSON": (root) => plant(controlFile(root, "approvers.json"), "not json\n"),
  "v 2": (root) => plant(controlFile(root, "approvers.json"), jsonLine({ ...PROJECTION, v: 2 })),
  "over the cap": (root) =>
    plant(
      controlFile(root, "approvers.json"),
      jsonLine({ ...PROJECTION, pad: "x".repeat(1024 * 1024) }),
    ),
  link: (root) => {
    const target = controlFile(root, "elsewhere.json");
    plant(target, jsonLine(PROJECTION));
    symlinkSync(target, controlFile(root, "approvers.json"));
  },
  directory: (root) => mkdirSync(controlFile(root, "approvers.json"), { recursive: true }),
  "a file where its directory goes": (root) => plant(controlFile(root), "not a directory"),
};

const BAD_BODIES: Readonly<Record<string, unknown>> = {
  "a negative epoch": { ...PROJECTION, epoch: -1 },
  "a fractional epoch": { ...PROJECTION, epoch: 1.5 },
  "no generatedAt": { ...PROJECTION, generatedAt: undefined },
  "no governedSince": { ...PROJECTION, governedSince: undefined },
  "a malformed harness": { ...PROJECTION, harness: "hrn_short" },
  "a malformed owner": { ...PROJECTION, owner: "prn_bad" },
  "members not an array": { ...PROJECTION, members: {} },
  "links not an array": { ...PROJECTION, links: "none" },
  "a member that is not an object": { ...PROJECTION, members: [1] },
  "a malformed member principal": {
    ...PROJECTION,
    members: [{ principal: "prn_bad", decide: "operator" }],
  },
  "an unknown decide class": { ...PROJECTION, members: [{ principal: MEMBER, decide: "viewer" }] },
  "a link that is not an object": { ...PROJECTION, links: [null] },
  "a malformed link principal": {
    ...PROJECTION,
    links: [{ external: "github:12345", principal: "prn_bad" }],
  },
  "a malformed link subject": {
    ...PROJECTION,
    links: [{ external: "someone", principal: MEMBER }],
  },
  "a local actor as a link": {
    ...PROJECTION,
    links: [{ external: "local:max@laptop", principal: MEMBER }],
  },
};

const GRANT: DecisionRecordView = {
  id: "appr_0123456789abcdef",
  createdAt: "2026-11-02T00:00:00.000Z",
  toolName: "Bash",
  inputHash: "h",
  runId: "run_abcd1234",
  sessionId: "sess_0123456789abcdef",
  surface: "daemon",
  decision: "grant",
  decidedAt: "2026-11-02T00:00:00.000Z",
  decidedByPrincipal: MEMBER,
};
const CONSUMER: VerifyConsumer = {
  runId: "run_abcd1234",
  resumeScope: "session:sess_0123456789abcdef",
};

function verify(approvers: ApproverRead, decision: DecisionRecordView = GRANT) {
  return verifyDecision({
    decision,
    consumer: CONSUMER,
    approvers,
    now: Date.parse("2026-11-07T00:00:00.000Z"),
  });
}

describe("readApproverProjection", () => {
  test("absent is single-owner mode, and a decision stands", () => {
    const read = reader()(tempDir());
    expect(read).toEqual({ state: "absent" });
    expect(verify(read)).toEqual({ ok: true });
  });

  test("present is enforced: a member may decide, a stranger may not", () => {
    const read = reader()(harnessWith(PROJECTION));
    expect(read).toEqual({ state: "present", projection: PROJECTION });
    expect(verify(read)).toEqual({ ok: true });
    expect(verify(read, { ...GRANT, decidedByPrincipal: STRANGER })).toMatchObject({
      ok: false,
      reason: "decider-not-authorized",
    });
  });

  test("the type's governedSince reaches the check, as a real projection's must", () => {
    const read = reader()(harnessWith(PROJECTION));
    const { decidedByPrincipal: _gone, ...legacy } = GRANT;
    expect(verify(read, { ...legacy, decidedAt: "2026-10-01T00:00:00.000Z" })).toEqual({
      ok: true,
    });
    expect(verify(read, { ...legacy, decidedAt: "2026-11-02T00:00:00.000Z" })).toMatchObject({
      ok: false,
      reason: "decider-unverified",
    });
  });

  test("an unknown key survives on the answer, so a later field passes through", () => {
    const read = reader()(harnessWith({ ...PROJECTION, homeUrl: "https://example.test/home" }));
    if (read.state !== "present") throw new Error(read.state);
    expect((read.projection as unknown as Record<string, unknown>)["homeUrl"]).toBe(
      "https://example.test/home",
    );
  });

  test("every decision class is accepted", () => {
    for (const decide of ["operator", "maintainer", "owner"]) {
      const read = reader()(
        harnessWith({ ...PROJECTION, members: [{ principal: MEMBER, decide }] }),
      );
      expect(read.state).toBe("present");
    }
  });

  for (const [form, make] of Object.entries(UNREADABLE)) {
    test(`${form} is unreadable, and a consume is refused`, () => {
      const root = tempDir();
      make(root);
      const read = reader()(root);
      expect(read.state).toBe("unreadable");
      expect(verify(read)).toMatchObject({ ok: false, reason: "approvers-unreadable" });
    });
  }

  for (const [form, body] of Object.entries(BAD_BODIES)) {
    test(`${form} is unreadable, and a consume is refused`, () => {
      const read = reader()(harnessWith(body));
      expect(read.state).toBe("unreadable");
      if (read.state !== "unreadable") throw new Error(read.state);
      expect(read.reason).toContain("approvers.json");
      expect(verify(read)).toMatchObject({ ok: false, reason: "approvers-unreadable" });
    });
  }

  test("a good projection followed by padding past the cap is still over the cap", () => {
    const root = tempDir();
    plant(controlFile(root, "approvers.json"), `${jsonLine(PROJECTION)}${" ".repeat(1024 * 1024)}`);
    expect(reader()(root).state).toBe("unreadable");
  });

  test("two reads inside one second open the file once; a rewrite shows after the second", () => {
    const root = harnessWith(PROJECTION);
    let t = 1000;
    const read = createApproverReader({ now: () => t });
    let opens = 0;
    _setIoTapForTest({
      open: () => {
        opens += 1;
      },
    });
    const first = read(root);
    t += 999;
    expect(read(root)).toBe(first);
    expect(opens).toBe(1);
    writeFileSync(controlFile(root, "approvers.json"), jsonLine({ ...PROJECTION, epoch: 5 }));
    t += 2;
    const later = read(root);
    expect(opens).toBe(2);
    expect(later.state === "present" && later.projection.epoch).toBe(5);
  });
});
