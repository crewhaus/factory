import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAnchorStore, FileAnchorStoreError, openAuditLog, verify } from "./index";

let tmp: string;
let anchorDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "file-anchor-"));
  anchorDir = join(tmp, "anchors");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const fixedNow = (start = 1_700_000_000_000): (() => number) => {
  let t = start;
  return () => {
    t += 1;
    return t;
  };
};

const FIXED_DAY = "2026-05-08";

describe("FileAnchorStore — AnchorStore contract", () => {
  test("put + get round-trips the latest anchor", async () => {
    const store = new FileAnchorStore(anchorDir);
    await store.putAnchor("log-a", { seq: 0, hash: "h0" });
    await store.putAnchor("log-a", { seq: 1, hash: "h1" });
    expect(await store.getAnchor("log-a")).toEqual({ seq: 1, hash: "h1" });
  });

  test("getAnchor returns undefined for a logId never put (and for a missing dir)", async () => {
    const store = new FileAnchorStore(anchorDir);
    expect(await store.getAnchor("never-seen")).toBeUndefined();
  });

  test("monotonic — a stale lower-seq put cannot regress the witnessed tip", async () => {
    const store = new FileAnchorStore(anchorDir);
    await store.putAnchor("log-a", { seq: 5, hash: "h5" });
    await store.putAnchor("log-a", { seq: 2, hash: "h2" });
    expect(await store.getAnchor("log-a")).toEqual({ seq: 5, hash: "h5" });
  });

  test("an equal-seq put overwrites, matching InMemoryAnchorStore semantics", async () => {
    const store = new FileAnchorStore(anchorDir);
    await store.putAnchor("log-a", { seq: 3, hash: "old" });
    await store.putAnchor("log-a", { seq: 3, hash: "new" });
    expect(await store.getAnchor("log-a")).toEqual({ seq: 3, hash: "new" });
  });

  test("distinct logIds are independent files", async () => {
    const store = new FileAnchorStore(anchorDir);
    await store.putAnchor("log-a", { seq: 1, hash: "ha" });
    await store.putAnchor("log-b", { seq: 9, hash: "hb" });
    expect(await store.getAnchor("log-a")).toEqual({ seq: 1, hash: "ha" });
    expect(await store.getAnchor("log-b")).toEqual({ seq: 9, hash: "hb" });
    expect(readdirSync(anchorDir)).toHaveLength(2);
  });

  test("anchors survive across store instances (durability the in-memory store lacks)", async () => {
    const writer = new FileAnchorStore(anchorDir);
    await writer.putAnchor("/abs/audit/root", { seq: 4, hash: "h4" });
    const reader = new FileAnchorStore(anchorDir);
    expect(await reader.getAnchor("/abs/audit/root")).toEqual({ seq: 4, hash: "h4" });
  });

  test("the anchor file is append-only — every accepted put is retained as a line", async () => {
    const store = new FileAnchorStore(anchorDir, { now: fixedNow() });
    await store.putAnchor("log-a", { seq: 0, hash: "h0" });
    await store.putAnchor("log-a", { seq: 1, hash: "h1" });
    await store.putAnchor("log-a", { seq: 0, hash: "stale" }); // skipped, not written
    const file = join(anchorDir, readdirSync(anchorDir)[0] as string);
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ logId: "log-a", seq: 0, hash: "h0" });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ logId: "log-a", seq: 1, hash: "h1" });
  });

  test("a path-separator-laden logId cannot escape the anchor dir", async () => {
    const store = new FileAnchorStore(anchorDir);
    await store.putAnchor("../../etc/evil", { seq: 0, hash: "h" });
    // The write landed INSIDE anchorDir under a sanitized name.
    const files = readdirSync(anchorDir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("/");
    expect(await store.getAnchor("../../etc/evil")).toEqual({ seq: 0, hash: "h" });
  });

  test("anchor files are 0o600 and the directory 0o700 (owner-only)", async () => {
    const store = new FileAnchorStore(anchorDir);
    await store.putAnchor("log-a", { seq: 0, hash: "h" });
    expect(statSync(anchorDir).mode & 0o777).toBe(0o700);
    const file = join(anchorDir, readdirSync(anchorDir)[0] as string);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a corrupt anchor line makes getAnchor THROW (never silently drop a witness)", async () => {
    const store = new FileAnchorStore(anchorDir);
    await store.putAnchor("log-a", { seq: 1, hash: "h1" });
    const file = join(anchorDir, readdirSync(anchorDir)[0] as string);
    writeFileSync(file, `${readFileSync(file, "utf8")}{not-json\n`);
    await expect(store.getAnchor("log-a")).rejects.toThrow(/malformed JSON/);
  });

  test("a well-formed line for the WRONG logId in the file is rejected, not returned", async () => {
    const store = new FileAnchorStore(anchorDir);
    await store.putAnchor("log-a", { seq: 1, hash: "h1" });
    const file = join(anchorDir, readdirSync(anchorDir)[0] as string);
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}${JSON.stringify({ logId: "log-b", seq: 9, hash: "hx", ts: 1 })}\n`,
    );
    await expect(store.getAnchor("log-a")).rejects.toThrow(/invalid anchor/);
  });

  test("constructor and putAnchor validate their inputs", async () => {
    expect(() => new FileAnchorStore("")).toThrow(FileAnchorStoreError);
    const store = new FileAnchorStore(anchorDir);
    await expect(store.putAnchor("log-a", { seq: Number.NaN, hash: "h" })).rejects.toBeInstanceOf(
      FileAnchorStoreError,
    );
    await expect(store.putAnchor("log-a", { seq: 0, hash: "" })).rejects.toBeInstanceOf(
      FileAnchorStoreError,
    );
  });
});

describe("FileAnchorStore + verify integration", () => {
  test("clean chain cross-checks against the file store (externalAnchorChecked=true)", async () => {
    const store = new FileAnchorStore(anchorDir);
    const logDir = join(tmp, "audit");
    const log = await openAuditLog({
      rootDir: logDir,
      now: fixedNow(),
      day: () => FIXED_DAY,
      anchorStore: store,
    });
    for (let i = 0; i < 3; i += 1) await log.append({ kind: "policy_decision", payload: i });

    const r = await verify(logDir, { anchorStore: store });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.recordsChecked).toBe(3);
      expect(r.anchorChecked).toBe(true);
      expect(r.externalAnchorChecked).toBe(true);
    }
  });

  test("THREAT: truncation + lockstep on-host anchor rewrite is caught by the file store", async () => {
    const store = new FileAnchorStore(anchorDir);
    const logDir = join(tmp, "audit");
    const log = await openAuditLog({
      rootDir: logDir,
      now: fixedNow(),
      day: () => FIXED_DAY,
      anchorStore: store,
    });
    await log.append({ kind: "secrets_access", payload: "sensitive-1" });
    await log.append({ kind: "secrets_access", payload: "sensitive-2" });
    await log.append({ kind: "secrets_access", payload: "sensitive-3" });

    // Same-uid attacker: drop the last record AND rewrite _chain-tail.json to
    // commit to the shorter survivors — on-host-only verify is fooled.
    const dayFile = join(logDir, `${FIXED_DAY}.jsonl`);
    const lines = readFileSync(dayFile, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const survivors = lines.slice(0, 2);
    writeFileSync(dayFile, `${survivors.join("\n")}\n`);
    const last = JSON.parse(survivors[1] as string);
    writeFileSync(
      join(logDir, "_chain-tail.json"),
      JSON.stringify({ day: FIXED_DAY, hash: last.hash, seq: last.seq }),
    );
    const fooled = await verify(logDir);
    expect(fooled.ok).toBe(true);

    // The file store (on a dir the attacker could not reach) still witnesses seq 2.
    const caught = await verify(logDir, { anchorStore: store });
    expect(caught.ok).toBe(false);
    if (!caught.ok) expect(caught.reason).toMatch(/external anchor mismatch/);
  });
});
