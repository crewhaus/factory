import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ImageNotFoundError,
  ImageRegistrationError,
  _resetSandboxImageRegistry,
  hasSandboxImage,
  listAllowedImageRefs,
  listSandboxImages,
  lookupSandboxImage,
  markHealthy,
  markUnhealthy,
  registerSandboxImage,
  runHealthchecks,
  snapshotImageStatuses,
} from "./index";

describe("registerSandboxImage / lookupSandboxImage", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("auto-registers the §18 trio (python / javascript / shell)", () => {
    expect(hasSandboxImage("python")).toBe(true);
    expect(hasSandboxImage("javascript")).toBe(true);
    expect(hasSandboxImage("shell")).toBe(true);
    const py = lookupSandboxImage("python");
    expect(py.image).toBe("python:3.13-slim");
    expect(py.defaultEntrypoint).toEqual(["python3", "-c"]);
    const js = lookupSandboxImage("javascript");
    expect(js.image).toBe("node:22-alpine");
    const sh = lookupSandboxImage("shell");
    expect(sh.image).toBe("alpine:3.19");
  });

  test("registers a new image with a healthcheck contract", () => {
    const entry = registerSandboxImage({
      id: "go",
      image: "golang:1.23-alpine",
      defaultEntrypoint: ["go", "run", "-"],
      healthcheck: { command: ["go", "version"], expectedExitCode: 0, timeoutMs: 2_000 },
      description: "Go 1.23 alpine",
    });
    expect(entry.id).toBe("go");
    expect(entry.image).toBe("golang:1.23-alpine");
    expect(entry.healthcheck.command).toEqual(["go", "version"]);
    expect(lookupSandboxImage("go").image).toBe("golang:1.23-alpine");
  });

  test("listSandboxImages returns sorted entries including bootstrap trio", () => {
    registerSandboxImage({
      id: "go",
      image: "golang:1.23-alpine",
      defaultEntrypoint: ["go", "run", "-"],
      healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
    });
    const ids = listSandboxImages().map((e) => e.id);
    expect(ids).toEqual(["go", "javascript", "python", "shell"]);
  });

  test("listAllowedImageRefs flattens to image strings", () => {
    const refs = listAllowedImageRefs();
    expect(refs).toContain("python:3.13-slim");
    expect(refs).toContain("node:22-alpine");
    expect(refs).toContain("alpine:3.19");
  });

  test("lookupSandboxImage throws ImageNotFoundError for unknown id", () => {
    expect(() => lookupSandboxImage("ghost")).toThrow(ImageNotFoundError);
    expect(() => lookupSandboxImage("ghost")).toThrow(/known: /);
  });
});

describe("registration validation (T8 surface)", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("rejects duplicate registration", () => {
    registerSandboxImage({
      id: "go",
      image: "golang:1.23-alpine",
      defaultEntrypoint: ["go", "run", "-"],
      healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
    });
    expect(() =>
      registerSandboxImage({
        id: "go",
        image: "golang:1.23-alpine",
        defaultEntrypoint: ["go", "run", "-"],
        healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
      }),
    ).toThrow(/already registered/);
  });

  test("rejects re-registering the bootstrap trio", () => {
    expect(() =>
      registerSandboxImage({
        id: "python",
        image: "python:3.13-slim",
        defaultEntrypoint: ["python3", "-c"],
        healthcheck: { command: ["python3", "-c", "print(1)"], expectedExitCode: 0 },
      }),
    ).toThrow(/already registered/);
  });

  test("rejects image starting with dash (CLI flag injection)", () => {
    expect(() =>
      registerSandboxImage({
        id: "evil",
        image: "--privileged",
        defaultEntrypoint: ["sh", "-c"],
        healthcheck: { command: ["true"], expectedExitCode: 0 },
      }),
    ).toThrow(/CLI flag/);
  });

  test("rejects image with whitespace", () => {
    expect(() =>
      registerSandboxImage({
        id: "evil",
        image: "alpine:3.19 --privileged",
        defaultEntrypoint: ["sh", "-c"],
        healthcheck: { command: ["true"], expectedExitCode: 0 },
      }),
    ).toThrow(/whitespace/);
  });

  test("rejects image with newline", () => {
    expect(() =>
      registerSandboxImage({
        id: "evil",
        image: "alpine:3.19\n--privileged",
        defaultEntrypoint: ["sh", "-c"],
        healthcheck: { command: ["true"], expectedExitCode: 0 },
      }),
    ).toThrow(/whitespace/);
  });

  test("rejects image with shell-meta tag", () => {
    expect(() =>
      registerSandboxImage({
        id: "evil",
        image: "alpine:$(id)",
        defaultEntrypoint: ["sh", "-c"],
        healthcheck: { command: ["true"], expectedExitCode: 0 },
      }),
    ).toThrow(/valid registry reference/);
  });

  test("rejects empty argv healthcheck", () => {
    expect(() =>
      registerSandboxImage({
        id: "go",
        image: "golang:1.23-alpine",
        defaultEntrypoint: ["go", "run", "-"],
        healthcheck: { command: [], expectedExitCode: 0 },
      }),
    ).toThrow(/non-empty argv/);
  });

  test("rejects non-integer expected exit code", () => {
    expect(() =>
      registerSandboxImage({
        id: "go",
        image: "golang:1.23-alpine",
        defaultEntrypoint: ["go", "run", "-"],
        healthcheck: { command: ["go", "version"], expectedExitCode: 0.5 },
      }),
    ).toThrow(/integer/);
  });

  test("rejects healthcheck argv with newline", () => {
    expect(() =>
      registerSandboxImage({
        id: "go",
        image: "golang:1.23-alpine",
        defaultEntrypoint: ["go", "run", "-"],
        healthcheck: { command: ["go\nversion"], expectedExitCode: 0 },
      }),
    ).toThrow(/newlines/);
  });

  test("rejects empty defaultEntrypoint", () => {
    expect(() =>
      registerSandboxImage({
        id: "go",
        image: "golang:1.23-alpine",
        defaultEntrypoint: [],
        healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
      }),
    ).toThrow(/non-empty argv/);
  });

  test("rejects id with uppercase / spaces", () => {
    expect(() =>
      registerSandboxImage({
        id: "GoLang",
        image: "golang:1.23-alpine",
        defaultEntrypoint: ["go", "run", "-"],
        healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
      }),
    ).toThrow(ImageRegistrationError);
    expect(() =>
      registerSandboxImage({
        id: "go lang",
        image: "golang:1.23-alpine",
        defaultEntrypoint: ["go", "run", "-"],
        healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
      }),
    ).toThrow(ImageRegistrationError);
  });

  test("accepts digest-pinned image", () => {
    const digest = `a${"b".repeat(63)}`;
    registerSandboxImage({
      id: "rust-pinned",
      image: `rust:1-alpine@sha256:${digest}`,
      defaultEntrypoint: ["sh", "-c"],
      healthcheck: { command: ["rustc", "--version"], expectedExitCode: 0 },
    });
    expect(lookupSandboxImage("rust-pinned").image).toBe(`rust:1-alpine@sha256:${digest}`);
  });
});

