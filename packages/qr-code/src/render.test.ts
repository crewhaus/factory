/**
 * Tests for the terminal renderer.
 *
 * The important property is that the half-block packing is lossless: two
 * module rows go into one text row, and {@link unpack} takes them back out.
 * A symbol rendered and then unpacked has to equal the symbol that went in,
 * quiet zone included — that is what makes the printed code scannable, and
 * it was confirmed once end-to-end by photographing the rendered text back
 * through a real decoder.
 */
import { describe, expect, test } from "bun:test";
import { encodeQr } from "./encode";
import { renderQrLines, renderedWidth } from "./render";

const ESC = "\u001b";

/** Reverse the half-block packing: one text row back into two module rows. */
function unpack(lines: readonly string[]): string[] {
  const rows: string[] = [];
  for (const line of lines) {
    let top = "";
    let bottom = "";
    for (const ch of line) {
      top += ch === "█" || ch === "▀" ? "1" : "0";
      bottom += ch === "█" || ch === "▄" ? "1" : "0";
    }
    rows.push(top, bottom);
  }
  return rows;
}

/** The symbol plus its quiet zone, as rows of "0"/"1". */
function expected(text: string, quietZone: number): string[] {
  const qr = encodeQr(text);
  const span = qr.size + quietZone * 2;
  const rows: string[] = [];
  for (let y = 0; y < span; y++) {
    let row = "";
    for (let x = 0; x < span; x++) {
      const mx = x - quietZone;
      const my = y - quietZone;
      row +=
        mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my]?.[mx] === true
          ? "1"
          : "0";
    }
    rows.push(row);
  }
  return rows;
}

describe("renderQrLines", () => {
  test("packs two module rows per text row, losslessly", () => {
    for (const text of [
      "x",
      "HELLO",
      "http://192.168.1.42:4200/#t=deadbeefcafe",
      "a".repeat(200),
    ]) {
      const qr = encodeQr(text);
      const lines = renderQrLines(qr, { color: false, invert: false });
      const want = expected(text, 4);
      const got = unpack(lines);
      // An odd span leaves one trailing half-row, which is quiet zone.
      expect(got.slice(0, want.length)).toEqual(want);
      for (const extra of got.slice(want.length)) expect(extra).toBe("0".repeat(extra.length));
    }
  });

  test("is as many columns wide as the symbol plus its quiet zone", () => {
    const qr = encodeQr("width");
    const lines = renderQrLines(qr, { color: false, invert: false });
    const span = qr.size + 8;
    expect(lines.length).toBe(Math.ceil(span / 2));
    for (const line of lines) expect(line.length).toBe(span);
    expect(renderedWidth(qr)).toBe(span);
  });

  test("defaults to the spec's four-module quiet zone and honours an override", () => {
    const qr = encodeQr("quiet");
    expect(renderQrLines(qr, { color: false, invert: false })[0]?.length).toBe(qr.size + 8);
    expect(renderQrLines(qr, { color: false, invert: false, quietZone: 0 })[0]?.length).toBe(
      qr.size,
    );
    expect(renderQrLines(qr, { color: false, invert: false, quietZone: 2 })[0]?.length).toBe(
      qr.size + 4,
    );
    // A negative quiet zone clamps to none rather than cropping the symbol.
    expect(renderQrLines(qr, { color: false, invert: false, quietZone: -3 })[0]?.length).toBe(
      qr.size,
    );
  });

  test("the quiet zone is entirely light", () => {
    const qr = encodeQr("margins");
    const rows = unpack(renderQrLines(qr, { color: false, invert: false }));
    for (let y = 0; y < 4; y++) expect(rows[y]).toBe("0".repeat(qr.size + 8));
    for (const row of rows) {
      expect(row.slice(0, 4)).toBe("0000");
      expect(row.slice(qr.size + 4)).toBe("0000");
    }
  });

  test("wraps each line in a black-on-white SGR pair by default", () => {
    const qr = encodeQr("colour");
    const [first] = renderQrLines(qr);
    expect(first?.startsWith(`${ESC}[38;5;16;48;5;231m`)).toBe(true);
    expect(first?.endsWith(`${ESC}[0m`)).toBe(true);
    // Every line is independently wrapped, so a truncated paste still resets.
    for (const line of renderQrLines(qr)) {
      expect(line.startsWith(`${ESC}[38;5;16;48;5;231m`) && line.endsWith(`${ESC}[0m`)).toBe(true);
    }
  });

  test("emits no escape codes when colour is off", () => {
    for (const line of renderQrLines(encodeQr("plain"), { color: false, invert: false })) {
      expect(line.includes(ESC)).toBe(false);
    }
  });

  test("ascii mode uses two columns per module and no block-drawing halves", () => {
    const qr = encodeQr("ascii");
    const lines = renderQrLines(qr, { color: false, invert: false, ascii: true });
    const span = qr.size + 8;
    expect(lines.length).toBe(span);
    for (const line of lines) {
      expect(line.length).toBe(span * 2);
      expect(line.includes("▀")).toBe(false);
      expect(line.includes("▄")).toBe(false);
    }
    expect(renderedWidth(qr, { ascii: true })).toBe(span * 2);
  });

  test("ascii mode carries the same modules as half-block mode", () => {
    const qr = encodeQr("both modes agree");
    const ascii = renderQrLines(qr, { color: false, invert: false, ascii: true }).map((line) => {
      let row = "";
      for (let i = 0; i < line.length; i += 2) row += line[i] === "█" ? "1" : "0";
      return row;
    });
    expect(ascii).toEqual(expected("both modes agree", 4));
  });

  test("monochrome output inverts, so the terminal background becomes the ink", () => {
    // With escape codes the blocks are the DARK modules; without them the
    // blocks have to be the LIGHT ones, because a dark-themed terminal draws
    // a block light and its own background dark.
    const qr = encodeQr("polarity");
    const coloured = unpack(renderQrLines(qr, { color: false, invert: false }));
    const monochrome = unpack(renderQrLines(qr, { color: false }));
    expect(monochrome.length).toBe(coloured.length);
    for (let y = 0; y < coloured.length; y++) {
      const a = coloured[y] ?? "";
      const b = monochrome[y] ?? "";
      expect(b).toBe([...a].map((c) => (c === "1" ? "0" : "1")).join(""));
    }
  });

  test("the inverted quiet zone is solid, so the symbol sits on a light card", () => {
    const qr = encodeQr("card");
    const rows = unpack(renderQrLines(qr, { color: false }));
    const span = qr.size + 8;
    for (let y = 0; y < 4; y++) expect(rows[y]).toBe("1".repeat(span));
    for (const row of rows.slice(0, span)) {
      expect(row.slice(0, 4)).toBe("1111");
      expect(row.slice(span - 4)).toBe("1111");
    }
  });

  test("colour mode draws the dark modules, without inverting", () => {
    const qr = encodeQr("ink");
    // Built rather than written as a literal: biome rejects a control
    // character in a regex, escape form included.
    const sgr = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    const stripped = renderQrLines(qr).map((line) => line.replace(sgr, ""));
    expect(unpack(stripped).slice(0, qr.size + 8)).toEqual(expected("ink", 4));
  });

  test("only the three block characters and a space ever appear", () => {
    const allowed = new Set([" ", "█", "▀", "▄"]);
    for (const line of renderQrLines(encodeQr("charset"), { color: false, invert: false })) {
      for (const ch of line) expect(allowed.has(ch)).toBe(true);
    }
  });
});
