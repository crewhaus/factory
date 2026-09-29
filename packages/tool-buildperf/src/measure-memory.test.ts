/**
 * Weighing an artifact costs about its size (bounds review).
 *
 * 0.7.1's first cut read each measured file through tool-safety's contained
 * reader, which copied the bytes out of its buffer and decoded them all as
 * UTF-8, though measure() uses only the bytes: a 100 MiB wasm grew RSS by
 * 472 MiB and took 823 ms, where 0.7.0 took 101 MiB and 20 ms. LIMITS allows
 * 512 MiB a file, so a container harness could be pushed out of memory. The
 * reader now decodes on first use and hands back its buffer uncopied.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleSizeCheck } from "./index";

const MIB = 1024 * 1024;
let workspace: string;
const originalCwd = process.cwd();

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "tool-buildperf-mem-")));
  // Pseudo-random bytes, mostly invalid UTF-8, like a wasm or an image: as
  // text, nearly every byte becomes a two-byte U+FFFD.
  const bytes = Buffer.alloc(64 * MIB);
  let x = 12345;
  for (let i = 0; i < bytes.length; i += 4) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    bytes.writeUInt32LE(x, i);
  }
  writeFileSync(join(workspace, "app.wasm"), bytes);
  process.chdir(workspace);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

test("a 64 MiB binary is weighed in less than twice its size", async () => {
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  const out = JSON.parse(
    String(await bundleSizeCheck.execute({ files: ["app.wasm"], algorithm: "none" }, {} as never)),
  );
  const grew = process.memoryUsage().rss - before;
  expect(out.entries[0].bytes).toBe(64 * MIB);
  expect(grew).toBeLessThan(2 * 64 * MIB);
}, 30_000);
