/**
 * QuietHours caches one formatter per ZONE, and a bounded number of them
 * (C084, security-5#11).
 *
 * 0.7.0 kept an `Intl.DateTimeFormat` per timezone string exactly as the
 * caller spelled it, for the life of the process. Intl accepts any casing
 * of an IANA name and several spellings of every offset, each formatter
 * holds tens of kilobytes, and QuietHours is readOnly, so plan and auto mode
 * run it unasked: 20 000 case variants of one zone cost about 730 MB. The
 * cache is now keyed by the canonical name and capped as an LRU, because
 * the canonical offset zones alone number in the thousands.
 */
import { describe, expect, test } from "bun:test";
import { quietHours } from "./index";
import { __quietFormatterCountForTest, quietDecision } from "./lib/quiet";

const night = [{ start: "22:00", end: "07:00" }];
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

describe("the QuietHours formatter cache (C084)", () => {
  test("every spelling of one zone shares one formatter", () => {
    quietDecision({ timezone: "America/Argentina/Buenos_Aires", quietWindows: night }, at);
    const before = __quietFormatterCountForTest();
    for (let n = 0; n < 200; n++) {
      const zone = spelling("america/argentina/buenos_aires", n);
      quietDecision({ timezone: zone, quietWindows: night }, at);
    }
    expect(__quietFormatterCountForTest()).toBe(before);
  });

  test("however many zones are asked about, the cache holds at most 64", () => {
    for (let n = 1; n <= 200; n++) {
      quietDecision({ timezone: offsetZone(n), quietWindows: night }, at);
    }
    expect(__quietFormatterCountForTest()).toBe(64);
  });

  test("a spelling does not change the answer, and an evicted zone is answered correctly", () => {
    const canonical = quietDecision({ timezone: "America/New_York", quietWindows: night }, at);
    // Push New York out of the cache, then ask again in another spelling.
    for (let n = 300; n < 400; n++) {
      quietDecision({ timezone: offsetZone(n), quietWindows: night }, at);
    }
    const shouted = quietDecision({ timezone: "AMERICA/new_york", quietWindows: night }, at);
    expect(shouted).toEqual(canonical);
    expect(canonical).toMatchObject({
      allowed: false,
      localTime: "23:14",
      localDate: "2026-09-16",
    });
  });

  test("an unknown zone is still refused, and costs no cache entry", () => {
    const before = __quietFormatterCountForTest();
    const out = quietDecision({ timezone: "Mars/Olympus", quietWindows: night }, at);
    expect(out).toEqual({
      error:
        '"Mars/Olympus" is not a timezone this runtime knows — use an IANA name such as Europe/Berlin',
    });
    expect(__quietFormatterCountForTest()).toBe(before);
  });

  test("thousands of spellings through the tool do not accumulate memory", async () => {
    const batch = async (from: number): Promise<void> => {
      for (let n = from; n < from + 3_000; n++) {
        await quietHours.execute(
          {
            schedule: {
              timezone: spelling("america/argentina/buenos_aires", n),
              quietWindows: night,
            },
            now: "2026-09-17T03:14:00Z",
          },
          {} as never,
        );
      }
      Bun.gc(true);
    };
    // The first batch lets the allocator reach its working size (each call
    // still builds, and drops, one small formatter to learn the canonical
    // name). A second batch of NEW spellings must then fit in that memory:
    // 0.7.0 kept every formatter, so each batch added about 150 MB.
    await batch(0);
    const before = process.memoryUsage().rss;
    await batch(3_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(40 * 1024 * 1024);
    expect(__quietFormatterCountForTest()).toBeLessThanOrEqual(64);
  }, 30_000);
});
