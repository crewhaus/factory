import { describe, expect, test } from "bun:test";
import { ERROR_CODES, EXIT_FOR_ERROR, EXIT_FOR_REJECTED_RECEIPT } from "@crewhaus/control-contract";
import { EXIT_CODES } from "@crewhaus/errors";

describe("the control exit band", () => {
  test("every error code has an exit", () => {
    for (const code of Object.keys(ERROR_CODES)) {
      expect(EXIT_FOR_ERROR[code as keyof typeof EXIT_FOR_ERROR]).toBeNumber();
    }
  });

  test("every exit is one EXIT_CODES documents, except exactly the operator-state pair", () => {
    const documented = new Set<number>(Object.values(EXIT_CODES));
    const outside = Object.entries(EXIT_FOR_ERROR).filter(([, exit]) => !documented.has(exit));
    // `paused` and `disabled` take their codes when the operator controls land in the
    // runtime's table; until then they are the only two outside it.
    expect(Object.fromEntries(outside)).toEqual({ paused: 39, disabled: 38 });
    expect(documented.has(EXIT_FOR_REJECTED_RECEIPT)).toBe(true);
  });

  test("50 to 56 are each used, under their documented names", () => {
    const band = Object.entries(EXIT_CODES).filter(([, exit]) => exit >= 50 && exit <= 56);
    expect(band).toEqual([
      ["not_signed_in", 50],
      ["forbidden", 51],
      ["unavailable", 52],
      ["conflict", 53],
      ["unsupported", 54],
      ["refused", 55],
      ["not_found", 56],
    ]);
    const used = new Set(Object.values(EXIT_FOR_ERROR));
    for (const [, exit] of band) expect(used.has(exit)).toBe(true);
    expect(EXIT_FOR_ERROR.unauthenticated).toBe(EXIT_CODES.not_signed_in);
    expect(EXIT_FOR_ERROR.forbidden).toBe(EXIT_CODES.forbidden);
    expect(EXIT_FOR_ERROR.unavailable).toBe(EXIT_CODES.unavailable);
    expect(EXIT_FOR_ERROR.conflict).toBe(EXIT_CODES.conflict);
    expect(EXIT_FOR_ERROR.unsupported).toBe(EXIT_CODES.unsupported);
    expect(EXIT_FOR_ERROR.invalid).toBe(EXIT_CODES.refused);
    expect(EXIT_FOR_REJECTED_RECEIPT).toBe(EXIT_CODES.refused);
    expect(EXIT_FOR_ERROR.not_found).toBe(EXIT_CODES.not_found);
    expect(EXIT_FOR_ERROR.internal).toBe(EXIT_CODES.generic);
  });
});
