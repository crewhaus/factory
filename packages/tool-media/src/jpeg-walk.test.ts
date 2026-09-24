/**
 * ExifStrip removes metadata from the WHOLE file, and ExifRead reads it all.
 *
 * 0.7.0 walked the marker segments only as far as the first start-of-scan
 * and copied everything after it verbatim. So an EXIF block between the scans
 * of a progressive JPEG, and an image appended after the main one's EOI (an
 * MPF preview, an HDR gain map; phones append motion-photo video the same
 * way), survived ExifStrip with their GPS. ExifRead read the same prefix, from
 * a 1 MiB head, and then answered `hasGps: false` about the stripped copy.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exifApp1Payload, jpegSegment, sampleJpeg } from "./fixtures";
import { exifRead, exifStrip } from "./index";
import { concatBytes, toHex } from "./lib/bytes";
import { inspectJpegMetadata, stripJpegMetadata, walkJpeg } from "./lib/jpeg";

const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

function count(haystack: Uint8Array, needle: ReadonlyArray<number>): number {
  let n = 0;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    n++;
  }
  return n;
}

const HOME = { latitude: 37.775, longitude: -122.419 };
const AWAY = { latitude: 51.5, longitude: -0.12 };

/** A primary image with no EXIF, and a second one with GPS appended after its EOI. */
function withAppendedImage(): { file: Uint8Array; primary: Uint8Array; appended: Uint8Array } {
  const primary = sampleJpeg({ width: 8, height: 8 });
  const appended = sampleJpeg({ width: 8, height: 8, exif: AWAY });
  return { file: concatBytes([primary, appended]), primary, appended };
}

/**
 * Two scans, with an EXIF block carrying GPS, a COM and a DHT between them.
 * The scans' bytes hold stuffing (FF 00) and a restart marker (FF D0), which
 * belong to the scan and must be copied, not read as markers.
 */
function withInterScanGps(): { file: Uint8Array; scans: Uint8Array[] } {
  const base = sampleJpeg({ width: 8, height: 8, exif: HOME, scanBytes: 4 });
  const sosAt = walkJpeg(base).segments.find((s) => s.name === "SOS")?.offset as number;
  const head = base.subarray(0, sosAt);
  const sos = jpegSegment(
    0xda,
    walkJpeg(base).segments.find((s) => s.name === "SOS")?.payload as Uint8Array,
  );
  const scan1 = new Uint8Array([0x42, 0xff, 0x00, 0x42, 0xff, 0xd0, 0x42]);
  const scan2 = new Uint8Array([0x43, 0xff, 0x00, 0x43]);
  const file = concatBytes([
    head,
    sos,
    scan1,
    jpegSegment(0xc4, new Uint8Array([0x00, ...new Array(16).fill(0)])),
    jpegSegment(0xe1, exifApp1Payload(AWAY)),
    jpegSegment(0xfe, new TextEncoder().encode("between")),
    sos,
    scan2,
    new Uint8Array([0xff, 0xd9]),
  ]);
  return { file, scans: [scan1, scan2] };
}

describe("the whole codestream is walked", () => {
  test("an image appended after EOI is dropped by the strip, with its EXIF", () => {
    const { file, primary, appended } = withAppendedImage();
    const stripped = stripJpegMetadata(file);
    // 0.7.0 left the appended image, and its GPS, in place.
    expect(count(stripped.bytes, EXIF_ID)).toBe(0);
    expect(stripped.trailingBytesRemoved).toBe(appended.length);
    expect(stripped.trailingKind).toMatch(/appended JPEG/);
    expect(toHex(stripped.bytes)).toBe(toHex(stripJpegMetadata(primary).bytes));
    expect(stripped.eoiMissing).toBe(false);
  });

  test("EXIF and COM between scans are dropped; scans and tables are kept byte for byte", () => {
    const { file, scans } = withInterScanGps();
    expect(count(file, EXIF_ID)).toBe(2);
    const stripped = stripJpegMetadata(file);
    expect(count(stripped.bytes, EXIF_ID)).toBe(0);
    const walk = walkJpeg(stripped.bytes);
    expect(walk.segments.map((s) => s.name)).toEqual(["APP0", "SOF0", "SOS", "DHT", "SOS", "EOI"]);
    const kept = walk.parts.filter((p) => p.type === "scan") as Array<{
      start: number;
      end: number;
    }>;
    expect(kept.map((p) => toHex(stripped.bytes.subarray(p.start, p.end)))).toEqual(
      scans.map((b) => toHex(b)),
    );
    expect(stripped.removed.map((r) => r.name)).toEqual(["APP1", "APP1", "COM"]);
  });

  test("a file that ends without EOI is walked to its end and says so", () => {
    const base = sampleJpeg({ width: 8, height: 8, exif: HOME });
    const cut = base.subarray(0, base.length - 2);
    const stripped = stripJpegMetadata(cut);
    expect(stripped.eoiMissing).toBe(true);
    expect(count(stripped.bytes, EXIF_ID)).toBe(0);
    expect(inspectJpegMetadata(cut).eoiMissing).toBe(true);
  });

  test("the inspector finds EXIF before, between and after the scans", () => {
    const report = inspectJpegMetadata(withInterScanGps().file);
    expect(report.exifBlocks.map((b) => [b.where, b.exif?.hasGps])).toEqual([
      ["before the first scan", true],
      ["between scans", true],
    ]);
    expect(report.interScanMetadataSegments).toEqual(["APP1", "COM"]);
    const appended = inspectJpegMetadata(withAppendedImage().file);
    expect(appended.exifBlocks.map((b) => b.where)).toEqual(["in an appended image"]);
    expect(appended.embeddedImages).toBe(1);
  });
});

