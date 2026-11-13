import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensureAccessSetUp, localActorOf } from "@crewhaus/access-control";
import { LOCAL_ACTOR_RE, isId, isStoredActor } from "@crewhaus/control-contract";
import { commandReceipt } from "@crewhaus/control-contract/schemas";
import { isCredentialKey } from "@crewhaus/spec-patch";
import { IDEMPOTENCY_TTL_MS } from "./idempotency";
import { commandsLedgerOf, workspaceCommandsLedger } from "./ledgers";
import {
  IDENTITY,
  NOW,
  deferred,
  fakeProbe,
  plantReceipt,
  removeTempDirs,
  rig,
  rowsOf,
  tempDir,
  treeBytes,
} from "./test-helpers";

let clockSpy: { mockRestore(): void } | undefined;
afterEach(() => {
  clockSpy?.mockRestore();
  clockSpy = undefined;
});
afterAll(removeTempDirs);

/** Empty every segment: the state a crash between a claim and its append leaves. */
function loseRows(harness: string): void {
  const dir = join(harness, ".crewhaus", "run", "control", "commands");
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".jsonl")) truncateSync(join(dir, name), 0);
  }
}

const HRN = "home/harness/hrn_0123456789abcdef";

/** Every key at every depth of a JSON value. */
function fieldNames(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) fieldNames(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const [name, inner] of Object.entries(value)) {
      into.add(name);
      fieldNames(inner, into);
    }
  }
  return into;
}

