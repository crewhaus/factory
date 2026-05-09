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
  DOTNET_COLD_START_BUDGET_MS,
  DOTNET_DEFAULT_ENTRYPOINT,
  DOTNET_HEALTHCHECK_ARGV,
  DOTNET_IMAGE_ID,
  DOTNET_IMAGE_REF,
  registerDotnetSandboxImage,
} from "./index";

describe("registerDotnetSandboxImage (T1 + T2)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("constants match the kickoff prompt's spec", () => {
    expect(DOTNET_IMAGE_ID).toBe("dotnet");
    expect(DOTNET_IMAGE_REF).toBe("mcr.microsoft.com/dotnet/sdk:8.0-alpine");
    expect(DOTNET_DEFAULT_ENTRYPOINT).toEqual(["dotnet", "script"]);
    expect(DOTNET_HEALTHCHECK_ARGV).toEqual(["dotnet", "--version"]);
  });

  test("registerDotnetSandboxImage() registers an image with the right shape", () => {
    const entry = registerDotnetSandboxImage();
    expect(entry.id).toBe("dotnet");
    expect(entry.image).toBe("mcr.microsoft.com/dotnet/sdk:8.0-alpine");
    expect(entry.defaultEntrypoint).toEqual(["dotnet", "script"]);
    expect(entry.healthcheck.command).toEqual(["dotnet", "--version"]);
    expect(entry.healthcheck.expectedExitCode).toBe(0);
    expect(entry.healthcheck.timeoutMs).toBe(DOTNET_COLD_START_BUDGET_MS);
    expect(entry.description).toMatch(/\.NET 8/);
  });

  test("lookupSandboxImage('dotnet') returns the registered entry", () => {
    registerDotnetSandboxImage();
    expect(hasSandboxImage("dotnet")).toBe(true);
    expect(lookupSandboxImage("dotnet").image).toBe("mcr.microsoft.com/dotnet/sdk:8.0-alpine");
  });

  test("listAllowedImageRefs includes the .NET SDK ref", () => {
    registerDotnetSandboxImage();
    const refs = listAllowedImageRefs();
    expect(refs).toContain("mcr.microsoft.com/dotnet/sdk:8.0-alpine");
    expect(refs).toContain("python:3.13-slim");
  });
});

describe("Dotnet-shape T2 contract — round-trip via noop sandbox", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("noop sandbox accepts the .NET SDK ref when registered", async () => {
    registerDotnetSandboxImage();
    const sandbox = createSandbox({
      backend: "noop",
      allowedImages: listAllowedImageRefs(),
    });
    const result = await sandbox.exec({
      image: DOTNET_IMAGE_REF,
      argv: ["printf", "hello-from-dotnet"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-from-dotnet");
    await sandbox.close();
  });

  test("noop sandbox refuses the .NET SDK ref when NOT registered", async () => {
    const trioRefs = ["python:3.13-slim", "node:22-alpine", "alpine:3.19"];
    const sandbox = createSandbox({ backend: "noop", allowedImages: trioRefs });
    await expect(sandbox.exec({ image: DOTNET_IMAGE_REF, argv: ["printf", "x"] })).rejects.toThrow(
      /not on the allowlist/,
    );
    await sandbox.close();
  });
});

describe("Dotnet-shape T7 — cold-start budget (≤4s, the looser bucket)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("healthcheck timeoutMs is within the .NET-specific budget (≤4s)", () => {
    const entry = registerDotnetSandboxImage();
    expect(entry.healthcheck.timeoutMs).toBeLessThanOrEqual(4_000);
    expect(entry.healthcheck.timeoutMs).toBeGreaterThan(0);
  });

  test(".NET budget is the looser one (the kickoff prompt grants 4s for .NET)", () => {
    expect(DOTNET_COLD_START_BUDGET_MS).toBe(4_000);
    expect(DOTNET_COLD_START_BUDGET_MS).toBeGreaterThan(2_000);
  });
});

describe("Dotnet-shape T8 — escape-attempt suite (reuses §18 corpus shape)", () => {
  beforeEach(() => _resetSandboxImageRegistry());
  afterEach(() => _resetSandboxImageRegistry());

  test("Dotnet image registration is idempotent-then-rejected", () => {
    registerDotnetSandboxImage();
    expect(() => registerDotnetSandboxImage()).toThrow(/already registered/);
  });

  test("Dotnet entry's image string passes registry validation", () => {
    expect(DOTNET_IMAGE_REF.startsWith("-")).toBe(false);
    expect(/\s/.test(DOTNET_IMAGE_REF)).toBe(false);
    expect(DOTNET_IMAGE_REF.includes("\n")).toBe(false);
  });

  test("Dotnet defaultEntrypoint contains no shell-meta", () => {
    for (const arg of DOTNET_DEFAULT_ENTRYPOINT) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("Dotnet healthcheck argv contains no shell-meta", () => {
    for (const arg of DOTNET_HEALTHCHECK_ARGV) {
      expect(/[;&|<>$`(){}]/.test(arg)).toBe(false);
      expect(arg.includes("\n")).toBe(false);
    }
  });

  test("CLI-flag-injection registration via dotnet id is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "dotnet",
        image: "--privileged",
        defaultEntrypoint: ["dotnet", "script"],
        healthcheck: { command: ["dotnet", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(ImageRegistrationError);
  });

  test("whitespace-tampered Dotnet image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "dotnet",
        image: "mcr.microsoft.com/dotnet/sdk:8.0-alpine --privileged",
        defaultEntrypoint: ["dotnet", "script"],
        healthcheck: { command: ["dotnet", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(/whitespace/);
  });

  test("shell-meta-tagged Dotnet image is refused", () => {
    expect(() =>
      registerSandboxImage({
        id: "dotnet",
        image: "mcr.microsoft.com/dotnet/sdk:$(id)",
        defaultEntrypoint: ["dotnet", "script"],
        healthcheck: { command: ["dotnet", "--version"], expectedExitCode: 0 },
      }),
    ).toThrow(/valid registry/);
  });
});
