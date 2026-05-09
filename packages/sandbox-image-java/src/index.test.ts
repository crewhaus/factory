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
  JAVA_COLD_START_BUDGET_MS,
  JAVA_DEFAULT_ENTRYPOINT,
  JAVA_HEALTHCHECK_ARGV,
  JAVA_IMAGE_ID,
  JAVA_IMAGE_REF,
  registerJavaSandboxImage,
} from "./index";

describe("registerJavaSandboxImage (T1 + T2)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("constants match the kickoff prompt's spec", () => {
    expect(JAVA_IMAGE_ID).toBe("java");
    expect(JAVA_IMAGE_REF).toBe("eclipse-temurin:21-alpine");
    expect(JAVA_DEFAULT_ENTRYPOINT).toEqual(["java"]);
    expect(JAVA_HEALTHCHECK_ARGV).toEqual(["java", "-version"]);
  });

  test("registerJavaSandboxImage() registers an image with the right shape", () => {
    const entry = registerJavaSandboxImage();
    expect(entry.id).toBe("java");
    expect(entry.image).toBe("eclipse-temurin:21-alpine");
    expect(entry.defaultEntrypoint).toEqual(["java"]);
    expect(entry.healthcheck.command).toEqual(["java", "-version"]);
    expect(entry.healthcheck.expectedExitCode).toBe(0);
    expect(entry.healthcheck.timeoutMs).toBe(JAVA_COLD_START_BUDGET_MS);
    expect(entry.description).toMatch(/JDK 21/);
  });

  test("lookupSandboxImage('java') returns the registered entry", () => {
    registerJavaSandboxImage();
    expect(hasSandboxImage("java")).toBe(true);
    expect(lookupSandboxImage("java").image).toBe("eclipse-temurin:21-alpine");
  });

  test("listAllowedImageRefs includes eclipse-temurin:21-alpine", () => {
    registerJavaSandboxImage();
    const refs = listAllowedImageRefs();
    expect(refs).toContain("eclipse-temurin:21-alpine");
    expect(refs).toContain("python:3.13-slim");
  });
});

describe("Java-shape T2 contract — round-trip via noop sandbox", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("noop sandbox accepts eclipse-temurin:21-alpine when registered", async () => {
    registerJavaSandboxImage();
    const sandbox = createSandbox({
      backend: "noop",
      allowedImages: listAllowedImageRefs(),
    });
    const result = await sandbox.exec({
      image: JAVA_IMAGE_REF,
      argv: ["printf", "hello-from-java"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-from-java");
    await sandbox.close();
  });

  test("noop sandbox refuses eclipse-temurin:21-alpine when NOT registered", async () => {
    const trioRefs = ["python:3.13-slim", "node:22-alpine", "alpine:3.19"];
    const sandbox = createSandbox({ backend: "noop", allowedImages: trioRefs });
    await expect(sandbox.exec({ image: JAVA_IMAGE_REF, argv: ["printf", "x"] })).rejects.toThrow(
      /not on the allowlist/,
    );
    await sandbox.close();
  });
});

describe("Java-shape T7 — cold-start budget", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("healthcheck timeoutMs is within the compiled-language budget (≤2s)", () => {
    const entry = registerJavaSandboxImage();
    expect(entry.healthcheck.timeoutMs).toBeLessThanOrEqual(2_000);
    expect(entry.healthcheck.timeoutMs).toBeGreaterThan(0);
  });
});

describe("Java-shape T8 — escape-attempt suite (reuses §18 corpus shape)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("Java image registration is idempotent-then-rejected", () => {
    registerJavaSandboxImage();
    expect(() => registerJavaSandboxImage()).toThrow(/already registered/);
  });

  test("Java entry's image string passes registry validation", () => {
    expect(JAVA_IMAGE_REF.startsWith("-")).toBe(false);
    expect(/\s/.test(JAVA_IMAGE_REF)).toBe(false);
    expect(JAVA_IMAGE_REF.includes("\n")).toBe(false);
  });

  test("Java defaultEntrypoint contains no shell-meta", () => {
    for (const arg of JAVA_DEFAULT_ENTRYPOINT) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("Java healthcheck argv contains no shell-meta", () => {
    for (const arg of JAVA_HEALTHCHECK_ARGV) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("CLI-flag-injection registration via Java id is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "java",
        image: "--privileged",
        defaultEntrypoint: ["java"],
        healthcheck: { command: ["java", "-version"], expectedExitCode: 0 },
      }),
    ).toThrow(ImageRegistrationError);
  });

  test("whitespace-tampered Java image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "java",
        image: "eclipse-temurin:21-alpine --privileged",
        defaultEntrypoint: ["java"],
        healthcheck: { command: ["java", "-version"], expectedExitCode: 0 },
      }),
    ).toThrow(/whitespace/);
  });

  test("shell-meta-tagged Java image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "java",
        image: "eclipse-temurin:$(id)",
        defaultEntrypoint: ["java"],
        healthcheck: { command: ["java", "-version"], expectedExitCode: 0 },
      }),
    ).toThrow(/valid registry/);
  });
});