describe("persist, then act", () => {
  test("an effect sees its own accepted receipt on disk before it runs", async () => {
    const { service, harness } = rig();
    const ledger = commandsLedgerOf(harness);
    let seen: Record<string, unknown>[] = [];
    const answer = await service.commands.submit(
      { kind: "controls.stop", target: HRN, ledger: { harness }, via: "cli" },
      async (receipt) => {
        seen = rowsOf(ledger);
        expect(seen.map((row) => row["id"])).toEqual([receipt.id]);
        return { settle: { state: "succeeded" }, value: "done" };
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.["state"]).toBe("accepted");
    if (!answer.ok || answer.replayed) throw new Error("submit refused");
    expect(answer.value).toBe("done");
    expect(answer.receipt.state).toBe("succeeded");
  });

  test("an inline effect goes accepted straight to its final state, never running", async () => {
    const { service, harness, supervisor } = rig();
    await service.commands.submit(
      { kind: "controls.stop", target: HRN, ledger: { harness }, via: "cli" },
      async () => ({ settle: { state: "rejected" }, value: undefined }),
    );
    expect(rowsOf(commandsLedgerOf(harness)).map((row) => row["state"])).toEqual([
      "accepted",
      "rejected",
    ]);
    expect(supervisor.calls).toEqual([]);
  });

  test("with no effect, a registered executor runs it: accepted, running, final", async () => {
    const { service, harness, supervisor } = rig({ pid: 1000 });
    const answer = await service.commands.submit({
      kind: "controls.stop",
      target: HRN,
      ledger: { harness },
      via: "home",
    });
    if (!answer.ok) throw new Error(answer.refusal.message);
    expect(answer.receipt.state).toBe("succeeded");
    expect(supervisor.calls).toEqual(["adopt", "stop"]);
    const rows = rowsOf(commandsLedgerOf(harness));
    expect(rows.map((row) => row["state"])).toEqual(["accepted", "running", "succeeded"]);
    expect((rows[1]?.["executor"] as { pid: number }).pid).toBe(1000);
  });

  test("a throwing effect leaves unknown for a kind not safe to repeat, and rethrows", async () => {
    const { service, harness } = rig();
    await expect(
      service.commands.submit(
        { kind: "controls.start", target: HRN, ledger: { harness }, via: "cli" },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    const rows = rowsOf(commandsLedgerOf(harness));
    expect(rows.map((row) => row["state"])).toEqual(["accepted", "unknown"]);
    expect(rows[1]?.["outcome"]).toEqual({
      code: "internal",
      message: "not done: it stopped with an error",
    });
  });

  test("a refused request writes nothing: an unknown kind, a bad key, a bad target", async () => {
    const { service, harness } = rig();
    for (const request of [
      { kind: "controls.nope" },
      { kind: "legacy.Bad-Key" },
      { kind: "controls.stop", idempotency: "has space" },
      { kind: "controls.stop", idempotency: "x".repeat(129) },
      { kind: "controls.stop", target: "not a ref" },
    ]) {
      const answer = await service.commands.submit({
        ledger: { harness },
        via: "cli",
        ...request,
      } as never);
      expect(answer).toMatchObject({ ok: false, refusal: { code: "invalid" } });
    }
    expect(existsSync(join(harness, ".crewhaus"))).toBe(false);
  });

  test("an unreadable digest key refuses as unavailable and writes no receipt", async () => {
    const { service, harness } = rig();
    const keyDir = join(harness, ".crewhaus", "run", "control", "keys");
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(join(keyDir, "digest.key"), "not a key\n");
    const answer = await service.commands.submit({
      kind: "controls.stop",
      ledger: { harness },
      via: "cli",
    });
    expect(answer).toMatchObject({ ok: false, refusal: { code: "unavailable" } });
    expect(existsSync(join(harness, ".crewhaus", "run", "control", "commands"))).toBe(false);
  });

  test("a command with no target targets its own receipt, in Home's ledger", async () => {
    const { service, hangarRoot } = rig();
    const answer = await service.commands.submit(
      { kind: "legacy.setReadOnly", ledger: "workspace", via: "home" },
      async () => ({ settle: { state: "succeeded" }, value: undefined }),
    );
    if (!answer.ok) throw new Error(answer.refusal.message);
    expect(answer.receipt.target).toBe(`home/cmd/${answer.receipt.id}`);
    expect(rowsOf(workspaceCommandsLedger(hangarRoot))).toHaveLength(2);
  });

  test("a queued command's accepted row carries the job effect", async () => {
    const { service, harness } = rig();
    const answer = await service.commands.submit(
      { kind: "legacy.submitJob", target: HRN, ledger: { harness }, via: "home", queued: true },
      async () => ({ value: undefined }),
    );
    if (!answer.ok) throw new Error(answer.refusal.message);
    expect(answer.receipt.state).toBe("accepted");
    expect(answer.receipt.effects).toEqual([{ kind: "job", status: "unknown" }]);
  });
});

describe("idempotency", () => {
  const stop = (harness: string, body: Record<string, unknown> = { grace: 5 }) => ({
    kind: "controls.stop",
    target: HRN,
    ledger: { harness },
    via: "home" as const,
    body,
    idempotency: "retry-1",
  });

  test("the same key twice: one effect, one receipt, and the second is a replay", async () => {
    const { service, harness } = rig();
    let effects = 0;
    const effect = async () => {
      effects += 1;
      return { settle: { state: "succeeded" as const }, value: undefined };
    };
    const first = await service.commands.submit(stop(harness), effect);
    const second = await service.commands.submit(stop(harness), effect);
    if (!first.ok || !second.ok) throw new Error("refused");
    expect(effects).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.receipt.id).toBe(first.receipt.id);
    expect(second.receipt.state).toBe("succeeded");
    expect(rowsOf(commandsLedgerOf(harness))).toHaveLength(2);
  });

  test("a duplicate while the first is in flight answers the same receipt, not a second effect", async () => {
    const { service, harness } = rig();
    const gate = deferred();
    let effects = 0;
    const first = service.commands.submit(stop(harness), async () => {
      effects += 1;
      await gate.promise;
      return { settle: { state: "succeeded" as const }, value: undefined };
    });
    await Bun.sleep(0);
    for (let i = 0; i < 50 && rowsOf(commandsLedgerOf(harness)).length === 0; i++)
      await Bun.sleep(1);
    const second = await service.commands.submit(stop(harness), async () => {
      effects += 1;
      return { settle: { state: "succeeded" as const }, value: undefined };
    });
    gate.open();
    const done = await first;
    if (!second.ok || !done.ok) throw new Error("refused");
    expect(second.replayed).toBe(true);
    expect(second.receipt.state).toBe("accepted");
    expect(second.receipt.id).toBe(done.receipt.id);
    expect(effects).toBe(1);
  });

  test("two callers racing on one key: one wins, one effect, both answer the same id", async () => {
    const { service, harness } = rig();
    let effects = 0;
    const effect = async () => {
      effects += 1;
      return { settle: { state: "succeeded" as const }, value: undefined };
    };
    const [a, b] = await Promise.all([
      service.commands.submit(stop(harness), effect),
      service.commands.submit(stop(harness), effect),
    ]);
    if (!a?.ok || !b?.ok) throw new Error("refused");
    expect(effects).toBe(1);
    expect(a.receipt.id).toBe(b.receipt.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  });

  test("a different body under the same key is refused, and the ledger is unchanged", async () => {
    const { service, harness } = rig();
    await service.commands.submit(stop(harness), async () => ({
      settle: { state: "succeeded" as const },
      value: undefined,
    }));
    const before = treeBytes(join(harness, ".crewhaus"));
    let ran = false;
    const answer = await service.commands.submit(stop(harness, { grace: 6 }), async () => {
      ran = true;
      return { settle: { state: "succeeded" as const }, value: undefined };
    });
    expect(answer).toMatchObject({ ok: false, refusal: { code: "idempotency_key_reused" } });
    expect(ran).toBe(false);
    expect(treeBytes(join(harness, ".crewhaus"))).toEqual(before);
  });

  test("a key is honoured for seven days, and a day later than that is a new command", async () => {
    for (const [age, fresh] of [
      [IDEMPOTENCY_TTL_MS + 1, true],
      [IDEMPOTENCY_TTL_MS - 1, false],
    ] as const) {
      const { service, harness, clock } = rig();
      // The claim's `at` is stamped by the records layer's own clock: fake both.
      clockSpy?.mockRestore();
      clockSpy = spyOn(Date, "now").mockImplementation(() => clock.now);
      const first = await service.commands.submit(stop(harness), async () => ({
        settle: { state: "succeeded" as const },
        value: undefined,
      }));
      clock.now += age;
      const later = await service.commands.submit(stop(harness), async () => ({
        settle: { state: "succeeded" as const },
        value: "again",
      }));
      if (!first.ok || !later.ok) throw new Error("refused");
      expect(later.replayed).toBe(!fresh);
      if (fresh) {
        expect(later.receipt.id).not.toBe(first.receipt.id);
        expect(service.commands.get({ harness }, later.receipt.id)?.state).toBe("succeeded");
        expect(service.commands.get({ harness }, first.receipt.id)?.state).toBe("succeeded");
      } else {
        expect(later.receipt.id).toBe(first.receipt.id);
      }
    }
  });

  test("a claim whose receipt never landed is completed from the claim on the next touch", async () => {
    const { service, harness } = rig({ pid: 1000 });
    const first = await service.commands.submit(stop(harness), async () => ({ value: undefined }));
    if (!first.ok) throw new Error("refused");
    loseRows(harness);
    expect(rowsOf(commandsLedgerOf(harness))).toHaveLength(0);
    const touch = await service.commands.submit(stop(harness));
    if (!touch.ok) throw new Error("refused");
    expect(touch.replayed).toBe(true);
    expect(touch.receipt.id).toBe(first.receipt.id);
    expect(touch.receipt.state).toBe("accepted");
    expect(rowsOf(commandsLedgerOf(harness))[0]?.["repaired"]).toBe(true);
  });
});

describe("what a receipt holds", () => {
  const CANARY = "canary-7f3a1c";

  test("no argument, input or secret reaches the ledger or its claims", async () => {
    const { service, harness } = rig();
    const secret = ["sk", "live", "0123456789abcdef"].join("-");
    await service.commands.submit(
      {
        kind: "legacy.envSet",
        target: HRN,
        ledger: { harness },
        via: "home",
        body: { key: "API", value: secret, note: CANARY },
        secretFields: ["value"],
        idempotency: "k-1",
      },
      async () => ({ settle: { state: "succeeded" }, value: undefined }),
    );
    const bytes = [...treeBytes(join(harness, ".crewhaus")).entries()].filter(
      ([path]) => !path.endsWith("digest.key"),
    );
    expect(bytes.length).toBeGreaterThanOrEqual(3);
    for (const [, text] of bytes) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("k-1");
      expect(text).not.toContain("sam");
    }
  });

  test("two bodies that differ only in a secret field fingerprint the same", async () => {
    const { service, harness } = rig();
    const submit = (value: string) =>
      service.commands.submit(
        {
          kind: "legacy.envSet",
          target: HRN,
          ledger: { harness },
          via: "home",
          body: { name: "API", value },
          secretFields: ["value"],
        },
        async () => ({ settle: { state: "succeeded" }, value: undefined }),
      );
    const a = await submit("one");
    const b = await submit("two");
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(a.receipt.fingerprint).toBe(b.receipt.fingerprint);
    const c = await service.commands.submit(
      {
        kind: "legacy.envSet",
        target: HRN,
        ledger: { harness },
        via: "home",
        body: { name: "OTHER" },
      },
      async () => ({ settle: { state: "succeeded" }, value: undefined }),
    );
    if (!c.ok) throw new Error("refused");
    expect(c.receipt.fingerprint).not.toBe(a.receipt.fingerprint);
  });

  test("path parameters and the query are part of the fingerprint; the query's order is not", async () => {
    const { service, harness } = rig();
    const submit = async (
      params: Record<string, string>,
      query: (readonly [string, string])[] = [],
    ): Promise<string> => {
      const answer = await service.commands.submit(
        { kind: "legacy.envUnset", target: HRN, ledger: { harness }, via: "home", params, query },
        async () => ({ settle: { state: "succeeded" }, value: undefined }),
      );
      if (!answer.ok) throw new Error("refused");
      return answer.receipt.fingerprint;
    };
    const a = await submit({ key: "ALPHA" });
    expect(await submit({ key: "ALPHA" })).toBe(a);
    expect(await submit({ key: "BETA" })).not.toBe(a);
    const q = await submit({ key: "ALPHA" }, [
      ["b", "2"],
      ["a", "1"],
    ]);
    expect(q).not.toBe(a);
    expect(
      await submit({ key: "ALPHA" }, [
        ["a", "1"],
        ["b", "2"],
      ]),
    ).toBe(q);
  });

  test("an unlinked local user is a keyed digest; a linked one is its principal", async () => {
    const unlinked = rig();
    const a = await unlinked.service.commands.submit(
      { kind: "controls.stop", target: HRN, ledger: { harness: unlinked.harness }, via: "cli" },
      async () => ({ settle: { state: "succeeded" }, value: undefined }),
    );
    if (!a.ok) throw new Error("refused");
    expect(isStoredActor(a.receipt.actor)).toBe(true);
    expect(LOCAL_ACTOR_RE.test(a.receipt.actor)).toBe(false);
    expect(a.receipt.actor).toMatch(/^local:#[0-9a-f]{64}$/);

    const hangarRoot = tempDir("control-service-linked-");
    const setUp = await ensureAccessSetUp(hangarRoot, { localActor: localActorOf(IDENTITY) });
    if (!setUp.ok) throw new Error("access setup refused");
    const linked = rig({ hangarRoot });
    const b = await linked.service.commands.submit(
      { kind: "controls.stop", target: HRN, ledger: { harness: linked.harness }, via: "cli" },
      async () => ({ settle: { state: "succeeded" }, value: undefined }),
    );
    if (!b.ok) throw new Error("refused");
    expect(isId("prn", b.receipt.actor)).toBe(true);
    expect(b.receipt.actor).toBe(setUp.result.localPrincipal as string);
  });

  test("every row validates as a receipt, and no field name is one the masker eats", async () => {
    const { service, harness, hangarRoot } = rig({ pid: 1000 });
    await service.commands.submit(
      { kind: "controls.stop", target: HRN, ledger: { harness }, via: "home", idempotency: "k" },
      async () => ({ value: undefined }),
    );
    loseRows(harness);
    await service.commands.submit({
      kind: "controls.stop",
      target: HRN,
      ledger: { harness },
      via: "home",
      idempotency: "k",
    });
    await service.commands.submit({
      kind: "controls.stop",
      target: HRN,
      ledger: { harness },
      via: "cli",
    });
    await service.commands.submit(
      { kind: "legacy.scan", ledger: "workspace", via: "home" },
      async () => ({
        settle: { state: "rejected", outcome: { code: "invalid", message: "m" } },
        value: 0,
      }),
    );
    // A stamp the probe could not confirm.
    const unprobed = rig({ probe: fakeProbe() });
    await unprobed.service.commands.submit(
      { kind: "controls.stop", target: HRN, ledger: { harness: unprobed.harness }, via: "cli" },
      async () => ({ settle: { state: "succeeded" }, value: undefined }),
    );
    const rows = [
      ...rowsOf(commandsLedgerOf(harness)),
      ...rowsOf(workspaceCommandsLedger(hangarRoot)),
      ...rowsOf(commandsLedgerOf(unprobed.harness)),
    ];
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      const parsed = commandReceipt.safeParse(row);
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    }
    const names = new Set<string>();
    for (const row of rows) fieldNames(row, names);
    for (const name of ["claim", "repaired", "gen", "probed", "dedupeRef", "fingerprint"]) {
      expect(names.has(name)).toBe(true);
    }
    expect([...names].filter(isCredentialKey)).toEqual([]);
  });

  test("a ledger that refuses the write refuses the command, and the effect never runs", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { service, harness } = rig();
    await service.commands.submit(
      { kind: "controls.stop", target: HRN, ledger: { harness }, via: "cli" },
      async () => ({ settle: { state: "succeeded" }, value: undefined }),
    );
    const segment = join(harness, ".crewhaus", "run", "control", "commands", "000001.jsonl");
    chmodSync(segment, 0o400);
    let ran = false;
    try {
      const answer = await service.commands.submit(
        { kind: "controls.stop", target: HRN, ledger: { harness }, via: "cli" },
        async () => {
          ran = true;
          return { settle: { state: "succeeded" }, value: undefined };
        },
      );
      expect(answer).toMatchObject({ ok: false, refusal: { code: "unavailable" } });
      expect(ran).toBe(false);
    } finally {
      chmodSync(segment, 0o600);
    }
    expect(rowsOf(commandsLedgerOf(harness))).toHaveLength(2);
  });
});

test("NOW is a fixed time", () => {
  expect(new Date(NOW).toISOString()).toBe("2026-11-11T12:00:00.000Z");
});

describe("the actor is the caller, and is checked again before a command runs", () => {
  const MEMBER = "prn_01jc0000000000000000000001";
  const OTHER = "prn_01jc0000000000000000000002";

  test("a command from a member whose authority is gone settles rejected and never runs", async () => {
    const asked: Array<readonly [string, string, string]> = [];
    const { service, harness, supervisor } = rig({
      authorizeActor: (actor, permission, target) => {
        asked.push([actor, permission, target]);
        return false;
      },
    });
    const answer = await service.commands.submit({
      kind: "controls.stop",
      target: HRN,
      ledger: { harness },
      via: "home",
      actor: MEMBER,
    });
    if (!answer.ok || answer.replayed) throw new Error("submit refused");
    expect(answer.receipt.actor).toBe(MEMBER);
    expect(answer.receipt.state).toBe("rejected");
    expect(answer.receipt.outcome?.code).toBe("forbidden");
    expect(supervisor.calls).not.toContain("stop");
    expect(asked).toEqual([[MEMBER, "h.control", HRN]]);
    expect(rowsOf(commandsLedgerOf(harness)).map((row) => row["state"])).toEqual([
      "accepted",
      "rejected",
    ]);
  });

  test("an accepted command recovered after its actor's grant was revoked is rejected, not run", async () => {
    let allowed = true;
    const r = rig({ authorizeActor: () => allowed });
    const ledger = commandsLedgerOf(r.harness);
    // Accepted while the member could stop this harness; the grant is revoked before it runs.
    plantReceipt(ledger, { id: "cmd_01jc00000000000000000000aa", actor: MEMBER });
    allowed = false;
    await r.service.commands.recover({ harness: r.harness });
    expect(r.supervisor.calls).not.toContain("stop");
    const last = rowsOf(ledger).at(-1);
    expect([last?.["state"], (last?.["outcome"] as { code?: string })?.code]).toEqual([
      "rejected",
      "forbidden",
    ]);
  });

  test("the Home's owner, a system actor and an unlinked local user pass without asking", async () => {
    const { service, harness, hangarRoot, supervisor } = rig({ authorizeActor: () => false });
    const setUp = await ensureAccessSetUp(hangarRoot, {
      localActor: localActorOf(IDENTITY),
      now: () => NOW,
    });
    if (!setUp.ok) throw new Error(setUp.reason);
    const owner = setUp.result.owner;
    const asOwner = await service.commands.submit({
      kind: "controls.stop",
      target: HRN,
      ledger: { harness },
      via: "home",
      actor: owner,
    });
    expect(asOwner.ok && !asOwner.replayed && asOwner.receipt.state).toBe("succeeded");
    // No actor given: the head's own user, which is the linked owner here.
    const asHead = await service.commands.submit({
      kind: "controls.stop",
      target: HRN,
      ledger: { harness },
      via: "cli",
    });
    expect(asHead.ok && !asHead.replayed && asHead.receipt.state).toBe("succeeded");
    expect(supervisor.calls.filter((call) => call === "stop")).toHaveLength(2);
  });

  test("an authority that cannot be determined runs the command, with one warning", async () => {
    const { service, harness, supervisor, warnings } = rig({ authorizeActor: () => undefined });
    for (const _ of [1, 2]) {
      const answer = await service.commands.submit({
        kind: "controls.stop",
        target: HRN,
        ledger: { harness },
        via: "home",
        actor: MEMBER,
      });
      expect(answer.ok && !answer.replayed && answer.receipt.state).toBe("succeeded");
    }
    expect(supervisor.calls.filter((call) => call === "stop")).toHaveLength(2);
    expect(warnings.filter((w) => w.includes("could not be determined"))).toHaveLength(1);
  });

  test("two principals with one idempotency key get two receipts", async () => {
    const { service, harness } = rig({ authorizeActor: () => true });
    const ask = (actor: string) =>
      service.commands.submit({
        kind: "controls.stop",
        target: HRN,
        ledger: { harness },
        via: "home",
        actor,
        idempotency: "same-key",
      });
    const first = await ask(MEMBER);
    const second = await ask(OTHER);
    if (!first.ok || !second.ok) throw new Error("submit refused");
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    expect(first.receipt.id).not.toBe(second.receipt.id);
    const again = await ask(MEMBER);
    expect(again.ok && again.replayed).toBe(true);
  });

  test("an actor that is not a principal is refused before anything is written", async () => {
    const { service, harness } = rig();
    const answer = await service.commands.submit({
      kind: "controls.stop",
      target: HRN,
      ledger: { harness },
      via: "home",
      actor: "operator@example.invalid",
    });
    expect(answer.ok === false && answer.refusal.code).toBe("invalid");
    expect(existsSync(join(harness, ".crewhaus", "run", "control", "commands"))).toBe(false);
  });
});
