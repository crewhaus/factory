import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnchorRecord,
  type AnchorStore,
  type AuditLog,
  AuditLogError,
  GENESIS_HASH,
  InMemoryAnchorStore,
  openAuditLog,
  verify,
} from "./index";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "audit-log-"));
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

async function makeLog(): Promise<AuditLog> {
  return openAuditLog({ rootDir: tmp, now: fixedNow(), day: () => FIXED_DAY });
}

describe("append + read", () => {
  test("first record uses GENESIS as prevHash", async () => {
    const log = await makeLog();
    const r = await log.append({ kind: "gateway_request", payload: { p: 1 } });
    expect(r.prevHash).toBe(GENESIS_HASH);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("subsequent records chain to the previous hash", async () => {
    const log = await makeLog();
    const a = await log.append({ kind: "model_call", payload: 1 });
    const b = await log.append({ kind: "model_call", payload: 2 });
    expect(b.prevHash).toBe(a.hash);
  });

  test("read yields records in append order", async () => {
    const log = await makeLog();
    await log.append({ kind: "model_call", payload: "a" });
    await log.append({ kind: "model_call", payload: "b" });
    const out: unknown[] = [];
    for await (const r of log.read()) out.push(r.payload);
    expect(out).toEqual(["a", "b"]);
  });
});

describe("verify (T4)", () => {
  test("clean chain reports ok=true and matches the tail anchor", async () => {
    const log = await makeLog();
    for (let i = 0; i < 10; i += 1) {
      await log.append({ kind: "policy_decision", payload: { i } });
    }
    const r = await verify(tmp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.recordsChecked).toBe(10);
      // The _chain-tail.json anchor exists and matches the surviving tail,
      // so the truncation guard actually ran (not the missing-anchor path).
      expect(r.anchorChecked).toBe(true);
    }
  });

  test("empty rootDir reports ok=true with 0 records", async () => {
    const r = await verify(join(tmp, "missing"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recordsChecked).toBe(0);
  });

  test("tampering with one byte of payload breaks the chain on that line", async () => {
    const log = await makeLog();
    await log.append({ kind: "model_call", payload: "first" });
    await log.append({ kind: "model_call", payload: "second" });
    await log.append({ kind: "model_call", payload: "third" });

    // Read the file and rewrite line 2 with a payload byte flipped.
    const file = join(tmp, `${FIXED_DAY}.jsonl`);
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const second = JSON.parse(lines[1] as string);
    // Tamper the payload but leave hash + prevHash intact — the chain
    // verification recomputes the body hash and notices the divergence.
    second.payload = "tampered";
    lines[1] = JSON.stringify(second);
    writeFileSync(file, `${lines.join("\n")}\n`);

    const r = await verify(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.line).toBe(2);
      expect(r.reason).toMatch(/hash mismatch/);
    }
  });

  test("tampering with prevHash to point at a sibling reports prevHash mismatch", async () => {
    const log = await makeLog();
    await log.append({ kind: "model_call", payload: 1 });
    await log.append({ kind: "model_call", payload: 2 });

    const file = join(tmp, `${FIXED_DAY}.jsonl`);
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const second = JSON.parse(lines[1] as string);
    // Replace prevHash with a different (but well-formed) hash.
    second.prevHash = "0".repeat(64);
    lines[1] = JSON.stringify(second);
    writeFileSync(file, `${lines.join("\n")}\n`);

    const r = await verify(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/prevHash mismatch/);
    }
  });

  test("malformed JSON line reports the line number", async () => {
    const log = await makeLog();
    await log.append({ kind: "model_call", payload: 1 });
    const file = join(tmp, `${FIXED_DAY}.jsonl`);
    writeFileSync(file, `${readFileSync(file, "utf8")}{not-json\n`);
    const r = await verify(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.line).toBe(2);
      expect(r.reason).toMatch(/malformed JSON/);
    }
  });

  test("a corrupt _chain-tail.json is reported, not thrown (no verifier DoS)", async () => {
    const log = await makeLog();
    await log.append({ kind: "model_call", payload: 1 });
    await log.append({ kind: "model_call", payload: 2 });

    // Garble the on-host anchor (a crash mid-write, or a one-byte attacker
    // edit, leaves invalid JSON). verify must surface this as a broken link
    // rather than crash with an unhandled JSON.parse throw.
    writeFileSync(join(tmp, "_chain-tail.json"), "{ this is not valid json");

    const r = await verify(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/chain-tail anchor unreadable/);
      expect(r.file).toMatch(/_chain-tail\.json$/);
      // The chain walk itself completed before the anchor was consulted.
      expect(r.recordsChecked).toBe(2);
    }
  });
});

