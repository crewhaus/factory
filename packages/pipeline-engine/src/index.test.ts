import { describe, expect, test } from "bun:test";
import { type ComponentEvent, PipelineBuildError, createPipeline } from "./index";

describe("builder", () => {
  test("rejects compile without setOutput", () => {
    const b = createPipeline().addComponent("a", async () => ({}));
    expect(() => b.compile()).toThrow(PipelineBuildError);
  });
  test("rejects unknown setOutput", () => {
    const b = createPipeline()
      .addComponent("a", async () => ({}))
      .setOutput("missing");
    expect(() => b.compile()).toThrow(/output component/);
  });
  test("rejects duplicate components", () => {
    const b = createPipeline().addComponent("a", async () => ({}));
    expect(() => b.addComponent("a", async () => ({}))).toThrow(PipelineBuildError);
  });
  test("rejects cyclic graphs", () => {
    const b = createPipeline()
      .addComponent("a", async () => ({}))
      .addComponent("b", async () => ({}))
      .connect("a", "b")
      .connect("b", "a")
      .setOutput("a");
    expect(() => b.compile()).toThrow(/cycle/);
  });
});

describe("simple linear pipeline", () => {
  test("a → b → c flows outputs through inputs", async () => {
    const events: ComponentEvent[] = [];
    const p = createPipeline()
      .addComponent("a", async (i) => ({ x: ((i["seed"] as number) ?? 0) + 1 }))
      .addComponent("b", async (i) => ({ y: (i["x"] as number) * 2 }))
      .addComponent("c", async (i) => ({ z: (i["y"] as number) - 3 }))
      .connect("a", "b")
      .connect("b", "c")
      .setInput("a", "seed")
      .setOutput("c")
      .compile();
    const out = (await p.run({ seed: 5 }, { onEvent: (e) => events.push(e) })) as { z: number };
    expect(out.z).toBe((5 + 1) * 2 - 3);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "component_start",
      "component_end",
      "component_start",
      "component_end",
      "component_start",
      "component_end",
    ]);
  });
});

describe("parallel branches (T3)", () => {
  test("siblings run concurrently and merge into a sink", async () => {
    const order: string[] = [];
    const p = createPipeline()
      .addComponent("entry", async () => ({}))
      .addComponent("left", async () => {
        order.push("left-start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("left-end");
        return { l: 1 };
      })
      .addComponent("right", async () => {
        order.push("right-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("right-end");
        return { r: 2 };
      })
      .addComponent("sink", async (i) => ({ sum: (i["l"] as number) + (i["r"] as number) }))
      .connect("entry", "left")
      .connect("entry", "right")
      .connect("left", "sink")
      .connect("right", "sink")
      .setOutput("sink")
      .compile();
    const out = (await p.run({})) as { sum: number };
    expect(out.sum).toBe(3);
    // left-start and right-start both occur before either ends.
    expect(order.indexOf("right-start")).toBeLessThan(order.indexOf("left-end"));
  });
});

describe("edge mapping", () => {
  test("mapping renames a key from upstream output to downstream input", async () => {
    const p = createPipeline()
      .addComponent("a", async () => ({ value: 7 }))
      .addComponent("b", async (i) => ({ doubled: (i["input"] as number) * 2 }))
      .connect("a", "b", [{ from: "value", to: "input" }])
      .setOutput("b")
      .compile();
    const out = (await p.run({})) as { doubled: number };
    expect(out.doubled).toBe(14);
  });
});

describe("topological order invariant (T9)", () => {
  test("schedule order is independent of component declaration order", async () => {
    const events1: string[] = [];
    const events2: string[] = [];
    const p1 = createPipeline()
      .addComponent("c", async (i) => ({ z: (i["y"] as number) - 3 }))
      .addComponent("a", async (i) => ({ x: ((i["seed"] as number) ?? 0) + 1 }))
      .addComponent("b", async (i) => ({ y: (i["x"] as number) * 2 }))
      .connect("a", "b")
      .connect("b", "c")
      .setInput("a", "seed")
      .setOutput("c")
      .compile();
    const p2 = createPipeline()
      .addComponent("a", async (i) => ({ x: ((i["seed"] as number) ?? 0) + 1 }))
      .addComponent("b", async (i) => ({ y: (i["x"] as number) * 2 }))
      .addComponent("c", async (i) => ({ z: (i["y"] as number) - 3 }))
      .connect("a", "b")
      .connect("b", "c")
      .setInput("a", "seed")
      .setOutput("c")
      .compile();
    const o1 = (await p1.run(
      { seed: 5 },
      {
        onEvent: (e) => {
          if (e.kind === "component_end") events1.push(e.name);
        },
      },
    )) as { z: number };
    const o2 = (await p2.run(
      { seed: 5 },
      {
        onEvent: (e) => {
          if (e.kind === "component_end") events2.push(e.name);
        },
      },
    )) as { z: number };
    expect(events1).toEqual(["a", "b", "c"]);
    expect(events2).toEqual(["a", "b", "c"]);
    expect(o1.z).toBe(o2.z);
  });
});
