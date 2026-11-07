/**
 * Rules in the stylesheet a screen depends on. No renderer runs in this suite, so
 * these read the CSS: a contrast ratio is arithmetic over the tokens, and a rule
 * that clips a command or defeats `hidden` is there in the text.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(import.meta.dir, "..", "assets", "hangar.css"), "utf8");

/** The declarations of the first rule with exactly this selector. */
function rule(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf("}", at));
}

function tokensOf(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[m[1] as string] = m[2] as string;
  }
  return tokens;
}

const DARK = tokensOf(rule(":root"));
const LIGHT = { ...DARK, ...tokensOf(rule(':root[data-theme="light"]')) };

function luminance(hex: string): number {
  const channel = (at: number): number => {
    const v = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("the word beside a status dot is the verdict, so it has to be readable", () => {
  const LABELS = [
    [".dot-ok .dot-label", "--ok-text"],
    [".dot-warn .dot-label", "--warn-text"],
    [".dot-bad .dot-label", "--bad-text"],
    [".dot-off .dot-label", "--ink-2"],
  ] as const;

  test.each(LABELS)("%s uses %s", (selector, token) => {
    expect(rule(selector)).toContain(`var(${token})`);
  });

  for (const [theme, tokens] of [
    ["dark", DARK],
    ["light", LIGHT],
  ] as const) {
    test.each(LABELS)(`${theme}: %s holds 4.5:1 on every surface`, (_selector, token) => {
      for (const surface of ["--bg", "--panel", "--panel-2", "--panel-3"]) {
        expect(contrast(tokens[token] as string, tokens[surface] as string)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });
  }
});

describe("the advisor's command twin", () => {
  test("wraps rather than losing its flags, and cannot push the page sideways", () => {
    const twin = rule(".adv-cli");
    expect(twin).not.toContain("nowrap");
    expect(twin).not.toContain("ellipsis");
    expect(twin).toContain("white-space: normal");
    expect(twin).toContain("overflow-wrap: anywhere");
    expect(twin).toContain("max-width: 100%");
  });
});

describe("the test-case confirmation", () => {
  test("hidden wins over the display .gated sets, or it never hides", () => {
    expect(rule(".gated")).toContain("display: inline-flex");
    expect(rule(".gated[hidden]")).toContain("display: none");
  });
});
