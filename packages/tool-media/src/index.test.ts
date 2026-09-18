/**
 * Every tool this package registers, exercised through its own `execute`.
 *
 * Each test builds a throwaway directory under the OS temp dir and chdir's
 * into it, because the workspace root is `process.cwd()` and that is the
 * boundary every path here is checked against. Nothing is ever written
 * inside the repository, nothing reaches a public network address, and
 * every fixture is constructed rather than committed — including the
 * `ffprobe` that `MediaProbe` finds, which is a script this test writes
 * and puts on `PATH`, so the process path is tested for real without
 * depending on what is installed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  SAMPLE_FFPROBE_JSON,
  SAMPLE_SRT,
  SAMPLE_VTT,
  handWrittenPng,
  rgbaSamples,
  sampleBmp,
  sampleGif,
  sampleJpeg,
  sampleWebpLossless,
} from "./fixtures";
import {
  MEDIA_TOOLS,
  barcodeEncode,
  chartRender,
  colorContrast,
  colorConvert,
  diagramRender,
  exifRead,
  exifStrip,
  imageCrop,
  imageDiff,
  imageInfo,
  imageKind,
  imageResize,
  mediaProbe,
  pngRead,
  pngWrite,
  qrEncode,
  sparklineRender,
  subtitleParse,
  subtitleWrite,
} from "./index";
import { decodePng, encodePng } from "./lib/png";

const originalCwd = process.cwd();
const originalPath = process.env["PATH"] ?? "";
let tmp: string;
/** A directory OUTSIDE the workspace, for the containment tests. */
let outside: string;
/** A directory holding the fake `ffprobe`, put on PATH for the probe tests. */
let binDir: string;

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), "crewhaus-media-bin-"));
  const script = `#!/bin/sh\nif [ "$CREWHAUS_FFPROBE_SLOW" = "1" ]; then sleep 10; fi\ncat <<'JSON'\n${SAMPLE_FFPROBE_JSON}\nJSON\n`;
  writeFileSync(path.join(binDir, "ffprobe"), script);
  chmodSync(path.join(binDir, "ffprobe"), 0o755);
});

