/**
 * Rendering a symbol into terminal text.
 *
 * Two problems have to be solved that a PNG renderer never meets.
 *
 * ASPECT RATIO. A terminal cell is about twice as tall as it is wide, so one
 * character per module produces a symbol stretched 2:1 vertically, and two
 * characters per module doubles the width — a version 6 symbol would need 98
 * columns. The half-block characters ▀ and ▄ split a cell in two, letting one
 * text row carry two module rows: modules come out square, and the symbol is
 * as many columns wide as it is modules.
 *
 * POLARITY. Scanners expect dark modules on a light background, and a
 * terminal has no fixed background — the same characters read as a QR code on
 * a dark theme and as its photographic negative on a light one. So each line
 * carries an explicit black-on-white SGR pair, and the block characters draw
 * the DARK modules. The colours are the 256-colour cube's 16 and 231 rather
 * than the 8-colour `30;47`, because the first sixteen palette entries are
 * exactly the ones a theme remaps: an operator whose "white" is a mid grey
 * would get a symbol with too little contrast to scan.
 *
 * {@link RenderOptions.color} turns the escape codes off, and then the
 * mapping has to INVERT: with no way to set a background, the only way to
 * make the light modules light is to draw THEM with the block characters and
 * let the terminal's own (overwhelmingly dark) background stand in for the
 * dark ones. Getting this backwards produces a photographic negative, which
 * most scanners refuse.
 */
import type { QrCode } from "./encode";

export type RenderOptions = {
  /** Light margin around the symbol, in modules. The spec requires 4, which
   *  is the default; anything less risks a scanner failing to find the
   *  symbol's edge against terminal text. */
  readonly quietZone?: number;
  /** Wrap each line in an explicit black-on-white SGR pair so the symbol
   *  scans on light and dark terminal themes alike. Default true. */
  readonly color?: boolean;
  /** Draw the light modules with the block characters instead of the dark
   *  ones. Defaults to `!color`: with no escape codes the terminal's own
   *  (usually dark) background has to serve as the ink. Set it explicitly on
   *  a light-background terminal running under `NO_COLOR`. */
  readonly invert?: boolean;
  /** Use two spaces per module instead of half blocks. Twice as tall and
   *  twice as wide, but it needs no Unicode block characters — the fallback
   *  for terminals and fonts that render ▀/▄ with gaps. */
  readonly ascii?: boolean;
};

const SGR_RESET = "\u001b[0m";
/** Black on white, taken from the 256-colour cube rather than the 8-colour
 *  palette — see the module docblock for why. */
const SGR_INK = "\u001b[38;5;16;48;5;231m";

const BLOCK_FULL = "█";
const BLOCK_UPPER = "▀";
const BLOCK_LOWER = "▄";

/**
 * Render `qr` as terminal lines, without a trailing newline on any of them.
 *
 * In colour mode the dark modules are drawn in the foreground colour against
 * a white background, so a "dark" module is a black block — the escape codes
 * make the mapping literal rather than dependent on the theme.
 */
export function renderQrLines(qr: QrCode, options: RenderOptions = {}): string[] {
  const quietZone = Math.max(0, options.quietZone ?? 4);
  const color = options.color ?? true;
  const invert = options.invert ?? !color;
  const span = qr.size + quietZone * 2;

  // Whether a cell gets a block character. The quiet zone is light, and so is
  // anything outside the symbol.
  const inked = (x: number, y: number): boolean => {
    const mx = x - quietZone;
    const my = y - quietZone;
    const dark =
      mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my]?.[mx] === true;
    return invert ? !dark : dark;
  };

  const paint = (line: string): string => (color ? `${SGR_INK}${line}${SGR_RESET}` : line);

  if (options.ascii === true) {
    const lines: string[] = [];
    for (let y = 0; y < span; y++) {
      let line = "";
      for (let x = 0; x < span; x++) line += inked(x, y) ? "██" : "  ";
      lines.push(paint(line));
    }
    return lines;
  }

  const lines: string[] = [];
  for (let y = 0; y < span; y += 2) {
    let line = "";
    for (let x = 0; x < span; x++) {
      const top = inked(x, y);
      // An odd span leaves the final row half empty; that half is quiet zone,
      // which is light — and so, when inverted, still gets a block.
      const bottom = inked(x, y + 1);
      line += top && bottom ? BLOCK_FULL : top ? BLOCK_UPPER : bottom ? BLOCK_LOWER : " ";
    }
    lines.push(paint(line));
  }
  return lines;
}

/** Columns {@link renderQrLines} will occupy, so a caller can decide whether
 *  the terminal is wide enough before printing. */
export function renderedWidth(qr: QrCode, options: RenderOptions = {}): number {
  const span = qr.size + Math.max(0, options.quietZone ?? 4) * 2;
  return options.ascii === true ? span * 2 : span;
}
