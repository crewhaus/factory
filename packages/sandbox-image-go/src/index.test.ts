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
  GO_COLD_START_BUDGET_MS,
  GO_DEFAULT_ENTRYPOINT,
  GO_HEALTHCHECK_ARGV,
  GO_IMAGE_ID,
  GO_IMAGE_REF,
  registerGoSandboxImage,
} from "./index";

describe("registerGoSandboxImage (T1 + T2)", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("constants match the kickoff prompt's spec", () => {
    expect(GO_IMAGE_ID).toBe("go");
    expect(GO_IMAGE_REF).toBe("golang:1.23-alpine");
    expect(GO_DEFAULT_ENTRYPOINT).toEqual(["go", "run", "-"]);
    expect(GO_HEALTHCHECK_ARGV).toEqual(["go", "version"]);
  });

  test("registerGoSandboxImage() registers an image with the right shape", () => {
    const entry = registerGoSandboxImage();
    expect(entry.id).toBe("go");
    expect(entry.image).toBe("golang:1.23-alpine");
    expect(entry.defaultEntrypoint).toEqual(["go", "run", "-"]);
    expect(entry.healthcheck.command).toEqual(["go", "version"]);
    expect(entry.healthcheck.expectedExitCode).toBe(0);
    expect(entry.healthcheck.timeoutMs).toBe(GO_COLD_START_BUDGET_MS);
    expect(entry.description).toMatch(/Go 1\.23/);
  });

  test("lookupSandboxImage('go') returns the registered entry", () => {
    registerGoSandboxImage();
    expect(hasSandboxImage("go")).toBe(true);
    const entry = lookupSandboxImage("go");
    expect(entry.image).toBe("golang:1.23-alpine");
  });

  test("listAllowedImageRefs includes golang:1.23-alpine after registration", () => {
    registerGoSandboxImage();
    const refs = listAllowedImageRefs();
    expect(refs).toContain("golang:1.23-alpine");
    // Bootstrap trio still present
    expect(refs).toContain("python:3.13-slim");
    expect(refs).toContain("node:22-alpine");
  });
});

describe("Go-shape T2 contract — round-trip via noop sandbox", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("noop sandbox accepts golang:1.23-alpine when registered", async () => {
    registerGoSandboxImage();
    const sandbox = createSandbox({
      backend: "noop",
      allowedImages: listAllowedImageRefs(),
    });
    // The noop backend spawns the argv directly — `printf` is universal,
    // so we use it instead of `go run -` to assert the wiring without
    // needing a Go toolchain on the test host.
    const result = await sandbox.exec({
      image: GO_IMAGE_REF,
      argv: ["printf", "hello-from-go"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-from-go");
    await sandbox.close();
  });

  test("noop sandbox refuses golang:1.23-alpine when NOT registered", async () => {
    // Registry not touched here — Go image is not in the allowlist.
    // The bootstrap trio is still present, so we explicitly use a
    // sandbox configured with only the trio.
    const trioRefs = ["python:3.13-slim", "node:22-alpine", "alpine:3.19"];
    const sandbox = createSandbox({ backend: "noop", allowedImages: trioRefs });
    await expect(sandbox.exec({ image: GO_IMAGE_REF, argv: ["printf", "x"] })).rejects.toThrow(
      /not on the allowlist/,
    );
    await sandbox.close();
  });
});

describe("Go-shape T7 — cold-start budget", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("healthcheck timeoutMs is within the compiled-language budget (≤2s)", () => {
    const entry = registerGoSandboxImage();
    expect(entry.healthcheck.timeoutMs).toBeLessThanOrEqual(2_000);
    expect(entry.healthcheck.timeoutMs).toBeGreaterThan(0);
  });
});

describe("Go-shape T8 — escape-attempt suite (reuses §18 corpus shape)", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("Go image registration is idempotent-then-rejected (no silent override)", () => {
    registerGoSandboxImage();
    expect(() => registerGoSandboxImage()).toThrow(/already registered/);
  });

  test("Go entry's image string passes registry validation (no leading dash)", () => {
    expect(GO_IMAGE_REF.startsWith("-")).toBe(false);
  });

  test("Go entry's image string contains no whitespace / newline", () => {
    expect(/\s/.test(GO_IMAGE_REF)).toBe(false);
    expect(GO_IMAGE_REF.includes("\n")).toBe(false);
  });

  test("Go entry's defaultEntrypoint contains no shell-meta sequences", () => {
    for (const arg of GO_DEFAULT_ENTRYPOINT) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("Go entry's healthcheck argv contains no shell-meta sequences", () => {
    for (const arg of GO_HEALTHCHECK_ARGV) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("attempted CLI-flag-injection registration via Go id is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "go",
        image: "--privileged",
        defaultEntrypoint: ["go", "run", "-"],
        healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
      }),
    ).toThrow(ImageRegistrationError);
  });

  test("attempted whitespace-tampered Go image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "go",
        image: "golang:1.23-alpine --privileged",
        defaultEntrypoint: ["go", "run", "-"],
        healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
      }),
    ).toThrow(/whitespace/);
  });

  test("attempted shell-meta-tagged Go image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "go",
        image: "golang:$(id)",
        defaultEntrypoint: ["go", "run", "-"],
        healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
      }),
    ).toThrow(/valid registry/);
  });
});
