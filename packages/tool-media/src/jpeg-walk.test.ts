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
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exifApp1Payload, jpegSegment, sampleJpeg } from "./fixtures";
import { exifRead, exifStrip } from "./index";
import { concatBytes, toHex } from "./lib/bytes";
import { inspectJpegMetadata, stripJpegMetadata, walkJpeg } from "./lib/jpeg";

const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const EXIF_ID_BYTES = new Uint8Array(EXIF_ID);

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

  describe("metadata other than EXIF is read for a location, or leaves the answer open", () => {
    const text = (t: string) => new TextEncoder().encode(t);
    /** A small JPEG with `segments` after its SOI (and its own APP0 JFIF after them). */
    const withSegments = (...segments: Uint8Array[]) =>
      concatBytes([
        new Uint8Array([0xff, 0xd8]),
        ...segments,
        sampleJpeg({ width: 8, height: 8 }).subarray(2),
      ]);
    const XMP_ID = "http://ns.adobe.com/xap/1.0/\0";
    const xmp = (body: string) =>
      jpegSegment(
        0xe1,
        text(
          `${XMP_ID}<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description ${body}/></rdf:RDF></x:xmpmeta>`,
        ),
      );
    const extendedXmp = (guid: string, offset: number, full: number, chunk: string) => {
      const header = text(`http://ns.adobe.com/xmp/extension/\0${guid}`);
      const u32 = (n: number) =>
        new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
      return jpegSegment(0xe1, concatBytes([header, u32(full), u32(offset), text(chunk)]));
    };
    /** A Photoshop IRB with one resource. */
    const photoshop = (id: number, data: Uint8Array) =>
      jpegSegment(
        0xed,
        concatBytes([
          text("Photoshop 3.0\0"),
          text("8BIM"),
          new Uint8Array([id >> 8, id & 255, 0, 0]),
          new Uint8Array([0, 0, data.length >> 8, data.length & 255]),
          data,
          new Uint8Array(data.length & 1),
        ]),
      );

    test("GPS written only in XMP is a definite yes (0.7.1's first cut: hasGps false)", async () => {
      writeFileSync(
        path.join(tmp, "xmp.jpg"),
        withSegments(xmp('exif:GPSLatitude="37,46.5N" exif:GPSLongitude="122,25.1W"')),
      );
      const out = await run(exifRead, { path: "xmp.jpg" });
      expect(out.hasExif).toBe(false);
      expect(out.hasGps).toBe(true);
      expect(out.gpsInOtherMetadata).toEqual([
        { segment: "APP1 XMP", where: "before the first scan", offset: 2 },
      ]);
      expect(out.privacyWarning).toBeDefined();
    });

    test("XMP without GPS, ICC and JFIF are read, so no GPS stays a definite no", async () => {
      writeFileSync(
        path.join(tmp, "plain.jpg"),
        withSegments(xmp('xmp:CreatorTool="Camera 1.0" photoshop:City="Springfield"')),
      );
      writeFileSync(
        path.join(tmp, "icc.jpg"),
        sampleJpeg({ width: 8, height: 8, iccProfile: true }),
      );
      for (const name of ["plain.jpg", "icc.jpg"]) {
        const out = await run(exifRead, { path: name });
        expect({ name, hasGps: out.hasGps, why: out.gpsUndetermined }).toEqual({
          name,
          hasGps: false,
          why: undefined,
        });
      }
    });

    test("Extended XMP is put back together before it is searched", async () => {
      const guid = "0123456789ABCDEF0123456789ABCDEF";
      const whole = '<rdf:Description exif:GPSLatitude="51,30N"/>';
      const cut = whole.indexOf("Latitude");
      writeFileSync(
        path.join(tmp, "ext.jpg"),
        // Out of order, and the property name cut across the two chunks.
        withSegments(
          xmp('xmpNote:HasExtendedXMP="0123456789ABCDEF0123456789ABCDEF"'),
          extendedXmp(guid, cut, whole.length, whole.slice(cut)),
          extendedXmp(guid, 0, whole.length, whole.slice(0, cut)),
        ),
      );
      const out = await run(exifRead, { path: "ext.jpg" });
      expect(out.hasGps).toBe(true);
      expect(out.gpsInOtherMetadata[0].segment).toBe("APP1 extended XMP");
    });

    test("a Photoshop block is read: its XMP and EXIF resources count, IPTC alone does not", async () => {
      const gps = exifApp1Payload(AWAY).subarray(6); // the TIFF stream, without "Exif\0\0"
      writeFileSync(
        path.join(tmp, "irb-xmp.jpg"),
        withSegments(photoshop(0x0424, text('<x exif:GPSLongitude="0,7.2W"/>'))),
      );
      writeFileSync(path.join(tmp, "irb-exif.jpg"), withSegments(photoshop(0x0422, gps)));
      writeFileSync(
        path.join(tmp, "irb-iptc.jpg"),
        withSegments(
          photoshop(0x0404, new Uint8Array([0x1c, 2, 90, 0, 4, 0x4c, 0x69, 0x6d, 0x61])),
        ),
      );
      const got: Record<string, unknown> = {};
      for (const name of ["irb-xmp.jpg", "irb-exif.jpg", "irb-iptc.jpg"]) {
        got[name] = (await run(exifRead, { path: name })).hasGps;
      }
      expect(got).toEqual({ "irb-xmp.jpg": true, "irb-exif.jpg": true, "irb-iptc.jpg": false });
    });

    test("a segment this reader does not parse leaves hasGps null, and names it", async () => {
      // A C2PA manifest (JUMBF in APP11) can carry the EXIF location as an
      // assertion; a vendor APP5 could hold anything.
      writeFileSync(
        path.join(tmp, "c2pa.jpg"),
        withSegments(
          jpegSegment(
            0xeb,
            concatBytes([text("JP"), new Uint8Array([0, 0, 0, 0, 0, 1]), text("jumb")]),
          ),
          jpegSegment(0xe5, text("VENDOR\0payload")),
        ),
      );
      const out = await run(exifRead, { path: "c2pa.jpg" });
      expect(out.hasGps).toBeNull();
      expect(out.gpsUndetermined).toMatch(
        /metadata this reader does not parse may carry a location: APP11 JP at offset 2, APP5 VENDOR at offset \d+/,
      );
      // GPS found anywhere still wins over a segment not read.
      writeFileSync(
        path.join(tmp, "both.jpg"),
        withSegments(jpegSegment(0xe5, text("VENDOR\0")), jpegSegment(0xe1, exifApp1Payload(HOME))),
      );
      expect((await run(exifRead, { path: "both.jpg" })).hasGps).toBe(true);
    });
  });

  test("GPS in bytes no walk accounts for is found; without it, hasGps is undetermined", async () => {
    // 0.7.1's first cut answered a definite hasGps: false for each of these,
    // though every file carries the GPS block byte for byte.
    const gps = exifApp1Payload(AWAY);
    const primary = sampleJpeg({ width: 8, height: 8 });
    const box = (type: string, body: Uint8Array): Uint8Array => {
      const out = new Uint8Array(8 + body.length);
      new DataView(out.buffer).setUint32(0, out.length);
      out.set(new TextEncoder().encode(type), 4);
      out.set(body, 8);
      return out;
    };
    const cases: Array<[string, Uint8Array]> = [
      [
        "an appended JPEG cut off after its APP1",
        concatBytes([
          new Uint8Array([0xff, 0xd8]),
          jpegSegment(0xe1, gps),
          new Uint8Array([0xff, 0xc0, 0x00, 0x40, 0x08]),
        ]),
      ],
      [
        "an appended JPEG with a second SOI",
        concatBytes([
          new Uint8Array([0xff, 0xd8]),
          jpegSegment(0xe1, gps),
          new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        ]),
      ],
      ["a raw EXIF block after EOI", gps],
      [
        "a motion-photo video",
        concatBytes([box("ftyp", new TextEncoder().encode("mp42")), box("uuid", gps)]),
      ],
    ];
    for (const [label, trailer] of cases) {
      writeFileSync(path.join(tmp, "t.jpg"), concatBytes([primary, trailer]));
      const out = await run(exifRead, { path: "t.jpg" });
      expect({ label, hasGps: out.hasGps }).toEqual({ label, hasGps: true });
      expect(
        out.exifBlocks.some((b: { where: string }) => b.where === "in bytes no walk accounts for"),
      ).toBe(true);
    }
    // No EXIF block in them: not a definite no, because they were not read.
    const video = concatBytes([
      box("ftyp", new TextEncoder().encode("mp42")),
      box("moov", new Uint8Array(64)),
    ]);
    writeFileSync(path.join(tmp, "v.jpg"), concatBytes([primary, video]));
    const unknown = await run(exifRead, { path: "v.jpg" });
    expect(unknown.hasGps).toBeNull();
    expect(unknown.unaccountedBytes).toBe(video.length);
    expect(unknown.gpsUndetermined).toMatch(
      /bytes after the image that no walk accounts for \(an appended video \(a motion photo\)\) were searched for EXIF blocks but not parsed/,
    );
    // Padding after EOI is not data: still a definite no.
    writeFileSync(path.join(tmp, "p.jpg"), concatBytes([primary, new Uint8Array(32)]));
    const padded = await run(exifRead, { path: "p.jpg" });
    expect({ hasGps: padded.hasGps, trailingBytes: padded.trailingBytes }).toEqual({
      hasGps: false,
      trailingBytes: 32,
    });
  });

  test("a JPEG that breaks off after its first scan is read and stripped as 0.7.0 did", async () => {
    // Cut inside a DHT between scans: 0.7.1's first cut refused both tools
    // ("runs 19 bytes past the end of the file"); 0.7.0 answered.
    const { file } = withInterScanGps();
    const walked = walkJpeg(file);
    const dht = walked.segments.find((s) => s.name === "DHT" && s.offset > 100) as {
      offset: number;
    };
    const cut = file.subarray(0, dht.offset + 6);
    writeFileSync(path.join(tmp, "cut.jpg"), cut);
    const read = await run(exifRead, { path: "cut.jpg" });
    expect(read.make).toBeUndefined();
    expect(read.hasExif).toBe(true);
    // The primary block's GPS is found; the break is reported.
    expect(read.hasGps).toBe(true);
    expect(read.breaksOffAt).toBe(dht.offset);
    const stripped = await run(exifStrip, { path: "cut.jpg", output: "clean.jpg" });
    expect(stripped.breaksOffAt).toBe(dht.offset);
    const clean = new Uint8Array(readFileSync(path.join(tmp, "clean.jpg")));
    expect(count(clean, EXIF_ID)).toBe(0);
    // Everything from the first scan to the break, and the cut DHT, kept verbatim.
    const firstSos = walked.segments.find((s) => s.name === "SOS")?.offset as number;
    expect(toHex(clean.subarray(clean.length - (cut.length - firstSos)))).toBe(
      toHex(cut.subarray(firstSos)),
    );
    // Without GPS before the break, no GPS is not a definite no.
    const plain = sampleJpeg({ width: 8, height: 8, scanBytes: 4 });
    const plainCut = concatBytes([
      plain.subarray(0, plain.length - 2),
      new Uint8Array([0xff, 0xc4, 0x00, 0x40, 0x00]),
    ]);
    writeFileSync(path.join(tmp, "plain.jpg"), plainCut);
    const plainRead = await run(exifRead, { path: "plain.jpg" });
    expect(plainRead.hasGps).toBeNull();
    expect(plainRead.gpsUndetermined).toMatch(/the file breaks off at offset \d+ \(segment DHT/);
  });

  test("a metadata segment cut off after the first scan is dropped; unframed bytes holding one are refused", async () => {
    const plain = sampleJpeg({ width: 8, height: 8, scanBytes: 4 });
    const body = plain.subarray(0, plain.length - 2);
    // A cut-off APP1: dropped, the rest kept.
    const cutApp1 = concatBytes([body, new Uint8Array([0xff, 0xe1, 0x10, 0x00]), EXIF_ID_BYTES]);
    const stripped = stripJpegMetadata(cutApp1);
    expect(stripped.removed.map((r) => r.name)).toContain("APP1 (cut off)");
    expect(count(stripped.bytes, EXIF_ID)).toBe(0);
    // Bytes where a marker should be, with an EXIF block further on: refused.
    const garbled = concatBytes([
      body,
      new Uint8Array([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00, 0x42]),
      EXIF_ID_BYTES,
    ]);
    expect(walkJpeg(garbled).stopped?.reason).toMatch(/expected a marker/);
    expect(() => stripJpegMetadata(garbled)).toThrow(
      /holds what may be metadata at offset \d+; nothing was written/,
    );
    // A broken header is still refused outright, as in 0.7.0.
    expect(() => walkJpeg(plain.subarray(0, 12))).toThrow();
  });

  test("a JPEG past the read limit is read as far as the limit, not refused", async () => {
    // 0.7.0 read a 1 MiB head; 0.7.1's first cut refused anything over 64 MiB.
    const head = sampleJpeg({ width: 8, height: 8, exif: { ...HOME }, scanBytes: 4 });
    const body = head.subarray(0, head.length - 2);
    const file = path.join(tmp, "big.jpg");
    writeFileSync(file, body);
    const fd = openSync(file, "r+");
    ftruncateSync(fd, 64 * 1024 * 1024 + 4096);
    closeSync(fd);
    const out = await run(exifRead, { path: "big.jpg" });
    expect(out.hasExif).toBe(true);
    expect(out.hasGps).toBe(true);
    expect(out.fileBytes).toBe(64 * 1024 * 1024 + 4096);
    expect(out.bytesRead).toBe(64 * 1024 * 1024);
    // Without GPS in what was read, the answer is undetermined, with the reason.
    const plain = sampleJpeg({ width: 8, height: 8, scanBytes: 4 });
    writeFileSync(file, plain.subarray(0, plain.length - 2));
    const fd2 = openSync(file, "r+");
    ftruncateSync(fd2, 64 * 1024 * 1024 + 4096);
    closeSync(fd2);
    const unknown = await run(exifRead, { path: "big.jpg" });
    expect(unknown.hasGps).toBeNull();
    expect(unknown.gpsUndetermined).toMatch(
      /only the first 67108864 of the file's 67112960 bytes were read/,
    );
  }, 20_000);

  test.skipIf(process.platform === "win32")("a FIFO is refused, not opened", async () => {
    expect(Bun.spawnSync(["mkfifo", path.join(tmp, "pipe.jpg")]).exitCode).toBe(0);
    const out = (await exifRead.execute({ path: "pipe.jpg" })) as string;
    expect(out).toMatch(/not a regular file/);
  });
});