describe("tail-truncation detection (CWE-345)", () => {
  const readLines = (file: string): string[] =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "");

  test("every record carries a 0-based, gapless seq", async () => {
    const log = await makeLog();
    for (let i = 0; i < 5; i += 1) {
      await log.append({ kind: "model_call", payload: i });
    }
    const seqs: number[] = [];
    for await (const r of log.read()) seqs.push(r.seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });

  test("the persisted chain-tail anchor records the last seq", async () => {
    const log = await makeLog();
    await log.append({ kind: "model_call", payload: "a" });
    await log.append({ kind: "model_call", payload: "b" });
    await log.append({ kind: "model_call", payload: "c" });
    const anchor = JSON.parse(readFileSync(join(tmp, "_chain-tail.json"), "utf8"));
    expect(anchor.seq).toBe(2);
    expect(anchor.day).toBe(FIXED_DAY);
    expect(anchor.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("truncating the last record is detected via the tail anchor", async () => {
    const log = await makeLog();
    await log.append({ kind: "secrets_access", payload: "sensitive-1" });
    await log.append({ kind: "secrets_access", payload: "sensitive-2" });
    await log.append({ kind: "secrets_access", payload: "sensitive-3" });

    // Attacker deletes the trailing record to erase their activity, but
    // leaves _chain-tail.json untouched. The survivors still chain cleanly
    // and their seq run (0,1) is gapless — only the independent anchor,
    // which still commits to the dropped record, reveals the truncation.
    const file = join(tmp, `${FIXED_DAY}.jsonl`);
    const lines = readLines(file);
    writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);

    const r = await verify(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/chain-tail anchor mismatch/);
      expect(r.recordsChecked).toBe(2);
    }
  });

  test("deleting the entire newest-day file is detected", async () => {
    const log = await makeLog();
    await log.append({ kind: "gateway_request", payload: 1 });
    await log.append({ kind: "gateway_request", payload: 2 });

    // rm the only day file but keep the anchor: the surviving chain is now
    // empty (ends at GENESIS) yet the anchor still points at a real hash.
    unlinkSync(join(tmp, `${FIXED_DAY}.jsonl`));

    const r = await verify(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/chain-tail anchor mismatch/);
  });

  test("deleting a record from the middle is detected as a seq gap", async () => {
    const log = await makeLog();
    await log.append({ kind: "model_call", payload: 0 });
    await log.append({ kind: "model_call", payload: 1 });
    await log.append({ kind: "model_call", payload: 2 });

    // Remove the middle line. prevHash linkage would also break, but the
    // gapless-seq assertion fires first on the now-missing seq 1.
    const file = join(tmp, `${FIXED_DAY}.jsonl`);
    const lines = readLines(file);
    writeFileSync(file, `${[lines[0], lines[2]].join("\n")}\n`);

    const r = await verify(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/seq gap|prevHash mismatch/);
  });

  test("a missing anchor is reported as a limitation, not a clean pass", async () => {
    const log = await makeLog();
    await log.append({ kind: "model_call", payload: 1 });
    await log.append({ kind: "model_call", payload: 2 });

    // Without the independent anchor, tail-truncation cannot be ruled out:
    // the surviving chain is internally consistent, so verify still reports
    // ok, but flags anchorChecked=false so callers know it is not proof of
    // completeness.
    unlinkSync(join(tmp, "_chain-tail.json"));

    const r = await verify(tmp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.recordsChecked).toBe(2);
      expect(r.anchorChecked).toBe(false);
    }
  });

  test("a legit append after verify still chains and verifies", async () => {
    const log = await makeLog();
    await log.append({ kind: "model_call", payload: 1 });
    const first = await verify(tmp);
    expect(first.ok).toBe(true);

    // Guard against over-blocking: continuing to append must keep seq
    // monotone and the anchor in sync, so a fresh verify still passes.
    await log.append({ kind: "model_call", payload: 2 });
    await log.append({ kind: "model_call", payload: 3 });
    const second = await verify(tmp);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.recordsChecked).toBe(3);
      expect(second.anchorChecked).toBe(true);
    }
  });
});

