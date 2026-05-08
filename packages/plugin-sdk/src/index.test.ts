import { describe, expect, test } from "bun:test";
import { PluginSdkError, assertPluginPathsStaySandboxed, definePlugin } from "./index.js";

describe("definePlugin (T1)", () => {
  test("returns a frozen plugin definition with the supplied fields", () => {
    const p = definePlugin({
      name: "fixture",
      version: "0.0.1",
      panes: [{ id: "main", title: "Hello", html: "<div>Hello from plugin</div>" }],
    });
    expect(p.name).toBe("fixture");
    expect(p.version).toBe("0.0.1");
    expect(p.panes?.[0]?.title).toBe("Hello");
    expect(Object.isFrozen(p)).toBe(true);
  });

  test("rejects empty name / version", () => {
    expect(() => definePlugin({ name: "", version: "1" })).toThrow(PluginSdkError);
    expect(() => definePlugin({ name: "x", version: "" })).toThrow(PluginSdkError);
  });

  test("rejects duplicate pane ids within a plugin", () => {
    expect(() =>
      definePlugin({
        name: "p",
        version: "1",
        panes: [
          { id: "a", title: "A", html: "" },
          { id: "a", title: "A2", html: "" },
        ],
      }),
    ).toThrow(/duplicate pane id "a"/);
  });

  test("hooks pass through verbatim and are callable", () => {
    let calls = 0;
    const p = definePlugin({
      name: "p",
      version: "1",
      hooks: {
        onTraceEvent: () => {
          calls += 1;
        },
      },
    });
    p.hooks?.onTraceEvent?.({ kind: "x" });
    expect(calls).toBe(1);
  });
});

describe("assertPluginPathsStaySandboxed (T8 — sandbox isolation)", () => {
  test("allows file:// URLs inside the sandbox root", () => {
    const p = definePlugin({
      name: "p",
      version: "1",
      panes: [
        {
          id: "x",
          title: "x",
          html: '<a href="file:///home/u/.crewhaus/plugins/p/asset.png">a</a>',
        },
      ],
    });
    expect(() => assertPluginPathsStaySandboxed(p, "/home/u/.crewhaus/plugins/p/")).not.toThrow();
  });

  test("rejects file:// URLs outside the sandbox root", () => {
    const p = definePlugin({
      name: "p",
      version: "1",
      panes: [{ id: "x", title: "x", html: '<img src="file:///etc/passwd" />' }],
    });
    expect(() => assertPluginPathsStaySandboxed(p, "/home/u/.crewhaus/plugins/p/")).toThrow(
      /outside its sandbox root/,
    );
  });

  test("plugin with no panes is a no-op", () => {
    const p = definePlugin({ name: "p", version: "1" });
    expect(() => assertPluginPathsStaySandboxed(p, "/home/u/.crewhaus/plugins/p/")).not.toThrow();
  });
});
