import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isStoredActor } from "@crewhaus/control-contract";
import { ensureDigestKey, keyedDigest, readDigestKey } from "./digest";
import { controlFile, plant, removeTempDirs, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const FIXED_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

function harnessWithKey(hex: string = FIXED_KEY): string {
  const root = tempDir();
  plant(controlFile(root, "keys/digest.key"), `${hex}\n`);
  return root;
}

async function keyOf(root: string): Promise<CryptoKey> {
  const read = await readDigestKey(root);
  if (read.state !== "present") throw new Error(read.state);
  return read.hmac;
}

describe("keyedDigest", () => {
  test("a known answer: HMAC-SHA256 hex over the exact JSON array, a format that is pinned", async () => {
    const key = await keyOf(harnessWithKey());
    const expected = createHmac("sha256", Buffer.from(FIXED_KEY, "hex"))
      .update(JSON.stringify(["label", "one", "two"]))
      .digest("hex");
    expect(await keyedDigest(key, "label", ["one", "two"])).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the text is hashed as UTF-8", async () => {
    const key = await keyOf(harnessWithKey());
    const expected = createHmac("sha256", Buffer.from(FIXED_KEY, "hex"))
      .update(Buffer.from(JSON.stringify(["l", "é"]), "utf8"))
      .digest("hex");
    expect(await keyedDigest(key, "l", ["é"])).toBe(expected);
  });

  test("length-safe: moving a boundary changes the digest", async () => {
    const key = await keyOf(harnessWithKey());
    expect(await keyedDigest(key, "a", ["bc"])).not.toBe(await keyedDigest(key, "ab", ["c"]));
    expect(await keyedDigest(key, "l", ["a", "b"])).not.toBe(await keyedDigest(key, "l", ["ab"]));
  });

  test("another label or another harness's key gives another digest", async () => {
    const key = await keyOf(harnessWithKey());
    const other = await keyOf(harnessWithKey("ff".repeat(32)));
    expect(await keyedDigest(key, "input", ["x"])).not.toBe(
      await keyedDigest(key, "places", ["x"]),
    );
    expect(await keyedDigest(key, "input", ["x"])).not.toBe(
      await keyedDigest(other, "input", ["x"]),
    );
  });

  test("an unlinked actor's digest is a stored actor", async () => {
    const key = await keyOf(harnessWithKey());
    const digest = await keyedDigest(key, "local-actor", ["max@laptop"]);
    expect(isStoredActor(`local:#${digest}`)).toBe(true);
    expect(isStoredActor("local:max@laptop")).toBe(false);
  });
});

describe("the key file", () => {
  test("reading on a fresh harness is absent, and creates nothing", async () => {
    const root = tempDir();
    expect(await readDigestKey(root)).toEqual({ state: "absent" });
    expect(readdirSync(root)).toEqual([]);
  });

  test("ensure creates 64 lowercase hex and a newline, owner-only", async () => {
    const root = tempDir();
    const created = await ensureDigestKey(root);
    expect(created.state).toBe("present");
    const path = controlFile(root, "keys/digest.key");
    expect(readFileSync(path, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(controlFile(root, "keys")).mode & 0o777).toBe(0o700);
    }
  });

  test("the key ensure returns is the key on disk", async () => {
    const root = tempDir();
    const created = await ensureDigestKey(root);
    if (created.state !== "present") throw new Error(created.state);
    const hex = readFileSync(controlFile(root, "keys/digest.key"), "utf8").trim();
    const expected = createHmac("sha256", Buffer.from(hex, "hex"))
      .update(JSON.stringify(["l", "x"]))
      .digest("hex");
    expect(await keyedDigest(created.hmac, "l", ["x"])).toBe(expected);
    expect(await keyedDigest(await keyOf(root), "l", ["x"])).toBe(expected);
  });

  test("two concurrent ensures make one file and one key", async () => {
    const root = tempDir();
    const [a, b] = await Promise.all([ensureDigestKey(root), ensureDigestKey(root)]);
    if (a.state !== "present" || b.state !== "present") throw new Error("not present");
    expect(await keyedDigest(a.hmac, "l", ["x"])).toBe(await keyedDigest(b.hmac, "l", ["x"]));
    expect(readdirSync(controlFile(root, "keys"))).toEqual(["digest.key"]);
  });

  test("a later ensure returns the same key", async () => {
    const root = tempDir();
    const first = await ensureDigestKey(root);
    const before = readFileSync(controlFile(root, "keys/digest.key"), "utf8");
    const second = await ensureDigestKey(root);
    if (first.state !== "present" || second.state !== "present") throw new Error("not present");
    expect(readFileSync(controlFile(root, "keys/digest.key"), "utf8")).toBe(before);
    expect(await keyedDigest(first.hmac, "l", ["x"])).toBe(
      await keyedDigest(second.hmac, "l", ["x"]),
    );
  });

  test("an unreadable key is refused, not replaced", async () => {
    for (const body of [
      "short\n",
      "",
      `${"AB".repeat(32)}\n`,
      `${"ab".repeat(32)}`,
      "é".repeat(33),
    ]) {
      const root = tempDir();
      const path = controlFile(root, "keys/digest.key");
      plant(path, body);
      const read = await readDigestKey(root);
      expect(read.state).toBe("unreadable");
      const ensured = await ensureDigestKey(root);
      expect(ensured.state).toBe("unreadable");
      expect(readFileSync(path, "utf8")).toBe(body);
    }
  });

  test("a directory at the name is refused, not replaced", async () => {
    const root = tempDir();
    mkdirSync(controlFile(root, "keys/digest.key"), { recursive: true });
    expect((await ensureDigestKey(root)).state).toBe("unreadable");
    expect(statSync(controlFile(root, "keys/digest.key")).isDirectory()).toBe(true);
  });

  test("a refusal names the file, never the key's bytes", async () => {
    const root = harnessWithKey("zz".repeat(32));
    const read = await readDigestKey(root);
    if (read.state !== "unreadable") throw new Error(read.state);
    expect(read.reason).toContain("digest.key");
    expect(read.reason).not.toContain("zzzz");
    expect(existsSync(controlFile(root, "keys/digest.key"))).toBe(true);
  });
});
