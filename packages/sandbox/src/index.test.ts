import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SANDBOX_DEFAULT_ALLOWED_IMAGES, SandboxError, createSandbox } from "./index";

const ORIGINAL_ENV = { ...process.env };
function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CREWHAUS_SANDBOX")) delete process.env[key];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (k.startsWith("CREWHAUS_SANDBOX") && v !== undefined) process.env[k] = v;
  }
}

describe("createSandbox factory", () => {
  beforeEach(() => {
    resetEnv();
  });
  afterEach(() => {
    resetEnv();
  });

  test("backend resolves from env", () => {
    process.env["CREWHAUS_SANDBOX"] = "noop";
    const s = createSandbox();
    expect(s.backend).toBe("noop");
  });

  test("explicit option overrides env", () => {
    process.env["CREWHAUS_SANDBOX"] = "docker";
    const s = createSandbox({ backend: "noop" });
    expect(s.backend).toBe("noop");
  });

  test("invalid env value throws at construction", () => {
    process.env["CREWHAUS_SANDBOX"] = "vagrant";
    expect(() => createSandbox()).toThrow(SandboxError);
  });

  test("default allowlist exposes the curated image list", () => {
    expect(SANDBOX_DEFAULT_ALLOWED_IMAGES).toContain("python:3.13-slim");
    expect(SANDBOX_DEFAULT_ALLOWED_IMAGES).toContain("node:22-alpine");
    expect(SANDBOX_DEFAULT_ALLOWED_IMAGES).toContain("alpine:3.19");
  });
});

