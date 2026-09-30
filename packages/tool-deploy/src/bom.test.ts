/**
 * SpecPin registers the spec file as written, a leading byte-order mark
 * included, as 0.7.0 did (bounds review). 0.7.1's first cut read it through
 * tool-safety's reader, whose text drops the mark: the registered version
 * lost a byte, and a spec pinned on 0.7.0 no longer content-matched its own
 * registered version, so pinning it again would register a new one.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specPin } from "./index";

const BOM = String.fromCharCode(0xfeff);
let workspace: string;
const originalCwd = process.cwd();

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "tool-deploy-bom-")));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

test("the registered version is the spec file byte for byte, and pinning it again changes nothing", async () => {
  writeFileSync(join(workspace, "spec.yaml"), `${BOM}name: demo\nx: 1\n`);
  const first = JSON.parse(
    String(
      await specPin.execute({ name: "demo", specFile: "spec.yaml", env: "prod" }, {} as never),
    ),
  );
  expect(first.registration.version).toBe("v1");
  const stored = readFileSync(join(workspace, ".crewhaus/specs/demo/v1.yaml"));
  expect(stored.equals(readFileSync(join(workspace, "spec.yaml")))).toBe(true);
  const again = JSON.parse(
    String(
      await specPin.execute({ name: "demo", specFile: "spec.yaml", env: "prod" }, {} as never),
    ),
  );
  expect(again.registration.status).toBe("unchanged");
  expect(again.registration.version).toBe("v1");
});
