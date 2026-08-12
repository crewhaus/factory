import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManagerBlock, readManagerSettings } from "./manager-settings";

const roots: string[] = [];
function harnessWith(settings: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-settings-"));
  roots.push(dir);
  if (settings !== undefined) {
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(join(dir, ".crewhaus", "settings.json"), settings);
  }
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readManagerSettings", () => {
  test("reads envFiles in declaration order", () => {
    const dir = harnessWith(JSON.stringify({ manager: { envFiles: ["../.env", "../ops.env"] } }));
    expect(readManagerSettings(dir).envFiles).toEqual(["../.env", "../ops.env"]);
  });

  test("no file, no .crewhaus, and an empty object all read as no declarations", () => {
    expect(readManagerSettings(harnessWith(undefined)).envFiles).toEqual([]);
    expect(readManagerSettings(harnessWith("{}")).envFiles).toEqual([]);
    expect(readManagerSettings(harnessWith(JSON.stringify({ manager: {} }))).envFiles).toEqual([]);
  });

  test("malformed JSON degrades to defaults rather than throwing", () => {
    // Read on the spawn path: a typo in a human-owned file must not be the
    // reason a fleet cannot start.
    expect(readManagerSettings(harnessWith("{ not json")).envFiles).toEqual([]);
  });

  test("a `manager` key of the wrong type is ignored", () => {
    for (const manager of ["nope", 3, [], null]) {
      expect(readManagerSettings(harnessWith(JSON.stringify({ manager }))).envFiles).toEqual([]);
    }
  });

  test("non-string and blank entries are dropped, the rest survive", () => {
    const dir = harnessWith(
      JSON.stringify({ manager: { envFiles: ["../.env", 7, "", "   ", null, "../b.env"] } }),
    );
    expect(readManagerSettings(dir).envFiles).toEqual(["../.env", "../b.env"]);
  });

  test("entries are trimmed", () => {
    const dir = harnessWith(JSON.stringify({ manager: { envFiles: ["  ../.env  "] } }));
    expect(readManagerSettings(dir).envFiles).toEqual(["../.env"]);
  });

  test("readManagerBlock hands back the raw block so other readers can share the parse", () => {
    const dir = harnessWith(
      JSON.stringify({
        hooks: [{ event: "stop", command: "true" }],
        manager: { logRetention: { runs: 5, bytes: 10 }, futureField: "kept" },
      }),
    );
    expect(readManagerBlock(dir)).toEqual({
      logRetention: { runs: 5, bytes: 10 },
      futureField: "kept",
    });
  });
});
