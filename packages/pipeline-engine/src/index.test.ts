import { describe, expect, test } from "bun:test";
import { type ComponentEvent, PipelineBuildError, PipelineRunError, createPipeline } from "./index";

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

  test("rejects an empty component name", () => {
    expect(() => createPipeline().addComponent("", async () => ({}))).toThrow(
      /name must be non-empty/,
    );
  });

  test("rejects an edge whose `from` component is unknown", () => {
    const b = createPipeline()
      .addComponent("a", async () => ({}))
      .connect("ghost", "a")
      .setOutput("a");
    expect(() => b.compile()).toThrow(/unknown component "ghost" \(from\)/);
  });

  test("rejects an edge whose `to` component is unknown", () => {
    const b = createPipeline()
      .addComponent("a", async () => ({}))
      .connect("a", "ghost")
      .setOutput("a");
    expect(() => b.compile()).toThrow(/unknown component "ghost" \(to\)/);
  });

  test("rejects setInput referencing an unknown component", () => {
    const b = createPipeline()
      .addComponent("a", async () => ({}))
      .setInput("ghost", "seed")
      .setOutput("a");
    expect(() => b.compile()).toThrow(/setInput references unknown component "ghost"/);
  });
});

describe("PipelineRunError", () => {
  test("carries its name, message, and an optional cause", () => {
    const cause = new Error("inner");
    const err = new PipelineRunError("component disappeared", cause);
    expect(err).toBeInstanceOf(PipelineRunError);
    expect(err.name).toBe("PipelineRunError");
    expect(err.message).toBe("component disappeared");
    expect(err.cause).toBe(cause);
  });

  test("run throws when a scheduled component has no function", async () => {
    // `addComponent` does not validate the function reference, so a caller can
    // register a component with an `undefined` body. Its name is still a key in
    // the component map, so `compile()` and the topological schedule accept it,
    // but at run time `this.o.components.get(name)` resolves to `undefined` and
    // the defensive guard fires. This is the one reachable path to that guard.
    const broken = createPipeline()
      .addComponent("dead", undefined as never)
      .setOutput("dead")
      .compile();
    await expect(broken.run({})).rejects.toBeInstanceOf(PipelineRunError);
    await expect(broken.run({})).rejects.toThrow(/disappeared from the registry/);
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
