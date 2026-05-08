import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  test("clean chain reports ok=true", async () => {
    const log = await makeLog();
    for (let i = 0; i < 10; i += 1) {
      await log.append({ kind: "policy_decision", payload: { i } });
    }
    const r = await verify(tmp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recordsChecked).toBe(10);
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