describe("healthcheck status tracking", () => {
  beforeEach(() => {
    _resetSandboxImageRegistry();
  });
  afterEach(() => {
    _resetSandboxImageRegistry();
  });

  test("snapshotImageStatuses lists every registered image", () => {
    registerSandboxImage({
      id: "go",
      image: "golang:1.23-alpine",
      defaultEntrypoint: ["go", "run", "-"],
      healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
    });
    const statuses = snapshotImageStatuses();
    const ids = statuses.map((s) => s.id);
    expect(ids).toContain("go");
    expect(ids).toContain("python");
    for (const s of statuses) {
      expect(s.healthy).toBe(false);
      expect(s.lastHealthyAt).toBeNull();
      expect(s.lastError).toBeNull();
    }
  });

  test("markHealthy / markUnhealthy update status", () => {
    registerSandboxImage({
      id: "go",
      image: "golang:1.23-alpine",
      defaultEntrypoint: ["go", "run", "-"],
      healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
    });
    markHealthy("go", 1700000000000);
    let s = snapshotImageStatuses().find((x) => x.id === "go");
    expect(s).toBeDefined();
    expect(s?.healthy).toBe(true);
    expect(s?.lastHealthyAt).toBe(new Date(1700000000000).toISOString());
    markUnhealthy("go", "image pull denied");
    s = snapshotImageStatuses().find((x) => x.id === "go");
    expect(s?.healthy).toBe(false);
    expect(s?.lastError).toBe("image pull denied");
  });

  test("markHealthy throws for unregistered id", () => {
    expect(() => markHealthy("ghost")).toThrow(ImageNotFoundError);
    expect(() => markUnhealthy("ghost", "nope")).toThrow(ImageNotFoundError);
  });

  test("runHealthchecks runs each entry through the supplied probe", async () => {
    registerSandboxImage({
      id: "go",
      image: "golang:1.23-alpine",
      defaultEntrypoint: ["go", "run", "-"],
      healthcheck: { command: ["go", "version"], expectedExitCode: 0 },
    });
    const calls: string[] = [];
    const statuses = await runHealthchecks(async (entry) => {
      calls.push(entry.id);
      // Python + go succeed; javascript fails (exit 17); shell throws.
      if (entry.id === "javascript") return { exitCode: 17, stderr: "node: not found" };
      if (entry.id === "shell") throw new Error("shell probe blew up");
      return { exitCode: 0, stderr: "" };
    });
    expect(calls.sort()).toEqual(["go", "javascript", "python", "shell"]);
    const byId = new Map(statuses.map((s) => [s.id, s]));
    expect(byId.get("go")?.healthy).toBe(true);
    expect(byId.get("python")?.healthy).toBe(true);
    expect(byId.get("javascript")?.healthy).toBe(false);
    expect(byId.get("javascript")?.lastError).toContain("node: not found");
    expect(byId.get("shell")?.healthy).toBe(false);
    expect(byId.get("shell")?.lastError).toContain("shell probe blew up");
  });
});
