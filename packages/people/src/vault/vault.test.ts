/**
 * The vault: sealed records round-trip and refuse to open anywhere else, notes are
 * compare-and-set, the root is checked before anything is made, and reads write nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { VaultError } from "./files";
import {
  OWNER,
  fakeSecrets,
  filesUnder,
  mustOpen,
  readyVault,
  removeTempDirs,
  snapshot,
  tempDir,
} from "./test-helpers";
import { type Vault, type VaultObservation, normalizeNote, openVault } from "./vault";

afterAll(removeTempDirs);

type Note = { id: string; rev: number; area: string; value: string; situation?: string };

const note = (id: string, value: string): Note => ({ id, rev: 0, area: "communication", value });

async function person(vault: Vault, label = "Sam"): Promise<string> {
  return vault.write(async (w) => {
    const made = await w.createPerson({ kind: "personal", owner: OWNER, data: { label } });
    return made.person;
  });
}

async function addNote(vault: Vault, psn: string, value: string, id = mintId("pcl")) {
  const answer = await vault.appendClaimRevision(psn, note(id, value), { expectRev: 0 });
  if ("conflict" in answer) throw new Error("conflict");
  return id;
}

async function failure(run: () => Promise<unknown>): Promise<VaultError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof VaultError) return err;
    throw err;
  }
  throw new Error("expected a VaultError");
}

function spaceDir(root: string): string {
  const spaces = readdirSync(join(root, "spaces"));
  return join(root, "spaces", spaces[0] as string);
}

describe("round trips", () => {
  test("every record kind writes and reads back", async () => {
    const { vault } = await readyVault();
    const psn = await person(vault, "Sam");
    const pcl = await addNote(vault, psn, "Prefers short daily updates.");
    await vault.write(async (w) => {
      await w.writeRejected(psn, [{ fp: "ab", claim: pcl }]);
      w.appendExport(psn, {
        pex: mintId("pex"),
        at: "t",
        by: OWNER,
        counts: { notes: 1 },
        sha256: "0",
      });
      w.appendActivity(psn, {
        at: "t",
        actor: OWNER,
        event: "claim.created",
        counts: { notes: 1 },
      });
    });
    expect((await vault.readPerson<{ label: string }>(psn)).data.label).toBe("Sam");
    const claims = await vault.readClaims<Note>(psn);
    expect(claims.map((c) => [c.id, c.rev, c.value])).toEqual([
      [pcl, 1, "Prefers short daily updates."],
    ]);
    expect(await vault.readRejected(psn)).toEqual([{ fp: "ab", claim: pcl }]);
    expect(vault.readExports(psn)).toHaveLength(1);
    expect(vault.readActivity(psn, 10).rows.map((r) => r.event)).toEqual(["claim.created"]);
    expect(vault.row(psn)).toEqual({
      person: psn,
      kind: "personal",
      owner: OWNER,
      viewers: [],
      rev: 1,
      state: "active",
    });
  });

  test("a wrong space key is locked, with the reason, before any record is read", async () => {
    const { root, secrets } = await readyVault();
    for (const [name, value] of secrets.items) {
      secrets.items.set(name, `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`);
    }
    const reopened = mustOpen({ root, secrets });
    const status = await reopened.status();
    expect(status).toEqual(
      expect.objectContaining({
        state: "locked",
        reason: "The key in the credential store does not open these profiles.",
      }),
    );
    const err = await failure(() => reopened.readPerson(mintId("psn")));
    expect(err.code).toBe("locked");
  });

  test("a notes segment copied into another profile does not open there", async () => {
    const { vault, root } = await readyVault();
    const sam = await person(vault, "Sam");
    const dana = await person(vault, "Dana");
    await addNote(vault, sam, "Prefers short daily updates.");
    const persons = join(spaceDir(root), "persons");
    cpSync(join(persons, sam, "claims"), join(persons, dana, "claims"), { recursive: true });
    const err = await failure(() => vault.readClaims(dana));
    expect(err.code).toBe("tampered");
    expect(err.message).toBe(
      `A sealed note of profile ${dana} does not open: it was changed, moved from another profile or replayed.`,
    );
  });

  test("a person key copied to another profile does not open there", async () => {
    const { vault, root, secrets } = await readyVault();
    const sam = await person(vault, "Sam");
    const dana = await person(vault, "Dana");
    const persons = join(spaceDir(root), "persons");
    cpSync(join(persons, sam, "key.json"), join(persons, dana, "key.json"));
    // A cold cache, as the next command would have.
    const reopened = mustOpen({ root, secrets });
    const err = await failure(() => reopened.readPerson(dana));
    expect(err.code).toBe("tampered");
    expect(err.message).toContain(`The key of profile ${dana} does not open`);
    expect((await reopened.readPerson<{ label: string }>(sam)).data.label).toBe("Sam");
  });

  test("a revision replayed at another revision, and a flipped byte, do not open", async () => {
    const { vault, root } = await readyVault();
    const psn = await person(vault);
    await addNote(vault, psn, "Prefers short daily updates.");
    const segment = join(spaceDir(root), "persons", psn, "claims", "000001.sealed");
    const original = readFileSync(segment, "utf8");
    writeFileSync(segment, original.replace('"rev":1', '"rev":2'));
    expect((await failure(() => vault.readClaims(psn))).code).toBe("tampered");
    const line = JSON.parse(original) as { ct: string };
    const flipped = `${line.ct[0] === "0" ? "1" : "0"}${line.ct.slice(1)}`;
    writeFileSync(segment, original.replace(line.ct, flipped));
    const err = await failure(() => vault.readClaims(psn));
    expect(err.code).toBe("tampered");
    expect(err.message).toContain("A sealed note");
  });
});

describe("compare-and-set", () => {
  test("two writers at revision 3: the second is told the current note, at revision 4", async () => {
    const { vault } = await readyVault();
    const psn = await person(vault);
    const pcl = await addNote(vault, psn, "one");
    for (const [rev, value] of [
      [1, "two"],
      [2, "three"],
    ] as const) {
      const answer = await vault.appendClaimRevision(psn, note(pcl, value), { expectRev: rev });
      expect("conflict" in answer).toBe(false);
    }
    const first = await vault.appendClaimRevision(psn, note(pcl, "four"), { expectRev: 3 });
    expect(first).toEqual({ rev: 4, claim: { ...note(pcl, "four"), rev: 4 } });
    const second = await vault.appendClaimRevision(psn, note(pcl, "other"), { expectRev: 3 });
    expect(second).toEqual({
      conflict: "stale_claim_revision",
      current: { ...note(pcl, "four"), rev: 4 },
    });
    expect((await vault.readClaims<Note>(psn)).map((c) => c.value)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
  });

  test("a profile update is compare-and-set too", async () => {
    const { vault } = await readyVault();
    const psn = await person(vault, "Sam");
    const ok = await vault.write((w) => w.updatePerson(psn, { label: "Samuel" }, { expectRev: 1 }));
    expect(ok).toEqual({ rev: 2 });
    const stale = await vault.write((w) => w.updatePerson(psn, { label: "S" }, { expectRev: 1 }));
    expect(stale).toEqual({
      conflict: "stale_person_revision",
      current: { rev: 2, data: { label: "Samuel" } },
    });
  });
});

describe("the root", () => {
  test("a root under a .git ancestor is refused and nothing is created", () => {
    const base = tempDir();
    mkdirSync(join(base, "repo", ".git"), { recursive: true });
    const root = join(base, "repo", "home", "people");
    const refused = openVault({ root, secrets: fakeSecrets() });
    expect(refused).toEqual({
      ok: false,
      code: "in-git-work-tree",
      reason: `Profiles can't be kept inside a git work tree (${join(base, "repo")}), where they could be committed. Set CREWHAUS_HANGAR_ROOT to a directory outside it.`,
    });
    expect(existsSync(join(base, "repo", "home"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "a root reached through a link into a git work tree is refused by its physical path",
    () => {
      const base = tempDir();
      mkdirSync(join(base, "repo", ".git"), { recursive: true });
      mkdirSync(join(base, "repo", "sub"));
      // No ancestor of the name holds .git; the directory the link leads into does.
      symlinkSync(join(base, "repo", "sub"), join(base, "elsewhere"));
      const refused = openVault({ root: join(base, "elsewhere", "a", "b", "people") });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.code).toBe("in-git-work-tree");
        expect(refused.reason).toContain(`(${join(base, "repo")})`);
      }
      expect(readdirSync(join(base, "repo", "sub"))).toEqual([]);
    },
  );

  test("a root at or under a registered harness directory is refused and nothing is created", () => {
    const base = tempDir();
    const harness = join(base, "steward");
    mkdirSync(harness);
    for (const root of [harness, join(harness, ".crewhaus", "people")]) {
      const refused = openVault({ root, harnessDirs: [harness] });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.code).toBe("in-harness");
        expect(refused.reason).toContain("CREWHAUS_HANGAR_ROOT");
      }
    }
    expect(readdirSync(harness)).toEqual([]);
  });

  test("an ancestor holding only .crewhaus is not a harness: the default root is accepted", async () => {
    const base = tempDir();
    mkdirSync(join(base, ".crewhaus"));
    const root = join(base, ".crewhaus", "hangar", "people");
    const vault = mustOpen({ root, secrets: fakeSecrets(), harnessDirs: [join(base, "other")] });
    expect((await vault.setUp({ custody: "keychain", owner: OWNER })).created).toBe(true);
  });
});

describe("work", () => {
  test("listing N profiles opens each one's record exactly once, and writes nothing", async () => {
    const events: VaultObservation[] = [];
    const { vault, root, secrets } = await readyVault();
    const ids: string[] = [];
    for (const name of ["A", "B", "C", "D"]) ids.push(await person(vault, name));
    const counted = mustOpen({ root, secrets, observe: (event) => events.push(event) });
    for (const row of counted.rows()) await counted.readPerson(row.person);
    const opens = events.filter((e) => e.op === "open" && e.record === "person");
    expect(opens.map((e) => (e as { person: string }).person).sort()).toEqual([...ids].sort());
    expect(events.filter((e) => e.op === "write")).toEqual([]);
  });

  test("reads change no byte and no modification time, and create nothing", async () => {
    const { vault, root } = await readyVault();
    const psn = await person(vault);
    await addNote(vault, psn, "a note");
    const before = snapshot([root]);
    await vault.status();
    vault.rows();
    await vault.readPerson(psn);
    await vault.readClaims(psn);
    await vault.readRejected(psn);
    vault.readExports(psn);
    vault.readActivity(psn, 5);
    await vault.inventory(psn);
    await vault.erasureNonce(psn, "d", 1);
    expect(snapshot([root])).toEqual(before);
  });

  test("a vault not set up answers so, and its reads create nothing", async () => {
    const base = tempDir();
    const root = join(base, "hangar", "people");
    const vault = mustOpen({ root, secrets: fakeSecrets() });
    expect(await vault.status()).toEqual({ state: "not-set-up" });
    expect(vault.rows()).toEqual([]);
    expect(filesUnder(base)).toEqual([]);
    expect(readdirSync(base)).toEqual([]);
  });
});

test("notes compare by meaning: case, spacing and compatible forms fold", () => {
  expect(normalizeNote("  Prefers\tSHORT\n updates ")).toBe("prefers short updates");
  expect(normalizeNote("ﬁne")).toBe("fine");
});
