/**
 * What the vault's files hold and how they are written: no word of a profile in clear,
 * no field the masker would eat, and nothing written through a link planted in the vault.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { isCredentialKey } from "@crewhaus/spec-patch";
import { VaultError } from "./files";
import { OWNER, filesUnder, readyVault, removeTempDirs, scan, tempDir } from "./test-helpers";
import type { Vault } from "./vault";

afterAll(removeTempDirs);

async function everyRecord(vault: Vault, marker: string): Promise<string> {
  const psn = await vault.write(
    async (w) =>
      (
        await w.createPerson({
          kind: "personal",
          owner: OWNER,
          viewers: [mintId("prn")],
          data: { label: marker, offLimits: [] },
        })
      ).person,
  );
  const pcl = mintId("pcl");
  await vault.appendClaimRevision(
    psn,
    {
      id: pcl,
      rev: 0,
      area: "communication",
      value: `${marker} value`,
      situation: `${marker} when`,
    },
    { expectRev: 0 },
  );
  await vault.write(async (w) => {
    await w.writeRejected(psn, [
      { fp: await vault.fingerprint(psn, "communication", marker), claim: pcl },
    ]);
    w.appendExport(psn, {
      pex: mintId("pex"),
      at: "t",
      by: OWNER,
      counts: { notes: 1 },
      sha256: "0".repeat(64),
    });
    w.appendActivity(psn, { at: "t", actor: OWNER, event: "claim.created", counts: { notes: 1 } });
    w.setBackupDays(30);
  });
  return psn;
}

describe("a marker planted in every record", () => {
  test("appears in no byte under the vault, before or after an erasure", async () => {
    const { vault, root } = await readyVault();
    const marker = `zq${crypto.randomUUID()}`;
    const psn = await everyRecord(vault, marker);
    await everyRecord(vault, `${marker}-second`);
    const before = scan([root], marker);
    expect(before.files).toBeGreaterThan(10);
    expect(before.hits).toEqual([]);
    await vault.write(async (w) => {
      w.markErasing(psn, {
        per: mintId("per"),
        by: OWNER,
        at: "t",
        kekTarget: 2,
        inventoryDigest: "0".repeat(64),
        removed: { notes: 1, revisions: 1, rejected: 1, exports: 1 },
        residue: [{ code: "backups", until: "2026-12-12" }],
      });
      await w.eraseMarked(psn);
    });
    const after = scan([root], marker);
    expect(after.files).toBeGreaterThan(5);
    expect(after.hits).toEqual([]);
  });
});

describe("field names", () => {
  test("no key in any vault file, or in the rejected set, is credential-shaped", async () => {
    const { vault, root } = await readyVault({ custody: "file" });
    const psn = await everyRecord(vault, "Sam");
    await vault.write(async (w) => {
      w.markErasing(psn, {
        per: mintId("per"),
        by: OWNER,
        at: "t",
        kekTarget: 1,
        inventoryDigest: "0".repeat(64),
        removed: { notes: 1, revisions: 1, rejected: 1, exports: 1 },
        residue: [{ code: "downloaded-export", at: "t" }],
      });
    });
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    for (const file of filesUnder(root)) {
      if (file.endsWith(".kek") || file.endsWith("lock")) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim() !== "") walk(JSON.parse(line));
      }
    }
    walk(await vault.readRejected(psn));
    expect([...keys].filter(isCredentialKey)).toEqual([]);
    for (const name of [
      "kekVersion",
      "kekCheck",
      "custody",
      "home",
      "erasure",
      "inventoryDigest",
      "fp",
      "iv",
      "ct",
    ]) {
      expect(keys.has(name)).toBe(true);
    }
    expect(keys.size).toBeGreaterThan(30);
  });
});

describe.skipIf(process.platform === "win32")("planted links", () => {
  async function refused(run: () => Promise<unknown>): Promise<VaultError> {
    try {
      await run();
    } catch (err) {
      if (err instanceof VaultError) return err;
      throw err;
    }
    throw new Error("expected a refusal");
  }

  test("a link at the lock is refused, and nothing is created where it points", async () => {
    const { vault, root } = await readyVault();
    const outside = join(tempDir("people-outside-"), "target");
    symlinkSync(outside, join(root, "lock"));
    const err = await refused(() => vault.write(async () => undefined));
    expect(err.code).toBe("unsafe-path");
    expect(err.message).toContain("is not a lock file");
    expect(existsSync(outside)).toBe(false);
  });

  test("a link at a notes segment is refused for writing and for reading", async () => {
    const { vault, root } = await readyVault();
    const psn = await everyRecord(vault, "Sam");
    const segment = filesUnder(root).find((f) => f.endsWith("000001.sealed")) as string;
    const outside = join(tempDir("people-outside-"), "segment");
    writeFileSync(outside, "outside\n");
    renameSync(segment, `${segment}.moved`);
    symlinkSync(outside, segment);
    const write = await refused(() =>
      vault.appendClaimRevision(psn, { id: mintId("pcl"), rev: 0 }, { expectRev: 0 }),
    );
    expect(write.code).toBe("unsafe-path");
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
    expect((await refused(() => vault.readClaims(psn))).code).toBe("unsafe-path");
  });

  test("a link at the index is refused, and nothing is written through it", async () => {
    const { vault, root } = await readyVault();
    const index = filesUnder(root).find((f) => f.endsWith("index.json")) as string;
    const outside = join(tempDir("people-outside-"), "index.json");
    writeFileSync(outside, readFileSync(index));
    renameSync(index, `${index}.moved`);
    symlinkSync(outside, index);
    const before = readFileSync(outside, "utf8");
    const err = await refused(() =>
      vault.write((w) => w.createPerson({ kind: "synthetic", owner: OWNER, data: { label: "x" } })),
    );
    expect(err.code).toBe("unsafe-path");
    expect(readFileSync(outside, "utf8")).toBe(before);
  });
});
