/**
 * The pure modules, driven entirely by output recorded from real machines.
 *
 * Nothing in this file touches a host: no command is spawned, no watcher is
 * attached, no clock is read. Every input is either a fixture from
 * `./fixtures.ts` — captured by running the real program on macOS 15.6 and on
 * Alpine Linux 3.19 — or a number written out by hand. That is deliberate:
 * these parsers exist to survive the differences between those two machines,
 * and a suite that asked the machine it happens to run on would be testing
 * the one case it is least likely to get wrong.
 */
import { describe, expect, test } from "bun:test";
import {
  GIO_COLLISION_NAMES,
  GIO_CROSS_DEVICE_STDERR,
  GIO_TRASHINFO,
  GIO_TRASH_NAMES,
  LINUX_WATCH,
  MACOS_WATCH,
  MACOS_WATCH_UNDER_BUN,
  MDFIND_APPS_STDOUT,
  MDFIND_BAD_QUERY_STDOUT,
  MDFIND_DOUBLE_DASH_STDOUT,
  MDFIND_EMPTY_STDOUT,
  MDUTIL_DISABLED_STDOUT_UNVERIFIED,
  MDUTIL_ENABLED_DATA_STDOUT,
  MDUTIL_ENABLED_STDOUT,
  MDUTIL_INVALID_PATH_STDOUT,
  MDUTIL_UNKNOWN_STDOUT,
  PLOCATE_DASH_PATTERN_STDOUT,
  PLOCATE_MATCH_STDOUT,
  PLOCATE_NO_DATABASE,
  PLOCATE_NO_MATCH,
  PLOCATE_TWO_MATCHES_STDOUT,
  PLOCATE_UNRECOGNISED_OPTION,
  type RecordedWatchEvent,
  replay,
} from "./fixtures";
import {
  type CoalesceOptions,
  type CoalesceResult,
  EventCoalescer,
  type RawWatchEvent,
  coalesceTimeline,
} from "./lib/coalesce";
import { LOCATE_DB_PATHS, classifyLocateResult, describeIndexAge, locateArgv } from "./lib/locate";
import {
  applyLimit,
  compileGlob,
  dropTruncatedTail,
  globRegexSource,
  isInsideRoot,
  scopeResults,
} from "./lib/scope";
import {
  buildPredicate,
  classifyMdfindResult,
  escapePredicateLiteral,
  mdfindArgv,
  mdutilArgv,
  parseMdutilStatus,
  parseNulList,
  rejectUnsafeQuery,
} from "./lib/spotlight";
import {
  candidateNames,
  checkTopdirTrash,
  decodeTrashPath,
  encodeTrashPath,
  formatDeletionDate,
  homeTrashDir,
  infoPathFor,
  parseTrashInfo,
  renderTrashInfo,
  sharedTopdirTrash,
  userTopdirTrash,
} from "./lib/trashspec";
import { assertArgv } from "./run";

const BASE_MS = 1_000_000;

const defaults: CoalesceOptions = {
  settleMs: 200,
  maxEvents: 100,
  maxRawEvents: 1_000,
};

function fold(
  recorded: readonly RecordedWatchEvent[],
  exists: (filename: string, index: number) => boolean,
  options: Partial<CoalesceOptions> & { endAtMs?: number } = {},
): CoalesceResult {
  const events = replay(recorded, exists, BASE_MS);
  const last = events.at(-1);
  return coalesceTimeline(events, {
    ...defaults,
    ...options,
    endAtMs: options.endAtMs ?? (last === undefined ? BASE_MS : last.atMs + 1_000),
  });
}

const always = (): boolean => true;
const never = (): boolean => false;

// ===========================================================================
// coalesce — the fold, from recorded event streams
// ===========================================================================

