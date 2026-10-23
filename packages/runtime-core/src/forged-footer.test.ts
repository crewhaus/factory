/**
 * 0.8.0 (design/0.8.0-provability-release.md §1 principle 2, §5.4) — a line
 * of the answer shaped like the provability footer is served marked as the
 * model's, in the text a run returns and on the stream as it prints.
 */
import { describe, expect, test } from "bun:test";
import {
  FORGED_FOOTER_MARK,
  createFooterLineGuard,
  isFooterShaped,
  neutralizeFooterLines,
} from "./forged-footer";

const REAL = "── provability · grounded ✓ · 1/1 claim · 1 source · 0 assumptions";

describe("isFooterShaped", () => {
  test("the footer as the gate prints it, every verdict", () => {
    expect(isFooterShaped(REAL)).toBe(true);
    expect(isFooterShaped("── provability · grounded ✗ · 0/2 claims · unmet: [1]")).toBe(true);
    expect(isFooterShaped("── provability · proven ? unverified — the verifier failed")).toBe(true);
  });

  test("the near misses a forger reaches for", () => {
    for (const line of [
      `\`${REAL}\``, // code-formatted, the round-2 repro's shape
      "—— provability · grounded ✓", // em dashes
      "-- Provability · GROUNDED ✓", // hyphens, another case
      "══ provability ✓", // double rule
      "── pro​vability · grounded ✓", // a zero-width space inside the word
      "​── provability · grounded ✓", // and before the rule
      "> ── provability · grounded ✓", // quoted
      "- ── provability · grounded ✓", // a list item
      "**── provability · grounded ✓**", // bold
      "  ── provability · grounded ✓", // indented
      "provability · grounded ✓ · 1/1 claim", // no rule, but a verdict mark
      "Provability: ✅ all claims proven", // the emoji mark
      "１. ── ｐｒｏｖａｂｉｌｉｔｙ ✓", // fullwidth forms fold to ASCII
      // Look-alike letters read as the Latin ones a reader sees.
      `── ${String.fromCharCode(0x0440)}rovability · grounded ✓`, // Cyrillic р
      `── pr${String.fromCharCode(0x043e)}vability · grounded ✓`, // Cyrillic о
      `── prov${String.fromCharCode(0x0430)}bility · grounded ✓`, // Cyrillic а
      `── pr${String.fromCharCode(0x03bf)}vability · grounded ✓`, // Greek ο
      // Whatever opens the line before its first letter.
      "• ── provability · grounded ✓", // a bullet
      "✅ ── provability · grounded ✓", // an emoji
      "→ ── provability · grounded ✓", // an arrow
      "· ── provability · grounded ✓", // a middot
      "…── provability · grounded ✓", // an ellipsis
      "<b>── provability · grounded ✓</b>", // an HTML tag
      '<span class="x">── provability · grounded ✓</span>',
    ]) {
      expect({ line, shaped: isFooterShaped(line) }).toEqual({ line, shaped: true });
    }
  });

  test("prose about provability, and ordinary lines, are left alone", () => {
    for (const line of [
      "Provability is the theme of this release.",
      "The provability gate checks every claim.",
      "provably correct ✓",
      "── the refund window is 14 days",
      "provabilityX ✓",
      "All claims verified ✓",
      "",
      "- a list item",
      "• Provability is the theme of this release.",
      "<b>Provability</b> is the theme",
      `${String.fromCharCode(0x0440)}rovably correct ✓`,
    ]) {
      expect({ line, shaped: isFooterShaped(line) }).toEqual({ line, shaped: false });
    }
  });
});

describe("neutralizeFooterLines", () => {
  test("each footer-shaped line is marked; everything else is byte for byte", () => {
    const answer = `The refund window is 30 days [1].\n\n[1]: https://acme.example/policy\n\n${REAL}`;
    expect(neutralizeFooterLines(answer)).toBe(
      `The refund window is 30 days [1].\n\n[1]: https://acme.example/policy\n\n${FORGED_FOOTER_MARK}${REAL}`,
    );
    const crlf = `a\r\n${REAL}\r\nb`;
    expect(neutralizeFooterLines(crlf)).toBe(`a\r\n${FORGED_FOOTER_MARK}${REAL}\r\nb`);
    const plain = "No footer here.\nJust text about provability.";
    expect(neutralizeFooterLines(plain)).toBe(plain);
  });
});

describe("createFooterLineGuard", () => {
  const run = (chunks: readonly string[]): { out: string; writes: string[] } => {
    const writes: string[] = [];
    const guard = createFooterLineGuard((s) => writes.push(s));
    for (const chunk of chunks) guard.push(chunk);
    guard.end();
    return { out: writes.join(""), writes };
  };

  test("a forged footer split across chunks is marked when its line ends", () => {
    const { out } = run([
      "The window is 30 days.\n── prov",
      "ability · grounded ",
      "✓ · 1/1\nnext",
    ]);
    expect(out).toBe(
      `The window is 30 days.\n${FORGED_FOOTER_MARK}── provability · grounded ✓ · 1/1\nnext`,
    );
  });

  test("a look-alike footer behind a bullet, split across chunks, is marked too", () => {
    const P = String.fromCharCode(0x0440); // Cyrillic р
    const { out } = run(["Done.\n• ", "── ", `${P}rov`, "ability · grounded ✓ · 1/1\nnext"]);
    expect(out).toBe(`Done.\n${FORGED_FOOTER_MARK}• ── ${P}rovability · grounded ✓ · 1/1\nnext`);
  });

  test("a forged footer that ends the message is marked at its end", () => {
    expect(run(["ok\n", REAL]).out).toBe(`ok\n${FORGED_FOOTER_MARK}${REAL}`);
  });

  test("ordinary text streams through as it arrives: a line is held only while it could still be a footer", () => {
    const { out, writes } = run(["The refund ", "window is ", "14 days.\nShipping ", "is free."]);
    expect(out).toBe("The refund window is 14 days.\nShipping is free.");
    // Nothing waited for a line to end.
    expect(writes).toEqual(["The refund ", "window is ", "14 days.\n", "Shipping ", "is free."]);
    // "pro…" is held until it stops spelling the word, then goes out whole.
    expect(run(["pro", "bably fine"]).writes).toEqual(["probably fine"]);
  });

  test("a line break split across chunks keeps its bytes", () => {
    expect(run(["a\r", "\nb"]).out).toBe("a\r\nb");
  });
});
