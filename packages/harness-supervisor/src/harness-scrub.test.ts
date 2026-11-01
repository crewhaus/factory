/**
 * The two readers' scrubbers: the harness's own `.env` chain, and the merged
 * spawn env (that chain UNDER the manager's environment) the live pump
 * scrubs with. The second is a strict superset of the first.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessScrubber, spawnEnvScrubber } from "./harness-scrub";

/** Built from parts: never realistic-shaped literals in a fixture. */
const FILE_SECRET = ["file", "held", "0123456789abcdef"].join("-");
const SHELL_SECRET = ["shell", "held", "0123456789abcdef"].join("-");
const SHARED_SECRET = ["fleet", "shared", "0123456789abcdef"].join("-");

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function harness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-scrub-"));
  scratch.push(root);
  const dir = join(root, "member");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), `FILE_TOKEN=${FILE_SECRET}\n`);
  return dir;
}

describe("harnessScrubber", () => {
  test("replaces a value from the harness's own .env with its NAME, and nothing else", () => {
    const scrub = harnessScrubber(harness());
    expect(scrub(`a ${FILE_SECRET} b`)).toBe("a «FILE_TOKEN» b");
    // A value that lives only in the shell the manager started from is not
    // the harness's — this scrubber cannot know it.
    expect(scrub(`c ${SHELL_SECRET} d`)).toBe(`c ${SHELL_SECRET} d`);
  });

  test("reads the shared files manager.envFiles declares, as a spawn does", () => {
    const dir = harness();
    writeFileSync(join(dir, "..", ".env"), `SHARED_TOKEN=${SHARED_SECRET}\n`);
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "settings.json"),
      JSON.stringify({ manager: { envFiles: ["../.env"] } }),
    );
    expect(harnessScrubber(dir)(SHARED_SECRET)).toBe("«SHARED_TOKEN»");
  });
});

describe("spawnEnvScrubber", () => {
  test("is a superset: the .env value AND the manager's own environment", () => {
    const scrub = spawnEnvScrubber(harness(), { SHELL_TOKEN: SHELL_SECRET });
    expect(scrub(`a ${FILE_SECRET} b ${SHELL_SECRET}`)).toBe("a «FILE_TOKEN» b «SHELL_TOKEN»");
  });

  test("leaves the operational variables a log is supposed to show", () => {
    const scrub = spawnEnvScrubber(harness(), { HOME: "/home/someone-long", PORT: "41234" });
    expect(scrub("home /home/someone-long on 41234")).toBe("home /home/someone-long on 41234");
  });
});
