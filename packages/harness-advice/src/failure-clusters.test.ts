/**
 * Failure clustering as its own subpath: the names it exports, so a dropped export fails
 * here. The behaviour is tested through the CLI's re-export (`apps/cli/src/failures.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import * as clusters from "./failure-clusters";

describe("@crewhaus/harness-advice/failure-clusters", () => {
  test("exports exactly these runtime names", () => {
    expect(Object.keys(clusters).sort()).toEqual(
      [
        "DEFAULT_SIMILARITY_THRESHOLD",
        "NON_FAILURE_CLASSES",
        "clusterFailures",
        "defaultRecoveryFor",
        "distinctivePattern",
        "leadingStableClause",
        "longestCommonSubstring",
        "normalizeTokens",
        "proposeTaxonomy",
        "renderFailuresTable",
        "renderTaxonomyYaml",
        "tokenSimilarity",
      ].sort(),
    );
  });

  test("two similar messages of one class form one cluster", () => {
    const out = clusters.clusterFailures([
      {
        source: "run_failed",
        class: "auth",
        message: "invalid api key for provider",
        sessionId: "a",
      },
      {
        source: "run_failed",
        class: "auth",
        message: "invalid api key for the provider",
        sessionId: "b",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.count).toBe(2);
  });
});
