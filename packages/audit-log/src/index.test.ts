import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditLog, GENESIS_HASH, openAuditLog, verify } from "./index";

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
