/**
 * A file:// page keeps a leading byte-order mark, as 0.7.0 read it (bounds
 * review). 0.7.1's first cut read the page through tool-safety's reader,
 * whose text drops the mark, so the content (and the sha256 its citation
 * records) changed for any file that starts with one.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCitationTracker } from "@crewhaus/citation-tracker";
import { createCrawler } from "./index";

const BOM = String.fromCharCode(0xfeff);
const root = realpathSync(mkdtempSync(join(tmpdir(), "crawler-bom-")));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a file:// page's content is the file's text, byte-order mark and all", async () => {
  const file = join(root, "a.md");
  writeFileSync(file, `${BOM}# Title\nbody é\n`);
  const crawler = createCrawler({
    tracker: createCitationTracker({ rootDir: join(root, ".cite") }),
    config: { allowedFileRoots: [root] },
  });
  const page = await crawler.fetch(`file://${file}`);
  expect(page.content).toBe(readFileSync(file, "utf8"));
  expect(page.content.startsWith(BOM)).toBe(true);
});
