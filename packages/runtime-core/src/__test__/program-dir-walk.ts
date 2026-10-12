/**
 * The work the gate's reader does for many command words read from one deep
 * directory, counted: run as its own process by `path-canonical.test.ts`.
 *
 * Every `node:path` function is wrapped to count its calls before the
 * reader is loaded (see `outside-place-park.ts` for why a process of its
 * own). Each name the walk steps into is one `join`, so a directory walked
 * again for every word shows up as its depth times the words.
 *
 * Prints one JSON line per reading: the directory's depth, the number of
 * words read there, and the `join` calls counted.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

type PathFn = (this: unknown, ...args: unknown[]) => unknown;

const nodePath = require("node:path") as Record<string, unknown>;
const counter = { on: false, joins: 0 };
const realJoin = nodePath["join"] as PathFn;
nodePath["join"] = function (this: unknown, ...args: unknown[]) {
  if (counter.on) counter.joins += 1;
  return realJoin.apply(this, args);
};
const join = realJoin as unknown as (...parts: string[]) => string;

const { placeRecordingCanonicalizer } = await import("../path-canonical");

const ws = realpathSync(mkdtempSync(join(tmpdir(), "program-dir-walk-")));
try {
  for (const depth of [64, 128]) {
    const deep = Array.from({ length: depth }, () => "d").join("/");
    mkdirSync(join(ws, `w${depth}`, deep), { recursive: true });
    for (const words of [1, 65]) {
      const view = placeRecordingCanonicalizer(ws);
      counter.joins = 0;
      counter.on = true;
      for (let i = 0; i < words; i++) {
        // An argument after `cd <deep>`, and one after `env -C <deep>`.
        view.readProgramPath(`x${i}/y`, `w${depth}/${deep}`, { argument: true });
        view.readProgramPath(`x${i}/y`, undefined, { argument: true, prefix: `w${depth}/${deep}` });
      }
      counter.on = false;
      console.log(JSON.stringify({ depth, words, joins: counter.joins }));
    }
  }
} finally {
  rmSync(ws, { recursive: true, force: true });
}
