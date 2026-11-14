import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { acquireMutatingLease } from "./lease";
import { append, publishClaim } from "./ledger";
import { controlPaths, harnessLedger, runsLedger } from "./paths";
import { removeTempDirs, snapshotTree, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const CONTROL = join(".crewhaus", "run", "control");

describe("the layout", () => {
  test("controlPaths spells every fixed name, relative to the harness, and touches nothing", () => {
    const root = tempDir();
    expect(controlPaths(root)).toEqual({
      root,
      controlDir: CONTROL,
      lockFile: join(CONTROL, "lock"),
      claimsDir: join(CONTROL, "claims"),
      digestKeyFile: join(CONTROL, "keys", "digest.key"),
      mutatingLeaseFile: join(CONTROL, "leases", "mutating.json"),
      operatorFile: join(CONTROL, "operator.json"),
      approversFile: join(CONTROL, "approvers.json"),
      deploymentsFile: join(CONTROL, "deployments.jsonl"),
      harnessIdentityFile: join(CONTROL, "harness.json"),
      heartbeatFile: join(".crewhaus", "run", "control-heartbeat.json"),
      standingRulesFile: join(CONTROL, "standing-rules.jsonl"),
      decisionsDir: join(CONTROL, "decisions"),
      runsDir: join(CONTROL, "runs"),
      inputsDir: join(CONTROL, "inputs"),
      subjectKeyFile: join(CONTROL, "keys", "subject.key"),
      delegationsFile: join(CONTROL, "delegations.jsonl"),
      delegationLogDir: join(CONTROL, "delegation-log"),
    });
    expect(readdirSync(root)).toEqual([]);
  });

  test("harnessLedger fills in the shared lock and claims, and takes its records as given", () => {
    const runs = join(CONTROL, "runs");
    expect(harnessLedger("/h", { dir: runs }, { machine: "run" })).toEqual({
      root: "/h",
      records: { dir: runs },
      lock: join(CONTROL, "lock"),
      claims: join(CONTROL, "claims"),
      machine: "run",
    });
    const file = join(CONTROL, "deployments.jsonl");
    expect(harnessLedger("/h", { file })).toEqual({
      root: "/h",
      records: { file },
      lock: join(CONTROL, "lock"),
      claims: join(CONTROL, "claims"),
    });
  });

  test("runsLedger is the run ledger, on the run machine", () => {
    expect(runsLedger("/h")).toEqual({
      root: "/h",
      records: { dir: join(CONTROL, "runs") },
      lock: join(CONTROL, "lock"),
      claims: join(CONTROL, "claims"),
      machine: "run",
    });
  });

  test("the writers land exactly there", async () => {
    const root = tempDir();
    const ledger = harnessLedger(root, { dir: join(CONTROL, "runs") });
    append(ledger, { n: 1 });
    publishClaim(ledger, "idem/one", { n: 1 });
    publishClaim(ledger, "gen/obj/1", { n: 1 });
    await acquireMutatingLease(root, { head: "cli", kind: "eval" }, { waitMs: 0 });
    const paths = [...snapshotTree(root).keys()]
      .map((path) =>
        path
          .slice(root.length + 1)
          .split(/[\\/]/)
          .join("/"),
      )
      .sort();
    expect(paths).toEqual([
      ".crewhaus",
      ".crewhaus/run",
      ".crewhaus/run/control",
      ".crewhaus/run/control/claims",
      ".crewhaus/run/control/claims/gen",
      ".crewhaus/run/control/claims/gen/obj",
      ".crewhaus/run/control/claims/gen/obj/1.json",
      ".crewhaus/run/control/claims/idem",
      ".crewhaus/run/control/claims/idem/one.json",
      ".crewhaus/run/control/leases",
      ".crewhaus/run/control/leases/mutating.json",
      ".crewhaus/run/control/runs",
      ".crewhaus/run/control/runs/000001.jsonl",
    ]);
  });
});