afterAll(() => {
  process.env["PATH"] = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-media-"));
  outside = mkdtempSync(path.join(tmpdir(), "crewhaus-media-out-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Tools return compact JSON or plain text; parse it when it is JSON. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
async function run(tool: RegisteredTool, input: unknown): Promise<any> {
  const out = await tool.execute(input);
  const text = typeof out === "string" ? out : JSON.stringify(out);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function put(name: string, data: Uint8Array | string): string {
  writeFileSync(path.join(tmp, name), data);
  return name;
}

/** A small PNG with a red square, written into the temp workspace. */
function putPng(name: string, width = 20, height = 16, shift = 0): string {
  const data = rgbaSamples(width, height, (x, y) =>
    x >= 4 + shift && x < 9 + shift && y >= 3 && y < 8
      ? [220, 30, 30, 255]
      : [(x * 11) % 256, (y * 17) % 256, 90, 255],
  );
  return put(name, encodePng({ width, height, data }));
}

describe("the tool surface", () => {
  test("names are PascalCase and unique", () => {
    const names = MEDIA_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every description's second sentence starts with Use", () => {
    for (const tool of MEDIA_TOOLS) {
      const sentences = tool.description.split(/(?<=\.)\s+/);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      expect(sentences[1]?.startsWith("Use ")).toBe(true);
    }
  });

  test("the tools array is frozen and sorted by name", () => {
    expect(Object.isFrozen(MEDIA_TOOLS)).toBe(true);
    const names = MEDIA_TOOLS.map((t) => t.name);
    expect([...names]).toEqual([...names].sort());
  });

  test("safety flags match what each tool actually does", () => {
    const writers = new Set([
      "PngWrite",
      "ImageResize",
      "ImageCrop",
      "ExifStrip",
      "QrEncode",
      "BarcodeEncode",
      "ChartRender",
      "DiagramRender",
      "SubtitleWrite",
    ]);
    for (const tool of MEDIA_TOOLS) {
      if (writers.has(tool.name)) {
        expect(tool.destructive).toBe(true);
        expect(tool.readOnly).toBe(false);
      } else if (tool.name === "MediaProbe") {
        // Spawning is neither: ffprobe cannot change a file, so it is not
        // destructive, but `readOnly` is what `plan` mode auto-allows and a
        // plan must not start a process.
        expect(tool.readOnly).toBe(false);
        expect(tool.destructive).toBe(false);
      } else {
        expect(tool.readOnly).toBe(true);
        expect(tool.destructive).toBe(false);
      }
    }
  });

  test("no tool that spawns a process is readOnly, so plan mode cannot run it", () => {
    for (const tool of MEDIA_TOOLS) {
      if (tool.ioCapability === undefined) continue;
      expect({ name: tool.name, readOnly: tool.readOnly }).toEqual({
        name: tool.name,
        readOnly: false,
      });
    }
  });

  test("only the process-spawning tool is external, and it declares why", () => {
    for (const tool of MEDIA_TOOLS) {
      if (tool.name === "MediaProbe") {
        expect(tool.scope).toBe("external");
        expect(tool.ioCapability).toBe("process");
      } else {
        expect(tool.scope).toBe("internal");
        expect(tool.ioCapability).toBeUndefined();
      }
    }
  });

  test("no tool puts text in front of a person, so none needs a justification", () => {
    // Everything here writes into the workspace or returns to the caller;
    // nothing sends, posts or publishes. If that ever changes, the tool
    // that changes it needs `requireJustification: true` and this test
    // should be the thing that says so.
    for (const tool of MEDIA_TOOLS) expect(tool.requireJustification).toBe(false);
  });

  test("every schema rejects a wrong-typed input", () => {
    for (const tool of MEDIA_TOOLS) {
      expect(tool.inputSchema.safeParse({ path: 42, text: 42, values: 42 }).success).toBe(false);
    }
  });
});

describe("path containment", () => {
  const cases: Array<[RegisteredTool, (p: string) => unknown]> = [
    [imageInfo, (p) => ({ path: p })],
    [imageKind, (p) => ({ path: p })],
    [pngRead, (p) => ({ path: p })],
    [exifRead, (p) => ({ path: p })],
    [exifStrip, (p) => ({ path: p, output: "out.jpg" })],
    [imageDiff, (p) => ({ a: p, b: p })],
    [imageResize, (p) => ({ path: p, output: "out.png", width: 4 })],
    [imageCrop, (p) => ({ path: p, output: "o.png", x: 0, y: 0, width: 1, height: 1 })],
    [subtitleParse, (p) => ({ path: p })],
    [mediaProbe, (p) => ({ path: p })],
  ];

  test("a path with .. in it is refused before anything is read", async () => {
    for (const [tool, makeInput] of cases) {
      const result = await tool.execute(makeInput("../escape.bin"));
      expect(String(result)).toMatch(/escapes the workspace root/);
    }
  });

  test("an absolute path outside the workspace is refused", async () => {
    const target = path.join(outside, "secret.bin");
    writeFileSync(target, "secret");
    for (const [tool, makeInput] of cases) {
      const result = await tool.execute(makeInput(target));
      expect(String(result)).toMatch(/escapes the workspace root/);
    }
  });

  test("a symlink inside the workspace pointing out of it is refused", async () => {
    writeFileSync(
      path.join(outside, "secret.png"),
      encodePng({ width: 1, height: 1, data: new Uint8Array(4) }),
    );
    symlinkSync(outside, path.join(tmp, "link"));
    for (const [tool, makeInput] of cases) {
      const result = await tool.execute(makeInput("link/secret.png"));
      expect(String(result)).toMatch(/escapes the workspace root/);
    }
  });

  test("a DANGLING symlink out of the workspace is refused, not written through", async () => {
    // The target does not exist, so `existsSync` on the link is false and a
    // containment check that probes with it treats the link as a plain
    // missing leaf — but `open(…, "w")` follows it and CREATES the target
    // outside the workspace. Every writing tool has to refuse the link.
    const escapedTo = path.join(outside, "pwned.png");
    symlinkSync(escapedTo, path.join(tmp, "dangling.png"));
    symlinkSync(path.join(outside, "pwned.svg"), path.join(tmp, "dangling.svg"));
    symlinkSync(path.join(outside, "pwned.srt"), path.join(tmp, "dangling.srt"));
    putPng("in.png");
    put("in.jpg", sampleJpeg({ width: 8, height: 8 }));
    const attempts: Array<[RegisteredTool, unknown]> = [
      [
        pngWrite,
        {
          path: "dangling.png",
          width: 1,
          height: 1,
          pixels: Buffer.from([1, 2, 3, 255]).toString("base64"),
        },
      ],
      [imageResize, { path: "in.png", output: "dangling.png", width: 4 }],
      [imageCrop, { path: "in.png", output: "dangling.png", x: 0, y: 0, width: 2, height: 2 }],
      [exifStrip, { path: "in.jpg", output: "dangling.png" }],
      [qrEncode, { text: "x", path: "dangling.png" }],
      [barcodeEncode, { symbology: "code128", value: "AB", path: "dangling.png" }],
      [chartRender, { type: "pie", slices: [{ label: "a", value: 1 }], path: "dangling.svg" }],
      [diagramRender, { nodes: [{ id: "a" }], edges: [], path: "dangling.svg" }],
      [
        subtitleWrite,
        { cues: [{ startMs: 0, endMs: 1, text: "x" }], format: "srt", path: "dangling.srt" },
      ],
    ];
    for (const [tool, input] of attempts) {
      const said = String(await run(tool, input));
      expect({ tool: tool.name, refused: /escapes the workspace root/.test(said) }).toEqual({
        tool: tool.name,
        refused: true,
      });
    }
    expect(existsSync(escapedTo)).toBe(false);
    expect(existsSync(path.join(outside, "pwned.svg"))).toBe(false);
    expect(existsSync(path.join(outside, "pwned.srt"))).toBe(false);
  });

  test("a dangling symlink that stays inside the workspace still works", async () => {
    mkdirSync(path.join(tmp, "sub"));
    symlinkSync(path.join(tmp, "sub", "made.png"), path.join(tmp, "inside.png"));
    const result = await run(pngWrite, {
      path: "inside.png",
      width: 1,
      height: 1,
      pixels: Buffer.from([1, 2, 3, 255]).toString("base64"),
    });
    expect(result.path).toBe("inside.png");
    expect(existsSync(path.join(tmp, "sub", "made.png"))).toBe(true);
  });

  test("the destination of a writing tool is contained too", async () => {
    putPng("in.png");
    const outputs: Array<[RegisteredTool, unknown]> = [
      [imageResize, { path: "in.png", output: "../out.png", width: 4 }],
      [imageCrop, { path: "in.png", output: `${outside}/o.png`, x: 0, y: 0, width: 2, height: 2 }],
      [
        pngWrite,
        {
          path: "../x.png",
          width: 1,
          height: 1,
          pixels: Buffer.from([0, 0, 0, 255]).toString("base64"),
        },
      ],
      [qrEncode, { text: "x", path: "../q.png" }],
      [barcodeEncode, { symbology: "code128", value: "AB", path: "../b.png" }],
      [chartRender, { type: "pie", slices: [{ label: "a", value: 1 }], path: "../c.svg" }],
      [diagramRender, { nodes: [{ id: "a" }], edges: [], path: "../d.svg" }],
      [
        subtitleWrite,
        { cues: [{ startMs: 0, endMs: 1, text: "x" }], format: "srt", path: "../s.srt" },
      ],
    ];
    for (const [tool, input] of outputs) {
      expect(String(await run(tool, input))).toMatch(/escapes the workspace root/);
    }
  });

  test("a relative dangling link under an outward directory link is refused", async () => {
    // In the dangling cases above, the link and its lexical parent name the
    // same real directory, so reading a target relative to either gives the
    // same answer. Here they come apart. `pdir` leaves the workspace, so `l`
    // really sits in <outside>/realdir and its RELATIVE target "../escape.bin"
    // truly names <outside>/escape.bin. Measured from the LEXICAL parent
    // <tmp>/pdir, that same target reads as <tmp>/escape.bin — an in-root
    // path, which containment would wave through, so the write would land at
    // a location "pdir/l" does not lead to. POSIX resolves a relative target
    // against the directory that actually CONTAINS the link, which is why the
    // parent is made real before the target is joined to it.
    mkdirSync(path.join(outside, "realdir"));
    symlinkSync(path.join(outside, "realdir"), path.join(tmp, "pdir"));
    symlinkSync("../escape.bin", path.join(outside, "realdir", "l"));

    const written = await run(pngWrite, {
      path: "pdir/l",
      width: 1,
      height: 1,
      pixels: Buffer.from([1, 2, 3, 255]).toString("base64"),
    });
    expect(String(written)).toMatch(/escapes the workspace root/);
    // Reading it is refused for the same reason, and says the same thing.
    expect(String(await run(imageInfo, { path: "pdir/l" }))).toMatch(/escapes the workspace root/);
    // Nothing at the true destination — and nothing at the in-root path the
    // lexical reading names either, because the harm here is a silent
    // redirect to the wrong in-workspace file, not a write outside the root.
    expect(existsSync(path.join(outside, "escape.bin"))).toBe(false);
    expect(existsSync(path.join(tmp, "escape.bin"))).toBe(false);
  });
});

describe("ImageInfo and ImageKind", () => {
  test("reads a PNG header without decoding it", async () => {
    putPng("shot.png", 640, 480);
    const result = await run(imageInfo, { path: "shot.png" });
    expect(result).toMatchObject({
      path: "shot.png",
      format: "png",
      width: 640,
      height: 480,
      bitDepth: 8,
      hasAlpha: false,
    });
    expect(result.megapixels).toBeCloseTo(0.31, 2);
    expect(result.aspectRatio).toBeCloseTo(1.333, 3);
  });

  test("covers JPEG, GIF, WebP and BMP as well", async () => {
    put("a.jpg", sampleJpeg({ width: 300, height: 200 }));
    put("a.gif", sampleGif(64, 32, { transparent: true }));
    put("a.webp", sampleWebpLossless(120, 90, true));
    put("a.bmp", sampleBmp(16, 8));
    expect(await run(imageInfo, { path: "a.jpg" })).toMatchObject({ format: "jpeg", width: 300 });
    expect(await run(imageInfo, { path: "a.gif" })).toMatchObject({
      format: "gif",
      hasAlpha: true,
    });
    expect(await run(imageInfo, { path: "a.webp" })).toMatchObject({ format: "webp", width: 120 });
    expect(await run(imageInfo, { path: "a.bmp" })).toMatchObject({ format: "bmp", height: 8 });
  });

  test("says plainly when a format is not one it reads headers for", async () => {
    put("doc.pdf", "%PDF-1.7\ntrailer\n");
    expect(String(await run(imageInfo, { path: "doc.pdf" }))).toMatch(/these bytes are pdf/);
  });

  test("flags an extension that disagrees with the content", async () => {
    put("photo.jpg", encodePng({ width: 2, height: 2, data: new Uint8Array(16) }));
    const result = await run(imageKind, { path: "photo.jpg" });
    expect(result).toMatchObject({ kind: "png", extensionAgrees: false });
    expect(result.warning).toMatch(/names jpeg, but the content is png/);
  });

  test("agrees when the extension is right, and reports the magic bytes", async () => {
    putPng("right.png", 4, 4);
    const result = await run(imageKind, { path: "right.png" });
    expect(result).toMatchObject({ kind: "png", extensionAgrees: true, family: "image" });
    expect(result.magic).toBe("89504e470d0a1a0a");
  });

  test("an unknown format is reported as unknown, not guessed at", async () => {
    put("mystery.dat", new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44]));
    const result = await run(imageKind, { path: "mystery.dat" });
    expect(result.kind).toBeNull();
    expect(result.recognised).toBe(false);
    expect(result.magic.startsWith("0011")).toBe(true);
  });

  test("a directory is refused rather than read", async () => {
    mkdirSync(path.join(tmp, "folder"));
    expect(String(await run(imageInfo, { path: "folder" }))).toMatch(/is a directory/);
  });

  test("a missing file gets a readable answer, not a stack trace", async () => {
    expect(String(await run(imageInfo, { path: "nope.png" }))).toMatch(/no such file/);
  });
});

describe("PngWrite and PngRead", () => {
  const pixels = (n: number): string =>
    Buffer.from(Array.from({ length: n * 4 }, (_, i) => (i * 7) % 256)).toString("base64");

  test("writes pixels and reads them back unchanged", async () => {
    const written = await run(pngWrite, {
      path: "out.png",
      width: 4,
      height: 3,
      pixels: pixels(12),
      colorType: "rgba",
    });
    expect(written).toMatchObject({ path: "out.png", width: 4, height: 3 });
    const read = await run(pngRead, { path: "out.png" });
    expect(read).toMatchObject({ width: 4, height: 3, pixelFormat: "rgba8" });
    expect(read.pixels).toBe(pixels(12));
  });

  test("a blob whose length disagrees with the dimensions is refused", async () => {
    const result = await run(pngWrite, { path: "bad.png", width: 4, height: 4, pixels: pixels(3) });
    expect(String(result)).toMatch(/decodes to 12 bytes, but 4x4 RGBA needs 64/);
  });

  test("an existing destination is not clobbered unless asked", async () => {
    await run(pngWrite, { path: "x.png", width: 1, height: 1, pixels: pixels(1) });
    expect(
      String(await run(pngWrite, { path: "x.png", width: 1, height: 1, pixels: pixels(1) })),
    ).toMatch(/already exists; pass overwrite/);
    const again = await run(pngWrite, {
      path: "x.png",
      width: 1,
      height: 1,
      pixels: pixels(1),
      overwrite: true,
    });
    expect(again.path).toBe("x.png");
  });

  test("a region is decoded and returned on its own", async () => {
    putPng("shot.png", 20, 16);
    const region = await run(pngRead, {
      path: "shot.png",
      region: { x: 4, y: 3, width: 5, height: 5 },
    });
    expect(region).toMatchObject({ width: 5, height: 5, fullWidth: 20, fullHeight: 16 });
    const decoded = Buffer.from(region.pixels as string, "base64");
    expect(decoded.length).toBe(100);
    expect([...decoded.subarray(0, 4)]).toEqual([220, 30, 30, 255]);
  });

  test("a region outside the image is refused with its bounds", async () => {
    putPng("shot.png", 10, 10);
    expect(
      String(await run(pngRead, { path: "shot.png", region: { x: 8, y: 0, width: 5, height: 2 } })),
    ).toMatch(/is not inside the 10x10 image/);
  });

  test("statistics stand in when the pixels would be too big to return", async () => {
    putPng("big.png", 300, 300);
    const refused = await run(pngRead, { path: "big.png", maxBase64Chars: 1000 });
    expect(refused.pixels).toBeNull();
    expect(refused.refused).toMatch(/over the 1000 cap/);
    const stats = await run(pngRead, { path: "big.png", statsOnly: true });
    expect(stats.stats.opaquePixels).toBe(90_000);
    expect(stats.stats.mean.r).toBeGreaterThan(0);
  });

  test("reading something that is not a PNG says so, and names what it is", async () => {
    put("a.jpg", sampleJpeg({ width: 8, height: 8 }));
    expect(String(await run(pngRead, { path: "a.jpg" }))).toMatch(
      /is jpeg; this tool decodes PNG only/,
    );
  });

  test("a palette PNG decodes to RGBA", async () => {
    put(
      "pal.png",
      handWrittenPng({
        width: 2,
        height: 1,
        colorType: 3,
        samples: new Uint8Array([0, 1]),
        palette: new Uint8Array([9, 8, 7, 1, 2, 3]),
      }),
    );
    const read = await run(pngRead, { path: "pal.png" });
    expect([...Buffer.from(read.pixels as string, "base64")]).toEqual([9, 8, 7, 255, 1, 2, 3, 255]);
    expect(read.sourceColorType).toBe(3);
  });
});

describe("ImageResize and ImageCrop", () => {
  test("resizing preserves the aspect ratio from one dimension", async () => {
    putPng("in.png", 40, 20);
    const result = await run(imageResize, { path: "in.png", output: "out.png", width: 10 });
    expect(result.to).toEqual({ width: 10, height: 5 });
    expect(result.method).toBe("bilinear");
    expect(result.resampling).toMatch(/bilinear interpolation/);
    const decoded = decodePng(new Uint8Array(readFileSync(path.join(tmp, "out.png"))));
    expect(decoded.width).toBe(10);
    expect(decoded.height).toBe(5);
  });

  test("the method is stated and actually changes the pixels", async () => {
    putPng("in.png", 33, 21);
    await run(imageResize, { path: "in.png", output: "near.png", width: 8, method: "nearest" });
    await run(imageResize, { path: "in.png", output: "bil.png", width: 8, method: "bilinear" });
    const near = readFileSync(path.join(tmp, "near.png"));
    const bil = readFileSync(path.join(tmp, "bil.png"));
    expect(Buffer.compare(near, bil)).not.toBe(0);
  });

  test("resizing is reproducible byte for byte", async () => {
    putPng("in.png", 25, 25);
    await run(imageResize, { path: "in.png", output: "a.png", width: 9, height: 7 });
    await run(imageResize, { path: "in.png", output: "b.png", width: 9, height: 7 });
    expect(
      Buffer.compare(readFileSync(path.join(tmp, "a.png")), readFileSync(path.join(tmp, "b.png"))),
    ).toBe(0);
  });

  test("resizing needs at least one dimension", async () => {
    putPng("in.png");
    expect(String(await run(imageResize, { path: "in.png", output: "o.png" }))).toMatch(
      /give a width, a height, or both/,
    );
  });

  test("cropping takes the rectangle asked for", async () => {
    putPng("in.png", 20, 16);
    const result = await run(imageCrop, {
      path: "in.png",
      output: "crop.png",
      x: 4,
      y: 3,
      width: 5,
      height: 5,
    });
    expect(result.region).toEqual({ x: 4, y: 3, width: 5, height: 5 });
    const decoded = decodePng(new Uint8Array(readFileSync(path.join(tmp, "crop.png"))));
    expect(decoded.width).toBe(5);
    expect([...decoded.data.subarray(0, 4)]).toEqual([220, 30, 30, 255]);
  });

  test("a crop that does not fit is refused with the dimensions", async () => {
    putPng("in.png", 10, 10);
    expect(
      String(
        await run(imageCrop, { path: "in.png", output: "o.png", x: 8, y: 8, width: 5, height: 5 }),
      ),
    ).toMatch(/is not inside the 10x10 image/);
  });
});

describe("ImageDiff", () => {
  test("identical images compare equal, with a zero hash distance", async () => {
    putPng("a.png", 24, 24);
    putPng("b.png", 24, 24);
    const result = await run(imageDiff, { a: "a.png", b: "b.png" });
    expect(result).toMatchObject({ identical: true, differingPixels: 0, hashDistance: 0 });
    expect(result.boundingBox).toBeNull();
  });

  test("a moved square is located by its bounding box", async () => {
    putPng("a.png", 24, 24, 0);
    putPng("b.png", 24, 24, 6);
    const result = await run(imageDiff, { a: "a.png", b: "b.png" });
    expect(result.identical).toBe(false);
    expect(result.differingPixels).toBeGreaterThan(0);
    expect(result.boundingBox.y).toBe(3);
    expect(result.boundingBox.height).toBe(5);
    expect(result.fraction).toBeGreaterThan(0);
  });

  test("different sizes are reported, not compared", async () => {
    putPng("a.png", 10, 10);
    putPng("b.png", 12, 10);
    const result = await run(imageDiff, { a: "a.png", b: "b.png" });
    expect(result.sizeMismatch).toEqual({
      a: { width: 10, height: 10 },
      b: { width: 12, height: 10 },
    });
    expect(result.hashDistance).toBeGreaterThanOrEqual(0);
  });

  test("the threshold tolerates small changes", async () => {
    putPng("a.png", 8, 8);
    const original = decodePng(new Uint8Array(readFileSync(path.join(tmp, "a.png"))));
    const nudged = original.data.slice();
    nudged[0] = Math.min(255, (nudged[0] as number) + 3);
    put("b.png", encodePng({ width: 8, height: 8, data: nudged }));
    expect((await run(imageDiff, { a: "a.png", b: "b.png" })).differingPixels).toBe(1);
    expect((await run(imageDiff, { a: "a.png", b: "b.png", threshold: 3 })).differingPixels).toBe(
      0,
    );
  });
});

describe("ExifRead and ExifStrip", () => {
  test("reads the camera, orientation and exposure", async () => {
    put(
      "photo.jpg",
      sampleJpeg({
        width: 4000,
        height: 3000,
        exif: {
          make: "Acme",
          model: "Field 900",
          orientation: 8,
          isoSpeed: 200,
          fNumber: [40, 10],
        },
      }),
    );
    const result = await run(exifRead, { path: "photo.jpg" });
    expect(result).toMatchObject({
      hasExif: true,
      make: "Acme",
      model: "Field 900",
      orientation: 8,
      orientationDescription: "rotated 90 degrees counter-clockwise",
      isoSpeed: 200,
      hasGps: false,
    });
    expect(result.privacyWarning).toBeUndefined();
  });

  test("GPS is surfaced with an explicit warning", async () => {
    put(
      "located.jpg",
      sampleJpeg({ width: 10, height: 10, exif: { latitude: 51.5007, longitude: -0.1246 } }),
    );
    const result = await run(exifRead, { path: "located.jpg" });
    expect(result.hasGps).toBe(true);
    expect(result.gps.latitude).toBeCloseTo(51.5007, 4);
    expect(result.gps.longitude).toBeCloseTo(-0.1246, 4);
    expect(result.privacyWarning).toMatch(/publishing it publishes that location/);
  });

  test("a JPEG with no EXIF says so, and lists what metadata it does carry", async () => {
    put("plain.jpg", sampleJpeg({ width: 8, height: 8, iccProfile: true }));
    const result = await run(exifRead, { path: "plain.jpg" });
    expect(result).toMatchObject({ hasExif: false, hasGps: false });
    expect(result.metadataSegments).toEqual(["APP0", "APP2"]);
  });

  test("a non-JPEG is refused by name", async () => {
    putPng("a.png");
    expect(String(await run(exifRead, { path: "a.png" }))).toMatch(
      /is png; EXIF reading here covers JPEG only/,
    );
  });

  test("stripping removes the location and leaves a readable JPEG", async () => {
    put(
      "in.jpg",
      sampleJpeg({
        width: 200,
        height: 150,
        exif: { make: "Acme", latitude: 1.23, longitude: 4.56 },
        comment: "shot at home",
        iccProfile: true,
      }),
    );
    const result = await run(exifStrip, { path: "in.jpg", output: "clean.jpg" });
    expect(result.removed.map((r: { name: string }) => r.name).sort()).toEqual(["APP1", "COM"]);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    const after = await run(exifRead, { path: "clean.jpg" });
    expect(after.hasExif).toBe(false);
    expect(after.hasGps).toBe(false);
    // The colour profile survived, and so did the picture's dimensions.
    expect(after.metadataSegments).toEqual(["APP0", "APP2"]);
    expect(await run(imageInfo, { path: "clean.jpg" })).toMatchObject({ width: 200, height: 150 });
  });

  test("the colour profile can be dropped when that is what is wanted", async () => {
    put("in.jpg", sampleJpeg({ width: 8, height: 8, iccProfile: true, exif: { make: "A" } }));
    const result = await run(exifStrip, {
      path: "in.jpg",
      output: "bare.jpg",
      keepIccProfile: false,
    });
    expect(result.removed.map((r: { name: string }) => r.name).sort()).toEqual(["APP1", "APP2"]);
  });
});

describe("QrEncode", () => {
  test("writes a PNG whose size follows from the module count", async () => {
    const result = await run(qrEncode, { text: "https://crewhaus.ai", path: "qr.png", scale: 4 });
    expect(result).toMatchObject({ ecc: "M", mode: "byte (UTF-8)", quietZone: 4, scale: 4 });
    expect(result.width).toBe((result.modules + 8) * 4);
    expect(result.width).toBe(result.height);
    const decoded = decodePng(new Uint8Array(readFileSync(path.join(tmp, "qr.png"))));
    expect(decoded.width).toBe(result.width);
    // Top-left corner is quiet zone, so it is the light colour.
    expect([...decoded.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
  });

  test("the text form is square and has its quiet zone", async () => {
    const result = await run(qrEncode, { text: "hello", format: "text", quietZone: 2 });
    const lines = (result.matrix as string).split("\n");
    expect(lines.length).toBe(result.modules + 4);
    expect(lines[0]?.length).toBe((result.modules + 4) * 2);
  });

  test("the error-correction level changes the version needed", async () => {
    const payload = "x".repeat(60);
    const low = await run(qrEncode, { text: payload, format: "text", ecc: "L" });
    const high = await run(qrEncode, { text: payload, format: "text", ecc: "H" });
    expect(high.version).toBeGreaterThan(low.version);
    expect(low.capacityBytes).toBeGreaterThanOrEqual(60);
  });

  test("the same payload writes byte-identical PNGs", async () => {
    await run(qrEncode, { text: "same", path: "a.png" });
    await run(qrEncode, { text: "same", path: "b.png" });
    expect(
      Buffer.compare(readFileSync(path.join(tmp, "a.png")), readFileSync(path.join(tmp, "b.png"))),
    ).toBe(0);
  });

  test("custom colours are honoured", async () => {
    await run(qrEncode, {
      text: "colour",
      path: "c.png",
      dark: "#003366",
      light: "#f0f0f0",
      quietZone: 1,
      scale: 2,
    });
    const decoded = decodePng(new Uint8Array(readFileSync(path.join(tmp, "c.png"))));
    expect([...decoded.data.subarray(0, 4)]).toEqual([240, 240, 240, 255]);
  });

  test("a payload past the capacity is refused by name", async () => {
    expect(String(await run(qrEncode, { text: "z".repeat(400), path: "q.png" }))).toMatch(
      /exceed the .* capacity of version 10/,
    );
  });

  test("png format without a path is a caller mistake, stated as one", async () => {
    expect(String(await run(qrEncode, { text: "x" }))).toMatch(/needs a `path` to write to/);
  });
});

describe("BarcodeEncode", () => {
  test("EAN-13 computes the check digit and writes a PNG", async () => {
    const result = await run(barcodeEncode, {
      symbology: "ean13",
      value: "400638133393",
      path: "ean.png",
      scale: 2,
      height: 50,
    });
    expect(result).toMatchObject({ digits: "4006381333931", checkDigit: 1, moduleCount: 95 });
    expect(result.width).toBe((95 + 22) * 2);
    expect(result.height).toBe(50);
    expect(decodePng(new Uint8Array(readFileSync(path.join(tmp, "ean.png")))).width).toBe(
      result.width,
    );
  });

  test("a wrong check digit is refused rather than corrected", async () => {
    expect(
      String(
        await run(barcodeEncode, { symbology: "ean13", value: "4006381333930", format: "modules" }),
      ),
    ).toMatch(/checks to 1/);
  });

  test("Code 128 reports its code set and check character", async () => {
    const result = await run(barcodeEncode, {
      symbology: "code128",
      value: "ABC",
      format: "modules",
    });
    expect(result).toMatchObject({ codeSet: "B", checkCharacter: 1 });
    expect(result.modules.length).toBe(result.moduleCount);
    const digits = await run(barcodeEncode, {
      symbology: "code128",
      value: "1234",
      format: "modules",
    });
    expect(digits.codeSet).toBe("C");
  });

  test("a character Code 128 cannot carry is refused", async () => {
    expect(
      String(await run(barcodeEncode, { symbology: "code128", value: "café", format: "modules" })),
    ).toMatch(/outside the ASCII 32-126 range/);
  });
});

describe("ChartRender, SparklineRender and DiagramRender", () => {
  test("a chart can be written to a file or returned inline", async () => {
    const inline = await run(chartRender, {
      type: "bar",
      categories: ["a", "b"],
      series: [{ name: "s", values: [1, 2] }],
    });
    expect(inline.svg.startsWith("<svg")).toBe(true);
    expect(inline.note).toMatch(/SVG only/);
    const written = await run(chartRender, {
      type: "bar",
      categories: ["a", "b"],
      series: [{ name: "s", values: [1, 2] }],
      path: "chart.svg",
    });
    expect(written.path).toBe("chart.svg");
    expect(readFileSync(path.join(tmp, "chart.svg"), "utf8")).toBe(inline.svg);
  });

  test("every chart type renders", async () => {
    const line = await run(chartRender, {
      type: "line",
      series: [
        {
          name: "s",
          points: [
            [0, 1],
            [1, 4],
          ],
        },
      ],
      xLabel: "t",
      yLabel: "v",
    });
    expect(line.svg).toContain("<polyline");
    const scatter = await run(chartRender, {
      type: "scatter",
      series: [{ name: "s", points: [[0, 1]] }],
    });
    expect(scatter.svg).toContain("<circle");
    const pie = await run(chartRender, { type: "pie", slices: [{ label: "x", value: 1 }] });
    expect(pie.svg).toContain("x (100%)");
  });

  test("a malformed chart spec is a readable refusal", async () => {
    expect(
      String(await run(chartRender, { type: "bar", series: [{ name: "s", values: [1] }] })),
    ).toMatch(/needs `categories`/);
  });

  test("sparklines come back as blocks or as SVG", async () => {
    const blocks = await run(sparklineRender, { values: [1, 5, 3, 9, 2] });
    expect(blocks.sparkline).toHaveLength(5);
    expect(blocks).toMatchObject({ count: 5, first: 1, last: 2, min: 1, max: 9 });
    const svg = await run(sparklineRender, { values: [1, 5, 3], format: "svg", markLast: true });
    expect(svg.svg).toContain("<polyline");
  });

  test("a diagram reports its layers and its back edges", async () => {
    const result = await run(diagramRender, {
      nodes: [{ id: "fetch" }, { id: "parse" }, { id: "store" }],
      edges: [
        { from: "fetch", to: "parse", label: "html" },
        { from: "parse", to: "store" },
        { from: "store", to: "fetch" },
      ],
      direction: "LR",
      title: "Pipeline",
      path: "flow.svg",
    });
    expect(result.layerCount).toBe(3);
    expect(result.backEdges).toEqual([{ from: "store", to: "fetch" }]);
    const svg = readFileSync(path.join(tmp, "flow.svg"), "utf8");
    expect(svg).toContain("Pipeline");
    expect(svg).toContain("stroke-dasharray");
  });

  test("a diagram edge to a node that does not exist is refused", async () => {
    expect(
      String(await run(diagramRender, { nodes: [{ id: "a" }], edges: [{ from: "a", to: "b" }] })),
    ).toMatch(/unknown node "b"/);
  });
});

describe("ColorConvert and ColorContrast", () => {
  test("every notation comes back in every other notation", async () => {
    const result = await run(colorConvert, {
      colors: ["#1a2b3c", "rgb(255,0,0)", "hsl(210, 50%, 40%)"],
    });
    expect(result.colors[0]).toMatchObject({
      hex: "#1a2b3c",
      rgb: { r: 26, g: 43, b: 60 },
      alpha: 1,
    });
    expect(result.colors[1].hslCss).toBe("hsl(0, 100%, 50%)");
    expect(result.colors[2].hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(result.keywords).toContain("teal");
  });

  test("an unreadable colour is reported per entry, not fatal for the batch", async () => {
    const result = await run(colorConvert, { colors: ["#fff", "not-a-colour"] });
    expect(result.colors[0].hex).toBe("#ffffff");
    expect(result.colors[1].error).toMatch(/is not a colour this package reads/);
  });

  test("contrast names the level each pair clears", async () => {
    const result = await run(colorContrast, {
      pairs: [
        { foreground: "#000", background: "#fff", label: "body" },
        { foreground: "#777777", background: "#ffffff", label: "muted" },
        { foreground: "#aaaaaa", background: "#ffffff" },
      ],
    });
    expect(result.pairs[0]).toMatchObject({ label: "body", ratio: 21, verdict: "AAA" });
    expect(result.pairs[1]).toMatchObject({ verdict: "AA-large-only", normalTextAA: false });
    expect(result.pairs[2].verdict).toBe("fail");
    expect(result.failingNormalText).toBe(2);
    expect(result.failingEverything).toBe(1);
    expect(result.standard).toMatch(/WCAG 2/);
  });
});

describe("SubtitleParse and SubtitleWrite", () => {
  test("SRT parses to cues with millisecond times", async () => {
    put("a.srt", SAMPLE_SRT);
    const result = await run(subtitleParse, { path: "a.srt" });
    expect(result).toMatchObject({ format: "srt", cueCount: 3, returned: 3, truncated: false });
    expect(result.cues[0]).toMatchObject({ startMs: 1000, endMs: 3500 });
    expect(result.totalCueDurationMs).toBe(2500 + 2000 + 1750);
  });

  test("WebVTT keeps ids and settings", async () => {
    put("a.vtt", SAMPLE_VTT);
    const result = await run(subtitleParse, { path: "a.vtt" });
    expect(result.format).toBe("vtt");
    expect(result.cues[0]).toMatchObject({ id: "intro", settings: "align:start position:10%" });
  });

  test("textOnly drops the timings", async () => {
    put("a.srt", SAMPLE_SRT);
    const result = await run(subtitleParse, { path: "a.srt", textOnly: true });
    expect(result.cues).toBeUndefined();
    expect(result.text).toContain("First line");
  });

  test("maxCues truncates and says so", async () => {
    put("a.srt", SAMPLE_SRT);
    const result = await run(subtitleParse, { path: "a.srt", maxCues: 1 });
    expect(result).toMatchObject({ cueCount: 3, returned: 1, truncated: true });
  });

  test("a shift round-trips through the writer and the parser", async () => {
    put("a.srt", SAMPLE_SRT);
    const parsed = await run(subtitleParse, { path: "a.srt" });
    const written = await run(subtitleWrite, {
      cues: parsed.cues,
      format: "vtt",
      path: "out.vtt",
      shiftMs: 1500,
      wrapColumns: 24,
    });
    expect(written).toMatchObject({ cueCount: 3, droppedBeforeZero: 0, shiftMs: 1500 });
    const again = await run(subtitleParse, { path: "out.vtt" });
    expect(again.format).toBe("vtt");
    expect(again.cues[0].startMs).toBe(2500);
    for (const cue of again.cues) {
      for (const line of (cue.text as string).split("\n"))
        expect(line.length).toBeLessThanOrEqual(24);
    }
  });

  test("a negative shift drops what falls before zero and counts it", async () => {
    put("a.srt", SAMPLE_SRT);
    const parsed = await run(subtitleParse, { path: "a.srt" });
    const written = await run(subtitleWrite, { cues: parsed.cues, format: "srt", shiftMs: -3000 });
    expect(written.droppedBeforeZero).toBe(1);
    expect(written.cueCount).toBe(2);
    expect(written.text.startsWith("1\n")).toBe(true);
  });

  test("a cue's text cannot smuggle a second cue into the document", async () => {
    for (const format of ["srt", "vtt"] as const) {
      const written = await run(subtitleWrite, {
        cues: [
          {
            startMs: 0,
            endMs: 1000,
            text: "hello\n\n00:00:09,000 --> 00:00:10,000\nINJECTED",
          },
        ],
        format,
        path: `x.${format}`,
      });
      expect(written.cueCount).toBe(1);
      const again = await run(subtitleParse, { path: `x.${format}` });
      // One cue in, one cue out — the injected timing line stayed text.
      expect({ format, cueCount: again.cueCount }).toEqual({ format, cueCount: 1 });
      expect(again.cues[0].endMs).toBe(1000);
      expect(again.cues[0].text).toContain("INJECTED");
    }
  });

  test("a WebVTT id, settings or header that would start a new block is refused", async () => {
    const base = { cues: [{ startMs: 0, endMs: 1000, text: "hi" }], format: "vtt" as const };
    expect(
      String(
        await run(subtitleWrite, {
          ...base,
          cues: [{ ...base.cues[0], id: "a\n00:00:09.000 --> 00:00:10.000\nX" }],
        }),
      ),
    ).toMatch(/id contains a line break/);
    expect(
      String(
        await run(subtitleWrite, { ...base, cues: [{ ...base.cues[0], settings: "a --> b" }] }),
      ),
    ).toMatch(/settings contains "-->"/);
    expect(
      String(
        await run(subtitleWrite, { ...base, header: "x\n\n00:00:09.000 --> 00:00:10.000\nH" }),
      ),
    ).toMatch(/header contains a line break/);
  });

  test("a cue that ends before it starts is refused", async () => {
    expect(
      String(
        await run(subtitleWrite, {
          cues: [{ startMs: 500, endMs: 100, text: "x" }],
          format: "srt",
        }),
      ),
    ).toMatch(/ends at 100ms, before its start/);
  });
});

describe("MediaProbe", () => {
  test("returns structured streams when ffprobe is on PATH", async () => {
    process.env["PATH"] = `${binDir}:${originalPath}`;
    put("clip.mp4", new Uint8Array(32));
    const result = await run(mediaProbe, { path: "clip.mp4" });
    expect(result).toMatchObject({ path: "clip.mp4", streamCount: 2, durationSeconds: 12.032 });
    expect(result.streams[0]).toMatchObject({ type: "video", codec: "h264", width: 1920 });
    expect(result.note).toMatch(/reported by the ffprobe on this machine/);
    // The absolute path ffprobe echoed back never reaches the caller.
    expect(JSON.stringify(result)).not.toContain("/somewhere/private");
  });

  test("says plainly when ffprobe is not installed", async () => {
    const empty = path.join(tmp, "emptybin");
    mkdirSync(empty);
    process.env["PATH"] = empty;
    put("clip.mp4", new Uint8Array(8));
    const result = await run(mediaProbe, { path: "clip.mp4" });
    expect(String(result)).toMatch(/ffprobe is not installed on this machine/);
    expect(String(result)).toContain("clip.mp4");
  });

  test("a slow ffprobe is killed at the deadline", async () => {
    process.env["PATH"] = `${binDir}:${originalPath}`;
    process.env["CREWHAUS_FFPROBE_SLOW"] = "1";
    put("clip.mp4", new Uint8Array(8));
    try {
      const result = await run(mediaProbe, { path: "clip.mp4", timeout: 1000 });
      expect(String(result)).toMatch(/killed for exceeding its timeout/);
    } finally {
      process.env["CREWHAUS_FFPROBE_SLOW"] = "";
    }
  }, 15_000);

  test("a directory is refused before anything is spawned", async () => {
    process.env["PATH"] = `${binDir}:${originalPath}`;
    mkdirSync(path.join(tmp, "media"));
    expect(String(await run(mediaProbe, { path: "media" }))).toMatch(/is a directory, not a file/);
  });
});
