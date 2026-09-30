/**
 * 0.7.1 — every file in the audit directory is a regular file the writer
 * made (security-5#2, flag-truth-3#6).
 *
 * `verify` used to `readdir` the directory and `createReadStream` every
 * `*.jsonl`, then `readFileSync` `_chain-tail.json`, all following links: a
 * chain file linked to an outside file was read, and its first token came
 * back in the "malformed JSON" / "prevHash mismatch" reason; a FIFO blocked
 * the walk for ever. The writer appended and wrote the anchor through a link
 * the same way. Each case asserts the outside file's bytes, or that its text
 * is absent from the result, not only that verification failed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogError, CHAIN_TAIL_FILENAME, listChainFiles, openAuditLog, verify } from "./index";
import { _leafSeamsForTest } from "./leaf";

let tmp: string;
let outside: string;
const DAY = "2026-05-08";
const SECRET = ["SECRET", "_Z", "LEAKTEST"].join("");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "audit-log-kinds-"));
  outside = mkdtempSync(join(tmpdir(), "audit-log-outside-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function seed(records = 3): Promise<void> {
  let t = 1_700_000_000_000;
  const log = await openAuditLog({ rootDir: tmp, now: () => ++t, day: () => DAY });
  for (let i = 0; i < records; i++) await log.append({ kind: "model_call", payload: { i } });
}

describe("verify refuses what the writer never makes", () => {
  test("a chain file that is a link to an outside file is a break, and its text is not read", async () => {
    await seed();
    writeFileSync(join(outside, "secret.txt"), `${SECRET} rest\n`);
    symlinkSync(join(outside, "secret.txt"), join(tmp, "2026-01-01.jsonl"));
    const r = await verify(tmp);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/2026-01-01\.jsonl" is a symbolic link, not a regular file/);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.recordsChecked).toBe(0);
  });

  test("a _chain-tail.json linked to an outside anchor is a break, and its hash is not quoted", async () => {
    await seed();
    unlinkSync(join(tmp, CHAIN_TAIL_FILENAME));
    writeFileSync(join(outside, "tail.json"), JSON.stringify({ day: "d", hash: SECRET, seq: 2 }));
    symlinkSync(join(outside, "tail.json"), join(tmp, CHAIN_TAIL_FILENAME));
    const r = await verify(tmp);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  // In a child process: a regression BLOCKS on the FIFO, and a blocked test
  // would hang the suite instead of failing.
  test.skipIf(process.platform === "win32")(
    "a FIFO chain file is a break, returned promptly",
    async () => {
      await seed();
      expect(Bun.spawnSync(["mkfifo", join(tmp, "9999-12-31.jsonl")]).exitCode).toBe(0);
      const script = `
        const { verify } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
        console.log(JSON.stringify(await verify(${JSON.stringify(tmp)})));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const text = await new Response(child.stdout).text();
      clearTimeout(killer);
      expect(await child.exited).toBe(0);
      const r = JSON.parse(text);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/is a fifo, not a regular file/);
    },
    20_000,
  );

  test("an untouched chain still verifies, with the anchor checked", async () => {
    await seed();
    expect(await verify(tmp)).toEqual({
      ok: true,
      recordsChecked: 3,
      anchorChecked: true,
      externalAnchorChecked: false,
    });
  });

  test("listChainFiles sums exactly the regular files verify walks", async () => {
    await seed();
    const listed = listChainFiles(tmp);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.files).toEqual([`${DAY}.jsonl`]);
    expect(listed.bytes).toBe(lstatSync(join(tmp, `${DAY}.jsonl`)).size);
    expect(listed.tailBytes).toBe(lstatSync(join(tmp, CHAIN_TAIL_FILENAME)).size);
  });

  // The ops review: a chain file the verifier cannot READ (audit files are
  // created 0600, so any other user or CI job meets this) came back as a
  // break, which `crewhaus audit verify` prints as "✗ tamper finding" and
  // doctor fails on. 0.7.0 threw. "Could not verify" is not a verdict.
  // Root reads a 0o000 file anyway, so the case means nothing there.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a chain file that cannot be read is an error, never a tamper finding",
    async () => {
      await seed();
      const day = join(tmp, `${DAY}.jsonl`);
      chmodSync(day, 0o000);
      try {
        const err = await verify(tmp).then(
          (r) => r,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(AuditLogError);
        expect((err as Error).message).toContain(
          "could not be verified, which is not a tamper finding",
        );
        expect((err as Error).message).toContain(`"${DAY}.jsonl" cannot be read`);
        expect((err as Error).message).not.toContain(tmp);
      } finally {
        chmodSync(day, 0o600);
      }
      // Readable again, the same chain verifies: nothing was wrong with it.
      expect((await verify(tmp)).ok).toBe(true);
    },
  );

  // A directory that can be listed but not searched: `lstat` of an entry
  // fails with EACCES, which the pre-check reported as the break.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an entry that cannot be examined is an error from the listing too",
    async () => {
      await seed();
      chmodSync(tmp, 0o400);
      try {
        expect(() => listChainFiles(tmp)).toThrow(AuditLogError);
        expect(() => listChainFiles(tmp)).toThrow(
          /could not be verified, which is not a tamper finding/,
        );
      } finally {
        chmodSync(tmp, 0o700);
      }
    },
  );
});

describe("the writer never writes through a link", () => {
  test("a day file linked out is refused, and the outside file is not appended to", async () => {
    const target = join(outside, "profile");
    writeFileSync(target, "export A=1\n");
    symlinkSync(target, join(tmp, `${DAY}.jsonl`));
    const log = await openAuditLog({ rootDir: tmp, day: () => DAY });
    await expect(log.append({ kind: "model_call", payload: 1 })).rejects.toBeInstanceOf(
      AuditLogError,
    );
    expect(readFileSync(target, "utf8")).toBe("export A=1\n");
  });

  test("a dangling _chain-tail.json link is refused, and its target never created", async () => {
    await seed(1);
    unlinkSync(join(tmp, CHAIN_TAIL_FILENAME));
    symlinkSync(join(outside, "created.json"), join(tmp, CHAIN_TAIL_FILENAME));
    const log = await openAuditLog({ rootDir: tmp, day: () => DAY });
    await expect(log.append({ kind: "model_call", payload: 2 })).rejects.toBeInstanceOf(
      AuditLogError,
    );
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("the anchor is rewritten in place, and a failed anchor write never forks the chain", () => {
  async function seqsOnDisk(): Promise<number[]> {
    return readFileSync(join(tmp, `${DAY}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { seq: number }).seq);
  }

  // The first 0.7.1 cut replaced the anchor by temp + rename. In a directory
  // flagged append-only, entries can be added but never replaced, so every
  // append after the first threw after its record was written, left a temp
  // behind, and re-used the stale anchor's seq: seqs [0,1,1,1], a verify
  // failure that reads as tampering. 0.7.0 rewrote the anchor in place.
  test.skipIf(process.platform !== "darwin")(
    "an append-only directory (chflags uappnd) keeps a gapless, verifying chain",
    async () => {
      await seed(1);
      const log = await openAuditLog({
        rootDir: tmp,
        now: () => 1_800_000_000_000,
        day: () => DAY,
      });
      expect(Bun.spawnSync(["chflags", "uappnd", tmp]).exitCode).toBe(0);
      const errors: string[] = [];
      try {
        for (let i = 1; i <= 3; i++) {
          await log.append({ kind: "model_call", payload: { i } }).catch((err: Error) => {
            errors.push(err.message);
          });
        }
      } finally {
        Bun.spawnSync(["chflags", "nouappnd", tmp]);
      }
      expect(errors).toEqual([]);
      expect(await seqsOnDisk()).toEqual([0, 1, 2, 3]);
      expect(readdirSync(tmp).sort()).toEqual([`${DAY}.jsonl`, CHAIN_TAIL_FILENAME]);
      expect((await verify(tmp)).ok).toBe(true);
    },
  );

  // Platform-independent: an anchor the writer cannot open for writing
  // (0o400). Root ignores the mode, so the case means nothing there.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an append whose anchor write fails says so, and the next append continues from its record",
    async () => {
      await seed(1);
      const log = await openAuditLog({
        rootDir: tmp,
        now: () => 1_800_000_000_000,
        day: () => DAY,
      });
      const anchor = join(tmp, CHAIN_TAIL_FILENAME);
      chmodSync(anchor, 0o400);
      const errors: string[] = [];
      try {
        for (let i = 1; i <= 2; i++) {
          await log.append({ kind: "model_call", payload: { i } }).catch((err: Error) => {
            errors.push(err.message);
          });
        }
      } finally {
        chmodSync(anchor, 0o600);
      }
      expect(errors.length).toBe(2);
      expect(errors[0]).toMatch(
        /the record was appended to 2026-05-08\.jsonl \(seq 1\), but the anchor was not updated/,
      );
      expect(errors[1]).toMatch(/\(seq 2\)/);
      expect(errors.join("\n")).not.toContain(tmp);
      await log.append({ kind: "model_call", payload: { i: 3 } });
      expect(await seqsOnDisk()).toEqual([0, 1, 2, 3]);
      expect(await verify(tmp)).toEqual({
        ok: true,
        recordsChecked: 4,
        anchorChecked: true,
        externalAnchorChecked: false,
      });
    },
  );

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "once another writer has moved the anchor, the lagging tip is dropped and the anchor wins",
    async () => {
      await seed(1);
      const a = await openAuditLog({ rootDir: tmp, now: () => 1_800_000_000_000, day: () => DAY });
      const anchor = join(tmp, CHAIN_TAIL_FILENAME);
      chmodSync(anchor, 0o400);
      try {
        await expect(a.append({ kind: "model_call", payload: "a1" })).rejects.toBeInstanceOf(
          AuditLogError,
        );
      } finally {
        chmodSync(anchor, 0o600);
      }
      const b = await openAuditLog({ rootDir: tmp, now: () => 1_800_000_000_001, day: () => DAY });
      const fromB = await b.append({ kind: "model_call", payload: "b1" });
      const fromA = await a.append({ kind: "model_call", payload: "a2" });
      expect({ seq: fromA.seq, prevHash: fromA.prevHash }).toEqual({
        seq: fromB.seq + 1,
        prevHash: fromB.hash,
      });
    },
  );

  test("another writer's anchor is honoured: the lagging tip is used only while the anchor is unchanged", async () => {
    await seed(1);
    const a = await openAuditLog({ rootDir: tmp, now: () => 1_800_000_000_000, day: () => DAY });
    const b = await openAuditLog({ rootDir: tmp, now: () => 1_800_000_000_001, day: () => DAY });
    // Interleaved writers over one directory, as before: each reads the anchor.
    await a.append({ kind: "model_call", payload: "a1" });
    await b.append({ kind: "model_call", payload: "b1" });
    await a.append({ kind: "model_call", payload: "a2" });
    expect(await seqsOnDisk()).toEqual([0, 1, 2, 3]);
    expect((await verify(tmp)).ok).toBe(true);
  });

  // In a child process: a regression BLOCKS on the FIFO.
  test.skipIf(process.platform === "win32")(
    "a FIFO at the anchor or the day file is refused promptly, and never written",
    async () => {
      await seed(1);
      const anchor = join(tmp, CHAIN_TAIL_FILENAME);
      unlinkSync(anchor);
      expect(Bun.spawnSync(["mkfifo", anchor]).exitCode).toBe(0);
      expect(Bun.spawnSync(["mkfifo", join(tmp, "2026-05-09.jsonl")]).exitCode).toBe(0);
      const dayFifo = join(tmp, "2026-05-09.jsonl");
      // First the anchor is the FIFO; then, with the anchor gone, the day file.
      const script = `
        const { unlinkSync } = await import("node:fs");
        const { openAuditLog } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
        const out = [];
        const attempt = async (day) => {
          const log = await openAuditLog({ rootDir: ${JSON.stringify(tmp)}, day: () => day });
          try { await log.append({ kind: "model_call", payload: 1 }); out.push("wrote"); }
          catch (err) { out.push(err.message); }
        };
        await attempt("2026-05-08");
        unlinkSync(${JSON.stringify(anchor)});
        await attempt("2026-05-09");
        console.log(JSON.stringify(out));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const text = await new Response(child.stdout).text();
      clearTimeout(killer);
      expect(await child.exited).toBe(0);
      const out = JSON.parse(text) as string[];
      expect(out.length).toBe(2);
      expect(out[0]).toMatch(/"_chain-tail\.json" is a fifo, not a regular file/);
      expect(out[1]).toMatch(
        /could not append to 2026-05-09\.jsonl: "2026-05-09\.jsonl" is a fifo/,
      );
      expect(lstatSync(dayFifo).isFIFO()).toBe(true);
    },
    20_000,
  );
});

describe("the leaf checks, one by one", () => {
  // Each in a child process: a regression BLOCKS on the FIFO.
  async function inChild(body: string): Promise<unknown> {
    const script = `
      const fs = await import("node:fs");
      const { openAuditLog } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
      const { _leafSeamsForTest } = await import(${JSON.stringify(join(import.meta.dir, "leaf.ts"))});
      const seams = _leafSeamsForTest();
      const rootDir = ${JSON.stringify(tmp)};
      const anchor = ${JSON.stringify(join(tmp, CHAIN_TAIL_FILENAME))};
      ${body}
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const text = await new Response(child.stdout).text();
    clearTimeout(killer);
    return { exit: await child.exited, out: text.trim() === "" ? undefined : JSON.parse(text) };
  }

  test.skipIf(process.platform === "win32")(
    "a FIFO found by lstat is refused without being opened",
    async () => {
      await seed(1);
      unlinkSync(join(tmp, CHAIN_TAIL_FILENAME));
      expect(Bun.spawnSync(["mkfifo", join(tmp, CHAIN_TAIL_FILENAME)]).exitCode).toBe(0);
      const result = await inChild(`
        const log = await openAuditLog({ rootDir, day: () => "2026-05-08" });
        const before = seams.opens;
        const message = await log.append({ kind: "model_call", payload: 1 }).then(() => "wrote", (e) => e.message);
        console.log(JSON.stringify({ opens: seams.opens - before, fifo: /is a fifo/.test(message) }));
      `);
      expect(result).toEqual({ exit: 0, out: { opens: 0, fifo: true } });
    },
    20_000,
  );

  test.skipIf(process.platform === "win32")(
    "a FIFO swapped in after the lstat is refused without blocking",
    async () => {
      await seed(1);
      const result = await inChild(`
        const log = await openAuditLog({ rootDir, day: () => "2026-05-08" });
        seams.afterLstat = (file) => {
          if (file !== anchor) return;
          seams.afterLstat = undefined;
          fs.unlinkSync(anchor);
          Bun.spawnSync(["mkfifo", anchor]);
        };
        const message = await log.append({ kind: "model_call", payload: 1 }).then(() => "wrote", (e) => e.message);
        console.log(JSON.stringify({ fifo: /is a fifo, not a regular file/.test(message), isFifo: fs.lstatSync(anchor).isFIFO() }));
      `);
      expect(result).toEqual({ exit: 0, out: { fifo: true, isFifo: true } });
    },
    20_000,
  );

  test("a link swapped in after the lstat is refused, and its target is not written", async () => {
    await seed(1);
    const target = join(outside, "tail.json");
    writeFileSync(target, "untouched");
    const seams = _leafSeamsForTest();
    const log = await openAuditLog({ rootDir: tmp, day: () => DAY });
    const anchor = join(tmp, CHAIN_TAIL_FILENAME);
    let swapped = 0;
    // The READ of the anchor goes first; swap before the WRITE's open.
    let seen = 0;
    seams.afterLstat = (file) => {
      if (file !== anchor || ++seen < 2) return;
      seams.afterLstat = undefined;
      swapped += 1;
      unlinkSync(anchor);
      symlinkSync(target, anchor);
    };
    try {
      await expect(log.append({ kind: "model_call", payload: 1 })).rejects.toThrow(
        /is a symbolic link, not a regular file/,
      );
    } finally {
      seams.afterLstat = undefined;
    }
    expect(swapped).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });
  test("a dangling link swapped in where a new day file goes is refused, and its target never created", async () => {
    await seed(1);
    const target = join(outside, "created.jsonl");
    const dayFile = join(tmp, "2026-05-09.jsonl");
    const seams = _leafSeamsForTest();
    const log = await openAuditLog({ rootDir: tmp, day: () => "2026-05-09" });
    let swapped = 0;
    seams.afterLstat = (file) => {
      if (file !== dayFile) return;
      seams.afterLstat = undefined;
      swapped += 1;
      symlinkSync(target, dayFile);
    };
    try {
      await expect(log.append({ kind: "model_call", payload: 1 })).rejects.toThrow(
        /could not append to 2026-05-09\.jsonl: "2026-05-09\.jsonl" is a symbolic link/,
      );
    } finally {
      seams.afterLstat = undefined;
    }
    expect(swapped).toBe(1);
    expect(readdirSync(outside)).toEqual([]);
  });
});
