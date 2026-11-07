import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { politenessFor } from "../assets/js/ui/live.js";

describe("politenessFor", () => {
  test("only an error interrupts", () => {
    expect(politenessFor("error")).toBe("assertive");
  });

  test.each(["info", "ok", "warn", "notification", "", undefined, null])(
    "%p waits its turn",
    (kind) => {
      expect(politenessFor(kind)).toBe("polite");
    },
  );
});
