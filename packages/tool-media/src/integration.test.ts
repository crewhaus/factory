/**
 * The tools driven the way the runtime drives them: registered in a
 * catalog, dispatched through `executeTool`, which validates the input
 * against the declared schema and checks the permission patterns before
 * calling execute.
 *
 * A tool that works when called directly but fails here is a tool the
 * runtime cannot actually use, which is why this file exists separately.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { auditToolScopes } from "@crewhaus/tool-builder";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { SAMPLE_FFPROBE_JSON, SAMPLE_SRT, rgbaSamples, sampleJpeg } from "./fixtures";
import { MEDIA_TOOLS } from "./index";
import { encodePng } from "./lib/png";

let catalog: ToolCatalog;
const originalCwd = process.cwd();
const originalPath = process.env["PATH"] ?? "";
let tmp: string;
let binDir: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), "crewhaus-media-int-bin-"));
  writeFileSync(
    path.join(binDir, "ffprobe"),
    `#!/bin/sh\ncat <<'JSON'\n${SAMPLE_FFPROBE_JSON}\nJSON\n`,
  );
  chmodSync(path.join(binDir, "ffprobe"), 0o755);
});

afterAll(() => {
  process.env["PATH"] = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of MEDIA_TOOLS) catalog.register(tool);
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-media-int-"));
  process.chdir(tmp);
  process.env["PATH"] = `${binDir}:${originalPath}`;
  const put = (name: string, data: Uint8Array | string): void => {
    writeFileSync(path.join(tmp, name), data);
  };
  const pixels = rgbaSamples(24, 18, (x, y) =>
    x >= 5 && x < 11 && y >= 4 && y < 10
      ? [220, 30, 30, 255]
      : [(x * 9) % 256, (y * 13) % 256, 80, 255],
  );
  put("a.png", encodePng({ width: 24, height: 18, data: pixels }));
  put("b.png", encodePng({ width: 24, height: 18, data: pixels }));
  put(
    "photo.jpg",
    sampleJpeg({
      width: 600,
      height: 400,
      exif: { make: "Acme", model: "Field 900", latitude: 48.8584, longitude: 2.2945 },
      comment: "private",
    }),
  );
  put("a.srt", SAMPLE_SRT);
  put("clip.mp4", new Uint8Array(64));
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env["PATH"] = originalPath;
  rmSync(tmp, { recursive: true, force: true });
});

const RED_PIXEL = Buffer.from([220, 30, 30, 255]).toString("base64");

/** One schema-valid call per tool, used by several tests below. */
const CALLS: Record<string, unknown> = {
  BarcodeEncode: { symbology: "ean13", value: "400638133393", path: "ean.png" },
  ChartRender: {
    type: "bar",
    categories: ["a", "b"],
    series: [{ name: "s", values: [1, 2] }],
    path: "chart.svg",
  },
  ColorContrast: { pairs: [{ foreground: "#000", background: "#fff" }] },
  ColorConvert: { colors: ["#1a2b3c"] },
  DiagramRender: {
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ from: "a", to: "b" }],
    path: "d.svg",
  },
  ExifRead: { path: "photo.jpg" },
  ExifStrip: { path: "photo.jpg", output: "clean.jpg" },
  ImageCrop: { path: "a.png", output: "crop.png", x: 2, y: 2, width: 6, height: 6 },
  ImageDiff: { a: "a.png", b: "b.png" },
  ImageInfo: { path: "a.png" },
  ImageKind: { path: "a.png" },
  ImageResize: { path: "a.png", output: "small.png", width: 8 },
  MediaProbe: { path: "clip.mp4" },
  PngRead: { path: "a.png", statsOnly: true },
  PngWrite: { path: "dot.png", width: 1, height: 1, pixels: RED_PIXEL },
  QrEncode: { text: "https://crewhaus.ai", path: "qr.png" },
  SparklineRender: { values: [1, 2, 3] },
  SubtitleParse: { path: "a.srt" },
  SubtitleWrite: { cues: [{ startMs: 0, endMs: 1000, text: "hi" }], format: "vtt" },
};

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(MEDIA_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of MEDIA_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });

  test("registering the same tool twice is refused, as a collision would be", () => {
    expect(() => catalog.register(MEDIA_TOOLS[0] as RegisteredTool)).toThrow();
  });

  test("the scope audit finds nothing to complain about", () => {
    // The gate `crewhaus compile --strict` runs: any tool that declares an
    // io capability must also be scoped external.
    expect(auditToolScopes(MEDIA_TOOLS)).toEqual([]);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(lookup("ImageInfo"), { path: "a.png" }, { toolUseId: "t1" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"width":24');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("ImageInfo"), { path: 42 }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ImageInfo");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("ImageCrop"), { path: "a.png" }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("ImageInfo"),
      { path: "a.png" },
      { toolUseId: "t4", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("ImageInfo"),
      { path: "a.png" },
      { toolUseId: "t5", allowedPatterns: ["ImageInfo"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("a path outside the workspace comes back as a result, not an exception", async () => {
    const result = await executeTool(
      lookup("ImageInfo"),
      { path: "../../etc/hosts" },
      { toolUseId: "t6" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("escapes the workspace root");
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    // Every registered tool must appear above; a new tool with no call here
    // would otherwise go unexercised.
    expect(Object.keys(CALLS).sort()).toEqual(MEDIA_TOOLS.map((tool) => tool.name).sort());
    for (const tool of MEDIA_TOOLS) {
      const result = await executeTool(tool, CALLS[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
      // A readable refusal is still a failure for a call that should work.
      expect({
        name: tool.name,
        refused: /^(no such file|that path|"|ffprobe is not)/.test(result.content),
      }).toEqual({ name: tool.name, refused: false });
    }
  });

  test("every tool's input schema rejects an empty object or accepts it on purpose", async () => {
    // Nothing should ever crash on `{}`: either the schema refuses it or the
    // tool has no required input.
    for (const tool of MEDIA_TOOLS) {
      const result = await executeTool(tool, {}, { toolUseId: `e-${tool.name}` });
      if (!result.isError) expect(typeof result.content).toBe("string");
    }
  });

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    for (const name of ["ImageInfo", "ColorConvert", "SparklineRender", "SubtitleParse"]) {
      const a = await executeTool(lookup(name), CALLS[name], { toolUseId: `d1-${name}` });
      const b = await executeTool(lookup(name), CALLS[name], { toolUseId: `d2-${name}` });
      expect(a.content).toBe(b.content);
    }
  });
});

describe("tools composed the way a harness would compose them", () => {
  test("write pixels, read the header, resize, then diff the two", async () => {
    const pixels = Buffer.from(rgbaSamples(12, 12, (x, y) => [x * 20, y * 20, 128, 255])).toString(
      "base64",
    );
    const written = await executeTool(
      lookup("PngWrite"),
      { path: "made.png", width: 12, height: 12, pixels },
      { toolUseId: "c1" },
    );
    expect(written.isError).toBe(false);

    const info = JSON.parse(
      (await executeTool(lookup("ImageInfo"), { path: "made.png" }, { toolUseId: "c2" })).content,
    );
    expect(info).toMatchObject({ width: 12, height: 12, format: "png" });

    await executeTool(
      lookup("ImageResize"),
      { path: "made.png", output: "half.png", width: 6 },
      { toolUseId: "c3" },
    );
    const diff = JSON.parse(
      (
        await executeTool(
          lookup("ImageDiff"),
          { a: "made.png", b: "half.png" },
          { toolUseId: "c4" },
        )
      ).content,
    );
    expect(diff.sizeMismatch).toEqual({
      a: { width: 12, height: 12 },
      b: { width: 6, height: 6 },
    });
  });

  test("read a photograph's GPS, strip it, and confirm it is gone", async () => {
    const before = JSON.parse(
      (await executeTool(lookup("ExifRead"), { path: "photo.jpg" }, { toolUseId: "g1" })).content,
    );
    expect(before.hasGps).toBe(true);
    expect(before.gps.latitude).toBeCloseTo(48.8584, 4);

    await executeTool(
      lookup("ExifStrip"),
      { path: "photo.jpg", output: "safe.jpg" },
      { toolUseId: "g2" },
    );
    const after = JSON.parse(
      (await executeTool(lookup("ExifRead"), { path: "safe.jpg" }, { toolUseId: "g3" })).content,
    );
    expect(after.hasGps).toBe(false);
    expect(after.hasExif).toBe(false);
    // And the picture is untouched.
    const info = JSON.parse(
      (await executeTool(lookup("ImageInfo"), { path: "safe.jpg" }, { toolUseId: "g4" })).content,
    );
    expect(info).toMatchObject({ width: 600, height: 400, format: "jpeg" });
  });

  test("a QR code written as a PNG is readable back as pixels", async () => {
    await executeTool(
      lookup("QrEncode"),
      { text: "round trip", path: "q.png", scale: 1, quietZone: 0 },
      { toolUseId: "q1" },
    );
    const info = JSON.parse(
      (await executeTool(lookup("ImageInfo"), { path: "q.png" }, { toolUseId: "q2" })).content,
    );
    expect(info.width).toBe(21); // version 1 at one pixel per module
    const read = JSON.parse(
      (
        await executeTool(
          lookup("PngRead"),
          { path: "q.png", region: { x: 0, y: 0, width: 7, height: 1 } },
          { toolUseId: "q3" },
        )
      ).content,
    );
    // The top-left finder's first row is seven dark modules.
    expect([...Buffer.from(read.pixels as string, "base64")].filter((_, i) => i % 4 === 0)).toEqual(
      [0, 0, 0, 0, 0, 0, 0],
    );
  });

  test("subtitles parse, shift and write back through the runtime", async () => {
    const parsed = JSON.parse(
      (await executeTool(lookup("SubtitleParse"), { path: "a.srt" }, { toolUseId: "s1" })).content,
    );
    expect(parsed.cueCount).toBe(3);
    const written = await executeTool(
      lookup("SubtitleWrite"),
      { cues: parsed.cues, format: "vtt", path: "out.vtt", shiftMs: 500 },
      { toolUseId: "s2" },
    );
    expect(written.isError).toBe(false);
    const again = JSON.parse(
      (await executeTool(lookup("SubtitleParse"), { path: "out.vtt" }, { toolUseId: "s3" }))
        .content,
    );
    expect(again.format).toBe("vtt");
    expect(again.cues[0].startMs).toBe(1500);
  });

  test("the probe reaches ffprobe and comes back structured", async () => {
    const result = await executeTool(
      lookup("MediaProbe"),
      { path: "clip.mp4" },
      { toolUseId: "p1" },
    );
    expect(result.isError).toBe(false);
    const probe = JSON.parse(result.content);
    expect(probe.streams.map((s: { type: string }) => s.type)).toEqual(["video", "audio"]);
  });

  test("a chart and a diagram both land on disk as SVG", async () => {
    for (const name of ["ChartRender", "DiagramRender"]) {
      const result = await executeTool(lookup(name), CALLS[name], { toolUseId: `v-${name}` });
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.format).toBe("svg");
      expect(parsed.path).toMatch(/\.svg$/);
    }
  });
});
