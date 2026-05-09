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
  R_COLD_START_BUDGET_MS,
  R_DEFAULT_ENTRYPOINT,
  R_HEALTHCHECK_ARGV,
  R_IMAGE_ID,
  R_IMAGE_REF,
  registerRSandboxImage,
} from "./index";

describe("registerRSandboxImage (T1 + T2)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("constants match the kickoff prompt's spec", () => {
    expect(R_IMAGE_ID).toBe("r");
    expect(R_IMAGE_REF).toBe("rocker/r-base:4.4");
    expect(R_DEFAULT_ENTRYPOINT).toEqual(["Rscript", "-e"]);
    expect(R_HEALTHCHECK_ARGV).toEqual(["Rscript", "-e", "cat(R.version.string)"]);
  });

  test("registerRSandboxImage() registers an image with the right shape", () => {
    const entry = registerRSandboxImage();
    expect(entry.id).toBe("r");
    expect(entry.image).toBe("rocker/r-base:4.4");
    expect(entry.defaultEntrypoint).toEqual(["Rscript", "-e"]);
    expect(entry.healthcheck.command).toEqual(["Rscript", "-e", "cat(R.version.string)"]);
    expect(entry.healthcheck.expectedExitCode).toBe(0);
    expect(entry.healthcheck.timeoutMs).toBe(R_COLD_START_BUDGET_MS);
    expect(entry.description).toMatch(/R 4/);
  });

  test("lookupSandboxImage('r') returns the registered entry", () => {
    registerRSandboxImage();
    expect(hasSandboxImage("r")).toBe(true);
    expect(lookupSandboxImage("r").image).toBe("rocker/r-base:4.4");
  });

  test("listAllowedImageRefs includes rocker/r-base:4.4", () => {
    registerRSandboxImage();
    const refs = listAllowedImageRefs();
    expect(refs).toContain("rocker/r-base:4.4");
    expect(refs).toContain("python:3.13-slim");
  });
});

describe("R-shape T2 contract — round-trip via noop sandbox", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("noop sandbox accepts rocker/r-base:4.4 when registered", async () => {
    registerRSandboxImage();
    const sandbox = createSandbox({
      backend: "noop",
      allowedImages: listAllowedImageRefs(),
    });
    const result = await sandbox.exec({
      image: R_IMAGE_REF,
      argv: ["printf", "hello-from-r"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-from-r");
    await sandbox.close();
  });

  test("noop sandbox refuses rocker/r-base:4.4 when NOT registered", async () => {
    const trioRefs = ["python:3.13-slim", "node:22-alpine", "alpine:3.19"];
    const sandbox = createSandbox({ backend: "noop", allowedImages: trioRefs });
    await expect(sandbox.exec({ image: R_IMAGE_REF, argv: ["printf", "x"] })).rejects.toThrow(
      /not on the allowlist/,
    );
    await sandbox.close();
  });
});

describe("R-shape T7 — cold-start budget", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("healthcheck timeoutMs is within the compiled-language budget (≤2s)", () => {
    const entry = registerRSandboxImage();
    expect(entry.healthcheck.timeoutMs).toBeLessThanOrEqual(2_000);
    expect(entry.healthcheck.timeoutMs).toBeGreaterThan(0);
  });
});

describe("R-shape T8 — escape-attempt suite (reuses §18 corpus shape)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("R image registration is idempotent-then-rejected", () => {
    registerRSandboxImage();
    expect(() => registerRSandboxImage()).toThrow(/already registered/);
  });

  test("R entry's image string passes registry validation", () => {
    expect(R_IMAGE_REF.startsWith("-")).toBe(false);
    expect(/\s/.test(R_IMAGE_REF)).toBe(false);
    expect(R_IMAGE_REF.includes("\n")).toBe(false);
  });

  test("R defaultEntrypoint contains no shell-meta", () => {
    for (const arg of R_DEFAULT_ENTRYPOINT) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("R healthcheck argv R.version.string call is well-formed", () => {
    // R healthcheck is `Rscript -e cat(R.version.string)` — the 3rd
    // argv element legitimately contains parens, but it's passed as
    // a single non-shell argv to Bun.spawn so shell-meta is moot. We
    // assert the first two argv elements are shell-meta-free, and the
    // third has no embedded newlines.
    expect(R_HEALTHCHECK_ARGV[0]).toBe("Rscript");
    expect(R_HEALTHCHECK_ARGV[1]).toBe("-e");
    expect(/[;&|<>$`{}]/.test(R_HEALTHCHECK_ARGV[0] ?? "")).toBe(false);
    expect(/[;&|<>$`{}]/.test(R_HEALTHCHECK_ARGV[1] ?? "")).toBe(false);
    for (const arg of R_HEALTHCHECK_ARGV) {
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("CLI-flag-injection registration via R id is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "r",
        image: "--privileged",
        defaultEntrypoint: ["Rscript", "-e"],
        healthcheck: { command: ["Rscript", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(ImageRegistrationError);
  });

  test("whitespace-tampered R image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "r",
        image: "rocker/r-base:4.4 --privileged",
        defaultEntrypoint: ["Rscript", "-e"],
        healthcheck: { command: ["Rscript", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(/whitespace/);
  });

  test("shell-meta-tagged R image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "r",
        image: "rocker/r-base:$(id)",
        defaultEntrypoint: ["Rscript", "-e"],
        healthcheck: { command: ["Rscript", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(/valid registry/);
  });
});
