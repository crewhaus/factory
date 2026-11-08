/**
 * Rules in the stylesheet a screen depends on. No renderer runs in this suite, so
 * these read the CSS: a contrast ratio is arithmetic over the tokens, and a rule
 * that clips a command or defeats `hidden` is there in the text.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { SHAPE_ACCENTS, SHAPE_ACCENTS_LIGHT } from "../assets/js/shapes.js";

const CSS = readFileSync(join(import.meta.dir, "..", "assets", "hangar.css"), "utf8");

/** The declarations of the first rule with exactly this selector. */
function rule(selector: string, source = CSS): string {
  const at = source.indexOf(`\n${selector} {`);
  expect(at).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf("}", at));
}

/** The body of the first `@media` block with exactly this condition. */
function mediaBlock(condition: string): string {
  const head = `\n@media ${condition} {`;
  const at = CSS.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = at + head.length - 1; i < CSS.length; i += 1) {
    if (CSS[i] === "{") depth += 1;
    else if (CSS[i] === "}") {
      depth -= 1;
      if (depth === 0) return CSS.slice(at + head.length, i);
    }
  }
  throw new Error(`unclosed @media ${condition}`);
}

/** A block's media rule, de-indented, so `rule()` reads it like a top-level one. */
const dedent = (block: string): string => block.replace(/\n {2}/g, "\n");

type Rgba = readonly [number, number, number, number];

/** Every custom property a block sets, raw. */
function declarationsOf(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    out[m[1] as string] = (m[2] as string).trim();
  return out;
}

/** A colour expression → its channels, with `var()` resolved in `tokens`. */
function colourOf(expr: string, tokens: Record<string, string>, depth = 0): Rgba {
  if (depth > 8) throw new Error(`a token cycle at ${expr}`);
  const e = expr.trim();
  const hex = /^#([0-9a-fA-F]{6})$/.exec(e);
  if (hex !== null) {
    const v = hex[1] as string;
    return [
      Number.parseInt(v.slice(0, 2), 16),
      Number.parseInt(v.slice(2, 4), 16),
      Number.parseInt(v.slice(4, 6), 16),
      1,
    ];
  }
  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(e);
  if (rgba !== null) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  const ref = /^var\((--[\w-]+)\)$/.exec(e);
  if (ref !== null) {
    const value = tokens[ref[1] as string];
    if (value === undefined) throw new Error(`${ref[1]} is not set`);
    return colourOf(value, tokens, depth + 1);
  }
  const mix = /^color-mix\(in srgb, (.+) (\d+)%, (.+)\)$/.exec(e);
  if (mix !== null) {
    const top = colourOf(mix[1] as string, tokens, depth + 1);
    const pct = Number(mix[2]) / 100;
    if ((mix[3] as string).trim() === "transparent") return [top[0], top[1], top[2], pct];
    const under = colourOf(mix[3] as string, tokens, depth + 1);
    return over([top[0], top[1], top[2], pct], under);
  }
  throw new Error(`cannot read the colour ${e}`);
}

/** `top` painted over an opaque `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [
    top[0] * a + under[0] * (1 - a),
    top[1] * a + under[1] * (1 - a),
    top[2] * a + under[2] * (1 - a),
    1,
  ];
}

function luminance([r, g, b]: Rgba): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["--bg", "--panel", "--panel-2", "--panel-3"] as const;
const TEXT_TOKENS = [
  "--ink",
  "--ink-2",
  "--ink-3",
  "--accent",
  "--ok",
  "--warn",
  "--bad",
  "--info",
  "--ok-text",
  "--warn-text",
  "--bad-text",
] as const;
const GRAPHICAL_TOKENS = ["--boundary", "--focus", "--off"] as const;
const NAMED = [
  ...SURFACES,
  ...TEXT_TOKENS,
  ...GRAPHICAL_TOKENS,
  "--accent-ghost",
  "--warn-ghost",
  "--bad-ghost",
];

const DARK = declarationsOf(rule(":root"));
const LIGHT = { ...DARK, ...declarationsOf(rule(':root[data-theme="light"]')) };
const DARK_MORE = { ...DARK, ...declarationsOf(rule(':root[data-contrast="more"]')) };
const LIGHT_MORE = {
  ...LIGHT,
  ...declarationsOf(rule(':root[data-theme="light"][data-contrast="more"]')),
};
const THEMES = [
  ["dark", DARK],
  ["light", LIGHT],
  ["dark, more contrast", DARK_MORE],
  ["light, more contrast", LIGHT_MORE],
] as const;

/** The worst ratio of `colour` (translucent ones painted over each surface) to each surface. */
function worstOnSurfaces(colour: (surface: Rgba) => Rgba, tokens: Record<string, string>): number {
  return Math.min(
    ...SURFACES.map((s) => {
      const surface = colourOf(`var(${s})`, tokens);
      return ratio(colour(surface), surface);
    }),
  );
}

