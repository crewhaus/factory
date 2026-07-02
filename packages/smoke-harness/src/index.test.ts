import { describe, expect, test } from "bun:test";
import {
  SHAPE_ASSERTIONS,
  assertBundleAgainstShape,
  assertionForTarget,
  listFixtureShapes,
  runShapeSmoke,
  runSmokeMatrix,
} from "./index.js";

describe("smoke matrix — every target shape compiles + wires its baseline", () => {
  // Generate one test per shape so a failure pinpoints which emitter
  // drifted instead of failing them all behind a single assertion.
  for (const assertion of SHAPE_ASSERTIONS) {
    test(`shape: ${assertion.shape}`, () => {
      const result = runShapeSmoke(assertion);
      if (result.status !== "ok") {
        throw new Error(
          [
            `smoke failed for shape "${assertion.shape}" (${result.status}):`,
            ...result.failures.map((f) => `  - ${f}`),
          ].join("\n"),
        );
      }
      expect(result.status).toBe("ok");
    });
  }
});

describe("smoke matrix — coverage", () => {
  test("every fixture on disk has a matching SHAPE_ASSERTIONS entry", () => {
    const fixtureShapes = listFixtureShapes();
    const assertionShapes = SHAPE_ASSERTIONS.map((a) => a.shape);
    const orphans = fixtureShapes.filter((s) => !assertionShapes.includes(s));
    expect(orphans).toEqual([]);
  });

  test("every SHAPE_ASSERTIONS entry has a fixture on disk", () => {
    const fixtureShapes = new Set(listFixtureShapes());
    const orphans = SHAPE_ASSERTIONS.filter((a) => !fixtureShapes.has(a.shape)).map((a) => a.shape);
    expect(orphans).toEqual([]);
  });

  test("runSmokeMatrix returns one ok result per declared shape", () => {
    const results = runSmokeMatrix();
    const matrixEntry = results.find((r) => r.shape === "__matrix__");
    if (matrixEntry !== undefined) {
      throw new Error(`matrix consistency failure: ${matrixEntry.failures.join("; ")}`);
    }
    expect(results).toHaveLength(SHAPE_ASSERTIONS.length);
    for (const r of results) expect(r.status).toBe("ok");
  });
});

describe("assertionForTarget + assertBundleAgainstShape (item 33 — compile --check)", () => {
  test("selects the exact-shape assertion for a target literal", () => {
    expect(assertionForTarget("cli")?.shape).toBe("cli");
    expect(assertionForTarget("onchain")?.shape).toBe("onchain");
    expect(assertionForTarget("onchain-game")?.shape).toBe("onchain-game");
  });

  test("provider fixture variants and unknown targets resolve to undefined", () => {
    // `cli-openai` etc. are matrix-only names, never a spec `target:` literal
    // — but exact-match still finds them if asked; a genuinely unknown
    // target has no entry.
    expect(assertionForTarget("cf-worker")).toBeUndefined();
    expect(assertionForTarget("")).toBeUndefined();
  });

  test("every fixture bundle passes its own shape assertion generically", () => {
    // Property: assertBundleAgainstShape applies a SUBSET of runShapeSmoke's
    // anchors, so any fixture bundle that passes the full matrix must pass
    // the generic application too.
    for (const assertion of SHAPE_ASSERTIONS) {
      const result = runShapeSmoke(assertion);
      expect(result.status).toBe("ok");
      if (result.bundle === undefined) throw new Error(`no bundle for ${assertion.shape}`);
      expect(assertBundleAgainstShape(assertion, result.bundle)).toEqual([]);
    }
  });

  test("fixtureOnly anchors are skipped for arbitrary bundles", () => {
    const channel = assertionForTarget("channel");
    if (channel === undefined) throw new Error("no channel assertion");
    // A discord-flavoured channel bundle: carries the generic wiring but
    // neither the slack adapter nor the fixture's SMOKE_* env names.
    const bundle = {
      files: [
        { path: "agent.ts", content: "// agent" },
        {
          path: "daemon.ts",
          content:
            'import { createDiscordAdapter } from "@crewhaus/channel-adapter-discord";\n' +
            'import { sendMessage } from "@crewhaus/tool-message-channel";\n' +
            'import { createJanitor } from "@crewhaus/runtime-core";\n' +
            'const token = process.env["MY_DISCORD_TOKEN"];\n',
        },
        { path: "gateway.ts", content: "// gateway" },
        { path: "session-router.ts", content: "// router" },
      ],
    };
    expect(assertBundleAgainstShape(channel, bundle)).toEqual([]);
    // The fixture matrix, by contrast, WOULD flag this bundle (slack anchors).
    const allFailures = channel.anchors
      .filter((a) => a.fixtureOnly === true)
      .map((a) => a.contains);
    expect(allFailures.length).toBeGreaterThan(0);
  });

  test("a missing generic anchor is still a failure, including its target file", () => {
    const cli = assertionForTarget("cli");
    if (cli === undefined) throw new Error("no cli assertion");
    const empty = { files: [{ path: "agent.ts", content: "// hollow bundle" }] };
    const failures = assertBundleAgainstShape(cli, empty);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join("\n")).toContain("@crewhaus/runtime-core");
    // Anchor target files that are absent fail too (expectedFiles is not
    // enforced, but named-file anchors imply the file).
    const noFiles = { files: [] as Array<{ path: string; content: string }> };
    expect(assertBundleAgainstShape(cli, noFiles).join("\n")).toContain(
      'anchor target file "agent.ts" not in bundle',
    );
  });
});
