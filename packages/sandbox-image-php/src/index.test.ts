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
  PHP_COLD_START_BUDGET_MS,
  PHP_DEFAULT_ENTRYPOINT,
  PHP_HEALTHCHECK_ARGV,
  PHP_IMAGE_ID,
  PHP_IMAGE_REF,
  registerPhpSandboxImage,
} from "./index";

describe("registerPhpSandboxImage (T1 + T2)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("constants match the kickoff prompt's spec", () => {
    expect(PHP_IMAGE_ID).toBe("php");
    expect(PHP_IMAGE_REF).toBe("php:8.3-alpine");
    expect(PHP_DEFAULT_ENTRYPOINT).toEqual(["php", "-r"]);
    expect(PHP_HEALTHCHECK_ARGV).toEqual(["php", "--version"]);
  });

  test("registerPhpSandboxImage() registers an image with the right shape", () => {
    const entry = registerPhpSandboxImage();
    expect(entry.id).toBe("php");
    expect(entry.image).toBe("php:8.3-alpine");
    expect(entry.defaultEntrypoint).toEqual(["php", "-r"]);
    expect(entry.healthcheck.command).toEqual(["php", "--version"]);
    expect(entry.healthcheck.expectedExitCode).toBe(0);
    expect(entry.healthcheck.timeoutMs).toBe(PHP_COLD_START_BUDGET_MS);
    expect(entry.description).toMatch(/PHP 8\.3/);
  });

  test("lookupSandboxImage('php') returns the registered entry", () => {
    registerPhpSandboxImage();
    expect(hasSandboxImage("php")).toBe(true);
    expect(lookupSandboxImage("php").image).toBe("php:8.3-alpine");
  });

  test("listAllowedImageRefs includes php:8.3-alpine", () => {
    registerPhpSandboxImage();
    const refs = listAllowedImageRefs();
    expect(refs).toContain("php:8.3-alpine");
    expect(refs).toContain("python:3.13-slim");
  });
});

describe("Php-shape T2 contract — round-trip via noop sandbox", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("noop sandbox accepts php:8.3-alpine when registered", async () => {
    registerPhpSandboxImage();
    const sandbox = createSandbox({
      backend: "noop",
      allowedImages: listAllowedImageRefs(),
    });
    const result = await sandbox.exec({
      image: PHP_IMAGE_REF,
      argv: ["printf", "hello-from-php"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-from-php");
    await sandbox.close();
  });

  test("noop sandbox refuses php:8.3-alpine when NOT registered", async () => {
    const trioRefs = ["python:3.13-slim", "node:22-alpine", "alpine:3.19"];
    const sandbox = createSandbox({ backend: "noop", allowedImages: trioRefs });
    await expect(sandbox.exec({ image: PHP_IMAGE_REF, argv: ["printf", "x"] })).rejects.toThrow(
      /not on the allowlist/,
    );
    await sandbox.close();
  });
});

describe("Php-shape T7 — cold-start budget (≤500ms, the shell-shape bucket)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("healthcheck timeoutMs is within the shell-shape interpreter budget (≤500ms)", () => {
    const entry = registerPhpSandboxImage();
    expect(entry.healthcheck.timeoutMs).toBeLessThanOrEqual(500);
    expect(entry.healthcheck.timeoutMs).toBeGreaterThan(0);
  });
});

describe("Php-shape T8 — escape-attempt suite (reuses §18 corpus shape)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("PHP image registration is idempotent-then-rejected", () => {
    registerPhpSandboxImage();
    expect(() => registerPhpSandboxImage()).toThrow(/already registered/);
  });

  test("PHP entry's image string passes registry validation", () => {
    expect(PHP_IMAGE_REF.startsWith("-")).toBe(false);
    expect(/\s/.test(PHP_IMAGE_REF)).toBe(false);
    expect(PHP_IMAGE_REF.includes("\n")).toBe(false);
  });

  test("PHP defaultEntrypoint contains no shell-meta", () => {
    for (const arg of PHP_DEFAULT_ENTRYPOINT) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("PHP healthcheck argv contains no shell-meta", () => {
    for (const arg of PHP_HEALTHCHECK_ARGV) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("CLI-flag-injection registration via PHP id is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "php",
        image: "--privileged",
        defaultEntrypoint: ["php", "-r"],
        healthcheck: { command: ["php", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(ImageRegistrationError);
  });

  test("whitespace-tampered PHP image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "php",
        image: "php:8.3-alpine --privileged",
        defaultEntrypoint: ["php", "-r"],
        healthcheck: { command: ["php", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(/whitespace/);
  });

  test("shell-meta-tagged PHP image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "php",
        image: "php:$(id)",
        defaultEntrypoint: ["php", "-r"],
        healthcheck: { command: ["php", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(/valid registry/);
  });
});
