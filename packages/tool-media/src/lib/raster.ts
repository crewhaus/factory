/**
 * Turning a module grid into pixels.
 *
 * Only what QR codes and linear barcodes need: filled rectangles on a solid
 * background. There is no text rendering here, and there is none anywhere
 * else in this package either — rasterising a label needs a font, this
 * package ships none, and a chart with invented glyphs would be worse than
 * a chart emitted as SVG for something with fonts to render it.
 */
import { MediaFormatError } from "./bytes";
import type { Rgb } from "./color";
import type { RgbaImage } from "./png";

/** A solid-colour canvas of `width` x `height`. */
export function canvas(width: number, height: number, fill: Rgb): RgbaImage {
  if (width <= 0 || height <= 0)
    throw new MediaFormatError(`cannot make a ${width}x${height} canvas`);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill.r;
    data[i + 1] = fill.g;
    data[i + 2] = fill.b;
    data[i + 3] = fill.a;
  }
  return { width, height, data };
}

/** Fill a rectangle, clipped to the canvas. */
export function fillRect(
  image: RgbaImage,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Rgb,
): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(image.width, x + width);
  const y1 = Math.min(image.height, y + height);
  for (let row = y0; row < y1; row++) {
    let at = (row * image.width + x0) * 4;
    for (let col = x0; col < x1; col++) {
      image.data[at] = color.r;
      image.data[at + 1] = color.g;
      image.data[at + 2] = color.b;
      image.data[at + 3] = color.a;
      at += 4;
    }
  }
}

/** Largest module scale that keeps `modules` within `maxPixels` of width. */
export function fitScale(modules: number, quietZone: number, maxPixels: number): number {
  return Math.max(1, Math.floor(maxPixels / (modules + quietZone * 2)));
}

/**
 * Render a boolean module grid: `scale` pixels per module, `quietZone`
 * modules of background on every side.
 */
export function renderModuleGrid(
  grid: ReadonlyArray<ReadonlyArray<boolean>>,
  scale: number,
  quietZone: number,
  dark: Rgb,
  light: Rgb,
): RgbaImage {
  const rows = grid.length;
  const cols = (grid[0] ?? []).length;
  if (rows === 0 || cols === 0) throw new MediaFormatError("cannot render an empty module grid");
  const width = (cols + quietZone * 2) * scale;
  const height = (rows + quietZone * 2) * scale;
  const image = canvas(width, height, light);
  for (let row = 0; row < rows; row++) {
    const line = grid[row] as ReadonlyArray<boolean>;
    for (let col = 0; col < cols; col++) {
      if (line[col] === true) {
        fillRect(image, (col + quietZone) * scale, (row + quietZone) * scale, scale, scale, dark);
      }
    }
  }
  return image;
}

/**
 * Render a one-dimensional module string as vertical bars: `barHeight`
 * pixels tall, `scale` pixels per module, `quietZone` modules either side.
 */
export function renderModuleStrip(
  modules: string,
  scale: number,
  barHeight: number,
  quietZone: number,
  dark: Rgb,
  light: Rgb,
): RgbaImage {
  if (modules.length === 0) throw new MediaFormatError("cannot render an empty barcode");
  const width = (modules.length + quietZone * 2) * scale;
  const image = canvas(width, barHeight, light);
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] === "1") {
      fillRect(image, (i + quietZone) * scale, 0, scale, barHeight, dark);
    }
  }
  return image;
}