describe("noop backend exec", () => {
  beforeEach(() => {
    process.env["CREWHAUS_SANDBOX"] = "noop";
  });
  afterEach(() => {
    resetEnv();
  });

  test("runs argv and captures stdout", async () => {
    const sandbox = createSandbox();
    const result = await sandbox.exec({
      image: "python:3.13-slim",
      argv: ["printf", "hello"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test("propagates non-zero exit code", async () => {
    const sandbox = createSandbox();
    const result = await sandbox.exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", "echo nope >&2; exit 17"],
    });
    expect(result.exitCode).toBe(17);
    expect(result.stderr).toContain("nope");
  });

  test("times out and marks timedOut=true", async () => {
    const sandbox = createSandbox();
    const result = await sandbox.exec({
      image: "alpine:3.19",
      argv: ["sleep", "5"],
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    // SIGKILL via Bun -> exitCode is non-zero (typically negative for signals)
    expect(result.exitCode).not.toBe(0);
  });

  test("streams stdout chunks to onStdoutChunk", async () => {
    const sandbox = createSandbox();
    const chunks: string[] = [];
    await sandbox.exec({
      image: "python:3.13-slim",
      argv: ["printf", "abcdefg"],
      onStdoutChunk: (c) => chunks.push(c),
    });
    expect(chunks.join("")).toBe("abcdefg");
  });
});

describe("image allowlist", () => {
  beforeEach(() => {
    process.env["CREWHAUS_SANDBOX"] = "noop";
  });
  afterEach(() => {
    resetEnv();
  });

  test("default allowlist accepts curated images", async () => {
    const sandbox = createSandbox();
    const result = await sandbox.exec({ image: "alpine:3.19", argv: ["printf", "ok"] });
    expect(result.stdout).toBe("ok");
  });

  test("rejects unknown image", async () => {
    const sandbox = createSandbox();
    await expect(sandbox.exec({ image: "evil:latest", argv: ["true"] })).rejects.toThrow(
      /not on the allowlist/,
    );
  });

  test("rejects image starting with dash (CLI flag injection)", async () => {
    const sandbox = createSandbox();
    await expect(sandbox.exec({ image: "--privileged", argv: ["true"] })).rejects.toThrow(
      /CLI flag/,
    );
  });

  test("rejects image with whitespace (newline injection)", async () => {
    const sandbox = createSandbox();
    await expect(
      sandbox.exec({ image: "alpine:3.19\n--privileged", argv: ["true"] }),
    ).rejects.toThrow(/whitespace|valid registry/);
  });

  test("rejects image with shell-meta tag", async () => {
    const sandbox = createSandbox();
    await expect(sandbox.exec({ image: "alpine:$(id)", argv: ["true"] })).rejects.toThrow(
      /valid registry/,
    );
  });

  test("env CREWHAUS_SANDBOX_ALLOWED_IMAGES extends allowlist", async () => {
    process.env["CREWHAUS_SANDBOX_ALLOWED_IMAGES"] = "busybox:1.36";
    const sandbox = createSandbox();
    // No throw: image is now allowed (will run via Bun.spawn with non-existent
    // binary args but the allowlist check passes first).
    await sandbox.exec({ image: "busybox:1.36", argv: ["printf", "x"] });
  });

  test("explicit allowedImages overrides default", async () => {
    const sandbox = createSandbox({ allowedImages: ["my:image"] });
    await expect(sandbox.exec({ image: "alpine:3.19", argv: ["true"] })).rejects.toThrow(
      /not on the allowlist/,
    );
  });
});

describe("mount whitelist", () => {
  beforeEach(() => {
    process.env["CREWHAUS_SANDBOX"] = "noop";
  });
  afterEach(() => {
    resetEnv();
  });

  test("rejects mount src outside whitelist", async () => {
    const sandbox = createSandbox({ mountWhitelist: ["/srv/agent"] });
    await expect(
      sandbox.exec({
        image: "alpine:3.19",
        argv: ["true"],
        mounts: [{ src: "/etc", dst: "/etc-mounted" }],
      }),
    ).rejects.toThrow(/not under any whitelisted root/);
  });

  test("rejects relative mount src", async () => {
    const sandbox = createSandbox({ mountWhitelist: ["/srv/agent"] });
    await expect(
      sandbox.exec({
        image: "alpine:3.19",
        argv: ["true"],
        mounts: [{ src: "../etc", dst: "/etc-mounted" }],
      }),
    ).rejects.toThrow(/absolute/);
  });

  test("rejects mount path with traversal segment", async () => {
    const sandbox = createSandbox({ mountWhitelist: ["/srv/agent"] });
    await expect(
      sandbox.exec({
        image: "alpine:3.19",
        argv: ["true"],
        mounts: [{ src: "/srv/agent/../etc", dst: "/etc-mounted" }],
      }),
    ).rejects.toThrow(/may not contain "\.\."/);
  });

  test("rejects newline in mount path", async () => {
    const sandbox = createSandbox({ mountWhitelist: ["/srv/agent"] });
    await expect(
      sandbox.exec({
        image: "alpine:3.19",
        argv: ["true"],
        mounts: [{ src: "/srv/agent\n--privileged", dst: "/x" }],
      }),
    ).rejects.toThrow(/newline|may not contain/);
  });

  test("accepts mount inside whitelist root", async () => {
    const sandbox = createSandbox({ mountWhitelist: ["/srv/agent"] });
    // Goes through validation; noop won't actually mount anything.
    await sandbox.exec({
      image: "alpine:3.19",
      argv: ["printf", "ok"],
      mounts: [{ src: "/srv/agent/data", dst: "/data" }],
    });
  });
});

describe("env-key validation", () => {
  beforeEach(() => {
    process.env["CREWHAUS_SANDBOX"] = "noop";
  });
  afterEach(() => {
    resetEnv();
  });

  test("rejects invalid env key", async () => {
    const sandbox = createSandbox();
    await expect(
      sandbox.exec({
        image: "alpine:3.19",
        argv: ["true"],
        env: { "FOO BAR": "1" },
      }),
    ).rejects.toThrow(/not a valid identifier/);
  });

  test("accepts well-formed env key", async () => {
    const sandbox = createSandbox();
    await sandbox.exec({
      image: "alpine:3.19",
      argv: ["printf", "ok"],
      env: { FOO_BAR: "1" },
    });
  });
});

describe("close", () => {
  beforeEach(() => {
    process.env["CREWHAUS_SANDBOX"] = "noop";
  });
  afterEach(() => {
    resetEnv();
  });

  test("close prevents further exec", async () => {
    const sandbox = createSandbox();
    await sandbox.close();
    await expect(sandbox.exec({ image: "alpine:3.19", argv: ["true"] })).rejects.toThrow(/closed/);
  });

  test("close is idempotent", async () => {
    const sandbox = createSandbox();
    await sandbox.close();
    await sandbox.close();
  });
});

describe("docker backend (no daemon required for argv assembly)", () => {
  beforeEach(() => {
    resetEnv();
  });
  afterEach(() => {
    resetEnv();
  });

  test("validates image on docker backend before invoking docker", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    await expect(sandbox.exec({ image: "evil:latest", argv: ["true"] })).rejects.toThrow(
      /not on the allowlist/,
    );
  });

  test("validates mount on docker backend before invoking docker", async () => {
    const sandbox = createSandbox({ backend: "docker", mountWhitelist: ["/srv/agent"] });
    await expect(
      sandbox.exec({
        image: "alpine:3.19",
        argv: ["true"],
        mounts: [{ src: "/etc", dst: "/etc" }],
      }),
    ).rejects.toThrow(/not under any whitelisted root/);
  });
});
