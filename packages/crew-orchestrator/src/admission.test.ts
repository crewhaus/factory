/**
 * A crew asks its harness's operator record before its first role runs: the crew holds
 * its run before that role's loop, and the hold does not count as admission. In a
 * process that serves a control plane (an intake root is registered), a paused or
 * disabled record refuses a new brief before any model call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { registerIntakeRoot, unregisterIntakeRoot } from "@crewhaus/control-records";
import { isRunFailedError } from "@crewhaus/errors";
import { Crew, type CrewEvent } from "./index.js";

/** A model that answers "done" and counts its calls. */
function countingAdapter(): { adapter: ProviderAdapter; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: {
      providerId: "anthropic",
      features: {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: true,
      },
      estimateTokens: () => 0,
      stream: () => {
        calls += 1;
        return (async function* () {
          yield { kind: "message_start" } as const;
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "end_turn",
            usage: { input: 1, output: 1 },
          } as const;
          yield { kind: "message_stop" } as const;
        })();
      },
    },
  };
}

const dirs: string[] = [];
const registered: string[] = [];

afterEach(() => {
  for (const dir of registered.splice(0)) unregisterIntakeRoot(dir);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A harness whose operator record carries `body`, served as this process's intake root. */
function servedHarness(body: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "crew-admission-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".crewhaus", "run", "control"), { recursive: true });
  writeFileSync(
    join(dir, ".crewhaus", "run", "control", "operator.json"),
    `${JSON.stringify({ v: 1, rev: 1, desired: "running", ...body })}\n`,
  );
  registerIntakeRoot(dir);
  registered.push(dir);
  return dir;
}

async function runCrew(
  dir: string,
  model: ProviderAdapter,
): Promise<{ kinds: string[]; caught?: unknown }> {
  const crew = Crew()
    .setName("solo-crew")
    .addRole("solo", { model: "test-model", instructions: "answer briefly" })
    .setEntry("solo")
    .compile();
  const kinds: string[] = [];
  try {
    for await (const event of crew.run("a new brief", {
      sessionRootDir: join(dir, "sessions"),
      _adapter: model,
      maxActivations: 2,
    }) as AsyncIterable<CrewEvent>) {
      kinds.push(event.kind);
    }
    return { kinds };
  } catch (caught) {
    return { kinds, caught };
  }
}

describe("a crew's first role while intake is closed", () => {
  for (const [block, cls] of [
    [{ intake: { paused: true } }, "paused"],
    [{ deployment: { disabled: true } }, "disabled"],
  ] as const) {
    test(`${cls}: the crew is refused with class ${cls}, before any model call`, async () => {
      const dir = servedHarness(block);
      const model = countingAdapter();
      const { kinds, caught } = await runCrew(dir, model.adapter);
      if (!isRunFailedError(caught)) throw new Error("not a RunFailedError");
      expect(caught.report.class).toBe(cls);
      expect(model.calls()).toBe(0);
      expect(kinds).not.toContain("crew_done");
    });
  }

  test("open: the same crew runs to its end", async () => {
    const dir = servedHarness({});
    const model = countingAdapter();
    const { kinds, caught } = await runCrew(dir, model.adapter);
    expect(caught).toBeUndefined();
    expect(model.calls()).toBe(1);
    expect(kinds).toContain("crew_done");
  });
});