describe("file mode (T8)", () => {
  test("audit log files are created with owner-only permissions", async () => {
    const log = await makeLog();
    await log.append({ kind: "policy_decision", payload: {} });
    const file = join(tmp, `${FIXED_DAY}.jsonl`);
    const stat = await import("node:fs").then((m) => m.statSync(file));
    // Mask off file-type bits and check the lower 9 (rwx for u/g/o).
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("off-host anchor (#156-followup)", () => {
  const readLines = (file: string): string[] =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "");

  const makeLogWith = (store: AnchorStore): Promise<AuditLog> =>
    openAuditLog({ rootDir: tmp, now: fixedNow(), day: () => FIXED_DAY, anchorStore: store });

  // Simulate a same-uid attacker who not only truncates the JSONL but ALSO
  // rewrites _chain-tail.json to commit to the new (shorter) survivors — so
  // the on-host anchor check is defeated and only the off-host store can tell.
  const truncateAndRewriteOnHostAnchor = (keep: number): void => {
    const file = join(tmp, `${FIXED_DAY}.jsonl`);
    const lines = readLines(file);
    const survivors = lines.slice(0, keep);
    writeFileSync(file, `${survivors.join("\n")}\n`);
    const last = JSON.parse(survivors[survivors.length - 1] as string);
    writeFileSync(
      join(tmp, "_chain-tail.json"),
      JSON.stringify({ day: FIXED_DAY, hash: last.hash, seq: last.seq }),
    );
  };

  test("append best-effort mirrors the tail to the store", async () => {
    const store = new InMemoryAnchorStore();
    const log = await makeLogWith(store);
    const a = await log.append({ kind: "model_call", payload: 1 });
    const b = await log.append({ kind: "model_call", payload: 2 });

    const anchor = await store.getAnchor(tmp);
    expect(anchor).toEqual({ seq: b.seq, hash: b.hash });
    // The mirrored hash is the live tail, not a stale earlier record.
    expect(anchor?.hash).not.toBe(a.hash);
  });

  test("THREAT: external anchor ahead of a truncated+rewritten chain fails verify", async () => {
    const store = new InMemoryAnchorStore();
    const log = await makeLogWith(store);
    await log.append({ kind: "secrets_access", payload: "sensitive-1" });
    await log.append({ kind: "secrets_access", payload: "sensitive-2" });
    await log.append({ kind: "secrets_access", payload: "sensitive-3" });

    // The external store now witnesses seq 2. Attacker drops the last record
    // AND rewrites the on-host anchor to match the survivors (seq 1).
    truncateAndRewriteOnHostAnchor(2);

    // On-host-only verify is fooled — the lockstep rewrite makes survivors +
    // _chain-tail.json mutually consistent. This is the gap the follow-up closes.
    const fooled = await verify(tmp);
    expect(fooled.ok).toBe(true);
    if (fooled.ok) expect(fooled.externalAnchorChecked).toBe(false);

    // With the off-host anchor consulted, the dropped seq 2 is caught.
    const caught = await verify(tmp, { anchorStore: store });
    expect(caught.ok).toBe(false);
    if (!caught.ok) {
      expect(caught.reason).toMatch(/external anchor mismatch/);
      expect(caught.reason).toMatch(/seq 2/);
      expect(caught.recordsChecked).toBe(2);
    }
  });

  test("external anchor catches a wholesale delete that also removed the on-host anchor", async () => {
    const store = new InMemoryAnchorStore();
    const log = await makeLogWith(store);
    await log.append({ kind: "gateway_request", payload: 1 });
    await log.append({ kind: "gateway_request", payload: 2 });

    // Attacker rm's the day file AND the on-host anchor — nothing local is
    // left to contradict an empty trail. The external anchor still witnesses seq 1.
    unlinkSync(join(tmp, `${FIXED_DAY}.jsonl`));
    unlinkSync(join(tmp, "_chain-tail.json"));

    const r = await verify(tmp, { anchorStore: store });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/external anchor mismatch/);
  });

  test("external anchor catches a same-seq in-place tail rewrite", async () => {
    const store = new InMemoryAnchorStore();
    const log = await makeLogWith(store);
    await log.append({ kind: "model_call", payload: "a" });
    const tail = await log.append({ kind: "model_call", payload: "b" });

    // Re-forge the tail record's payload and re-chain it so the local walk +
    // on-host anchor accept it; the external anchor still pins the old hash.
    const file = join(tmp, `${FIXED_DAY}.jsonl`);
    const lines = readLines(file);
    const forged = JSON.parse(lines[1] as string);
    forged.payload = "forged";
    // Recompute a valid hash for the forged body so the hash-chain walk passes.
    const { createHash } = await import("node:crypto");
    const body = {
      ts: forged.ts,
      version: forged.version,
      kind: forged.kind,
      seq: forged.seq,
      payload: forged.payload,
    };
    forged.hash = createHash("sha256")
      .update(forged.prevHash)
      .update("|")
      .update(JSON.stringify(body))
      .digest("hex");
    lines[1] = JSON.stringify(forged);
    writeFileSync(file, `${lines.join("\n")}\n`);
    // Rewrite on-host anchor to the forged tip (lockstep), same seq.
    writeFileSync(
      join(tmp, "_chain-tail.json"),
      JSON.stringify({ day: FIXED_DAY, hash: forged.hash, seq: forged.seq }),
    );

    expect(forged.hash).not.toBe(tail.hash);
    const r = await verify(tmp, { anchorStore: store });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/external anchor mismatch/);
  });

  test("THREAT: a rewritten chain extended past the anchored seq is NOT benign lag", async () => {
    // Ops-review F8c regression: the lag case (anchor.seq < lastSeq) used to
    // be waved through automatically. An attacker who rewrites the WHOLE
    // chain (internally valid, on-host anchor in lockstep) and then appends
    // fresh records ends up with lastSeq > anchor.seq — indistinguishable
    // from benign put-lag unless the anchored hash is matched against the
    // surviving chain's record AT that seq.
    const store = new InMemoryAnchorStore();
    const log = await makeLogWith(store);
    await log.append({ kind: "secrets_access", payload: "original-1" });
    await log.append({ kind: "secrets_access", payload: "original-2" });
    const witnessed = await log.append({ kind: "secrets_access", payload: "original-3" });
    expect((await store.getAnchor(tmp))?.seq).toBe(witnessed.seq); // store pins seq 2

    // Rewrite: wipe the log and rebuild a fully valid chain from GENESIS with
    // different payloads, opened WITHOUT the store so the external anchor
    // stays at the original seq-2 hash. Then extend past the anchored height.
    unlinkSync(join(tmp, `${FIXED_DAY}.jsonl`));
    unlinkSync(join(tmp, "_chain-tail.json"));
    const rewritten = await openAuditLog({ rootDir: tmp, now: fixedNow(), day: () => FIXED_DAY });
    for (let i = 0; i < 5; i += 1) {
      await rewritten.append({ kind: "secrets_access", payload: `forged-${i}` });
    }

    // The rewritten chain is internally consistent and its on-host anchor
    // matches, so an on-host-only verify is fooled.
    const fooled = await verify(tmp);
    expect(fooled.ok).toBe(true);

    // With the store consulted, the anchored seq-2 hash no longer matches the
    // surviving chain's record at seq 2 — rewrite-plus-appends is caught.
    const caught = await verify(tmp, { anchorStore: store });
    expect(caught.ok).toBe(false);
    if (!caught.ok) {
      expect(caught.reason).toMatch(/external anchor mismatch/);
      expect(caught.reason).toMatch(/rewritten below the anchored height/);
      expect(caught.file).toBe("<external-anchor>");
    }
  });

  test("NO-REGRESSION: a chain that legitimately extends past a lagging anchor verifies", async () => {
    // Anchor lags behind newer appends (benign best-effort put lag): verify
    // must NOT flag it, or normal operation would be over-blocked.
    const store = new InMemoryAnchorStore();
    const log = await makeLogWith(store);
    await log.append({ kind: "model_call", payload: 1 });
    await log.append({ kind: "model_call", payload: 2 });
    // Snapshot the store as it was at seq 1, then append more "live" records.
    const lagging = await store.getAnchor(tmp);
    const stale = new InMemoryAnchorStore();
    await stale.putAnchor(tmp, lagging as AnchorRecord);
    await log.append({ kind: "model_call", payload: 3 });
    await log.append({ kind: "model_call", payload: 4 });

    const r = await verify(tmp, { anchorStore: stale });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.recordsChecked).toBe(4);
      expect(r.externalAnchorChecked).toBe(true);
      expect(r.anchorChecked).toBe(true);
    }
  });

  test("clean chain with a matching store reports externalAnchorChecked=true", async () => {
    const store = new InMemoryAnchorStore();
    const log = await makeLogWith(store);
    for (let i = 0; i < 4; i += 1) await log.append({ kind: "policy_decision", payload: i });
    const r = await verify(tmp, { anchorStore: store });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.recordsChecked).toBe(4);
      expect(r.externalAnchorChecked).toBe(true);
    }
  });

  test("verify without a store leaves externalAnchorChecked=false (no-op default)", async () => {
    const log = await makeLog();
    await log.append({ kind: "model_call", payload: 1 });
    const r = await verify(tmp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.anchorChecked).toBe(true);
      expect(r.externalAnchorChecked).toBe(false);
    }
  });

  test("a store with no anchor yet is reported as not-checked, not a failure", async () => {
    const log = await makeLog(); // opened WITHOUT a store, so nothing was published
    await log.append({ kind: "model_call", payload: 1 });
    const emptyStore = new InMemoryAnchorStore();
    const r = await verify(tmp, { anchorStore: emptyStore });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.externalAnchorChecked).toBe(false);
  });

  test("a getAnchor that throws degrades to not-checked (never fabricates tamper)", async () => {
    const log = await makeLog();
    await log.append({ kind: "model_call", payload: 1 });
    const flaky: AnchorStore = {
      async putAnchor(): Promise<void> {},
      async getAnchor(): Promise<AnchorRecord | undefined> {
        throw new Error("anchor backend offline");
      },
    };
    const r = await verify(tmp, { anchorStore: flaky });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.externalAnchorChecked).toBe(false);
  });

  test("a putAnchor that throws does not break the durable local append", async () => {
    const flaky: AnchorStore = {
      async putAnchor(): Promise<void> {
        throw new Error("WORM bucket unreachable");
      },
      async getAnchor(): Promise<AnchorRecord | undefined> {
        return undefined;
      },
    };
    const log = await makeLogWith(flaky);
    // The append must still succeed and the local chain remain verifiable.
    const rec = await log.append({ kind: "model_call", payload: "durable" });
    expect(rec.seq).toBe(0);
    const r = await verify(tmp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recordsChecked).toBe(1);
  });

  test("InMemoryAnchorStore is monotonic — a stale put cannot regress the tip", async () => {
    const store = new InMemoryAnchorStore();
    await store.putAnchor("log-a", { seq: 5, hash: "h5" });
    // A late/replayed lower-seq put is ignored so the witnessed tip never regresses.
    await store.putAnchor("log-a", { seq: 2, hash: "h2" });
    expect(await store.getAnchor("log-a")).toEqual({ seq: 5, hash: "h5" });
    // Distinct logIds are independent.
    expect(await store.getAnchor("log-b")).toBeUndefined();
  });
});

