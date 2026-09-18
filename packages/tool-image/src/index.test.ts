import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

describe("T8 — dangling-symlink containment", () => {
  // The sibling block above plants links whose targets EXIST, which
  // `realpathSync` resolves on its own. These plant links whose targets do
  // NOT exist — the case that used to slip past, because the containment
  // walk probed with `existsSync`, which follows the link and so answers
  // false for a dangling one. The link's name then landed in the
  // "missing tail" that is re-appended to the workspace root verbatim, and
  // an out-of-root target was pronounced contained.
  //
  // `ReadImage` is read-only and opens with O_NOFOLLOW, so before the fix
  // these paths failed anyway — with ELOOP ("path is a symlink") or ENOENT
  // ("file not found"), incidental errors that say nothing about the
  // boundary. These tests pin the refusal to the CONTAINMENT check, which is
  // what the next tool added to this package will rely on.

  test("a dangling symlink pointing outside the workspace is refused", async () => {
    const outside = mkdtempSync(join(tmpdir(), "tool-image-outside-"));
    try {
      const target = join(outside, "never-made.png");
      const link = join(tmp, "dangling.png");
      symlinkSync(target, link);
      await expect(readImage.execute({ path: "dangling.png" })).rejects.toThrow(
        /escapes the workspace root/,
      );
      // Nothing was created out there, and the link itself is untouched — a
      // read-only tool should leave the filesystem exactly as it found it.
      expect(existsSync(target)).toBe(false);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a dangling symlinked DIRECTORY pointing outside is refused", async () => {
    // The link need not be the leaf: one standing in for a directory that
    // does not exist yet is walked past the same way, taking every component
    // after it out of the workspace too.
    const outside = mkdtempSync(join(tmpdir(), "tool-image-outside-"));
    try {
      const missing = join(outside, "never-made-dir");
      symlinkSync(missing, join(tmp, "dlink"));
      await expect(readImage.execute({ path: "dlink/secret.png" })).rejects.toThrow(
        /escapes the workspace root/,
      );
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a dangling symlink that stays inside the workspace is still honoured", async () => {
    // The mirror of the two above: refusing every dangling link would also
    // "pass" them, so check that an in-workspace one is not swept up.
    //
    // The target is written in tmpdir()'s UNRESOLVED form on purpose. On
    // macOS that is /var/folders/..., behind the /private/var symlink, while
    // `tmp` (and so the workspace root) is the realpath'd form. This is the
    // case that catches the tempting wrong fix — reading the link with
    // `readlinkSync` and returning that raw target instead of RESOLVING it:
    // /var/... does not sit under a /private/var/... root, so a link that is
    // in fact perfectly in-bounds would be refused as an escape.
    const unresolvedRoot = join(tmpdir(), basename(tmp));
    expect(realpathSync(unresolvedRoot)).toBe(tmp);
    mkdirSync(join(tmp, "sub"));
    const realTarget = join(tmp, "sub", "made.png");
    symlinkSync(join(unresolvedRoot, "sub", "made.png"), join(tmp, "inside.png"));

    // While the target is missing the read still fails — it has nothing to
    // open — but as an ordinary not-found, never as a containment refusal.
    const rejection: unknown = await readImage.execute({ path: "inside.png" }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(rejection).toBeInstanceOf(ToolPermissionError);
    const message = rejection instanceof Error ? rejection.message : "";
    expect(message).not.toMatch(/escapes the workspace root/);
    expect(message).toMatch(/file not found/);

    // And once the target exists, the same link reads THROUGH to it.
    writeFileSync(realTarget, TINY_PNG);
    const result = await readImage.execute({ path: "inside.png" });
    if (typeof result === "string") throw new Error("expected content array");
    const block = result[0];
    if (block?.type !== "image") throw new Error("expected image block");
    expect(block.source.media_type).toBe("image/png");
    expect(Buffer.from(block.source.data, "base64").equals(TINY_PNG)).toBe(true);
    expect(lstatSync(join(tmp, "inside.png")).isSymbolicLink()).toBe(true);
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

// Regression — a RELATIVE symlink target must be resolved against the
// directory that actually CONTAINS the link, not the link's lexical parent.
// The two differ exactly when that parent is itself reached through a
// symlink, and following one `readlink` hop is what first makes the
// difference reachable: the leaf now stays in the RESOLVED part of the path,
// so measuring it from the wrong directory names a location the caller's
// path does not lead to.
describe("T8 — relative dangling-link base", () => {
  test("an outward directory link holding a relative dangling link is refused", async () => {
    const outside = mkdtempSync(join(tmpdir(), "tool-image-outside-"));
    try {
      mkdirSync(join(outside, "realdir"));
      symlinkSync(join(outside, "realdir"), join(tmp, "pdir"));
      // True destination <outside>/secret.png; lexically it reads as the
      // in-root <tmp>/secret.png.
      symlinkSync("../secret.png", join(outside, "realdir", "l"));
      await expect(readImage.execute({ path: "pdir/l" })).rejects.toThrow(
        /escapes the workspace root/,
      );
      expect(existsSync(join(outside, "secret.png"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
