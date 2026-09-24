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