describe("coalesce: one logical change is one event", () => {
  test("macOS folds one atomic save into the target file plus its temp file", () => {
    // Recorded: four notifications for what a person calls one save.
    const result = fold(
      MACOS_WATCH.atomicSave as RecordedWatchEvent[],
      (name) => name === "doc.md",
      {
        known: new Set(["doc.md"]),
      },
    );
    expect(result.rawCount).toBe(4);
    expect(result.events.length).toBe(2);
    const target = result.events.find((event) => event.path === "doc.md");
    expect(target?.kind).toBe("modified");
    expect(target?.rawCount).toBe(2);
  });

  test("the temp file of an atomic save is reported as transient, not as a deletion", () => {
    const result = fold(
      MACOS_WATCH.atomicSave as RecordedWatchEvent[],
      (name) => name === "doc.md",
      {
        known: new Set(["doc.md"]),
      },
    );
    const temp = result.events.find((event) => event.path === "doc.md.tmp12345");
    expect(temp?.transient).toBe(true);
    // It never existed as far as the watch could see, so calling it "deleted"
    // without the flag would read as data loss.
    expect(temp?.kind).toBe("deleted");
  });

  test("dropTransient removes the temp file and counts it separately", () => {
    const result = fold(
      MACOS_WATCH.atomicSave as RecordedWatchEvent[],
      (name) => name === "doc.md",
      {
        known: new Set(["doc.md"]),
        dropTransient: true,
      },
    );
    expect(result.events.map((event) => event.path)).toEqual(["doc.md"]);
    expect(result.transientDropped).toBe(1);
    // Counted apart from the kind/glob filters: "an editor wrote a temp file"
    // is a different fact from "nothing you asked about happened".
    expect(result.filteredOut).toBe(0);
  });

  test("Linux's three writes for one save fold into one modification", () => {
    const result = fold(LINUX_WATCH.threeWriteSave as RecordedWatchEvent[], always, {
      known: new Set(["app.ts"]),
    });
    expect(result.rawCount).toBe(3);
    expect(result.events.length).toBe(1);
    expect(result.events[0]?.kind).toBe("modified");
    expect(result.events[0]?.rawCount).toBe(3);
  });

  test("macOS's two notifications for the same save fold the same way", () => {
    const result = fold(MACOS_WATCH.threeWriteSave as RecordedWatchEvent[], always, {
      known: new Set(["app.ts"]),
    });
    expect(result.events.length).toBe(1);
    expect(result.events[0]?.rawCount).toBe(2);
  });

  test("a caller counting saves gets the same number on both platforms", () => {
    const mac = fold(MACOS_WATCH.threeWriteSave as RecordedWatchEvent[], always, {
      known: new Set(["app.ts"]),
    });
    const linux = fold(LINUX_WATCH.threeWriteSave as RecordedWatchEvent[], always, {
      known: new Set(["app.ts"]),
    });
    // The whole point of the package: the raw counts differ (2 against 3) and
    // the answer does not.
    expect(mac.rawCount).not.toBe(linux.rawCount);
    expect(mac.events.length).toBe(linux.events.length);
    expect(mac.events[0]?.kind).toBe(linux.events[0]?.kind);
  });

  test("settleMs 0 keeps every notification as its own event", () => {
    const result = fold(LINUX_WATCH.threeWriteSave as RecordedWatchEvent[], always, {
      known: new Set(["app.ts"]),
      settleMs: 0,
    });
    expect(result.events.length).toBe(3);
  });

  test("two changes further apart than the window stay two events", () => {
    const events: RawWatchEvent[] = [
      { atMs: BASE_MS, eventType: "change", path: "a.txt", existsNow: true },
      { atMs: BASE_MS + 500, eventType: "change", path: "a.txt", existsNow: true },
    ];
    const result = coalesceTimeline(events, {
      ...defaults,
      known: new Set(["a.txt"]),
      endAtMs: BASE_MS + 1_000,
    });
    expect(result.events.length).toBe(2);
    expect(result.events.every((event) => event.kind === "modified")).toBe(true);
  });

  test("different paths never fold into each other, however close together", () => {
    const events: RawWatchEvent[] = [
      { atMs: BASE_MS, eventType: "rename", path: "a.txt", existsNow: true },
      { atMs: BASE_MS + 1, eventType: "rename", path: "b.txt", existsNow: true },
    ];
    const result = coalesceTimeline(events, { ...defaults, endAtMs: BASE_MS + 500 });
    expect(result.events.map((event) => event.path)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("coalesce: the kind comes from the filesystem, not the platform's word", () => {
  test("macOS calls an append 'rename' and it is still reported as modified", () => {
    const result = fold(MACOS_WATCH.appendWrite as RecordedWatchEvent[], always, {
      known: new Set(["log.txt"]),
    });
    expect(result.events[0]?.eventTypes).toEqual(["rename"]);
    expect(result.events[0]?.kind).toBe("modified");
  });

  test("Linux calls the same append 'change' and reports the same kind", () => {
    const result = fold(LINUX_WATCH.appendWrite as RecordedWatchEvent[], always, {
      known: new Set(["log.txt"]),
    });
    expect(result.events[0]?.eventTypes).toEqual(["change"]);
    expect(result.events[0]?.kind).toBe("modified");
  });

  test("a path absent before and present after is created", () => {
    const result = fold(MACOS_WATCH.createNested as RecordedWatchEvent[], always);
    expect(result.events.every((event) => event.kind === "created")).toBe(true);
    expect(result.events.map((event) => event.path)).toEqual(["pkg", "pkg/src", "pkg/src/new.ts"]);
  });

  test("a path present before and absent after is deleted", () => {
    const result = fold(MACOS_WATCH.deleteFile as RecordedWatchEvent[], never, {
      known: new Set(["gone.txt"]),
    });
    expect(result.events[0]?.kind).toBe("deleted");
    expect(result.events[0]?.transient).toBeUndefined();
  });

  test("a rename inside the tree reads as one deletion and one creation on macOS", () => {
    const result = fold(
      MACOS_WATCH.renameFile as RecordedWatchEvent[],
      (name) => name === "new.txt",
      { known: new Set(["old.txt"]) },
    );
    const byPath = new Map(result.events.map((event) => [event.path, event.kind]));
    expect(byPath.get("old.txt")).toBe("deleted");
    expect(byPath.get("new.txt")).toBe("created");
  });

  test("Linux reports only the new name for the same rename, and says created", () => {
    // Recorded divergence: the old name produces no notification at all here.
    const result = fold(
      LINUX_WATCH.renameFile as RecordedWatchEvent[],
      (name) => name === "new.txt",
      { known: new Set(["old.txt"]) },
    );
    expect(result.events.map((event) => event.path)).toEqual(["new.txt"]);
    expect(result.events[0]?.kind).toBe("created");
  });

  test("a delete followed by a create inside one window is a modification", () => {
    // What a non-atomic editor save looks like: the file is briefly gone.
    const events: RawWatchEvent[] = [
      { atMs: BASE_MS, eventType: "rename", path: "doc.md", existsNow: false },
      { atMs: BASE_MS + 5, eventType: "rename", path: "doc.md", existsNow: true },
    ];
    const result = coalesceTimeline(events, {
      ...defaults,
      known: new Set(["doc.md"]),
      endAtMs: BASE_MS + 500,
    });
    expect(result.events.length).toBe(1);
    expect(result.events[0]?.kind).toBe("modified");
  });

  test("a file created and then deleted across two windows is two events", () => {
    const events: RawWatchEvent[] = [
      { atMs: BASE_MS, eventType: "rename", path: "tmp.txt", existsNow: true },
      { atMs: BASE_MS + 900, eventType: "rename", path: "tmp.txt", existsNow: false },
    ];
    const result = coalesceTimeline(events, { ...defaults, endAtMs: BASE_MS + 2_000 });
    expect(result.events.map((event) => event.kind)).toEqual(["created", "deleted"]);
  });

  test("the known set is what makes 'created' mean created", () => {
    const withoutSnapshot = fold(MACOS_WATCH.appendWrite as RecordedWatchEvent[], always);
    const withSnapshot = fold(MACOS_WATCH.appendWrite as RecordedWatchEvent[], always, {
      known: new Set(["log.txt"]),
    });
    expect(withoutSnapshot.events[0]?.kind).toBe("created");
    expect(withSnapshot.events[0]?.kind).toBe("modified");
  });
});

describe("coalesce: what the runtime does not report", () => {
  test("the recorded Bun-on-macOS save contains nothing but the temp file", () => {
    // The fold is honest about this: with only the temp file's events, the
    // only thing to report is a transient. Recovering the save needs the
    // filesystem, which is what the watch session's reconciliation does.
    const result = fold(MACOS_WATCH_UNDER_BUN.atomicSave as RecordedWatchEvent[], () => false, {
      known: new Set(["doc.md"]),
      dropTransient: true,
    });
    expect(result.events).toEqual([]);
    expect(result.transientDropped).toBe(1);
  });

  test("a reconciled event folds together with a real one for the same path", () => {
    // On Linux both arrive. They must not be counted as two saves.
    const events: RawWatchEvent[] = [
      { atMs: BASE_MS, eventType: "rename", path: "doc.md", existsNow: true },
      { atMs: BASE_MS + 3, eventType: "reconciled", path: "doc.md", existsNow: true },
    ];
    const result = coalesceTimeline(events, {
      ...defaults,
      known: new Set(["doc.md"]),
      endAtMs: BASE_MS + 1_000,
    });
    expect(result.events.length).toBe(1);
    expect(result.events[0]?.eventTypes).toEqual(["reconciled", "rename"]);
  });
});

describe("coalesce: the bounds, and which one ended it", () => {
  test("the deadline is reported when nothing hit the cap", () => {
    const result = fold(LINUX_WATCH.appendWrite as RecordedWatchEvent[], always, {
      known: new Set(["log.txt"]),
    });
    expect(result.stoppedBy).toBe("deadline");
  });

  test("an empty timeline still reports the bound that ended it", () => {
    const result = coalesceTimeline([], { ...defaults, endAtMs: BASE_MS });
    expect(result.events).toEqual([]);
    // Assert the REASON, not just the emptiness: an empty answer with no
    // reason is what a caller mistakes for a satisfied wait.
    expect(result.stoppedBy).toBe("deadline");
  });

  test("an abort is reported as an abort, not as a deadline", () => {
    const result = coalesceTimeline([], {
      ...defaults,
      endAtMs: BASE_MS,
      reason: "aborted",
    });
    expect(result.stoppedBy).toBe("aborted");
  });

  test("the cap ends collection and says so", () => {
    const events: RawWatchEvent[] = [0, 1, 2, 3, 4].map((n) => ({
      atMs: BASE_MS + n * 1_000,
      eventType: "change",
      path: `f${n}.txt`,
      existsNow: true,
    }));
    const result = coalesceTimeline(events, {
      ...defaults,
      maxEvents: 2,
      endAtMs: BASE_MS + 10_000,
    });
    expect(result.stoppedBy).toBe("eventCap");
    expect(result.events.length).toBe(2);
  });

  test("the cap counts COALESCED events, so one noisy save does not exhaust it", () => {
    const noisy: RawWatchEvent[] = [0, 1, 2, 3, 4, 5].map((n) => ({
      atMs: BASE_MS + n * 10,
      eventType: "change",
      path: "app.ts",
      existsNow: true,
    }));
    const result = coalesceTimeline(noisy, {
      ...defaults,
      maxEvents: 2,
      known: new Set(["app.ts"]),
      endAtMs: BASE_MS + 5_000,
    });
    expect(result.events.length).toBe(1);
    expect(result.events[0]?.rawCount).toBe(6);
    expect(result.stoppedBy).toBe("deadline");
  });

  test("notifications arriving after the cap are counted, not lost quietly", () => {
    const events: RawWatchEvent[] = [0, 1, 2, 3].map((n) => ({
      atMs: BASE_MS + n * 1_000,
      eventType: "change",
      path: `f${n}.txt`,
      existsNow: true,
    }));
    const result = coalesceTimeline(events, {
      ...defaults,
      maxEvents: 1,
      endAtMs: BASE_MS + 10_000,
    });
    expect(result.events.length).toBe(1);
    expect(result.stoppedBy).toBe("eventCap");
    expect(result.rawDropped).toBeGreaterThan(0);
  });

  test("events still pending when the cap closes are counted as dropped", () => {
    // Three paths touched inside one window: the first to settle fills a cap
    // of one, and the other two must show up in the total rather than
    // vanishing between the cap and the report.
    const events: RawWatchEvent[] = ["a", "b", "c"].map((name, n) => ({
      atMs: BASE_MS + n,
      eventType: "change",
      path: `${name}.txt`,
      existsNow: true,
    }));
    const result = coalesceTimeline(events, {
      ...defaults,
      maxEvents: 1,
      endAtMs: BASE_MS + 10_000,
    });
    expect(result.events.length).toBe(1);
    expect(result.droppedByCap).toBe(2);
  });

  test("the raw ceiling drops notifications and counts them", () => {
    const flood: RawWatchEvent[] = Array.from({ length: 50 }, (_, n) => ({
      atMs: BASE_MS + n,
      eventType: "change",
      path: `f${n}.txt`,
      existsNow: true,
    }));
    const result = coalesceTimeline(flood, {
      ...defaults,
      maxRawEvents: 10,
      endAtMs: BASE_MS + 5_000,
    });
    expect(result.rawCount).toBe(10);
    expect(result.rawDropped).toBe(40);
  });

  test("whatever is still open at the deadline is flushed, not lost", () => {
    const events: RawWatchEvent[] = [
      { atMs: BASE_MS, eventType: "change", path: "late.txt", existsNow: true },
    ];
    // The deadline lands one millisecond after the event, inside the settle
    // window: the last save before a timeout must still be reported.
    const result = coalesceTimeline(events, { ...defaults, endAtMs: BASE_MS + 1 });
    expect(result.events.length).toBe(1);
    expect(result.stoppedBy).toBe("deadline");
  });
});

describe("coalesce: filters decide what counts", () => {
  test("a kind filter drops the others and counts them", () => {
    const result = fold(MACOS_WATCH.createNested as RecordedWatchEvent[], always, {
      kinds: new Set(["deleted"]),
    });
    expect(result.events).toEqual([]);
    expect(result.filteredOut).toBe(3);
  });

  test("a filtered-out event does not consume the cap", () => {
    const events: RawWatchEvent[] = [
      { atMs: BASE_MS, eventType: "rename", path: "noise.tmp", existsNow: true },
      { atMs: BASE_MS + 1_000, eventType: "rename", path: "wanted.ts", existsNow: true },
    ];
    const result = coalesceTimeline(events, {
      ...defaults,
      maxEvents: 1,
      matches: compileGlob("**/*.ts"),
      endAtMs: BASE_MS + 5_000,
    });
    // maxEvents 1 with a filter means "the first TypeScript change", not
    // "give up after the first temp file".
    expect(result.events.map((event) => event.path)).toEqual(["wanted.ts"]);
    expect(result.filteredOut).toBe(1);
  });

  test("a glob filter matches the path relative to the watch root", () => {
    const result = fold(MACOS_WATCH.createNested as RecordedWatchEvent[], always, {
      matches: compileGlob("**/*.ts"),
    });
    expect(result.events.map((event) => event.path)).toEqual(["pkg/src/new.ts"]);
  });
});

describe("coalesce: the reducer the live watcher drives", () => {
  test("advanceTo closes a window without any new event arriving", () => {
    const coalescer = new EventCoalescer({ ...defaults, maxEvents: 1 });
    coalescer.push({ atMs: BASE_MS, eventType: "change", path: "a.txt", existsNow: true });
    expect(coalescer.keptCount()).toBe(0);
    coalescer.advanceTo(BASE_MS + 201);
    expect(coalescer.keptCount()).toBe(1);
    expect(coalescer.capReached()).toBe(true);
  });

  test("push after the cap is reached is dropped and counted", () => {
    const coalescer = new EventCoalescer({ ...defaults, maxEvents: 1 });
    coalescer.push({ atMs: BASE_MS, eventType: "change", path: "a.txt", existsNow: true });
    coalescer.advanceTo(BASE_MS + 201);
    coalescer.push({ atMs: BASE_MS + 300, eventType: "change", path: "b.txt", existsNow: true });
    const result = coalescer.finish(BASE_MS + 1_000, "deadline");
    expect(result.events.length).toBe(1);
    expect(result.rawDropped).toBe(1);
    expect(result.stoppedBy).toBe("eventCap");
  });

  test("the reported order is by time, then by path, never by insertion", () => {
    const coalescer = new EventCoalescer(defaults);
    coalescer.push({ atMs: BASE_MS + 5, eventType: "change", path: "z.txt", existsNow: true });
    coalescer.push({ atMs: BASE_MS + 5, eventType: "change", path: "a.txt", existsNow: true });
    const result = coalescer.finish(BASE_MS + 1_000, "deadline");
    expect(result.events.map((event) => event.path)).toEqual(["a.txt", "z.txt"]);
  });
});

// ===========================================================================
// trashspec — against gio's own bytes
// ===========================================================================

describe("trashspec: the .trashinfo record reproduces gio's bytes", () => {
  test("a plain path", () => {
    expect(
      renderTrashInfo({
        originalPath: "/root/work/simple.txt",
        deletionDate: "2026-09-19T01:29:18",
      }),
    ).toBe(GIO_TRASHINFO.simple);
  });

  test("spaces, a hash and parentheses — the case encodeURIComponent gets wrong", () => {
    expect(
      renderTrashInfo({
        originalPath: "/root/work/spaced name #1 (copy).txt",
        deletionDate: "2026-09-19T01:29:18",
      }),
    ).toBe(GIO_TRASHINFO.spaced);
  });

  test("encodeURIComponent really would have got it wrong", () => {
    // Kept as a test rather than a comment: this is the reason the package
    // carries its own encoder, and a future simplification would break the
    // format for every desktop trash that reads it.
    expect(encodeURIComponent("(copy)")).toBe("(copy)");
    expect(encodeTrashPath("(copy)")).toBe("%28copy%29");
  });

  test("non-ASCII is encoded per UTF-8 byte", () => {
    expect(
      renderTrashInfo({
        originalPath: "/root/work/uni-café-ü.txt",
        deletionDate: "2026-09-19T01:29:18",
      }),
    ).toBe(GIO_TRASHINFO.unicode);
  });

  test("a directory records the same way a file does", () => {
    expect(
      renderTrashInfo({ originalPath: "/root/work/tree", deletionDate: "2026-09-19T01:29:18" }),
    ).toBe(GIO_TRASHINFO.directory);
  });

  test("the separator itself is never encoded", () => {
    expect(encodeTrashPath("/a/b/c")).toBe("/a/b/c");
  });

  test("every recorded record parses back to the path it came from", () => {
    for (const [name, text] of Object.entries(GIO_TRASHINFO)) {
      const parsed = parseTrashInfo(text);
      expect(parsed, name).toBeDefined();
      expect(parsed?.deletionDate).toBe("2026-09-19T01:29:18");
    }
    expect(parseTrashInfo(GIO_TRASHINFO.spaced)?.originalPath).toBe(
      "/root/work/spaced name #1 (copy).txt",
    );
    expect(parseTrashInfo(GIO_TRASHINFO.unicode)?.originalPath).toBe("/root/work/uni-café-ü.txt");
  });

  test("a round trip survives every awkward character", () => {
    for (const path of [
      "/a/b/plain.txt",
      "/a/b/with space.txt",
      "/a/b/100% sure.txt",
      "/a/b/quote'and\"quote.txt",
      "/a/b/emoji-🗑.txt",
      "/a/b/back\\slash.txt",
    ]) {
      expect(decodeTrashPath(encodeTrashPath(path)), path).toBe(path);
    }
  });

  test("something that is not a trashinfo file is rejected rather than half-read", () => {
    expect(parseTrashInfo("Path=/x\nDeletionDate=2026-01-01T00:00:00\n")).toBeUndefined();
    expect(parseTrashInfo("[Trash Info]\nPath=/x\n")).toBeUndefined();
    expect(parseTrashInfo("")).toBeUndefined();
  });
});

describe("trashspec: the deletion date", () => {
  test("UTC renders the recorded shape", () => {
    const epoch = Date.parse("2026-09-19T01:29:18Z");
    expect(formatDeletionDate(epoch, 0)).toBe("2026-09-19T01:29:18");
  });

  test("it is LOCAL time, with no zone suffix — the spec's requirement", () => {
    const epoch = Date.parse("2026-09-19T01:29:18Z");
    // getTimezoneOffset is positive west of Greenwich, so -120 is UTC+2.
    expect(formatDeletionDate(epoch, -120)).toBe("2026-09-19T03:29:18");
    expect(formatDeletionDate(epoch, 300)).toBe("2026-09-18T20:29:18");
  });

  test("every field is zero-padded", () => {
    expect(formatDeletionDate(Date.parse("2026-01-02T03:04:05Z"), 0)).toBe("2026-01-02T03:04:05");
  });
});

describe("trashspec: collision names follow gio", () => {
  test("the second file with a name becomes name.2.ext", () => {
    const names = [...take(candidateNames("simple.txt"), 3)];
    expect(names).toEqual(["simple.txt", "simple.2.txt", "simple.3.txt"]);
  });

  test("the recorded collision is exactly this scheme", () => {
    const second = GIO_TRASH_NAMES.filter((entry) => entry.original.endsWith("simple.txt"));
    expect(second.map((entry) => entry.stored)).toEqual(["simple.txt", "simple.2.txt"]);
  });

  test("a name with no extension takes the suffix at the end", () => {
    expect([...take(candidateNames("tree"), 2)]).toEqual(["tree", "tree.2"]);
  });

  test("a dotfile's leading dot counts as the start of the extension", () => {
    expect([...take(candidateNames(".env"), 2)]).toEqual([".env", ".2.env"]);
  });

  test("every recorded collision sequence is reproduced exactly", () => {
    // The scheme was captured rather than guessed: `archive.tar.gz` collides
    // as `archive.2.tar.gz`, not `archive.tar.2.gz`, and `.env` as `.2.env`.
    for (const [basename, expected] of Object.entries(GIO_COLLISION_NAMES)) {
      expect([...take(candidateNames(basename), expected.length)], basename).toEqual([...expected]);
    }
  });

  test("the generator is bounded, so a pathological trash cannot spin forever", () => {
    expect([...candidateNames("x", 3)].length).toBe(3);
  });
});

describe("trashspec: where the trash is", () => {
  test("$XDG_DATA_HOME wins when it is absolute", () => {
    expect(homeTrashDir({ home: "/home/u", xdgDataHome: "/data" })).toBe("/data/Trash");
  });

  test("a RELATIVE $XDG_DATA_HOME is ignored, per the XDG base directory spec", () => {
    // Honouring one would put the trash under whatever directory the harness
    // happens to be running in.
    expect(homeTrashDir({ home: "/home/u", xdgDataHome: "relative/path" })).toBe(
      "/home/u/.local/share/Trash",
    );
  });

  test("the default is $HOME/.local/share/Trash", () => {
    expect(homeTrashDir({ home: "/home/u", xdgDataHome: undefined })).toBe(
      "/home/u/.local/share/Trash",
    );
  });

  test("with neither set there is no home trash at all", () => {
    expect(homeTrashDir({ home: undefined, xdgDataHome: undefined })).toBeUndefined();
  });

  test("a trailing slash does not produce a doubled separator", () => {
    expect(homeTrashDir({ home: "/home/u/", xdgDataHome: undefined })).toBe(
      "/home/u/.local/share/Trash",
    );
  });

  test("the two top-directory forms are named as the spec names them", () => {
    expect(sharedTopdirTrash("/mnt/usb", 1000)).toBe("/mnt/usb/.Trash/1000");
    expect(userTopdirTrash("/mnt/usb", 1000)).toBe("/mnt/usb/.Trash-1000");
  });

  test("a top-directory trash records a path relative to the top directory", () => {
    // So the entry survives the volume being mounted somewhere else, which a
    // USB stick does every time.
    expect(infoPathFor("/mnt/usb/docs/a.txt", "/mnt/usb")).toBe("docs/a.txt");
  });

  test("the home trash records an absolute path", () => {
    expect(infoPathFor("/home/u/a.txt", undefined)).toBe("/home/u/a.txt");
  });

  test("a path that is not under the top directory stays absolute", () => {
    expect(infoPathFor("/elsewhere/a.txt", "/mnt/usb")).toBe("/elsewhere/a.txt");
  });
});

describe("trashspec: $topdir/.Trash is only trusted when it is safe", () => {
  const sticky = { exists: true, isDirectory: true, isSymlink: false, mode: 0o41777 };

  test("a sticky directory is usable", () => {
    expect(checkTopdirTrash(sticky).usable).toBe(true);
  });

  test("a symlink is refused, and the reason says so", () => {
    const result = checkTopdirTrash({ ...sticky, isSymlink: true });
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("symbolic link");
  });

  test("no sticky bit is refused", () => {
    // Without it, any user on the machine can replace another user's trashed
    // files — which is why the spec makes this a MUST.
    const result = checkTopdirTrash({ ...sticky, mode: 0o40777 });
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("sticky");
  });

  test("a regular file wearing the name is refused", () => {
    expect(checkTopdirTrash({ ...sticky, isDirectory: false }).usable).toBe(false);
  });

  test("an absent directory is refused rather than assumed", () => {
    expect(checkTopdirTrash({ ...sticky, exists: false }).usable).toBe(false);
  });
});

describe("trashspec: the recorded cross-device refusal", () => {
  test("the reference implementation refuses rather than copying", () => {
    // Recorded from `gio trash` on a file on a second filesystem. The file was
    // still in place afterwards, which is the behaviour this package copies.
    expect(GIO_CROSS_DEVICE_STDERR).toContain("not supported");
    expect(GIO_CROSS_DEVICE_STDERR).not.toContain("copied");
  });
});

// ===========================================================================
// spotlight — from mdfind's and mdutil's own output
// ===========================================================================

describe("spotlight: the predicate cannot be escaped out of", () => {
  test("a name query becomes a quoted, case-insensitive comparison", () => {
    expect(buildPredicate({ query: "report", mode: "name", matchCase: false })).toBe(
      'kMDItemFSName == "*report*"c',
    );
  });

  test("matchCase drops the c modifier", () => {
    expect(buildPredicate({ query: "Report", mode: "name", matchCase: true })).toBe(
      'kMDItemFSName == "*Report*"',
    );
  });

  test("a content query searches text and ignores diacritics", () => {
    expect(buildPredicate({ query: "cafe", mode: "content", matchCase: false })).toBe(
      'kMDItemTextContent == "*cafe*"cd',
    );
  });

  test("a double quote in the query is escaped, not honoured", () => {
    // Unescaped, `" || kMDItemTextContent == "` would turn a filename search
    // into a content search over everything the user can read.
    const predicate = buildPredicate({
      query: '" || kMDItemTextContent == "*secret*"c || kMDItemFSName == "',
      mode: "name",
      matchCase: false,
    });
    expect(predicate.startsWith('kMDItemFSName == "*\\"')).toBe(true);
    // Every quote that is not one of the two delimiters is escaped.
    const unescaped = [...predicate.matchAll(/(^|[^\\])"/g)].length;
    expect(unescaped).toBe(2);
  });

  test("a backslash is escaped before the quotes are", () => {
    expect(escapePredicateLiteral('a\\"b')).toBe('a\\\\\\"b');
  });

  test("wildcards are left alone, because both backends treat them the same", () => {
    expect(buildPredicate({ query: "*.log", mode: "name", matchCase: false })).toBe(
      'kMDItemFSName == "**.log*"c',
    );
  });

  test("a control character is refused outright", () => {
    expect(rejectUnsafeQuery("ok")).toBeUndefined();
    expect(rejectUnsafeQuery("bad\0value")).toContain("control character");
    expect(rejectUnsafeQuery("bad\nvalue")).toContain("control character");
    expect(rejectUnsafeQuery("bad\u007fvalue")).toContain("control character");
  });
});

describe("spotlight: the argv", () => {
  test("the query never becomes an argv element of its own", () => {
    const argv = mdfindArgv({
      predicate: buildPredicate({ query: "-count", mode: "name", matchCase: false }),
      roots: ["/w"],
    });
    expect(argv).toEqual(["mdfind", "-0", "-onlyin", "/w", 'kMDItemFSName == "*-count*"c']);
    // Recorded: `mdfind -- x` prints "Unknown option --" and exits 1, so there
    // is no separator to hide behind. Every element after `-0` is either a
    // flag this package wrote or a value that starts with `/` or `kMDItem`.
    expect(MDFIND_DOUBLE_DASH_STDOUT).toContain("Unknown option --");
  });

  test("every root becomes its own -onlyin pair", () => {
    expect(mdfindArgv({ predicate: 'kMDItemFSName == "*a*"c', roots: ["/a", "/b"] })).toEqual([
      "mdfind",
      "-0",
      "-onlyin",
      "/a",
      "-onlyin",
      "/b",
      'kMDItemFSName == "*a*"c',
    ]);
  });

  test("a predicate that is not an attribute comparison is refused", () => {
    // The guard for the missing `--`: reaching here means a caller's text has
    // become argv on its own, and a leading dash would be read as a flag.
    expect(() => mdfindArgv({ predicate: "-count", roots: [] })).toThrow();
  });

  test("a relative root is refused", () => {
    expect(() => mdfindArgv({ predicate: 'kMDItemFSName == "*a*"c', roots: ["rel"] })).toThrow();
  });

  test("mdutil is only ever asked about an absolute volume", () => {
    expect(mdutilArgv("/")).toEqual(["mdutil", "-s", "/"]);
    expect(() => mdutilArgv("rel")).toThrow();
  });
});

describe("spotlight: reading mdfind's answer", () => {
  test("a NUL-delimited listing parses into paths, spaces and all", () => {
    const paths = parseNulList(MDFIND_APPS_STDOUT);
    expect(paths.length).toBe(6);
    expect(paths).toContain("/Applications/Visual Studio Code.app");
    // No trailing empty entry from the final NUL.
    expect(paths.every((path) => path !== "")).toBe(true);
  });

  test("a path containing a newline survives, which is why -0 is used", () => {
    expect(parseNulList("/a/two\nline.txt\0/b/c.txt\0")).toEqual(["/a/two\nline.txt", "/b/c.txt"]);
  });

  test("an empty answer parses to nothing, not to one empty path", () => {
    expect(parseNulList(MDFIND_EMPTY_STDOUT)).toEqual([]);
  });

  test("a malformed query is recognised on STDOUT, where mdfind prints it", () => {
    const failure = classifyMdfindResult({
      code: 1,
      stdout: MDFIND_BAD_QUERY_STDOUT,
      stderr: "",
      timedOut: false,
      missing: false,
    });
    // A parser that only read stderr would return the error text as a path.
    expect(failure?.kind).toBe("badQuery");
    expect(failure?.detail).toContain("Failed to create query");
  });

  test("the usage block from a rejected option is a failure, not a result", () => {
    const failure = classifyMdfindResult({
      code: 1,
      stdout: MDFIND_DOUBLE_DASH_STDOUT,
      stderr: "",
      timedOut: false,
      missing: false,
    });
    expect(failure?.kind).toBe("badQuery");
  });

  test("a clean run with matches is not a failure", () => {
    expect(
      classifyMdfindResult({
        code: 0,
        stdout: MDFIND_APPS_STDOUT,
        stderr: "",
        timedOut: false,
        missing: false,
      }),
    ).toBeUndefined();
  });

  test("a clean run with NO matches is also not a failure", () => {
    // It is an answer that needs the index probe, which is a different thing
    // from an error.
    expect(
      classifyMdfindResult({
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        missing: false,
      }),
    ).toBeUndefined();
  });

  test("a missing binary and a timeout are each named", () => {
    expect(
      classifyMdfindResult({
        code: 127,
        stdout: "",
        stderr: "",
        timedOut: false,
        missing: true,
      })?.kind,
    ).toBe("backendMissing");
    expect(
      classifyMdfindResult({
        code: -1,
        stdout: "",
        stderr: "",
        timedOut: true,
        missing: false,
      })?.kind,
    ).toBe("timedOut");
  });
});

describe("spotlight: reading mdutil's answer", () => {
  test("an indexed volume reads as enabled, trailing space and all", () => {
    const status = parseMdutilStatus(MDUTIL_ENABLED_STDOUT, "/");
    expect(status.state).toBe("enabled");
    expect(status.volume).toBe("/");
  });

  test("the data volume parses the same way", () => {
    expect(parseMdutilStatus(MDUTIL_ENABLED_DATA_STDOUT, "/").volume).toBe("/System/Volumes/Data");
  });

  test("'unknown indexing state' is UNKNOWN, never disabled", () => {
    // Recorded for any path that is not a volume root, on a machine whose
    // volumes are all indexed. Calling it disabled would turn every ordinary
    // directory into a false alarm.
    const status = parseMdutilStatus(MDUTIL_UNKNOWN_STDOUT, "/tmp");
    expect(status.state).toBe("unknown");
  });

  test("an invalid path is unknown too, despite exiting 0 and saying Error", () => {
    expect(parseMdutilStatus(MDUTIL_INVALID_PATH_STDOUT, "/Volumes/x").state).toBe("unknown");
  });

  test("a disabled volume reads as disabled", () => {
    // NOTE: this string is documented rather than captured — see fixtures.ts.
    expect(parseMdutilStatus(MDUTIL_DISABLED_STDOUT_UNVERIFIED, "/Volumes/Backup").state).toBe(
      "disabled",
    );
  });

  test("'indexing and searching disabled' is also disabled", () => {
    expect(
      parseMdutilStatus("/Volumes/X:\n\tIndexing and searching disabled.\n", "/Volumes/X").state,
    ).toBe("disabled");
  });

  test("anything unrecognised falls back to unknown, which is the safe answer", () => {
    expect(parseMdutilStatus("something else entirely\n", "/").state).toBe("unknown");
    expect(parseMdutilStatus("", "/").state).toBe("unknown");
  });
});

// ===========================================================================
// locate — from plocate's own output
// ===========================================================================

describe("locate: the argv", () => {
  test("the pattern always sits after --", () => {
    expect(
      locateArgv({
        backend: "plocate",
        pattern: "-dashfile",
        limit: 100,
        matchCase: false,
        basenameOnly: false,
      }),
    ).toEqual(["plocate", "-0", "--limit", "100", "-i", "--", "-dashfile"]);
  });

  test("matchCase drops -i", () => {
    const argv = locateArgv({
      backend: "plocate",
      pattern: "Report",
      limit: 10,
      matchCase: true,
      basenameOnly: false,
    });
    expect(argv).not.toContain("-i");
  });

  test("basenameOnly adds -b", () => {
    expect(
      locateArgv({
        backend: "locate",
        pattern: "notes.md",
        limit: 10,
        matchCase: false,
        basenameOnly: true,
      }),
    ).toEqual(["locate", "-0", "--limit", "10", "-i", "-b", "--", "notes.md"]);
  });

  test("an empty pattern is refused rather than turned into 'everything'", () => {
    expect(() =>
      locateArgv({
        backend: "plocate",
        pattern: "",
        limit: 10,
        matchCase: false,
        basenameOnly: false,
      }),
    ).toThrow();
  });
});

describe("locate: exit 1 means two different things", () => {
  test("exit 1 with nothing on stderr is a genuine miss", () => {
    expect(classifyLocateResult({ ...PLOCATE_NO_MATCH, timedOut: false, missing: false })).toEqual({
      kind: "noMatches",
    });
  });

  test("exit 1 with a database message is an unavailable index, NOT a miss", () => {
    // Identical exit code, opposite meaning. Reporting this as "no matches"
    // would hand a caller a confident empty answer on a machine where the
    // index was never built.
    const outcome = classifyLocateResult({
      ...PLOCATE_NO_DATABASE,
      timedOut: false,
      missing: false,
    });
    expect(outcome.kind).toBe("indexUnavailable");
    expect(outcome.kind === "indexUnavailable" && outcome.detail).toContain("plocate.db");
  });

  test("the two fixtures really do share an exit code", () => {
    expect(PLOCATE_NO_MATCH.code).toBe(PLOCATE_NO_DATABASE.code);
  });

  test("a permission problem on the database is unavailable, not empty", () => {
    const outcome = classifyLocateResult({
      code: 1,
      stdout: "",
      stderr: "/var/lib/plocate/plocate.db: Permission denied\n",
      timedOut: false,
      missing: false,
    });
    expect(outcome.kind).toBe("indexUnavailable");
  });

  test("an option this build does not know is its own outcome", () => {
    // Otherwise our own argv mistake would be reported as "the filesystem
    // contains nothing".
    const outcome = classifyLocateResult({
      ...PLOCATE_UNRECOGNISED_OPTION,
      timedOut: false,
      missing: false,
    });
    expect(outcome.kind).toBe("optionUnsupported");
  });

  test("matches parse out of the NUL-delimited listing", () => {
    const outcome = classifyLocateResult({
      code: 0,
      stdout: PLOCATE_MATCH_STDOUT,
      stderr: "",
      timedOut: false,
      missing: false,
    });
    expect(outcome.kind === "matches" && outcome.paths).toEqual(["/srv/data/report-2024.txt"]);
  });

  test("a pattern beginning with a dash still returns its file", () => {
    const outcome = classifyLocateResult({
      code: 0,
      stdout: PLOCATE_DASH_PATTERN_STDOUT,
      stderr: "",
      timedOut: false,
      missing: false,
    });
    expect(outcome.kind === "matches" && outcome.paths).toEqual(["/srv/data/-dashfile.txt"]);
  });

  test("two matches keep the backend's own order", () => {
    const outcome = classifyLocateResult({
      code: 0,
      stdout: PLOCATE_TWO_MATCHES_STDOUT,
      stderr: "",
      timedOut: false,
      missing: false,
    });
    expect(outcome.kind === "matches" && outcome.paths).toEqual([
      "/srv/data/-dashfile.txt",
      "/srv/data/report-2024.txt",
    ]);
  });

  test("a missing backend and a timeout are each named", () => {
    expect(
      classifyLocateResult({
        code: 127,
        stdout: "",
        stderr: "",
        timedOut: false,
        missing: true,
      }).kind,
    ).toBe("backendMissing");
    expect(
      classifyLocateResult({
        code: -1,
        stdout: "",
        stderr: "",
        timedOut: true,
        missing: false,
      }).kind,
    ).toBe("timedOut");
  });

  test("an unexpected message is a failure, never an empty result", () => {
    const outcome = classifyLocateResult({
      code: 2,
      stdout: "",
      stderr: "plocate: something nobody has seen before\n",
      timedOut: false,
      missing: false,
    });
    expect(outcome.kind).toBe("failed");
  });

  test("the database paths are the ones each backend actually uses", () => {
    expect(LOCATE_DB_PATHS.plocate).toBe("/var/lib/plocate/plocate.db");
    expect(LOCATE_DB_PATHS.locate).toBe("/var/lib/mlocate/mlocate.db");
  });
});

describe("locate: index age", () => {
  const nowMs = Date.parse("2026-09-19T00:00:00Z");

  test("a database rebuilt an hour ago is not stale", () => {
    const age = describeIndexAge(nowMs - 3_600_000, nowMs, 172_800);
    expect(age.ageSeconds).toBe(3_600);
    expect(age.stale).toBe(false);
  });

  test("a database from last month is stale", () => {
    const age = describeIndexAge(nowMs - 30 * 86_400_000, nowMs, 172_800);
    expect(age.stale).toBe(true);
  });

  test("no database file means no age claim at all", () => {
    expect(describeIndexAge(undefined, nowMs, 172_800)).toEqual({});
  });

  test("a clock that has gone backwards reports zero rather than a negative age", () => {
    expect(describeIndexAge(nowMs + 5_000, nowMs, 172_800).ageSeconds).toBe(0);
  });
});

// ===========================================================================
// scope — filtering before limiting
// ===========================================================================

describe("scope: results are filtered to the roots, then limited", () => {
  const roots = ["/w/src"];

  test("a hit outside the roots is dropped and counted", () => {
    const result = scopeResults(["/w/src/a.ts", "/etc/passwd"], roots, []);
    expect(result.kept).toEqual(["/w/src/a.ts"]);
    expect(result.outOfScope).toBe(1);
  });

  test("the root itself is inside the root", () => {
    expect(isInsideRoot("/w/src", "/w/src")).toBe(true);
    expect(isInsideRoot("/w/src/a", "/w/src")).toBe(true);
  });

  test("a sibling with a shared prefix is NOT inside the root", () => {
    // `/w/src-other` starts with `/w/src`; without the separator check it
    // would be admitted.
    expect(isInsideRoot("/w/src-other/a.ts", "/w/src")).toBe(false);
  });

  test("a duplicate path from two overlapping roots is returned once", () => {
    const result = scopeResults(["/w/src/a.ts", "/w/src/a.ts"], ["/w", "/w/src"], []);
    expect(result.kept).toEqual(["/w/src/a.ts"]);
  });

  test("an exclude glob drops matches and counts them apart", () => {
    const result = scopeResults(["/w/src/a.ts", "/w/src/a.test.ts"], roots, [
      compileGlob("**/*.test.ts"),
    ]);
    expect(result.kept).toEqual(["/w/src/a.ts"]);
    expect(result.excluded).toBe(1);
  });

  test("the backend's order is preserved, never re-sorted", () => {
    // Relevance order is part of the answer; re-sorting invents a ranking.
    const result = scopeResults(["/w/src/z.ts", "/w/src/a.ts"], roots, []);
    expect(result.kept).toEqual(["/w/src/z.ts", "/w/src/a.ts"]);
  });

  test("filtering before limiting is what stops a false 'nothing found'", () => {
    // Twenty out-of-scope hits and one in scope: applying a limit of 5 first
    // would answer "nothing here" while the match sat sixth.
    const backendAnswer = [
      ...Array.from({ length: 20 }, (_, n) => `/elsewhere/f${n}.ts`),
      "/w/src/wanted.ts",
    ];
    const scoped = scopeResults(backendAnswer, roots, []);
    const limited = applyLimit(scoped.kept, 5);
    expect(limited.items).toEqual(["/w/src/wanted.ts"]);
    expect(scoped.outOfScope).toBe(20);
  });

  test("the limit reports whether anything was left behind", () => {
    expect(applyLimit([1, 2, 3], 2)).toEqual({ items: [1, 2], truncated: true });
    expect(applyLimit([1, 2], 2)).toEqual({ items: [1, 2], truncated: false });
  });
});

describe("scope: the glob matcher", () => {
  test("* does not cross a separator", () => {
    const matches = compileGlob("*.ts");
    expect(matches("a.ts")).toBe(true);
    expect(matches("src/a.ts")).toBe(false);
  });

  test("** spans whole segments, including none", () => {
    const matches = compileGlob("**/*.ts");
    expect(matches("a.ts")).toBe(true);
    expect(matches("src/deep/a.ts")).toBe(true);
    expect(matches("src/a.js")).toBe(false);
  });

  test("? is exactly one character, never a separator", () => {
    const matches = compileGlob("a?.ts");
    expect(matches("ab.ts")).toBe(true);
    expect(matches("a/.ts")).toBe(false);
  });

  test("a dot in the pattern is literal, not 'any character'", () => {
    const matches = compileGlob("a.ts");
    expect(matches("a.ts")).toBe(true);
    expect(matches("axts")).toBe(false);
  });

  test("the match is anchored at both ends", () => {
    const matches = compileGlob("node_modules");
    expect(matches("node_modules")).toBe(true);
    expect(matches("x/node_modules")).toBe(false);
  });

  test("regex metacharacters in a pattern are literal", () => {
    const matches = compileGlob("a+b(c).txt");
    expect(matches("a+b(c).txt")).toBe(true);
    expect(matches("aab(c).txt")).toBe(false);
  });

  test("a repeated ** still means what one ** means", () => {
    const matches = compileGlob("**/**/**/*.ts");
    expect(matches("/w/src/deep/a.ts")).toBe(true);
    expect(matches("a.ts")).toBe(true);
    expect(matches("/w/src/a.js")).toBe(false);
  });

  test("a run of ** compiles to ONE group, not one per repetition", () => {
    // Adjacent `(?:[^/]+/)*` groups can each absorb the same segments, which
    // is the catastrophic-backtracking shape: twelve of them against a
    // 24-segment path took over a SECOND to answer `false` before the runs
    // were collapsed, and every extra one multiplied it. The patterns come
    // from the caller, and the matcher runs on the same event loop
    // WatchPath's own deadline timer lives on — so that is not slowness, it
    // is a deadline that cannot fire.
    //
    // Asserted on the compiled SHAPE rather than on a stopwatch: the count of
    // cross-segment groups is the same fact and cannot flake on a loaded box.
    expect(globRegexSource(`${"**/".repeat(12)}zzz`).split("(?:").length - 1).toBe(1);
    expect(globRegexSource("**/**/**/*.ts")).toBe(globRegexSource("**/*.ts"));
  });
});

describe("scope: a listing cut at the output cap", () => {
  test("the last entry of a truncated listing is dropped, and counted", () => {
    // `-0` output is NUL-SEPARATED, so a cut stream ends in half a path with
    // no separator after it. It looks like a complete short path and would be
    // reported as a file that exists.
    const cut = dropTruncatedTail(["/w/a.ts", "/w/half-a-pa"], true);
    expect(cut.paths).toEqual(["/w/a.ts"]);
    expect(cut.partialDropped).toBe(1);
  });

  test("a complete listing keeps every entry", () => {
    const whole = dropTruncatedTail(["/w/a.ts", "/w/b.ts"], false);
    expect(whole.paths).toEqual(["/w/a.ts", "/w/b.ts"]);
    expect(whole.partialDropped).toBe(0);
  });

  test("a truncated listing with nothing in it stays empty rather than going negative", () => {
    expect(dropTruncatedTail([], true)).toEqual({ paths: [], partialDropped: 0 });
  });
});

// ===========================================================================
// run — the argv gate
// ===========================================================================

describe("run: an argv that could not be handed to execve is refused", () => {
  test("a well-formed argv passes", () => {
    expect(assertArgv(["mdfind", "-0", "query"])).toBeUndefined();
  });

  test("a NUL byte is refused", () => {
    // It would truncate the argument at the syscall boundary: the part after
    // the NUL never reaches the program, so what was checked here and what
    // runs there are different strings.
    expect(assertArgv(["plocate", "a\u0000b"])).toContain("NUL");
  });

  test("an empty program is refused", () => {
    expect(assertArgv([])).toContain("argv[0]");
    expect(assertArgv(["  "])).toContain("argv[0]");
  });

  test("a non-string element is refused rather than coerced", () => {
    expect(assertArgv(["plocate", 7 as unknown as string])).toContain("string");
  });
});

/** The first `count` items of a generator, for asserting an infinite sequence. */
function* take<T>(iterable: Iterable<T>, count: number): Generator<T> {
  let taken = 0;
  for (const item of iterable) {
    if (taken >= count) return;
    taken += 1;
    yield item;
  }
}