describe("openAuditLog input validation", () => {
  test("an empty rootDir throws AuditLogError", async () => {
    await expect(openAuditLog({ rootDir: "" })).rejects.toBeInstanceOf(AuditLogError);
  });

  test("a non-string rootDir throws AuditLogError with the config code", async () => {
    // The guard is `typeof rootDir !== "string" || rootDir === ""`; exercise the
    // typeof branch (distinct from the empty-string branch above).
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately bad input for the guard
      openAuditLog({ rootDir: undefined as any }),
    ).rejects.toMatchObject({ name: "AuditLogError", code: "config" });
  });
});

describe("default clock + day selector", () => {
  test("openAuditLog works with the built-in Date.now()/today defaults", async () => {
    // Opening WITHOUT `now`/`day` exercises the default `() => Date.now()`
    // clock and the default `todayStr` day selector (UTC ISO date). We assert
    // structural invariants rather than a fixed value so the test stays
    // deterministic despite using the real clock.
    const log = await openAuditLog({ rootDir: tmp });
    const before = Date.now();
    const rec = await log.append({ kind: "model_call", payload: { ok: true } });
    const after = Date.now();
    expect(rec.seq).toBe(0);
    expect(rec.prevHash).toBe(GENESIS_HASH);
    expect(rec.ts).toBeGreaterThanOrEqual(before);
    expect(rec.ts).toBeLessThanOrEqual(after);

    // The day file is named for today's UTC date (what `todayStr` returns).
    const today = new Date().toISOString().slice(0, 10);
    const lines = readFileSync(join(tmp, `${today}.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(1);

    // read() with the default day selector must round-trip the record back.
    const out: unknown[] = [];
    for await (const r of log.read()) out.push(r.payload);
    expect(out).toEqual([{ ok: true }]);

    const v = await verify(tmp);
    expect(v.ok).toBe(true);
  });
});

describe("read with an explicit day", () => {
  test("read({ day }) targets that day's file and round-trips its records", async () => {
    const log = await openAuditLog({ rootDir: tmp, now: fixedNow(), day: () => FIXED_DAY });
    await log.append({ kind: "model_call", payload: "x" });
    await log.append({ kind: "model_call", payload: "y" });

    // Explicitly request the known day instead of relying on the default.
    const out: unknown[] = [];
    for await (const r of log.read({ day: FIXED_DAY })) out.push(r.payload);
    expect(out).toEqual(["x", "y"]);
  });

  test("read({ day }) for a day with no file yields nothing", async () => {
    const log = await openAuditLog({ rootDir: tmp, now: fixedNow(), day: () => FIXED_DAY });
    await log.append({ kind: "model_call", payload: "x" });

    const out: unknown[] = [];
    for await (const r of log.read({ day: "1999-01-01" })) out.push(r.payload);
    expect(out).toEqual([]);
  });
});

describe("append evaluates the day selector once (midnight-boundary safety)", () => {
  test("the JSONL filename and the chain-tail day stay consistent across a boundary", async () => {
    // A `day` selector that flips on its SECOND call simulates an append that
    // straddles midnight. The record file and the persisted anchor's `day`
    // must agree (both the FIRST value), and the chain must still verify.
    const days = ["2026-05-08", "2026-05-09"];
    let calls = 0;
    const flippingDay = (): string => {
      const d = days[Math.min(calls, days.length - 1)] as string;
      calls += 1;
      return d;
    };

    const log = await openAuditLog({ rootDir: tmp, now: fixedNow(), day: flippingDay });
    const rec = await log.append({ kind: "model_call", payload: "boundary" });

    // The record landed in the FIRST day's file...
    const firstDayLines = readFileSync(join(tmp, "2026-05-08.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(firstDayLines).toHaveLength(1);

    // ...and the anchor's `day` matches that same file (not the flipped value).
    const anchor = JSON.parse(readFileSync(join(tmp, "_chain-tail.json"), "utf8"));
    expect(anchor.day).toBe("2026-05-08");
    expect(anchor.hash).toBe(rec.hash);

    // No second-day file was created by the single append.
    expect(() => readFileSync(join(tmp, "2026-05-09.jsonl"), "utf8")).toThrow();

    // The single append consumed exactly one `day()` evaluation post-fix.
    expect(calls).toBe(1);
  });
});