describe("every token the tests below name is found, and readable", () => {
  // A token that stops being a literal must fail here, not drop out of a loop.
  test.each(THEMES)("%s", (_theme, tokens) => {
    for (const name of NAMED) {
      expect(`${name}:${tokens[name] !== undefined}`).toBe(`${name}:true`);
      expect(() => colourOf(`var(${name})`, tokens)).not.toThrow();
    }
  });
});

describe("text holds 4.5:1 on every surface", () => {
  for (const [theme, tokens] of THEMES) {
    test.each(TEXT_TOKENS)(`${theme}: %s`, (token) => {
      const worst = worstOnSurfaces(() => colourOf(`var(${token})`, tokens), tokens);
      expect(`${token} ${worst.toFixed(2)}`).toBe(`${token} ${Math.max(worst, 4.5).toFixed(2)}`);
    });
  }

  test.each([
    ["dark, more contrast", DARK_MORE],
    ["light, more contrast", LIGHT_MORE],
  ] as const)("%s: the secondary inks hold 7:1", (_theme, tokens) => {
    for (const token of ["--ink-2", "--ink-3"]) {
      const worst = worstOnSurfaces(() => colourOf(`var(${token})`, tokens), tokens);
      expect(worst).toBeGreaterThanOrEqual(7);
    }
  });
});

