import { describe, expect, test } from "bun:test";
import {
  DRAFT_CAP_BYTES,
  canStash,
  clearDraft,
  draftKey,
  restore,
  stash,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/ui/draft.js";

function memoryStorage() {
  const data = new Map<string, string>();
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

describe("drafts", () => {
  test("a key names the route and the field", () => {
    expect(draftKey("h/hrn_1/advisor", "issue-title")).toBe(
      "hangar.draft.h/hrn_1/advisor.issue-title",
    );
  });

  test("a prose field is kept and read back, and an empty one clears", () => {
    const storage = memoryStorage();
    const key = draftKey("r", "f");
    expect(stash(key, "half a sentence", { storage, field: { type: "text" } })).toEqual({
      ok: true,
      reason: null,
    });
    expect(restore(key, { storage })).toBe("half a sentence");
    stash(key, "", { storage });
    expect(restore(key, { storage })).toBeNull();
    stash(key, "again", { storage });
    clearDraft(key, { storage });
    expect(storage.data.size).toBe(0);
  });

  test.each([
    ["a password field", { type: "password" }],
    ["a field marked secret", { type: "text", dataset: { secret: "" } }],
    ["a current password", { type: "text", autocomplete: "current-password" }],
    ["a new password", { type: "text", autocomplete: "section-a new-password" }],
    ["a one-time code", { type: "text", autocomplete: "one-time-code" }],
    ["a card number", { type: "text", autocomplete: "cc-number" }],
    ["a card code", { type: "text", autocomplete: "billing cc-csc" }],
    ["nothing at all", null],
  ])("%s is never kept", (_what, field) => {
    expect(canStash(field)).toBe(false);
    const storage = memoryStorage();
    expect(stash("k", "sk-something-secret", { storage, field }).ok).toBe(false);
    expect(storage.data.size).toBe(0);
  });

  test("an element's attributes are read too", () => {
    const element = (attrs: Record<string, string>) => ({
      getAttribute: (name: string) => attrs[name] ?? null,
    });
    expect(canStash(element({ type: "password" }))).toBe(false);
    expect(canStash(element({ "data-secret": "" }))).toBe(false);
    expect(canStash(element({ type: "text", autocomplete: "off" }))).toBe(true);
  });

  test("over the cap is refused rather than cut, and what was kept is cleared", () => {
    const storage = memoryStorage();
    stash("k", "short", { storage });
    expect(stash("k", "x".repeat(DRAFT_CAP_BYTES + 1), { storage })).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(storage.data.has("k")).toBe(false);
    // The cap is in bytes: four-byte characters reach it four times sooner.
    expect(stash("k", "😀".repeat(DRAFT_CAP_BYTES / 4 + 1), { storage }).reason).toBe("too-large");
  });

  test("a storage that throws loses the draft, never the page", () => {
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
    expect(stash("k", "text", { storage: throwing })).toEqual({
      ok: false,
      reason: "storage-failed",
    });
    expect(restore("k", { storage: throwing })).toBeNull();
    expect(() => clearDraft("k", { storage: throwing })).not.toThrow();
    expect(stash("k", "text", { storage: null }).reason).toBe("no-storage");
  });
});
