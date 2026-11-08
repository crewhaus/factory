/**
 * Readability preferences: what is stored, what reaches the document, and
 * what happens when storage refuses.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PREFS,
  PREFS_KEY,
  THEME_KEY,
  applyPrefs,
  applyTheme,
  normalizePrefs,
  readPrefs,
  readTheme,
  requestFocus,
  takeFocusRequest,
  writePrefs,
  writeTheme,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/prefs.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

const throwing = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

describe("preferences", () => {
  test("round trip: what is written is read back", () => {
    const storage = memoryStorage();
    const written = writePrefs(
      { textSize: "larger", density: "compact", singleKeys: false },
      storage,
    );
    expect(readPrefs(storage)).toEqual(written);
    expect(written).toMatchObject({
      v: 1,
      textSize: "larger",
      density: "compact",
      singleKeys: false,
    });
    expect(JSON.parse(storage.data.get(PREFS_KEY) as string).textSize).toBe("larger");
  });

  test("a later write merges into what is stored", () => {
    const storage = memoryStorage();
    writePrefs({ motion: "reduce" }, storage);
    expect(writePrefs({ contrast: "more" }, storage)).toMatchObject({
      motion: "reduce",
      contrast: "more",
    });
  });

  test("an unknown value falls back to the default, field by field", () => {
    expect(
      normalizePrefs({
        textSize: "huge",
        density: 3,
        motion: "reduce",
        contrast: null,
        singleKeys: "no",
        firstRunDone: 1,
      }),
    ).toEqual({ ...DEFAULT_PREFS, motion: "reduce" });
    for (const bad of [null, undefined, "x", [], 7])
      expect(normalizePrefs(bad)).toEqual({ ...DEFAULT_PREFS });
  });

  test("a stored record that is not JSON reads as the defaults", () => {
    expect(readPrefs(memoryStorage({ [PREFS_KEY]: "{nope" }))).toEqual({ ...DEFAULT_PREFS });
  });

  test("storage that throws: reads default, writes still return what applies", () => {
    expect(readPrefs(throwing)).toEqual({ ...DEFAULT_PREFS });
    expect(writePrefs({ textSize: "large" }, throwing).textSize).toBe("large");
    expect(readPrefs(null)).toEqual({ ...DEFAULT_PREFS });
  });

  test("applyPrefs sets an attribute only for a choice that is not the default", () => {
    const root = { dataset: {} as Record<string, string> };
    applyPrefs(root, {
      textSize: "larger",
      density: "compact",
      motion: "reduce",
      contrast: "more",
    });
    expect(root.dataset).toEqual({
      textSize: "larger",
      density: "compact",
      motion: "reduce",
      contrast: "more",
    });
    applyPrefs(root, DEFAULT_PREFS);
    expect(root.dataset).toEqual({});
  });

  test("a bad value never reaches the document", () => {
    const root = { dataset: {} as Record<string, string> };
    applyPrefs(root, { textSize: "<script>", density: "tiny", motion: true, contrast: "max" });
    expect(root.dataset).toEqual({});
  });
});

describe("the theme", () => {
  test("is its own key, dark by default, and anything else is dark", () => {
    const storage = memoryStorage();
    expect(readTheme(storage)).toBe("dark");
    expect(writeTheme("light", storage)).toBe("light");
    expect(storage.data.get(THEME_KEY)).toBe("light");
    expect(readTheme(storage)).toBe("light");
    expect(writeTheme("sepia", storage)).toBe("dark");
    expect(readTheme(throwing)).toBe("dark");
  });

  test("applyTheme writes only light or dark", () => {
    const root = { dataset: {} as Record<string, string> };
    applyTheme(root, "light");
    expect(root.dataset.theme).toBe("light");
    applyTheme(root, "<b>");
    expect(root.dataset.theme).toBe("dark");
  });
});

describe("a focus request", () => {
  test("is taken once, by the name it was made for", () => {
    requestFocus("readability");
    expect(takeFocusRequest("elsewhere")).toBe(false);
    expect(takeFocusRequest("readability")).toBe(true);
    expect(takeFocusRequest("readability")).toBe(false);
  });
});
