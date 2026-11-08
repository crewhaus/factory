import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { comboboxKey } from "../assets/js/ui/listbox.js";

const menu = (
  cursor: number,
  kinds = ["harness", "wiki", "action"],
  armed: number | null = null,
) => ({
  count: kinds.length,
  cursor,
  kinds,
  armed,
});

describe("comboboxKey", () => {
  test("the arrows move and wrap at both ends, and never leave the list", () => {
    expect(comboboxKey(menu(0), "ArrowDown").state.cursor).toBe(1);
    expect(comboboxKey(menu(2), "ArrowDown").state.cursor).toBe(0);
    expect(comboboxKey(menu(0), "ArrowUp").state.cursor).toBe(2);
    expect(comboboxKey(menu(-1), "ArrowDown").state.cursor).toBe(0);
    expect(comboboxKey(menu(-1), "ArrowUp").state.cursor).toBe(2);
    expect(comboboxKey(menu(1), "Home").state.cursor).toBe(0);
    expect(comboboxKey(menu(1), "End").state.cursor).toBe(2);
    for (let cursor = 0; cursor < 3; cursor += 1) {
      for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
        const next = comboboxKey(menu(cursor), key).state.cursor;
        expect(next >= 0 && next < 3).toBe(true);
      }
    }
  });

  test("an empty list keeps the cursor at none and does nothing", () => {
    const empty = { count: 0, cursor: -1, kinds: [], armed: null };
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"]) {
      const r = comboboxKey(empty, key);
      expect(`${key}:${r.effect}:${r.state.cursor}`).toBe(`${key}:null:-1`);
    }
  });

  test("Enter on an option opens it; Enter on an action only arms it", () => {
    expect(comboboxKey(menu(0), "Enter")).toMatchObject({ effect: "open", index: 0 });
    const armed = comboboxKey(menu(2), "Enter");
    expect(armed.effect).toBe("arm");
    expect(armed.state.armed).toBe(2);
    // A second Enter on the armed action does not run it: it is still only armed.
    expect(comboboxKey(armed.state, "Enter").effect).toBe("arm");
  });

  test("Escape takes an armed action back, and is not the reducer's otherwise", () => {
    const r = comboboxKey(menu(2, undefined, 2), "Escape");
    expect(r.effect).toBe("disarm");
    expect(r.state.armed).toBeNull();
    expect(comboboxKey(menu(1), "Escape").effect).toBeNull();
  });

  test("moving disarms", () => {
    expect(comboboxKey(menu(2, undefined, 2), "ArrowUp").state.armed).toBeNull();
  });

  test("Enter with no cursor does nothing", () => {
    expect(comboboxKey(menu(-1), "Enter").effect).toBeNull();
  });
});
