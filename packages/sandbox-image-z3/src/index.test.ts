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
  Z3_COLD_START_BUDGET_MS,
  Z3_DEFAULT_ENTRYPOINT,
  Z3_HEALTHCHECK_ARGV,
  Z3_IMAGE_ID,
  Z3_IMAGE_REF,
  Z3_IMAGE_REPO,
  Z3_IMAGE_TAG,
  Z3_SOLVER_VERSION,
  ensureZ3SandboxImage,
  registerZ3SandboxImage,
} from "./index";

const LIVE = process.env["CREWHAUS_SECTION36_LIVE_DOCKER"] === "1";

describe("registerZ3SandboxImage (T1 + T2)", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("constants pin the release-built image", () => {
    expect(Z3_IMAGE_ID).toBe("z3");
    expect(Z3_IMAGE_REPO).toBe("ghcr.io/crewhaus/sandbox-z3");
    expect(Z3_IMAGE_TAG).toBe("0.8.0");
    expect(Z3_IMAGE_REF).toBe("ghcr.io/crewhaus/sandbox-z3:0.8.0");
    expect(Z3_DEFAULT_ENTRYPOINT).toEqual(["z3", "-in"]);
    expect(Z3_HEALTHCHECK_ARGV).toEqual(["z3", "--version"]);
    // The solver the image carries; the Dockerfile test holds its ARG to this.
    expect(Z3_SOLVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("registerZ3SandboxImage() registers an image with the right shape", () => {
    const entry = registerZ3SandboxImage();
    expect(entry.id).toBe("z3");
    expect(entry.image).toBe(Z3_IMAGE_REF);
    expect(entry.defaultEntrypoint).toEqual(["z3", "-in"]);
    expect(entry.healthcheck.command).toEqual(["z3", "--version"]);
    expect(entry.healthcheck.expectedExitCode).toBe(0);
    expect(entry.healthcheck.timeoutMs).toBe(Z3_COLD_START_BUDGET_MS);
    expect(entry.description).toMatch(/Z3 SMT solver/);
  });

  test("lookupSandboxImage('z3') returns the registered entry", () => {
    registerZ3SandboxImage();
    expect(hasSandboxImage("z3")).toBe(true);
    expect(lookupSandboxImage("z3").image).toBe(Z3_IMAGE_REF);
  });

  test("listAllowedImageRefs includes the image after registration — how it joins the sandbox allowlist", () => {
    expect(listAllowedImageRefs()).not.toContain(Z3_IMAGE_REF);
    registerZ3SandboxImage();
    const refs = listAllowedImageRefs();
    expect(refs).toContain(Z3_IMAGE_REF);
    // Bootstrap trio still present
    expect(refs).toContain("python:3.13-slim");
    expect(refs).toContain("node:22-alpine");
  });

  test("ensureZ3SandboxImage() registers once and is idempotent after", () => {
    const first = ensureZ3SandboxImage();
    const second = ensureZ3SandboxImage();
    expect(second).toEqual(first);
    expect(listAllowedImageRefs().filter((r) => r === Z3_IMAGE_REF)).toHaveLength(1);
  });
});

describe("Z3-shape T2 contract — round-trip via noop sandbox", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("noop sandbox accepts the z3 image when registered", async () => {
    registerZ3SandboxImage();
    const sandbox = createSandbox({ backend: "noop", allowedImages: listAllowedImageRefs() });
    // The noop backend spawns the argv directly — `printf` is universal, so it
    // asserts the wiring without a Z3 install on the test host.
    const result = await sandbox.exec({ image: Z3_IMAGE_REF, argv: ["printf", "hello-from-z3"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-from-z3");
    await sandbox.close();
  });

  test("noop sandbox refuses the z3 image when NOT registered", async () => {
    const trioRefs = ["python:3.13-slim", "node:22-alpine", "alpine:3.19"];
    const sandbox = createSandbox({ backend: "noop", allowedImages: trioRefs });
    await expect(sandbox.exec({ image: Z3_IMAGE_REF, argv: ["printf", "x"] })).rejects.toThrow(
      /not on the allowlist/,
    );
    await sandbox.close();
  });

  test.skipIf(!LIVE)(
    "live docker: the healthcheck passes against the real image",
    async () => {
      registerZ3SandboxImage();
      const sandbox = createSandbox({ backend: "docker", allowedImages: listAllowedImageRefs() });
      const result = await sandbox.exec({
        image: Z3_IMAGE_REF,
        argv: [...Z3_HEALTHCHECK_ARGV],
        timeoutMs: 120_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Z3 version ${Z3_SOLVER_VERSION} `);
      await sandbox.close();
    },
    180_000,
  );
});

describe("Z3-shape T7 — cold-start budget", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("healthcheck timeoutMs is within the native-binary budget (≤2s)", () => {
    const entry = registerZ3SandboxImage();
    expect(entry.healthcheck.timeoutMs).toBeLessThanOrEqual(2_000);
    expect(entry.healthcheck.timeoutMs).toBeGreaterThan(0);
  });
});

describe("Z3-shape T8 — escape-attempt suite (reuses §18 corpus shape)", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("Z3 image registration is idempotent-then-rejected (no silent override)", () => {
    registerZ3SandboxImage();
    expect(() => registerZ3SandboxImage()).toThrow(/already registered/);
  });

  test("Z3 entry's image string passes registry validation (no leading dash)", () => {
    expect(Z3_IMAGE_REF.startsWith("-")).toBe(false);
  });

  test("Z3 entry's image string contains no whitespace / newline", () => {
    expect(/\s/.test(Z3_IMAGE_REF)).toBe(false);
    expect(Z3_IMAGE_REF.includes("\n")).toBe(false);
  });

  test("Z3 entry's defaultEntrypoint contains no shell-meta sequences", () => {
    for (const arg of Z3_DEFAULT_ENTRYPOINT) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("Z3 entry's healthcheck argv contains no shell-meta sequences", () => {
    for (const arg of Z3_HEALTHCHECK_ARGV) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("attempted CLI-flag-injection registration via the z3 id is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "z3",
        image: "--privileged",
        defaultEntrypoint: [...Z3_DEFAULT_ENTRYPOINT],
        healthcheck: { command: [...Z3_HEALTHCHECK_ARGV], expectedExitCode: 0 },
      }),
    ).toThrow(ImageRegistrationError);
  });

  test("attempted whitespace-tampered z3 image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "z3",
        image: `${Z3_IMAGE_REF} --privileged`,
        defaultEntrypoint: [...Z3_DEFAULT_ENTRYPOINT],
        healthcheck: { command: [...Z3_HEALTHCHECK_ARGV], expectedExitCode: 0 },
      }),
    ).toThrow(/whitespace/);
  });

  test("attempted shell-meta-tagged z3 image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "z3",
        image: "ghcr.io/crewhaus/sandbox-z3:$(id)",
        defaultEntrypoint: [...Z3_DEFAULT_ENTRYPOINT],
        healthcheck: { command: [...Z3_HEALTHCHECK_ARGV], expectedExitCode: 0 },
      }),
    ).toThrow(/valid registry/);
  });
});
