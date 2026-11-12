/**
 * The admin end to end over the real workspace ledger: one receipt per change, accepted
 * before the vault changes; reads that write nothing; an erasure that refuses a stale or
 * mistyped confirmation, finishes after a crash, and leaves no word of the profile behind
 * in the vault or in Home's command ledger.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { ERASURE_NONCE_TTL_MS } from "@crewhaus/people/vault";
import { type Refused, SAVED_KEY_ROTATION, createPeopleAdmin } from "./admin";
import { fixture, ok, removeTempDirs, scan, snapshot } from "./test-helpers";

afterAll(removeTempDirs);

describe("receipts", () => {
  test("each write is exactly one workspace receipt, settled succeeded", async () => {
    const { admin, receiptsNow, vault } = await fixture();
    expect(receiptsNow().map((r) => r.kind)).toEqual(["people.vault.setup"]);
    const psn = ok(await admin.createPerson({ kind: "personal", label: "Sam" })).person;
    const pcl = ok(await admin.addClaim(psn, { area: "comm", value: "Short updates." })).claim;
    ok(await admin.reviseClaim(pcl, { value: "Shorter updates." }, 1));
    ok(await admin.reviewClaim(pcl, { verdict: "narrow", purposes: ["communication"] }));
    ok(await admin.updatePerson(psn, { offLimits: ["family"] }, 1));
    ok(await admin.writeExport(psn));
    const receipts = receiptsNow();
    expect(receipts.map((r) => r.kind).sort()).toEqual(
      [
        "people.vault.setup",
        "people.persons.create",
        "people.claims.create",
        "people.claims.revise",
        "people.claims.review",
        "people.persons.update",
        "people.exports.create",
      ].sort(),
    );
    for (const receipt of receipts) {
      expect(receipt.state).toBe("succeeded");
      if (receipt.kind !== "people.vault.setup") expect(receipt.target).toBe(`home/person/${psn}`);
    }
    expect(vault.readActivity(psn, 50).rows.map((r) => r.event)).toEqual([
      "export.created",
      "person.updated",
      "claim.reviewed",
      "claim.revised",
      "claim.created",
      "person.created",
    ]);
  });

  test("the receipt is accepted before the vault changes, and a failing change is not succeeded", async () => {
    const f = await fixture();
    const psn = ok(await f.admin.createPerson({ kind: "personal", label: "Sam" })).person;
    const seen: string[] = [];
    let stop = false;
    const admin = createPeopleAdmin({
      vault: f.vault,
      actor: f.owner,
      now: f.clock.now,
      receipts: (request, effect) =>
        f.receipts(request, async (receipt) => {
          seen.push(`${receipt.state}:${f.vault.claimLines(psn).length}`);
          if (stop) throw new Error("the disk went away");
          return effect(receipt);
        }),
    });
    ok(await admin.addClaim(psn, { area: "comm", value: "one" }));
    expect(seen).toEqual(["accepted:0"]);
    stop = true;
    await expect(admin.addClaim(psn, { area: "comm", value: "two" })).rejects.toThrow(
      "the disk went away",
    );
    expect(f.vault.claimLines(psn)).toHaveLength(1);
    const last = f
      .receiptsNow()
      .find((r) => r.kind === "people.claims.create" && r.state !== "succeeded");
    expect(last?.state).toBe("failed");
  });

  test("a note's words never move its fingerprint: they are secret fields", async () => {
    const { admin, receiptsNow } = await fixture();
    const psn = ok(await admin.createPerson({ kind: "personal", label: "Sam" })).person;
    ok(await admin.addClaim(psn, { area: "comm", value: "first words" }));
    ok(await admin.addClaim(psn, { area: "work", value: "other words", situation: "on Mondays" }));
    const prints = receiptsNow()
      .filter((r) => r.kind === "people.claims.create")
      .map((r) => r.fingerprint);
    expect(prints).toHaveLength(2);
    expect(prints[0]).toBe(prints[1] as string);
    ok(await admin.addClaim(psn, { area: "comm", value: "x", type: "goal" }));
    const third = receiptsNow()
      .filter((r) => r.kind === "people.claims.create")
      .map((r) => r.fingerprint);
    expect(new Set(third).size).toBe(2);
  });
});

describe("reads", () => {
  test("list, show, review, activity, export preview and the erasure plan write nothing", async () => {
    const { admin, vaultRoot, hangarRoot } = await fixture();
    const psn = ok(await admin.createPerson({ kind: "personal", label: "Sam" })).person;
    ok(
      await admin.addClaim(psn, {
        area: "comm",
        value: "Short updates.",
        sensitivity: "sensitive",
      }),
    );
    const roots = [vaultRoot, join(hangarRoot, "control")];
    const before = snapshot(roots);
    expect(before.size).toBeGreaterThan(5);
    ok(await admin.listPersons());
    ok(await admin.getPerson(psn));
    ok(await admin.listClaims(psn));
    ok(await admin.reviewList(psn));
    ok(await admin.activity(psn, { limit: 5 }));
    ok(await admin.previewExport(psn));
    ok(await admin.planErasure(psn));
    ok(await admin.vaultState());
    expect(snapshot(roots)).toEqual(before);
  });
});

describe("erasure", () => {
  async function two() {
    const f = await fixture({ custody: "keychain" });
    const sam = ok(await f.admin.createPerson({ kind: "personal", label: "Sam" })).person;
    const dana = ok(
      await f.admin.createPerson({
        kind: "personal",
        label: "Dana",
        describes: "someone-else",
        basis: "custodian",
      }),
    ).person;
    ok(await f.admin.addClaim(sam, { area: "comm", value: "Short updates." }));
    ok(await f.admin.addClaim(dana, { area: "comm", value: "Calls, not texts." }));
    return { ...f, sam, dana };
  }

  test("an expired dry run, a changed profile and a wrong name each refuse, writing nothing", async () => {
    const { admin, sam, clock, vaultRoot, hangarRoot } = await two();
    const roots = [vaultRoot, join(hangarRoot, "control")];
    const plan = ok(await admin.planErasure(sam));
    let before = snapshot(roots);
    expect(await admin.runErasure(sam, { nonce: plan.nonce, confirm: "Samuel" })).toEqual(
      expect.objectContaining({ ok: false, reason: "wrong-name" }),
    );
    expect(snapshot(roots)).toEqual(before);
    clock.advance(ERASURE_NONCE_TTL_MS + 1);
    expect(await admin.runErasure(sam, { nonce: plan.nonce, confirm: "Sam" })).toEqual(
      expect.objectContaining({ ok: false, reason: "expired" }),
    );
    expect(snapshot(roots)).toEqual(before);
    const fresh = ok(await admin.planErasure(sam));
    ok(await admin.addClaim(sam, { area: "comm", value: "Another note." }));
    before = snapshot(roots);
    expect(await admin.runErasure(sam, { nonce: fresh.nonce, confirm: "Sam" })).toEqual(
      expect.objectContaining({ ok: false, reason: "inventory-changed" }),
    );
    expect(snapshot(roots)).toEqual(before);
  });

  test("erasure leaves no word of the profile in the vault or the ledger, and the other profile opens", async () => {
    const { admin, sam, dana, vaultRoot, hangarRoot, as, owner, receiptsNow } = await two();
    const marker = `zq${crypto.randomUUID()}`;
    const marked = ok(await admin.createPerson({ kind: "personal", label: marker })).person;
    const note = ok(
      await admin.addClaim(marked, {
        area: "comm",
        value: `${marker} v`,
        situation: `${marker} s`,
      }),
    );
    ok(await admin.reviewClaim(note.claim, { verdict: "reject" }));
    ok(await admin.addClaim(marked, { area: "work", value: `${marker} w` }));
    const out = join(hangarRoot, "..", "export.json");
    ok(await admin.writeExport(marked, { summary: true }, { path: out }));
    const roots = [vaultRoot, join(hangarRoot, "control")];
    expect(scan(roots, marker).hits).toEqual([]);
    const plan = ok(await admin.planErasure(marked));
    expect(plan.counts).toEqual({ notes: 2, revisions: 3, rejected: 1, exports: 1 });
    expect(plan.residue.map((r) => r.code)).toEqual(["downloaded-export", "backups-unknown"]);
    const done = ok(await admin.runErasure(marked, { nonce: plan.nonce, confirm: marker }));
    expect(done.rotated).toBe(true);
    const after = scan(roots, marker);
    expect(after.files).toBeGreaterThan(5);
    expect(after.hits).toEqual([]);
    expect(await admin.getPerson(marked)).toEqual(
      expect.objectContaining({ ok: false, code: "not_found" }),
    );
    expect(ok(await admin.getPerson(sam)).label).toBe("Sam");
    expect(ok(await as(owner).listClaims(dana)).map((n) => n.value)).toEqual(["Calls, not texts."]);
    const receipt = receiptsNow().find((r) => r.kind === "people.erasure.run");
    expect(receipt?.state).toBe("succeeded");
    expect(receipt?.effects.map((e) => e.kind)).toEqual([
      "vault",
      "space-key",
      "residue",
      "residue",
    ]);
  });

  test("an erasure stopped after any step is finished by running it again", async () => {
    for (const stop of [
      "marked",
      "key-deleted",
      "records-deleted",
      "space-key-rotated",
      "recorded",
    ]) {
      let armed = true;
      const f = await fixture({
        onStep: (step) => {
          if (armed && step === stop) {
            armed = false;
            throw new Error(`stopped after ${step}`);
          }
        },
      });
      const sam = ok(await f.admin.createPerson({ kind: "personal", label: "Sam" })).person;
      const dana = ok(await f.admin.createPerson({ kind: "personal", label: "Dana" })).person;
      ok(await f.admin.addClaim(sam, { area: "comm", value: "x" }));
      const plan = ok(await f.admin.planErasure(sam));
      await expect(f.admin.runErasure(sam, { nonce: plan.nonce, confirm: "Sam" })).rejects.toThrow(
        `stopped after ${stop}`,
      );
      expect(f.receiptsNow().find((r) => r.kind === "people.erasure.run")?.state).toBe("unknown");
      const resumed = f.as(f.owner);
      if (f.vault.row(sam) !== undefined) {
        expect(ok(await resumed.planErasure(sam)).resuming).toBe(true);
        ok(await resumed.runErasure(sam, { nonce: "", confirm: "" }));
      }
      expect(f.vault.row(sam)).toBeUndefined();
      expect(f.vault.readErasures()).toHaveLength(1);
      const status = await f.vault.status();
      expect(status.state === "ready" && status.kekVersion).toBe(2);
      expect(ok(await resumed.getPerson(dana)).label).toBe("Dana");
    }
  }, 20_000); // five fresh vaults and ledgers, each crashed and finished

  test("under environment custody the plan says the key cannot be rotated, and the erasure still runs", async () => {
    const { admin } = await fixture({ custody: "environment" });
    const psn = ok(await admin.createPerson({ kind: "synthetic", label: "Pat" })).person;
    const plan = ok(await admin.planErasure(psn));
    expect(plan.residue.map((r) => r.code)).toEqual(["backups-unknown", "space-key-not-rotated"]);
    const done = ok(await admin.runErasure(psn, { nonce: plan.nonce, confirm: "Pat" }));
    expect(done.rotated).toBe(false);
  });

  test("declared backup retention dates the backups residue", async () => {
    const { admin, clock } = await fixture();
    ok(await admin.setup({ custody: "keychain", backupDays: 30 }));
    const psn = ok(await admin.createPerson({ kind: "synthetic", label: "Pat" })).person;
    const plan = ok(await admin.planErasure(psn));
    const until = new Date(clock.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    expect(plan.residue).toEqual([{ code: "backups", until }]);
  });
});

describe("the vault", () => {
  test("set up twice reports the state; another custody is refused; rotation needs no body", async () => {
    const { admin, receiptsNow } = await fixture();
    const again = ok(await admin.setup({ custody: "keychain" }));
    expect(again).toEqual({
      created: false,
      state: { state: "ready", custody: "keychain", kekVersion: 1 },
    });
    expect(await admin.setup({ custody: "file" })).toEqual(
      expect.objectContaining({ ok: false, reason: "custody-fixed" }),
    );
    expect(receiptsNow()).toHaveLength(1);
    expect(ok(await admin.rotateKeys())).toEqual({
      kekVersion: 2,
      oldKey: "destroyed",
      resumed: false,
    });
    const rotate = receiptsNow().find((r) => r.kind === "people.vault.rotate");
    expect(rotate?.target).toMatch(/^home\/cmd\/cmd_/);
  });

  test("environment custody will not rotate without a new key from its caller", async () => {
    const { admin, receiptsNow } = await fixture({ custody: "environment" });
    const refusal = await admin.rotateKeys();
    expect(refusal).toEqual(
      expect.objectContaining({ ok: false, reason: "space-key-not-rotated" }),
    );
    // The way it names saves the new key before anything is re-wrapped under it.
    const message = (refusal as Refused).message;
    expect(message).toContain(SAVED_KEY_ROTATION);
    expect(SAVED_KEY_ROTATION).toContain("> new.key");
    expect(message).not.toMatch(/\|\s*crewhaus people keys --rotate/);
    expect(receiptsNow()).toHaveLength(1);
    expect(ok(await admin.rotateKeys("cd".repeat(32))).oldKey).toBe("kept");
  });

  test("an admin needs a principal", () => {
    expect(() =>
      createPeopleAdmin({
        vault: {} as never,
        receipts: (() => undefined) as never,
        actor: "local:sam@laptop",
      }),
    ).toThrow("principal");
    expect(mintId("prn")).toMatch(/^prn_/);
  });
});
