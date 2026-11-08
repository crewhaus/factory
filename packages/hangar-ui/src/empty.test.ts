import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { EMPTY_CAUSES, emptyModel } from "../assets/js/ui/empty.js";

describe("empty states", () => {
  test("there are exactly six causes, and each has its words", () => {
    expect(Object.keys(EMPTY_CAUSES).sort()).toEqual(
      [
        "connection-failed",
        "filtered",
        "no-access",
        "no-data",
        "not-indexed",
        "unsupported",
      ].sort(),
    );
    for (const cause of Object.keys(EMPTY_CAUSES)) {
      const model = emptyModel({ cause, subject: "Thredz" });
      expect(model.message.length).toBeGreaterThan(10);
      expect(model.message).not.toContain("{subject}");
    }
  });

  test("a filtered list offers to clear the filters", () => {
    expect(emptyModel({ cause: "filtered" }).action).toBe("Clear filters");
  });

  test("a failed connection names the service and offers a retry", () => {
    const m = emptyModel({ cause: "connection-failed", subject: "Thredz" });
    expect(m.message).toBe("Can't reach Thredz right now.");
    expect(m.action).toBe("Retry");
  });

  test("no data carries its verb and its detail; not indexed offers nothing", () => {
    const m = emptyModel({
      cause: "no-data",
      detail: "Nothing has changed.",
      verb: "crewhaus run",
    });
    expect(m).toMatchObject({
      message: "Nothing here yet.",
      detail: "Nothing has changed.",
      verb: "crewhaus run",
      action: null,
    });
    expect(emptyModel({ cause: "not-indexed" }).action).toBeNull();
  });

  test("an unknown cause throws: an empty state that cannot say why is a bug", () => {
    expect(() => emptyModel({ cause: "nothing" })).toThrow("unknown empty-state cause");
    expect(() => emptyModel({})).toThrow();
    expect(() => emptyModel({ cause: "toString" })).toThrow();
  });
});
