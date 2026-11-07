import { afterAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROBE_MARKER, firstOpenArea, simulatedAreaFiles, uncomment } from "../__test__/seed.js";

const PACKAGE = join(import.meta.dir, "..", "..");
const INDEX = join("src", "areas", "index.ts");
const SCHEMA_INDEX = join("src", "schemas", "areas.ts");

const scratch = mkdtempSync(join(tmpdir(), "control-contract-area-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const open = firstOpenArea(readFileSync(join(PACKAGE, INDEX), "utf8"), "MODULE");

// Once all twelve have landed there is no placeholder left to bring in.
test.skipIf(open === undefined)(
  "an area added the documented way leaves every other test in this package passing",
  () => {
    const area = open as string;
    cpSync(join(PACKAGE, "src"), join(scratch, "src"), { recursive: true });
    cpSync(join(PACKAGE, "package.json"), join(scratch, "package.json"));
    symlinkSync(join(PACKAGE, "node_modules"), join(scratch, "node_modules"), "junction");
    // This test would recurse. The type check is a full program, and the copy adds nothing to it.
    rmSync(join(scratch, "src", "areas", "simulated-area.test.ts"));
    rmSync(join(scratch, "src", "nodenext.test.ts"));

    for (const [file, suffix] of [
      [INDEX, "MODULE"],
      [SCHEMA_INDEX, "SCHEMAS"],
    ] as const) {
      const path = join(scratch, file);
      writeFileSync(path, uncomment(readFileSync(path, "utf8"), area, suffix));
    }
    for (const [file, text] of Object.entries(simulatedAreaFiles(area))) {
      const path = join(scratch, "src", file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }

    const run = Bun.spawnSync([process.execPath, "test", "src", "--timeout", "60000"], {
      cwd: scratch,
      env: { ...process.env },
    });
    const output = `${run.stdout.toString()}\n${run.stderr.toString()}`;
    if (run.exitCode !== 0) throw new Error(output.slice(-6000));
    expect(existsSync(join(scratch, PROBE_MARKER))).toBe(true);
    expect(output).toMatch(/\b0 fail\b/);
    const passed = Number(/\b(\d+) pass\b/.exec(output)?.[1] ?? 0);
    expect(passed).toBeGreaterThanOrEqual(400);
  },
  180_000, // It runs the package's own suite in a copy, and CI runners are slow.
);
