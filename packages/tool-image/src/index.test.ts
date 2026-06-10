import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolPermissionError, detectMediaType, readImage } from "./index";

// 1×1 transparent PNG — minimal valid PNG. Hand-encoded to avoid pulling in
// a generator dep just for tests.
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const TINY_JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const TINY_GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const TINY_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
]);
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

let tmp: string;
let originalCwd: string;
beforeEach(() => {
  originalCwd = process.cwd();
  // realpath so symlink-containment assertions hold on macOS, where
  // tmpdir() lives behind the /var → /private/var symlink.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "tool-image-")));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("ReadImage — registered tool metadata", () => {
  test("name + flags", () => {
    expect(readImage.name).toBe("ReadImage");
    expect(readImage.readOnly).toBe(true);
    expect(readImage.destructive).toBe(false);
    expect(readImage.concurrencySafe).toBe(false);
  });
});

describe("detectMediaType — magic bytes", () => {
  test("recognises PNG", () => {
    expect(detectMediaType(new Uint8Array(TINY_PNG))).toBe("image/png");
  });
  test("recognises JPEG", () => {
    expect(detectMediaType(new Uint8Array(TINY_JPEG_HEADER))).toBe("image/jpeg");
  });
  test("recognises GIF", () => {
    expect(detectMediaType(new Uint8Array(TINY_GIF))).toBe("image/gif");
  });
  test("recognises WebP", () => {
    expect(detectMediaType(new Uint8Array(TINY_WEBP))).toBe("image/webp");
  });
  test("returns null for an unknown signature", () => {
    expect(detectMediaType(new Uint8Array(PDF_MAGIC))).toBeNull();
  });
  test("returns null for too-short input", () => {
    expect(detectMediaType(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("ReadImage — happy path", () => {
  test("returns an Anthropic image content block for a PNG", async () => {
    writeFileSync(join(tmp, "tiny.png"), TINY_PNG);
    const result = await readImage.execute({ path: "./tiny.png" });
    expect(Array.isArray(result)).toBe(true);
    if (typeof result === "string") throw new Error("expected content array");
    expect(result.length).toBe(1);
    const block = result[0];
    if (block?.type !== "image") throw new Error("expected image block");
    expect(block.source.type).toBe("base64");
    expect(block.source.media_type).toBe("image/png");
    // base64 round-trips back to the original bytes.
    expect(Buffer.from(block.source.data, "base64").equals(TINY_PNG)).toBe(true);
  });

  test("works without leading ./", async () => {
    writeFileSync(join(tmp, "tiny.png"), TINY_PNG);
    const result = await readImage.execute({ path: "tiny.png" });
    if (typeof result === "string") throw new Error("expected content array");
    const block = result[0];
    if (block?.type !== "image") throw new Error("expected image block");
    expect(block.source.media_type).toBe("image/png");
  });
});

describe("T8 — path traversal", () => {
  test("rejects ../../etc/passwd", async () => {
    await expect(readImage.execute({ path: "../../etc/passwd" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  test("rejects an absolute path outside cwd", async () => {
    await expect(readImage.execute({ path: "/etc/passwd" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  test("rejects a path that resolves outside cwd via ..", async () => {
    await expect(readImage.execute({ path: "subdir/../../escape.png" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });
});

describe("T8 — symlink containment (#149)", () => {
  test("rejects an in-root symlink to an out-of-root image", async () => {
    const outside = mkdtempSync(join(tmpdir(), "tool-image-outside-"));
    try {
      writeFileSync(join(outside, "secret.png"), TINY_PNG);
      symlinkSync(join(outside, "secret.png"), join(tmp, "link.png"));
      await expect(readImage.execute({ path: "link.png" })).rejects.toBeInstanceOf(
        ToolPermissionError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects an in-root symlinked directory whose target is outside", async () => {
    const outside = mkdtempSync(join(tmpdir(), "tool-image-outside-"));
    try {
      writeFileSync(join(outside, "secret.png"), TINY_PNG);
      symlinkSync(outside, join(tmp, "escape"));
      await expect(readImage.execute({ path: "escape/secret.png" })).rejects.toBeInstanceOf(
        ToolPermissionError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("an in-root symlink to an in-root image still works (no over-blocking)", async () => {
    writeFileSync(join(tmp, "real.png"), TINY_PNG);
    symlinkSync(join(tmp, "real.png"), join(tmp, "good-link.png"));
    const result = await readImage.execute({ path: "good-link.png" });
    if (typeof result === "string") throw new Error("expected content array");
    const block = result[0];
    if (block?.type !== "image") throw new Error("expected image block");
    expect(block.source.media_type).toBe("image/png");
  });
});

describe("T8 — magic-byte spoof", () => {
  test("rejects a PDF renamed to .png", async () => {
    writeFileSync(join(tmp, "evil.png"), PDF_MAGIC);
    await expect(readImage.execute({ path: "./evil.png" })).rejects.toThrow(
      /unrecognized image format/,
    );
  });

  test("rejects a tiny text file with a .jpg extension", async () => {
    writeFileSync(join(tmp, "fake.jpg"), Buffer.from("hello world"));
    await expect(readImage.execute({ path: "./fake.jpg" })).rejects.toThrow(
      /unrecognized image format/,
    );
  });
});

describe("T8 — oversize cap", () => {
  test("rejects a file over 5 MB", async () => {
    // Build a "PNG" larger than 5 MB by padding the valid header with zero bytes.
    // Magic-bytes check happens AFTER the size check, so this test specifically
    // exercises the size cap.
    const big = Buffer.alloc(6 * 1024 * 1024);
    TINY_PNG.copy(big, 0);
    writeFileSync(join(tmp, "huge.png"), big);
    await expect(readImage.execute({ path: "./huge.png" })).rejects.toThrow(/exceeds/);
  });
});

describe("T8 — missing file", () => {
  test("rejects a path that does not exist", async () => {
    await expect(readImage.execute({ path: "./nope.png" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });
});
