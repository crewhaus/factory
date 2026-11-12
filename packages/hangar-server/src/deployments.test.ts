import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { casAppend, deploymentsLedger } from "@crewhaus/control-records";
import { deploymentsView } from "./deployments";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
function harness(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hangar-deployments-")));
  roots.push(dir);
  return dir;
}

const DIGEST = `sha256:${"ab".repeat(32)}`;
const DEP_A = "dep_01m76e6f05hp514w9j4v3qymka";
const DEP_B = "dep_01m76e6f05hp514w9j4v3qymkb";

describe("deploymentsView", () => {
  test("absent: an empty list that says why and names the verb", () => {
    const view = deploymentsView(harness());
    expect(view.present).toBe(false);
    expect(view.deployments).toEqual([]);
    expect(view.note).toContain("crewhaus deploy activate");
    expect(view.verb).toBe("crewhaus deploy activate");
  });

  test("kept records newest first and verified; legacy rows after them, unverified", async () => {
    const dir = harness();
    for (const id of [DEP_A, DEP_B]) {
      await casAppend(deploymentsLedger(dir), id, null, {
        id,
        state: "prepared",
        artifact: { digest: DIGEST, specHash: DIGEST, entry: "dist/daemon.ts" },
      });
    }
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "deployments.json"),
      JSON.stringify([{ env: "prod", version: "1.2.3", provider: "fly" }]),
    );
    const view = deploymentsView(dir);
    expect(view.present).toBe(true);
    expect(view.deployments.map((row) => row.verified)).toEqual([true, true, false]);
    expect(view.deployments[2]?.source).toBe(".crewhaus/deployments.json");
    expect(view.note).toContain("were not recorded by crewhaus");
    const newest = view.deployments[0]?.record as {
      id: string;
      artifact: { digest: string; specHash: string };
    };
    // The masked view keeps a digest and a deployment id intact.
    expect(newest.id).toBe(DEP_B);
    expect(newest.artifact.digest).toBe(DIGEST);
    expect(newest.artifact.specHash).toBe(DIGEST);
  });
});
