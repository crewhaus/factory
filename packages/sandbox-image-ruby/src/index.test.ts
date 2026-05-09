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
  RUBY_COLD_START_BUDGET_MS,
  RUBY_DEFAULT_ENTRYPOINT,
  RUBY_HEALTHCHECK_ARGV,
  RUBY_IMAGE_ID,
  RUBY_IMAGE_REF,
  registerRubySandboxImage,
} from "./index";

describe("registerRubySandboxImage (T1 + T2)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("constants match the kickoff prompt's spec", () => {
    expect(RUBY_IMAGE_ID).toBe("ruby");
    expect(RUBY_IMAGE_REF).toBe("ruby:3.3-alpine");
    expect(RUBY_DEFAULT_ENTRYPOINT).toEqual(["ruby", "-e"]);
    expect(RUBY_HEALTHCHECK_ARGV).toEqual(["ruby", "--version"]);
  });

  test("registerRubySandboxImage() registers an image with the right shape", () => {
    const entry = registerRubySandboxImage();
    expect(entry.id).toBe("ruby");
    expect(entry.image).toBe("ruby:3.3-alpine");
    expect(entry.defaultEntrypoint).toEqual(["ruby", "-e"]);
    expect(entry.healthcheck.command).toEqual(["ruby", "--version"]);
    expect(entry.healthcheck.expectedExitCode).toBe(0);
    expect(entry.healthcheck.timeoutMs).toBe(RUBY_COLD_START_BUDGET_MS);
    expect(entry.description).toMatch(/Ruby 3\.3/);
  });

  test("lookupSandboxImage('ruby') returns the registered entry", () => {
    registerRubySandboxImage();
    expect(hasSandboxImage("ruby")).toBe(true);
    expect(lookupSandboxImage("ruby").image).toBe("ruby:3.3-alpine");
  });

  test("listAllowedImageRefs includes ruby:3.3-alpine", () => {
    registerRubySandboxImage();
    const refs = listAllowedImageRefs();
    expect(refs).toContain("ruby:3.3-alpine");
    expect(refs).toContain("python:3.13-slim");
  });
});

describe("Ruby-shape T2 contract — round-trip via noop sandbox", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("noop sandbox accepts ruby:3.3-alpine when registered", async () => {
    registerRubySandboxImage();
    const sandbox = createSandbox({
      backend: "noop",
      allowedImages: listAllowedImageRefs(),
    });
    const result = await sandbox.exec({
      image: RUBY_IMAGE_REF,
      argv: ["printf", "hello-from-ruby"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-from-ruby");
    await sandbox.close();
  });

  test("noop sandbox refuses ruby:3.3-alpine when NOT registered", async () => {
    const trioRefs = ["python:3.13-slim", "node:22-alpine", "alpine:3.19"];
    const sandbox = createSandbox({ backend: "noop", allowedImages: trioRefs });
    await expect(sandbox.exec({ image: RUBY_IMAGE_REF, argv: ["printf", "x"] })).rejects.toThrow(
      /not on the allowlist/,
    );
    await sandbox.close();
  });
});

describe("Ruby-shape T7 — cold-start budget", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("healthcheck timeoutMs is within the shell-shape interpreter budget (≤500ms)", () => {
    const entry = registerRubySandboxImage();
    expect(entry.healthcheck.timeoutMs).toBeLessThanOrEqual(500);
    expect(entry.healthcheck.timeoutMs).toBeGreaterThan(0);
  });
});

describe("Ruby-shape T8 — escape-attempt suite (reuses §18 corpus shape)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("Ruby image registration is idempotent-then-rejected", () => {
    registerRubySandboxImage();
    expect(() => registerRubySandboxImage()).toThrow(/already registered/);
  });

  test("Ruby entry's image string passes registry validation", () => {
    expect(RUBY_IMAGE_REF.startsWith("-")).toBe(false);
    expect(/\s/.test(RUBY_IMAGE_REF)).toBe(false);
    expect(RUBY_IMAGE_REF.includes("\n")).toBe(false);
  });

  test("Ruby defaultEntrypoint contains no shell-meta", () => {
    for (const arg of RUBY_DEFAULT_ENTRYPOINT) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("Ruby healthcheck argv contains no shell-meta", () => {
    for (const arg of RUBY_HEALTHCHECK_ARGV) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("CLI-flag-injection registration via Ruby id is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "ruby",
        image: "--privileged",
        defaultEntrypoint: ["ruby", "-e"],
        healthcheck: { command: ["ruby", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(ImageRegistrationError);
  });

  test("whitespace-tampered Ruby image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "ruby",
        image: "ruby:3.3-alpine --privileged",
        defaultEntrypoint: ["ruby", "-e"],
        healthcheck: { command: ["ruby", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(/whitespace/);
  });

  test("shell-meta-tagged Ruby image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "ruby",
        image: "ruby:$(id)",
        defaultEntrypoint: ["ruby", "-e"],
        healthcheck: { command: ["ruby", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(/valid registry/);
  });
});
