/**
 * The NOTICE file is the Apache-2.0 §4(d) attribution notice: every downstream
 * redistributor must pass it on, and release-prep --for-publish copies it into
 * every published package. So it has to be finished text — no template
 * placeholders, no pointer at a file the tarball does not carry, no command
 * that does not exist — and every committed per-package copy has to be the
 * root text, byte for byte.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dir);
const NOTICE = readFileSync(join(ROOT, "NOTICE"), "utf8");
const LICENSE = readFileSync(join(ROOT, "LICENSE"), "utf8");
const ROOT_SCRIPTS = Object.keys(
  (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: object }).scripts,
);

/** Why this NOTICE text is not fit to ship; empty when it is. */
function noticeProblems(text: string, scripts: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/fill in|\[As of/i.test(line)) out.push(`template placeholder: ${line.trim()}`);
  }
  for (const m of text.matchAll(/bun run ([\w:-]+)/g)) {
    const script = m[1] ?? "";
    if (!scripts.includes(script)) out.push(`names a script that does not exist: ${script}`);
  }
  // A tarball carries NOTICE but not TRADEMARK.md, so the policy is linked by URL.
  if (/(^|\s)TRADEMARK\.md/m.test(text)) out.push("points at TRADEMARK.md, which does not ship");
  return out;
}

test("the root NOTICE is finished text", () => {
  expect(noticeProblems(NOTICE, ROOT_SCRIPTS)).toEqual([]);
  expect(NOTICE).toContain("Copyright 2026 Max Meier");
  expect(NOTICE).toContain("https://github.com/crewhaus/factory/blob/main/TRADEMARK.md");
  // The URL it links must be a file this repo has.
  expect(existsSync(join(ROOT, "TRADEMARK.md"))).toBe(true);
});

test("the NOTICE check catches each thing it looks for", () => {
  // The three defects the 0.7.0 NOTICE shipped with, one each, so the check
  // above is known to be able to fail.
  const draft = [
    NOTICE,
    "[As of the launch, fill in the third-party software list.]",
    "For the complete attribution, run:",
    "  bun run licenses",
    "See",
    "TRADEMARK.md for the use-of-marks policy.",
  ].join("\n");
  const problems = noticeProblems(draft, ROOT_SCRIPTS);
  expect(problems).toHaveLength(3);
  expect(problems[0]).toStartWith("template placeholder:");
  expect(problems[1]).toBe("names a script that does not exist: licenses");
  expect(problems[2]).toBe("points at TRADEMARK.md, which does not ship");
  // A script that does exist is fine.
  expect(noticeProblems(`${NOTICE}\nrun: bun run test\n`, ROOT_SCRIPTS)).toEqual([]);
});

test("every committed per-package LICENSE and NOTICE is the root text", () => {
  const copies: string[] = [];
  for (const group of ["packages", "apps"]) {
    for (const entry of readdirSync(join(ROOT, group))) {
      for (const [file, text] of [
        ["NOTICE", NOTICE],
        ["LICENSE", LICENSE],
      ] as const) {
        const path = join(ROOT, group, entry, file);
        if (!existsSync(path)) continue;
        copies.push(`${group}/${entry}/${file}`);
        expect({
          path: `${group}/${entry}/${file}`,
          same: readFileSync(path, "utf8") === text,
        }).toEqual({ path: `${group}/${entry}/${file}`, same: true });
      }
    }
  }
  // release-prep --for-publish writes the root text into every package at
  // publish time; these are the copies committed by hand before it did (five
  // packages, LICENSE and NOTICE each). A floor, not an exact count: a new
  // package's copy is checked the same way and should not need this edited,
  // but a scan that finds nothing would pass vacuously.
  expect(copies.length).toBeGreaterThanOrEqual(10);
});
