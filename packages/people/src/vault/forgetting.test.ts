/**
 * Forgetting: a shredded person's key is gone and a copy of it does not open under the
 * rotated space key; a rotation interrupted after any step leaves every remaining person
 * readable, and running it again finishes it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { aesKey, bytesOf, open, personKeyAad } from "./crypto";
import { keyFileOf } from "./custody";
import { OWNER, fakeSecrets, mustOpen, removeTempDirs, tempDir } from "./test-helpers";
import type { ErasureMark, Vault, VaultStatus } from "./vault";

afterAll(removeTempDirs);

type Custody = "keychain" | "file" | "environment";

async function vaultWith(custody: Custody, onStep?: (step: string) => void) {
  const base = tempDir();
  const root = join(base, "hangar", "people");
  const secrets = fakeSecrets();
  const env = { CREWHAUS_PEOPLE_SPACE_KEY: "ab".repeat(32) };
  const open = (step?: (s: string) => void) =>
    mustOpen({ root, secrets, env, ...(step !== undefined ? { onStep: step } : {}) });
  const vault = open(onStep);
  const made = await vault.setUp({ custody, owner: OWNER });
  const space = (made.status as Extract<VaultStatus, { state: "ready" }>).space;
  return { base, root, secrets, env, vault, space, open };
}

async function person(vault: Vault, label: string): Promise<string> {
  const psn = await vault.write(
    async (w) => (await w.createPerson({ kind: "personal", owner: OWNER, data: { label } })).person,
  );
  await vault.appendClaimRevision(
    psn,
    { id: mintId("pcl"), rev: 0, value: `${label} likes tea` },
    { expectRev: 0 },
  );
  return psn;
}

async function opens(vault: Vault, psn: string): Promise<string> {
  const claims = await vault.readClaims<{ id: string; rev: number; value: string }>(psn);
  return (await vault.readPerson<{ label: string }>(psn)).data.label + (claims[0]?.value ?? "");
}

/** Whether a copied `key.json` opens under the keychain's live space key. */
async function opensUnderLiveKey(
  vault: Vault,
  secrets: ReturnType<typeof fakeSecrets>,
  copiedKeyFile: string,
  space: string,
  psn: string,
): Promise<boolean> {
  const status = (await vault.status()) as Extract<VaultStatus, { state: "ready" }>;
  const live = [...secrets.items.entries()].find(([name]) =>
    name.endsWith(`/v${status.kekVersion}`),
  )?.[1];
  expect(live).toBeDefined();
  const copied = JSON.parse(readFileSync(copiedKeyFile, "utf8")) as {
    iv: string;
    ct: string;
    kekVersion: number;
  };
  const opened = await open(
    await aesKey(bytesOf(live as string) as Uint8Array),
    copied,
    personKeyAad(space, psn, copied.kekVersion),
  );
  return opened !== undefined;
}

function stopOnce(stop: string): { arm: () => void; onStep: (step: string) => void } {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    onStep: (step) => {
      if (armed && step === stop) {
        armed = false;
        throw new Error(`stopped after ${step}`);
      }
    },
  };
}

function mark(): ErasureMark {
  return {
    per: mintId("per"),
    by: OWNER,
    at: "2026-11-12T00:00:00.000Z",
    kekTarget: 2,
    inventoryDigest: "0".repeat(64),
    removed: { notes: 1, revisions: 1, rejected: 0, exports: 0 },
    residue: [],
  };
}

