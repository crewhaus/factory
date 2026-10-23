import { afterEach, describe, expect, test } from "bun:test";
import { isPureTool } from "@crewhaus/provability";
import { buildTool } from "@crewhaus/tool-builder";
import { uuid } from "@crewhaus/tool-encode";
import { deadlineCheck } from "@crewhaus/tool-flow";
import { DEFAULT_THRESHOLD_BYTES, storeAndPreview } from "@crewhaus/tool-result-store";
import { z } from "zod";
import { impureSumTool, sumTool, tempDirs } from "./__fixtures__/helpers";
import { catalogReplay, lookupTool, resultText } from "./replay";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

describe("lookupTool", () => {
  test("reads a catalog or a tool list; absent catalog finds nothing", () => {
    const tool = sumTool();
    expect(lookupTool([tool], "SumFake")).toBe(tool);
    expect(lookupTool({ get: (n) => (n === "SumFake" ? tool : undefined) }, "SumFake")).toBe(tool);
    expect(lookupTool([tool], "Nope")).toBeUndefined();
    expect(lookupTool(undefined, "SumFake")).toBeUndefined();
  });
});

describe("resultText", () => {
  test("a string as is; text blocks joined by newlines, images dropped", () => {
    expect(resultText("plain")).toBe("plain");
    expect(
      resultText([
        { type: "text", text: "a" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
        { type: "text", text: "b" },
      ] as Parameters<typeof resultText>[0]),
    ).toBe("a\nb");
  });
});

describe("catalogReplay", () => {
  test("purity is provability's: the pure tool is pure, the impure one and an unknown name are not", () => {
    const { isPureTool } = catalogReplay([sumTool(), impureSumTool()]);
    expect(isPureTool("SumFake")).toBe(true);
    expect(isPureTool("ImpureSum")).toBe(false);
    expect(isPureTool("Missing")).toBe(false);
    expect(catalogReplay(undefined).isPureTool("SumFake")).toBe(false);
  });

  test("re-runs a pure tool on the parsed logged input", async () => {
    let seen: unknown;
    const tool = buildTool({
      name: "Defaulted",
      description: "d",
      inputSchema: z.object({ a: z.number(), unit: z.string().default("EUR") }),
      readOnly: true,
      concurrencySafe: true,
      execute: async (input) => {
        seen = input;
        return `${input.a} ${input.unit}`;
      },
    });
    const { replay } = catalogReplay([tool]);
    expect(await replay("Defaulted", { a: 3 })).toEqual({ content: "3 EUR", isError: false });
    // The schema's default applied, as on the original call.
    expect(seen).toEqual({ a: 3, unit: "EUR" });
  });

  test("nothing to re-run: not pure, not there, or the logged input no longer parses", async () => {
    let impureRuns = 0;
    const { replay } = catalogReplay([
      sumTool(),
      impureSumTool(() => {
        impureRuns += 1;
      }),
    ]);
    expect(await replay("ImpureSum", { a: 1, b: 2 })).toBeUndefined();
    expect(impureRuns).toBe(0);
    expect(await replay("Missing", {})).toBeUndefined();
    expect(await replay("SumFake", { a: "one" })).toBeUndefined();
  });

  test("a tool that throws on an input it once answered is a disagreement (isError)", async () => {
    const { replay } = catalogReplay([
      sumTool("SumFake", () => {
        throw new Error("overflow");
      }),
    ]);
    expect(await replay("SumFake", { a: 1, b: 2 })).toEqual({ content: "overflow", isError: true });
  });

  test("a hung tool is stopped at the timeout, and that is no verdict (it throws)", async () => {
    let aborted = false;
    const hung = buildTool({
      name: "Hung",
      description: "h",
      inputSchema: z.object({}),
      readOnly: true,
      concurrencySafe: true,
      execute: (_input, ctx) =>
        new Promise<string>(() => {
          ctx?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });
    const { replay } = catalogReplay([hung], { timeoutMs: 20 });
    await expect(replay("Hung", {})).rejects.toThrow(/longer than 20ms/);
    expect(aborted).toBe(true);
  });

  test("the turn's abort stops a replay, and an already-aborted turn runs nothing", async () => {
    let runs = 0;
    const slow = buildTool({
      name: "Slow",
      description: "s",
      inputSchema: z.object({}),
      readOnly: true,
      concurrencySafe: true,
      execute: () => {
        runs += 1;
        return new Promise<string>(() => {});
      },
    });
    const ctrl = new AbortController();
    const pending = catalogReplay([slow], { signal: ctrl.signal }).replay("Slow", {});
    ctrl.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    const gone = new AbortController();
    gone.abort();
    await expect(catalogReplay([slow], { signal: gone.signal }).replay("Slow", {})).rejects.toThrow(
      /aborted/,
    );
    expect(runs).toBe(1);
  });
});

/** A pure tool whose output is `rows` deterministic table lines after the answer. */
function tableTool(rows: number, first = "The sum is 42."): ReturnType<typeof sumTool> {
  return buildTool({
    name: "Table",
    description: "a big deterministic table",
    inputSchema: z.object({}),
    readOnly: true,
    concurrencySafe: true,
    execute: async () =>
      `${first}\n${Array.from({ length: rows }, (_, k) => `row ${k}: ${k * 2}`).join("\n")}`,
  });
}

/** What runtime-core logged for `content`: tool-result-store's preview (spilled to a temp root). */
async function loggedAs(content: string, toolUseId = "toolu_1"): Promise<string> {
  const stored = await storeAndPreview(
    { toolUseId, content, isError: false },
    { runId: "run_1", toolUseId, rootDir: dirs.make() },
  );
  return stored.previewContent as string;
}

describe("a result over the spill threshold is compared in the shape it was logged in", () => {
  test("the logged preview of this very output comes back: a match on everything the evidence holds", async () => {
    const tool = tableTool(2000);
    const full = (await tool.execute({})) as string;
    expect(Buffer.byteLength(full)).toBeGreaterThan(DEFAULT_THRESHOLD_BYTES);
    const logged = await loggedAs(full);
    expect(logged).toContain("[truncated, full output at");
    const { replay } = catalogReplay([tool], { logged: () => [logged] });
    expect(await replay("Table", {})).toEqual({ content: logged, isError: false });
  });

  test("a preview whose head differs is a mismatch (the replay's own head comes back)", async () => {
    const logged = await loggedAs((await tableTool(2000, "The sum is 41.").execute({})) as string);
    const { replay } = catalogReplay([tableTool(2000)], { logged: () => [logged] });
    const result = await replay("Table", {});
    expect(result?.isError).toBe(false);
    expect(result?.content.startsWith("The sum is 42.")).toBe(true);
    expect(result?.content).not.toBe(logged);
  });

  test("a preview the log cannot be read as — or no log to read — is not compared at all", async () => {
    const tool = tableTool(2000);
    expect(
      await catalogReplay([tool], { logged: () => ["The sum is 42."] }).replay("Table", {}),
    ).toBe(undefined);
    expect(await catalogReplay([tool]).replay("Table", {})).toBeUndefined();
    expect(await catalogReplay([tool], { logged: () => [] }).replay("Table", {})).toBeUndefined();
  });

  test("under the threshold nothing changes: the output itself is handed over", async () => {
    const small = tableTool(10);
    const full = (await small.execute({})) as string;
    expect(await catalogReplay([small], { logged: () => [full] }).replay("Table", {})).toEqual({
      content: full,
      isError: false,
    });
  });
});

describe("a pure tool that does not reproduce is not replayed into a mismatch", () => {
  test("two runs that disagree with each other: could not replay (undefined), never a mismatch", async () => {
    let n = 0;
    const random = buildTool({
      name: "Random",
      description: "r",
      inputSchema: z.object({}),
      readOnly: true,
      concurrencySafe: true,
      execute: async () => {
        n += 1;
        return `id-${n}`;
      },
    });
    const { replay } = catalogReplay([random], { logged: () => ["id-0"], recheckMs: 1 });
    expect(await replay("Random", {})).toBeUndefined();
    expect(n).toBe(2);
  });

  test("two runs that agree with each other and not the log: the mismatch is handed over", async () => {
    let runs = 0;
    const tool = sumTool("SumFake", (a, b) => {
      runs += 1;
      return `The sum is ${a + b}.`;
    });
    const { replay } = catalogReplay([tool], {
      logged: () => ["The sum is 41."],
      recheckMs: 1,
    });
    expect(await replay("SumFake", { a: 2, b: 40 })).toEqual({
      content: "The sum is 42.",
      isError: false,
    });
    expect(runs).toBe(2);
  });

  test("a run that agrees with the log is run once", async () => {
    let runs = 0;
    const tool = sumTool("SumFake", (a, b) => {
      runs += 1;
      return `The sum is ${a + b}.`;
    });
    // The verifier's comparison: whitespace runs are one space.
    const { replay } = catalogReplay([tool], { logged: () => ["The   sum is\n42. "] });
    expect(await replay("SumFake", { a: 2, b: 40 })).toEqual({
      content: "The sum is 42.",
      isError: false,
    });
    expect(runs).toBe(1);
  });

  test("the real Uuid (pure by its flags, on the default all-compute allow): unseeded v4 is never a mismatch; seeded replays", async () => {
    expect(isPureTool(uuid)).toBe(true);
    const logged = (await uuid.execute(uuid.inputSchema.parse({}))) as string;
    const { replay } = catalogReplay([uuid], { logged: () => [logged] });
    expect(await replay("Uuid", {})).toBeUndefined();
    const seeded = { seed: "run-7" };
    const loggedSeeded = (await uuid.execute(uuid.inputSchema.parse(seeded))) as string;
    expect(
      await catalogReplay([uuid], { logged: () => [loggedSeeded] }).replay("Uuid", seeded),
    ).toEqual({ content: loggedSeeded, isError: false });
  });

  test("a call that left out `now` read the real clock (the real DeadlineCheck): not re-run; one that pinned it replays", async () => {
    expect(isPureTool(deadlineCheck)).toBe(true);
    const floating = { deadline: "2099-01-01T00:00:00Z" };
    const logged = (await deadlineCheck.execute(
      deadlineCheck.inputSchema.parse(floating),
    )) as string;
    expect(
      await catalogReplay([deadlineCheck], { logged: () => [logged] }).replay(
        "DeadlineCheck",
        floating,
      ),
    ).toBeUndefined();
    const pinned = { ...floating, now: "2098-12-31T00:00:00Z" };
    const loggedPinned = (await deadlineCheck.execute(
      deadlineCheck.inputSchema.parse(pinned),
    )) as string;
    expect(
      await catalogReplay([deadlineCheck], { logged: () => [loggedPinned] }).replay(
        "DeadlineCheck",
        pinned,
      ),
    ).toEqual({ content: loggedPinned, isError: false });
  });
});
