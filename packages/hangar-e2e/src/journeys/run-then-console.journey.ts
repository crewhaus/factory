import { readdirSync } from "node:fs";
/** A run against the fake model, then the console over what it left. */
import { join } from "node:path";
import { makeFixtureHarness } from "@crewhaus/hangar-server";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { SESSION_ID_RE } from "@crewhaus/session-store";
import { fakeModel } from "service-fakes";
import { harnessRoute } from "../console-routes";
import { childEnv, runCrewhaus, spawnHangar } from "../system";
import type { Journey } from "./journey";

export const runThenConsole: Journey = {
  id: "run-then-console",
  shard: "system",
  proves:
    "`crewhaus run` against a loopback model makes exactly one request and exits 0, and the session it wrote is in the console's Sessions tab under its id, over the registry the run itself updated.",
  run: async (scope) => {
    const model = fakeModel({ defaultReply: "Hello from the fake model." });
    scope.defer(() => model.stop());
    const sandbox = scope.tempDir("hangar-e2e-run-");
    const env = childEnv(sandbox, model.url);
    const harnessDir = makeFixtureHarness(join(sandbox, "harness"), {
      specName: "run-then-console",
    });

    const run = await runCrewhaus(harnessDir, env, "hello");
    if (run.exitCode !== 0) {
      throw new Error(`crewhaus run exited ${run.exitCode}:\n${run.stdout}\n${run.stderr}`);
    }
    if (model.count() !== 1) {
      throw new Error(`crewhaus run made ${model.count()} model requests, not 1:\n${run.stderr}`);
    }

    const sessionDir = join(harnessDir, ".crewhaus", "sessions");
    const sessionIds = readdirSync(sessionDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((name) => SESSION_ID_RE.test(name));
    if (sessionIds.length !== 1 || sessionIds[0] === undefined) {
      throw new Error(`crewhaus run left these sessions: [${sessionIds}]`);
    }
    const sessionId = sessionIds[0];

    const registry = openHangarRegistry({ root: join(sandbox, "registry"), env });
    const entry = registry.list().find((row) => row.specName === "run-then-console");
    if (entry === undefined) throw new Error("the run did not register its harness");

    const hangar = await spawnHangar(env, sandbox);
    scope.defer(async () => {
      await hangar.stop();
    });
    const session = await scope.session(hangar.home);
    await session.visit(harnessRoute(entry.id, "sessions"));
    if ((await session.page.getByText(sessionId).count()) === 0) {
      throw new Error(`the Sessions tab does not show ${sessionId}`);
    }
    session.assertClean();
  },
};