describe("shred", () => {
  for (const custody of ["keychain", "file"] as const) {
    test(`${custody}: the key is gone, a copy does not open under the rotated key, and the old key is destroyed`, async () => {
      const { base, root, secrets, vault, space } = await vaultWith(custody);
      const sam = await person(vault, "Sam");
      const dana = await person(vault, "Dana");
      cpSync(root, join(base, "copy"), { recursive: true });
      const keyName = [...secrets.items.keys()][0];
      await vault.write(async (w) => {
        w.markErasing(sam, mark());
        await w.eraseMarked(sam);
      });
      const persons = join(root, "spaces", space, "persons");
      expect(existsSync(join(persons, sam, "key.json"))).toBe(false);
      expect(existsSync(join(persons, sam))).toBe(false);
      expect(vault.row(sam)).toBeUndefined();
      // The copied wrapped key, under the space key the vault now holds.
      const status = (await vault.status()) as Extract<VaultStatus, { state: "ready" }>;
      expect(status.kekVersion).toBe(2);
      const current =
        custody === "keychain"
          ? [...secrets.items.values()][0]
          : readFileSync(join(root, keyFileOf(space, 2)), "utf8").trim();
      const copied = JSON.parse(
        readFileSync(join(base, "copy", "spaces", space, "persons", sam, "key.json"), "utf8"),
      ) as { iv: string; ct: string; kekVersion: number };
      const opened = await open(
        await aesKey(bytesOf(current as string) as Uint8Array),
        copied,
        personKeyAad(space, sam, copied.kekVersion),
      );
      expect(opened).toBeUndefined();
      if (custody === "keychain") {
        expect(secrets.items.has(keyName as string)).toBe(false);
        expect(secrets.items.size).toBe(1);
      } else {
        expect(existsSync(join(root, keyFileOf(space, 1)))).toBe(false);
        expect(existsSync(join(root, keyFileOf(space, 2)))).toBe(true);
      }
      expect(await opens(vault, dana)).toBe("DanaDana likes tea");
      expect(vault.readErasures().map((e) => e.person)).toEqual([sam]);
    });
  }

  test("environment custody cannot rotate on its own, and says so", async () => {
    const { vault } = await vaultWith("environment");
    const sam = await person(vault, "Sam");
    const outcome = await vault.write(async (w) => {
      w.markErasing(sam, { ...mark(), kekTarget: 1 });
      return w.eraseMarked(sam);
    });
    expect(outcome.rotation).toBe("skipped");
    expect(await vault.rotateSpaceKey()).toEqual({
      rotated: false,
      reason: "space-key-not-rotated",
    });
  });

  test("environment custody rotates to a key the caller hands it, and keeps the old one", async () => {
    const { root, env, vault } = await vaultWith("environment");
    const dana = await person(vault, "Dana");
    const next = "cd".repeat(32);
    expect(await vault.rotateSpaceKey({ newKeyHex: next })).toEqual({
      rotated: true,
      kekVersion: 2,
      resumed: false,
      oldKey: "kept",
    });
    expect(await opens(vault, dana)).toBe("DanaDana likes tea");
    expect((await mustOpen({ root, env }).status()).state).toBe("locked");
    const replaced = mustOpen({ root, env: { CREWHAUS_PEOPLE_SPACE_KEY: next } });
    expect(await opens(replaced, dana)).toBe("DanaDana likes tea");
  });

  test("shredPerson deletes the key, then the records, then the row", async () => {
    const { root, space, vault } = await vaultWith("keychain");
    const sam = await person(vault, "Sam");
    await vault.shredPerson(sam);
    expect(readdirSync(join(root, "spaces", space, "persons"))).toEqual([]);
    expect(vault.rows()).toEqual([]);
  });
});

describe("rotation, interrupted after each step", () => {
  const STEPS = [
    "key-stored",
    "person-key-rewrapped",
    "person-keys-rewrapped",
    "version-set",
    "old-key-destroyed",
  ];

  for (const custody of ["keychain", "file"] as const) {
    for (const stop of STEPS) {
      test(`${custody}, after ${stop}: every person opens, and a re-run completes`, async () => {
        let armed = true;
        const {
          vault,
          open: reopen,
          secrets,
          root,
          space,
        } = await vaultWith(custody, (step) => {
          if (armed && step === stop) {
            armed = false;
            throw new Error(`stopped after ${step}`);
          }
        });
        const people = [await person(vault, "A"), await person(vault, "B")];
        await expect(vault.rotateSpaceKey()).rejects.toThrow(`stopped after ${stop}`);
        const cold = reopen();
        for (const psn of people) expect(await opens(cold, psn)).toContain("likes tea");
        const rerun = await cold.rotateSpaceKey();
        expect(rerun.rotated).toBe(true);
        // Stopped after its last step, the rotation was whole: the re-run is a new one.
        const version = stop === "old-key-destroyed" ? 3 : 2;
        const status = (await reopen().status()) as Extract<VaultStatus, { state: "ready" }>;
        expect(status.kekVersion).toBe(version);
        for (const psn of people) expect(await opens(reopen(), psn)).toContain("likes tea");
        if (custody === "keychain") {
          expect([...secrets.items.keys()].map((k) => k.slice(-3))).toEqual([`/v${version}`]);
        } else {
          expect(readdirSync(join(root, "keys"))).toEqual([keyFileOf(space, version).slice(5)]);
        }
      });
    }
  }
});

describe("erasure, interrupted after each step", () => {
  const STEPS = [
    "marked",
    "key-deleted",
    "records-deleted",
    "space-key-rotated",
    "recorded",
    "row-removed",
  ];
  for (const stop of STEPS) {
    test(`after ${stop}: a re-run reaches the same end state`, async () => {
      let armed = true;
      const {
        vault,
        open: reopen,
        secrets,
        root,
        space,
      } = await vaultWith("keychain", (step) => {
        if (armed && step === stop) {
          armed = false;
          throw new Error(`stopped after ${step}`);
        }
      });
      const sam = await person(vault, "Sam");
      const dana = await person(vault, "Dana");
      const plan = mark();
      await expect(
        vault.write(async (w) => {
          w.markErasing(sam, plan);
          return w.eraseMarked(sam);
        }),
      ).rejects.toThrow(`stopped after ${stop}`);
      const cold = reopen();
      if (cold.row(sam) !== undefined) {
        await cold.write(async (w) => {
          w.markErasing(sam, mark());
          return w.eraseMarked(sam);
        });
      }
      const after = reopen();
      expect(after.row(sam)).toBeUndefined();
      expect(existsSync(join(root, "spaces", space, "persons", sam))).toBe(false);
      expect(after.readErasures().map((e) => e.per)).toEqual([plan.per]);
      expect(((await after.status()) as Extract<VaultStatus, { state: "ready" }>).kekVersion).toBe(
        2,
      );
      expect([...secrets.items.keys()].map((k) => k.slice(-3))).toEqual(["/v2"]);
      expect(await opens(after, dana)).toBe("DanaDana likes tea");
    });
  }
});

