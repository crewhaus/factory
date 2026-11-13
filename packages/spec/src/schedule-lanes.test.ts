/**
 * `schedule:` (#514): the object form keeps reporting exactly what it reported
 * before the list form existed.
 */
import { describe, expect, test } from "bun:test";
import { parseSpecIssues } from "./index";

const CHANNEL =
  "name: a\ntarget: channel\nagent: {model: claude-opus-4-7, instructions: Help.}\nchannels:\n  slack: {botToken: $T, signingSecret: $S}\nrouting: {sessionKey: thread}\n";

describe("the object form's errors", () => {
  // Captured from the parser before the list form existed: an object is still
  // checked by the object union alone, so its first issue keeps its path and words.
  const cases: ReadonlyArray<readonly [string, string, ReadonlyArray<string | number>, string]> = [
    [
      "no kind",
      "schedule:\n  every: 6h\n",
      ["schedule", "kind"],
      "Invalid discriminator value. Expected 'cron' | 'interval'",
    ],
    [
      "a bad cron",
      'schedule:\n  kind: cron\n  cron: "every day"\n',
      ["schedule", "cron"],
      'schedule.cron must be a 5- or 6-field cron expression, e.g. "0 */6 * * *"',
    ],
    [
      "an unknown key",
      "schedule:\n  kind: interval\n  every: 6h\n  catch_up: true\n",
      ["schedule"],
      "Unrecognized key(s) in object: 'catch_up'",
    ],
  ];
  for (const [label, block, path, message] of cases) {
    test(`${label}: the first issue's path and message are unchanged`, () => {
      const [first] = parseSpecIssues(`${CHANNEL}${block}`);
      expect(first?.path).toEqual([...path]);
      expect(first?.message).toBe(message);
    });
  }
});