describe("a control's edge, the focus ring and a status dot hold 3:1", () => {
  for (const [theme, tokens] of THEMES) {
    test.each(GRAPHICAL_TOKENS)(`${theme}: %s`, (token) => {
      expect(
        worstOnSurfaces(() => colourOf(`var(${token})`, tokens), tokens),
      ).toBeGreaterThanOrEqual(3);
    });
  }

  test("the ring is the focus token, and no shape scope sets that token", () => {
    expect(rule(":focus-visible")).toContain("outline: 2px solid var(--focus)");
    expect(rule("[data-shape-accent]")).not.toContain("--focus");
    expect(rule(':root[data-theme="light"] [data-shape-accent]')).not.toContain("--focus");
  });

  test("buttons and fields are edged with the boundary token, not a decorative rule", () => {
    expect(rule(".btn")).toContain("border: 1px solid var(--boundary)");
    expect(rule(".input")).toContain("border: 1px solid var(--boundary)");
  });

  test("a chart's bars are the full accent, which holds 3:1", () => {
    expect(rule(".chart-bars rect")).toContain("fill: var(--accent)");
    for (const [, tokens] of THEMES) {
      expect(
        worstOnSurfaces(() => colourOf("var(--accent)", tokens), tokens),
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("text on a wash, read from the rule that pairs them", () => {
  // [selector, the rule its text colour comes from when it sets none itself]
  const PAIRS = [
    [".chip-warn", ".chip-warn"],
    [".chip-group", ".chip-group"],
    [".nav-badge", ".nav-badge"],
    [".btn-primary", ".btn-primary"],
    [".btn-danger", ".btn-danger"],
    [".toast-error", ".toast"],
  ] as const;

  const declared = (block: string, property: string): string => {
    const m = new RegExp(`\\n\\s*${property}:\\s*([^;]+);`).exec(block);
    expect(m).not.toBeNull();
    return (m?.[1] as string).trim();
  };

  for (const [theme, tokens] of THEMES) {
    test.each(PAIRS)(`${theme}: %s`, (selector, colourFrom) => {
      const text = colourOf(declared(rule(colourFrom), "color"), tokens);
      const wash = colourOf(declared(rule(selector), "background"), tokens);
      // The text is painted over the wash, which is painted over the surface.
      const shown = Math.min(
        ...SURFACES.map((s) => {
          const surface = colourOf(`var(${s})`, tokens);
          const behind = over(wash, surface);
          return ratio(over(text, behind), behind);
        }),
      );
      expect(`${selector} ${shown.toFixed(2)}`).toBe(
        `${selector} ${Math.max(shown, 4.5).toFixed(2)}`,
      );
    });
  }
});

describe("every shape's accent", () => {
  const darkKeys = Object.keys(SHAPE_ACCENTS).sort();
  const lightKeys = Object.keys(SHAPE_ACCENTS_LIGHT).sort();
  const badge = rule(".shape-badge");
  const washPct = Number(
    /color-mix\(in srgb, var\(--accent\) (\d+)%, transparent\)/.exec(badge)?.[1],
  );

  test("the badge's wash is read from its rule, and is the 8% the values were chosen for", () => {
    expect(washPct).toBe(8);
  });

  test("both tables name the same shapes", () => {
    expect(lightKeys).toEqual(darkKeys);
    expect(darkKeys.length).toBe(14);
  });

  const onWash = (hex: string, pct: number, tokens: Record<string, string>) =>
    Math.min(
      ...SURFACES.map((s) => {
        const surface = colourOf(`var(${s})`, tokens);
        const accent = colourOf(hex, tokens);
        const behind = over([accent[0], accent[1], accent[2], pct / 100], surface);
        return ratio(accent, behind);
      }),
    );

  test.each(darkKeys)(
    "%s holds 4.5:1 in both themes, on the surfaces and on the badge's wash",
    (shape) => {
      for (const [table, tokens] of [
        [SHAPE_ACCENTS, DARK],
        [SHAPE_ACCENTS_LIGHT, LIGHT],
      ] as const) {
        const hex = (table as Record<string, string>)[shape] as string;
        expect(worstOnSurfaces(() => colourOf(hex, tokens), tokens)).toBeGreaterThanOrEqual(4.5);
        expect(onWash(hex, washPct, tokens)).toBeGreaterThanOrEqual(4.5);
      }
      // In light, an 8% wash of itself (a shape-scoped button's ghost) too.
      expect(onWash(SHAPE_ACCENTS_LIGHT[shape] as string, 8, LIGHT)).toBeGreaterThanOrEqual(4.5);
    },
  );

  test("the light theme sets its accent itself, rather than inheriting mint", () => {
    expect(rule(':root[data-theme="light"]')).toMatch(/--accent: #[0-9a-f]{6};/);
  });
});

describe("rules that undo an accessibility choice cannot come back", () => {
  test("no font size is in px, so the root carries the reader's text size", () => {
    expect(CSS.match(/font-size:\s*[\d.]+px/g) ?? []).toEqual([]);
    expect(rule("html")).toContain("font-size: 100%");
  });

  test("no focus outline is removed", () => {
    expect(CSS.match(/outline:\s*(none|0)\b/g) ?? []).toEqual([]);
  });

  test("the skeleton holds still under both reduced-motion rules", () => {
    expect(rule(".skel-line", dedent(mediaBlock("(prefers-reduced-motion: reduce)")))).toContain(
      "animation: none",
    );
    expect(rule(':root[data-motion="reduce"] .skel-line')).toContain("animation: none");
  });

  test("the system's more-contrast block is exactly the Readability one", () => {
    const media = dedent(mediaBlock("(prefers-contrast: more)"));
    expect(declarationsOf(rule(":root", media))).toEqual(
      declarationsOf(rule(':root[data-contrast="more"]')),
    );
    expect(declarationsOf(rule(':root[data-theme="light"]', media))).toEqual(
      declarationsOf(rule(':root[data-theme="light"][data-contrast="more"]')),
    );
  });

  test("the tooltip is a real element: no text is generated from an attribute", () => {
    expect(CSS).not.toContain("attr(data-tip)");
    expect(CSS).not.toContain(".has-tip");
    expect(rule(".tip-icon")).toContain("width: 24px");
    expect(rule(".tip-icon")).toContain("height: 24px");
  });

  test("compact density keeps a button at least 24px tall", () => {
    expect(rule(".btn")).toContain("min-height: 24px");
    expect(rule(':root[data-density="compact"] .btn')).not.toContain("min-height");
  });
});

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

  for (const [theme, tokens] of THEMES) {
    test.each(LABELS)(`${theme}: %s holds 4.5:1 on every surface`, (_selector, token) => {
      expect(
        worstOnSurfaces(() => colourOf(`var(${token})`, tokens), tokens),
      ).toBeGreaterThanOrEqual(4.5);
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
