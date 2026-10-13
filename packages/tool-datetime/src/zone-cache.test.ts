/**
 * The timezone formatter cache holds one formatter per ZONE, and a bounded
 * number of them (C084).
 *
 * 0.7.0 kept an `Intl.DateTimeFormat` per timezone string exactly as the
 * caller spelled it, for the life of the process. Intl accepts any casing of
 * an IANA name and several spellings of every offset, each formatter holds
 * tens of kilobytes, and DateConvertTimezone is readOnly, so plan and auto
 * mode run it unasked: 9 000 case variants of one zone cost about 458 MB.
 * The cache is now keyed by the canonical name and capped as an LRU, because
 * the canonical offset zones alone number in the thousands; the map from a
 * spelling to its canonical name is capped too.
 */
import { describe, expect, test } from "bun:test";
import { dateConvertTimezone } from "./index";
import { __zoneCacheSizesForTest, isValidTimeZone, wallClockInZone } from "./lib/civil";
import { __nameCacheSizeForTest, formatWallClock } from "./lib/format";

const at = Date.parse("2026-09-17T03:14:00Z");

/** The `n`th upper/lower-case spelling of `name`. */
function spelling(name: string, n: number): string {
  let bit = 0;
  return [...name]
    .map((ch) => {
      if (!/[a-z]/i.test(ch)) return ch;
      const upper = ((n >> bit++) & 1) === 1;
      return upper ? ch.toUpperCase() : ch.toLowerCase();
    })
    .join("");
}

/** `+HH:MM` for the `n`th minute offset past zero. */
function offsetZone(n: number): string {
  return `+${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

describe("the timezone formatter cache (C084)", () => {
  test("every spelling of one zone shares one formatter", () => {
    wallClockInZone(at, "America/Argentina/Buenos_Aires");
    const before = __zoneCacheSizesForTest().formatters;
    for (let n = 0; n < 200; n++) {
      wallClockInZone(at, spelling("america/argentina/buenos_aires", n));
    }
    expect(__zoneCacheSizesForTest().formatters).toBe(before);
  });

  test("however many zones and spellings are asked about, both caches stay capped", () => {
    for (let n = 1; n <= 200; n++) wallClockInZone(at, offsetZone(n));
    for (let n = 0; n < 1_000; n++) wallClockInZone(at, spelling("europe/berlin", n));
    expect(__zoneCacheSizesForTest()).toEqual({ formatters: 64, spellings: 256 });
  });

  test("a spelling does not change the answer, and an evicted zone is answered correctly", () => {
    const canonical = wallClockInZone(at, "America/New_York");
    for (let n = 300; n < 400; n++) wallClockInZone(at, offsetZone(n));
    for (let n = 0; n < 300; n++) wallClockInZone(at, spelling("asia/tokyo", n));
    expect(wallClockInZone(at, "AMERICA/new_york")).toEqual(canonical);
    expect(canonical).toMatchObject({ year: 2026, month: 9, day: 16, hour: 23, minute: 14 });
  });

  test("an unknown zone is still refused, and costs no cache entry", () => {
    const before = __zoneCacheSizesForTest();
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("mars/olympus")).toBe(false);
    expect(__zoneCacheSizesForTest()).toEqual(before);
  });

  test("thousands of spellings through the tool keep no formatter beyond the cache", async () => {
    // Counts the formatters still alive after a full collection, not the
    // process's RSS: RSS moves with the allocator and with every other test
    // in the process, and on a loaded CI runner the same measurement in
    // tool-notify read 61 MB where 40 MB was allowed. 0.7.0 kept every
    // formatter, so 3 000 spellings left 3 000.
    const Real = Intl.DateTimeFormat;
    const made: WeakRef<Intl.DateTimeFormat>[] = [];
    class Counted extends Real {
      constructor(...args: ConstructorParameters<typeof Real>) {
        super(...args);
        made.push(new WeakRef(this));
      }
    }
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = Counted;
    try {
      for (let n = 0; n < 3_000; n++) {
        const out = String(
          await dateConvertTimezone.execute(
            {
              instant: "2026-09-29T12:00:00Z",
              toTimeZone: spelling("america/argentina/buenos_aires", n),
            },
            {} as never,
          ),
        );
        if (!out.includes('"offset":"-03:00"')) throw new Error(`unexpected answer: ${out}`);
      }
    } finally {
      (Intl as { DateTimeFormat: unknown }).DateTimeFormat = Real;
    }
    // A WeakRef keeps its target until the job that made it ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
    const alive = made.filter((ref) => ref.deref() !== undefined).length;
    expect(made.length).toBeGreaterThanOrEqual(3_000);
    expect(alive).toBeLessThanOrEqual(64);
    expect(__zoneCacheSizesForTest().formatters).toBeLessThanOrEqual(64);
    expect(__zoneCacheSizesForTest().spellings).toBeLessThanOrEqual(256);
  }, 30_000);

  test("month and weekday names for many locale spellings stay capped", () => {
    // The locale is the caller's spelling (up to 35 characters), and 0.7.0
    // kept every name it looked up under that spelling for good.
    const wall = wallClockInZone(at, "UTC");
    // Two names per call, so 1 500 spellings would hold 3 000 uncapped.
    for (let n = 0; n < 1_500; n++) {
      formatWallClock("MMMM dddd", {
        wall,
        offsetMinutes: 0,
        epochMs: at,
        abbreviation: "UTC",
        locale: spelling("de-de-u-ca-gregory", n),
      });
    }
    expect(__nameCacheSizeForTest()).toBeGreaterThan(0);
    expect(__nameCacheSizeForTest()).toBeLessThanOrEqual(2_048);
  }, 20_000);
});
