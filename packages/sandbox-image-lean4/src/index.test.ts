import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSandbox } from "@crewhaus/sandbox";
import {
  ImageRegistrationError,
  _resetSandboxImageRegistry,
  hasSandboxImage,
  listAllowedImageRefs,
  lookupSandboxImage,
  registerSandboxImage,
} from "@crewhaus/sandbox-image-registry";
import {
  LEAN4_COLD_START_BUDGET_MS,
  LEAN4_DEFAULT_ENTRYPOINT,
  LEAN4_HEALTHCHECK_ARGV,
  LEAN4_IMAGE_ID,
  LEAN4_IMAGE_REF,
  LEAN4_IMAGE_REPO,
  LEAN4_IMAGE_TAG,
  LEAN4_TOOLCHAIN_VERSION,
  ensureLean4SandboxImage,
  registerLean4SandboxImage,
} from "./index";

const LIVE = process.env["CREWHAUS_SECTION36_LIVE_DOCKER"] === "1";

describe("registerLean4SandboxImage (T1 + T2)", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("constants pin the release-built image", () => {
    expect(LEAN4_IMAGE_ID).toBe("lean4");
    expect(LEAN4_IMAGE_REPO).toBe("ghcr.io/crewhaus/sandbox-lean4");
    expect(LEAN4_IMAGE_TAG).toBe("0.8.0");
    expect(LEAN4_IMAGE_REF).toBe("ghcr.io/crewhaus/sandbox-lean4:0.8.0");
    expect(LEAN4_DEFAULT_ENTRYPOINT).toEqual(["lean", "--stdin", "--json"]);
    expect(LEAN4_HEALTHCHECK_ARGV).toEqual(["lean", "--version"]);
    // The toolchain the image carries; the Dockerfile test holds its ARG to this.
    expect(LEAN4_TOOLCHAIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("registerLean4SandboxImage() registers an image with the right shape", () => {
    const entry = registerLean4SandboxImage();
    expect(entry.id).toBe("lean4");
    expect(entry.image).toBe(LEAN4_IMAGE_REF);
    expect(entry.defaultEntrypoint).toEqual(["lean", "--stdin", "--json"]);
    expect(entry.healthcheck.command).toEqual(["lean", "--version"]);
    expect(entry.healthcheck.expectedExitCode).toBe(0);
    expect(entry.healthcheck.timeoutMs).toBe(LEAN4_COLD_START_BUDGET_MS);
    expect(entry.description).toMatch(/Lean 4 \(Mathlib-free\)/);
  });

  test("lookupSandboxImage('lean4') returns the registered entry", () => {
    registerLean4SandboxImage();
    expect(hasSandboxImage("lean4")).toBe(true);
    expect(lookupSandboxImage("lean4").image).toBe(LEAN4_IMAGE_REF);
  });

  test("listAllowedImageRefs includes the image after registration — how it joins the sandbox allowlist", () => {
    expect(listAllowedImageRefs()).not.toContain(LEAN4_IMAGE_REF);
    registerLean4SandboxImage();
    const refs = listAllowedImageRefs();
    expect(refs).toContain(LEAN4_IMAGE_REF);
    // Bootstrap trio still present
    expect(refs).toContain("python:3.13-slim");
    expect(refs).toContain("node:22-alpine");
  });

  test("ensureLean4SandboxImage() registers once and is idempotent after", () => {
    const first = ensureLean4SandboxImage();
    const second = ensureLean4SandboxImage();
    expect(second).toEqual(first);
    expect(listAllowedImageRefs().filter((r) => r === LEAN4_IMAGE_REF)).toHaveLength(1);
  });
});

describe("Lean4-shape T2 contract — round-trip via noop sandbox", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("noop sandbox accepts the lean4 image when registered", async () => {
    registerLean4SandboxImage();
    const sandbox = createSandbox({ backend: "noop", allowedImages: listAllowedImageRefs() });
    // The noop backend spawns the argv directly — `printf` is universal, so it
    // asserts the wiring without a Lean install on the test host.
    const result = await sandbox.exec({
      image: LEAN4_IMAGE_REF,
      argv: ["printf", "hello-from-lean4"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-from-lean4");
    await sandbox.close();
  });

  test("noop sandbox refuses the lean4 image when NOT registered", async () => {
    const trioRefs = ["python:3.13-slim", "node:22-alpine", "alpine:3.19"];
    const sandbox = createSandbox({ backend: "noop", allowedImages: trioRefs });
    await expect(sandbox.exec({ image: LEAN4_IMAGE_REF, argv: ["printf", "x"] })).rejects.toThrow(
      /not on the allowlist/,
    );
    await sandbox.close();
  });

  test.skipIf(!LIVE)(
    "live docker: the healthcheck passes against the real image",
    async () => {
      registerLean4SandboxImage();
      const sandbox = createSandbox({ backend: "docker", allowedImages: listAllowedImageRefs() });
      const result = await sandbox.exec({
        image: LEAN4_IMAGE_REF,
        argv: [...LEAN4_HEALTHCHECK_ARGV],
        timeoutMs: 120_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`version ${LEAN4_TOOLCHAIN_VERSION},`);
      await sandbox.close();
    },
    180_000,
  );
});

describe("Lean4-shape T7 — cold-start budget", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("healthcheck timeoutMs is within the large-toolchain budget (≤4s)", () => {
    const entry = registerLean4SandboxImage();
    expect(entry.healthcheck.timeoutMs).toBeLessThanOrEqual(4_000);
    expect(entry.healthcheck.timeoutMs).toBeGreaterThan(0);
  });
});

describe("Lean4-shape T8 — escape-attempt suite (reuses §18 corpus shape)", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("Lean4 image registration is idempotent-then-rejected (no silent override)", () => {
    registerLean4SandboxImage();
    expect(() => registerLean4SandboxImage()).toThrow(/already registered/);
  });

  test("Lean4 entry's image string passes registry validation (no leading dash)", () => {
    expect(LEAN4_IMAGE_REF.startsWith("-")).toBe(false);
  });

  test("Lean4 entry's image string contains no whitespace / newline", () => {
    expect(/\s/.test(LEAN4_IMAGE_REF)).toBe(false);
    expect(LEAN4_IMAGE_REF.includes("\n")).toBe(false);
  });

  test("Lean4 entry's defaultEntrypoint contains no shell-meta sequences", () => {
    for (const arg of LEAN4_DEFAULT_ENTRYPOINT) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("Lean4 entry's healthcheck argv contains no shell-meta sequences", () => {
    for (const arg of LEAN4_HEALTHCHECK_ARGV) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("attempted CLI-flag-injection registration via the lean4 id is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "lean4",
        image: "--privileged",
        defaultEntrypoint: [...LEAN4_DEFAULT_ENTRYPOINT],
        healthcheck: { command: [...LEAN4_HEALTHCHECK_ARGV], expectedExitCode: 0 },
      }),
    ).toThrow(ImageRegistrationError);
  });

  test("attempted whitespace-tampered lean4 image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "lean4",
        image: `${LEAN4_IMAGE_REF} --privileged`,
        defaultEntrypoint: [...LEAN4_DEFAULT_ENTRYPOINT],
        healthcheck: { command: [...LEAN4_HEALTHCHECK_ARGV], expectedExitCode: 0 },
      }),
    ).toThrow(/whitespace/);
  });

  test("attempted shell-meta-tagged lean4 image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "lean4",
        image: "ghcr.io/crewhaus/sandbox-lean4:$(id)",
        defaultEntrypoint: [...LEAN4_DEFAULT_ENTRYPOINT],
        healthcheck: { command: [...LEAN4_HEALTHCHECK_ARGV], expectedExitCode: 0 },
      }),
    ).toThrow(/valid registry/);
  });
});