describe("an erasure ends under a key made after the person's key was deleted", () => {
  const keyFileIn = (dir: string, space: string, psn: string) =>
    join(dir, "spaces", space, "persons", psn, "key.json");
  const kekVersionOf = async (vault: Vault) =>
    ((await vault.status()) as Extract<VaultStatus, { state: "ready" }>).kekVersion;

  test("a rotation that stopped with the old key still kept is finished, then a new key is made", async () => {
    const stop = stopOnce("version-set");
    const {
      base,
      root,
      secrets,
      vault,
      space,
      open: reopen,
    } = await vaultWith("keychain", stop.onStep);
    const sam = await person(vault, "Sam");
    const dana = await person(vault, "Dana");
    stop.arm();
    await expect(vault.rotateSpaceKey()).rejects.toThrow("stopped after version-set");
    const cold = reopen();
    expect(await kekVersionOf(cold)).toBe(2);
    cpSync(root, join(base, "copy"), { recursive: true });
    const copy = keyFileIn(join(base, "copy"), space, sam);
    // The copy is wrapped under the version in use: the probe can say yes.
    expect(await opensUnderLiveKey(cold, secrets, copy, space, sam)).toBe(true);
    const plan = { ...mark(), kekTarget: (await kekVersionOf(cold)) + 1 };
    const outcome = await cold.write(async (w) => {
      w.markErasing(sam, plan);
      return w.eraseMarked(sam);
    });
    expect(outcome.rotation).toMatchObject({ rotated: true, kekVersion: 3 });
    expect(await kekVersionOf(reopen())).toBe(plan.kekTarget);
    expect(await opensUnderLiveKey(reopen(), secrets, copy, space, sam)).toBe(false);
    expect([...secrets.items.keys()].map((k) => k.slice(-3))).toEqual(["/v3"]);
    expect(await opens(reopen(), dana)).toBe("DanaDana likes tea");
  });

  test("a rotation run while an erasure is marked deletes that person's key instead of re-wrapping it", async () => {
    const stop = stopOnce("marked");
    const {
      base,
      root,
      secrets,
      vault,
      space,
      open: reopen,
    } = await vaultWith("keychain", stop.onStep);
    const sam = await person(vault, "Sam");
    const dana = await person(vault, "Dana");
    stop.arm();
    await expect(
      vault.write(async (w) => {
        w.markErasing(sam, mark());
        return w.eraseMarked(sam);
      }),
    ).rejects.toThrow("stopped after marked");
    cpSync(root, join(base, "before"), { recursive: true });
    const cold = reopen();
    const target = cold.row(sam)?.erasure?.kekTarget;
    expect(target).toBe(2);
    expect((await cold.rotateSpaceKey()).rotated).toBe(true);
    // A backup taken now holds no key for the person being erased.
    expect(existsSync(keyFileIn(root, space, sam))).toBe(false);
    expect(cold.row(sam)?.state).toBe("erasing");
    await cold.write((w) => w.eraseMarked(sam));
    const after = reopen();
    expect(after.row(sam)).toBeUndefined();
    expect(await kekVersionOf(after)).toBe(target as number);
    expect(
      await opensUnderLiveKey(
        after,
        secrets,
        keyFileIn(join(base, "before"), space, sam),
        space,
        sam,
      ),
    ).toBe(false);
    expect(await opens(after, dana)).toBe("DanaDana likes tea");
  });

  test("a person already re-wrapped by a stopped rotation is erased under the version after it", async () => {
    const stop = stopOnce("person-key-rewrapped");
    const {
      base,
      root,
      secrets,
      vault,
      space,
      open: reopen,
    } = await vaultWith("keychain", stop.onStep);
    const sam = await person(vault, "Sam");
    const dana = await person(vault, "Dana");
    stop.arm();
    await expect(vault.rotateSpaceKey()).rejects.toThrow("stopped after person-key-rewrapped");
    cpSync(root, join(base, "copy"), { recursive: true });
    const copy = keyFileIn(join(base, "copy"), space, sam);
    const copied = JSON.parse(readFileSync(copy, "utf8")) as { kekVersion: number };
    expect(copied.kekVersion).toBe(2);
    const cold = reopen();
    expect(await kekVersionOf(cold)).toBe(1);
    await cold.write(async (w) => {
      w.markErasing(sam, mark());
      expect(cold.row(sam)?.erasure?.kekTarget).toBe(3);
      return w.eraseMarked(sam);
    });
    const after = reopen();
    expect(await kekVersionOf(after)).toBe(3);
    expect(await opensUnderLiveKey(after, secrets, copy, space, sam)).toBe(false);
    expect([...secrets.items.keys()].map((k) => k.slice(-3))).toEqual(["/v3"]);
    expect(await opens(after, dana)).toBe("DanaDana likes tea");
  });
});
