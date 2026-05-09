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
  RUST_COLD_START_BUDGET_MS,
  RUST_DEFAULT_ENTRYPOINT,
  RUST_HEALTHCHECK_ARGV,
  RUST_IMAGE_ID,
  RUST_IMAGE_REF,
  registerRustSandboxImage,
} from "./index";

describe("registerRustSandboxImage (T1 + T2)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("constants match the kickoff prompt's spec", () => {
    expect(RUST_IMAGE_ID).toBe("rust");
    expect(RUST_IMAGE_REF).toBe("rust:1-alpine");
    expect(RUST_DEFAULT_ENTRYPOINT).toEqual(["rustc", "-"]);
    expect(RUST_HEALTHCHECK_ARGV).toEqual(["rustc", "--version"]);
  });

  test("registerRustSandboxImage() registers an image with the right shape", () => {
    const entry = registerRustSandboxImage();
    expect(entry.id).toBe("rust");
    expect(entry.image).toBe("rust:1-alpine");
    expect(entry.defaultEntrypoint).toEqual(["rustc", "-"]);
    expect(entry.healthcheck.command).toEqual(["rustc", "--version"]);
    expect(entry.healthcheck.expectedExitCode).toBe(0);
    expect(entry.healthcheck.timeoutMs).toBe(RUST_COLD_START_BUDGET_MS);
    expect(entry.description).toMatch(/Rust/);
  });

  test("lookupSandboxImage('rust') returns the registered entry", () => {
    registerRustSandboxImage();
    expect(hasSandboxImage("rust")).toBe(true);
    expect(lookupSandboxImage("rust").image).toBe("rust:1-alpine");
  });

  test("listAllowedImageRefs includes rust:1-alpine after registration", () => {
    registerRustSandboxImage();
    const refs = listAllowedImageRefs();
    expect(refs).toContain("rust:1-alpine");
    expect(refs).toContain("python:3.13-slim");
  });
});

describe("Rust-shape T2 contract — round-trip via noop sandbox", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("noop sandbox accepts rust:1-alpine when registered", async () => {
    registerRustSandboxImage();
    const sandbox = createSandbox({
      backend: "noop",
      allowedImages: listAllowedImageRefs(),
    });
    const result = await sandbox.exec({
      image: RUST_IMAGE_REF,
      argv: ["printf", "hello-from-rust"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-from-rust");
    await sandbox.close();
  });

  test("noop sandbox refuses rust:1-alpine when NOT registered", async () => {
    const trioRefs = ["python:3.13-slim", "node:22-alpine", "alpine:3.19"];
    const sandbox = createSandbox({ backend: "noop", allowedImages: trioRefs });
    await expect(sandbox.exec({ image: RUST_IMAGE_REF, argv: ["printf", "x"] })).rejects.toThrow(
      /not on the allowlist/,
    );
    await sandbox.close();
  });
});

describe("Rust-shape T7 — cold-start budget", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("healthcheck timeoutMs is within the compiled-language budget (≤2s)", () => {
    const entry = registerRustSandboxImage();
    expect(entry.healthcheck.timeoutMs).toBeLessThanOrEqual(2_000);
    expect(entry.healthcheck.timeoutMs).toBeGreaterThan(0);
  });
});

describe("Rust-shape T8 — escape-attempt suite (reuses §18 corpus shape)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("Rust image registration is idempotent-then-rejected", () => {
    registerRustSandboxImage();
    expect(() => registerRustSandboxImage()).toThrow(/already registered/);
  });

  test("Rust entry's image string passes registry validation", () => {
    expect(RUST_IMAGE_REF.startsWith("-")).toBe(false);
    expect(/\s/.test(RUST_IMAGE_REF)).toBe(false);
    expect(RUST_IMAGE_REF.includes("\n")).toBe(false);
  });

  test("Rust defaultEntrypoint contains no shell-meta", () => {
    for (const arg of RUST_DEFAULT_ENTRYPOINT) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("Rust healthcheck argv contains no shell-meta", () => {
    for (const arg of RUST_HEALTHCHECK_ARGV) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("attempted CLI-flag-injection registration via Rust id is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "rust",
        image: "--privileged",
        defaultEntrypoint: ["rustc", "-"],
        healthcheck: { command: ["rustc", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(ImageRegistrationError);
  });

  test("attempted whitespace-tampered Rust image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "rust",
        image: "rust:1-alpine --privileged",
        defaultEntrypoint: ["rustc", "-"],
        healthcheck: { command: ["rustc", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(/whitespace/);
  });

  test("attempted shell-meta-tagged Rust image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "rust",
        image: "rust:$(id)",
        defaultEntrypoint: ["rustc", "-"],
        healthcheck: { command: ["rustc", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(/valid registry/);
  });
});
