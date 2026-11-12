import { describe, expect, test } from "bun:test";
import * as owner from "@crewhaus/deployment-controller/approval-gate";
import * as cli from "./approval-gate";

describe("apps/cli approval-gate", () => {
  test("re-exports the deployment-controller gate as the same functions", () => {
    expect(cli.decideApproval).toBe(owner.decideApproval);
    expect(cli.rollupConclusion).toBe(owner.rollupConclusion);
  });
});
