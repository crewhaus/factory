/**
 * The Thredz view's WRITE-SAFETY decisions.
 *
 * Everything this screen sends upstream lands in someone else's workspace,
 * so the two decisions that can destroy content there — whether a served
 * body may be written back at all, and which fields an edit actually carries
 * — are pure functions in `views/thredz.js` and are proven here. The exact
 * file the browser loads is the file under test.
 *
 * The rest is a source scan, the same technique `creds-views.test.ts` uses:
 * this package deliberately ships no headless-DOM machinery, and what has to
 * hold is structural (the editor applies the guard; it never echoes a value
 * it was seeded with; the restore button reports what the server DID).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { MASK_MARK, maskedEditGuard, wikiEditBody } from "../assets/js/views/thredz.js";

const VIEW_PATH = join(import.meta.dir, "..", "assets", "js", "views", "thredz.js");

function viewSource(): string {
  return readFileSync(VIEW_PATH, "utf8");
}

/** One top-level function's source, so an assertion about the editor cannot
 *  be satisfied (or broken) by an unrelated part of the module. */
function functionSource(name: string): string {
  const src = viewSource();
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("maskedEditGuard", () => {
  test("a body carrying the mask mark is read-only, and it says why", () => {
    // Served text is MASKED. Saving it back would persist `***` over the
    // real span — upstream, in a workspace other people read.
    const guard = maskedEditGuard(`export GITHUB_TOKEN=${MASK_MARK}\nrestart the worker`);
    expect(guard.readOnly).toBe(true);
    expect(String(guard.reason)).toContain("persist the mask");
    expect(String(guard.reason)).toContain("Thredz workspace");
  });

  test("an ordinary body is editable, and a missing one is not a crash", () => {
    expect(maskedEditGuard("step one\nstep two")).toEqual({ readOnly: false, reason: null });
    expect(maskedEditGuard(undefined).readOnly).toBe(false);
    expect(maskedEditGuard(null).readOnly).toBe(false);
  });
});

describe("wikiEditBody", () => {
  test("the title is NEVER sent — the served one is masked, and a default renames the article", () => {
    const edit = wikiEditBody("MY TEXT", 7, "(unchanged)", "");
    expect(edit).not.toHaveProperty("title");
    expect(edit).not.toHaveProperty("status");
    expect(edit).not.toHaveProperty("visibility");
    expect(edit["body"]).toBe("MY TEXT");
    expect(edit["expectedVersion"]).toBe(7);
  });

  test("visibility rides along only when the operator picked one", () => {
    expect(wikiEditBody("x", 1, "shared", "")["visibility"]).toBe("shared");
    expect(wikiEditBody("x", 1, "private", "")["visibility"]).toBe("private");
    expect(wikiEditBody("x", 1, "(unchanged)", "")).not.toHaveProperty("visibility");
  });

  test("an absent version is absent rather than invented — the server refuses that write", () => {
    expect(wikiEditBody("x", null, "(unchanged)", "")).not.toHaveProperty("expectedVersion");
    expect(wikiEditBody("x", 0, "(unchanged)", "")["expectedVersion"]).toBe(0);
  });

  test("an empty edit message is omitted, a typed one is trimmed", () => {
    expect(wikiEditBody("x", 1, "(unchanged)", "   ")).not.toHaveProperty("editMessage");
    expect(wikiEditBody("x", 1, "(unchanged)", "  fix typo ")["editMessage"]).toBe("fix typo");
  });
});

describe("the article editor", () => {
  test("it applies the mask guard and locks the form rather than saving a view", () => {
    const editor = functionSource("editorCard");
    expect(editor).toContain("maskedEditGuard(");
    expect(editor).toContain("save.disabled = true");
    expect(editor).toContain("body.readOnly = true");
  });

  test("it never echoes the article's own title back into the write", () => {
    // `maskArticle` masks the title too, so echoing it persists the mask;
    // and a defaulted title renames the article to its slug upstream.
    const editor = functionSource("editorCard");
    expect(editor).toContain("wikiEditBody(");
    expect(editor).not.toContain("article.title");
    expect(editor).not.toContain("title:");
  });
});

describe("the record restore button", () => {
  test("the toast reports what the server DID, not what the button hoped", () => {
    // Restore is a one-shot: the second click has nothing to put back and
    // the server answers `restored: false`. Asserting "Record restored" on
    // `ok === true` would have told the operator a no-op was a restore.
    const flat = viewSource().replace(/\s+/g, " ");
    expect(flat).toContain('if (res.restored === true) toast("Record restored"');
    expect(flat).not.toContain('api.thredzRecordRestore({ id: ctx.id, recordId }, {}), "Record');
  });

  test("the button leaves the flight while a restore is in the air", () => {
    const flat = viewSource().replace(/\s+/g, " ");
    expect(flat).toContain("button.disabled = true");
  });
});