describe("ExifRead and ExifStrip over the whole file", () => {
  const originalCwd = process.cwd();
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-media-walk-"));
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  // biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
  const run = async (tool: typeof exifRead, input: unknown): Promise<any> =>
    JSON.parse((await tool.execute(tool.inputSchema.parse(input))) as string);

  test("ExifRead sees GPS in an appended image (0.7.0: hasExif false, hasGps false)", async () => {
    writeFileSync(path.join(tmp, "in.jpg"), withAppendedImage().file);
    const out = await run(exifRead, { path: "in.jpg" });
    expect(out.hasGps).toBe(true);
    expect(out.trailingBytes).toBeGreaterThan(0);
    expect(out.privacyWarning).toBeDefined();
  });

  test("ExifRead sees GPS between scans", async () => {
    writeFileSync(path.join(tmp, "in.jpg"), withInterScanGps().file);
    const out = await run(exifRead, { path: "in.jpg" });
    expect(out.hasGps).toBe(true);
    expect(out.interScanMetadataSegments).toEqual(["APP1", "COM"]);
    expect(out.exifBlocks).toHaveLength(2);
  });

  test("after ExifStrip, ExifRead finds nothing, and the strip says what it dropped", async () => {
    for (const [name, file] of [
      ["appended.jpg", withAppendedImage().file],
      ["interscan.jpg", withInterScanGps().file],
    ] as const) {
      writeFileSync(path.join(tmp, name), file);
      const stripped = await run(exifStrip, { path: name, output: `clean-${name}` });
      const out = await run(exifRead, { path: `clean-${name}` });
      expect({ name, hasGps: out.hasGps, trailingBytes: out.trailingBytes }).toEqual({
        name,
        hasGps: false,
        trailingBytes: 0,
      });
      expect(count(new Uint8Array(readFileSync(path.join(tmp, `clean-${name}`))), EXIF_ID)).toBe(0);
    }
    const appended = await run(exifStrip, { path: "appended.jpg", output: "again.jpg" });
    expect(appended.trailingBytesRemoved).toBeGreaterThan(0);
    expect(appended.note).toMatch(
      /bytes after its end-of-image marker were dropped with any metadata in them: an appended JPEG/,
    );
  });

  test("an EXIF block that cannot be parsed leaves hasGps undetermined, not false", async () => {
    const broken = concatBytes([
      new Uint8Array([0xff, 0xd8]),
      jpegSegment(0xe1, new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 7, 0])),
      sampleJpeg({ width: 8, height: 8 }).subarray(2),
    ]);
    writeFileSync(path.join(tmp, "broken.jpg"), broken);
    const out = await run(exifRead, { path: "broken.jpg" });
    expect(out.hasGps).toBeNull();
    expect(out.gpsUndetermined).toMatch(/could not be parsed/);
  });

  test.skipIf(process.platform === "win32")("a FIFO is refused, not opened", async () => {
    expect(Bun.spawnSync(["mkfifo", path.join(tmp, "pipe.jpg")]).exitCode).toBe(0);
    const out = (await exifRead.execute({ path: "pipe.jpg" })) as string;
    expect(out).toMatch(/not a regular file/);
  });
});
