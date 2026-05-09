import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BuildRunner,
  DockerImagesError,
  TARGET_SHAPES,
  buildImage,
  dockerRoot,
  dockerfilePath,
  dockerfileSize,
  fingerprintDockerfile,
  isTargetShape,
  listAvailableTargets,
  loadDigests,
  readDockerfile,
  recordDigest,
} from "./index";

describe("TARGET_SHAPES", () => {
  test("contains exactly the 12 shipped target shapes", () => {
    expect(TARGET_SHAPES).toEqual([
      "cli",
      "workflow",
      "channel",
      "graph",
      "managed",
      "pipeline",
      "crew",
      "research",
      "batch",
      "voice",
      "browser",
      "eval",
    ]);
  });

  test("isTargetShape accepts every shape and rejects unknowns", () => {
    for (const t of TARGET_SHAPES) {
      expect(isTargetShape(t)).toBe(true);
    }
    expect(isTargetShape("realtime")).toBe(false);
    expect(isTargetShape("")).toBe(false);
    expect(isTargetShape(42)).toBe(false);
  });
});

describe("Dockerfiles on disk", () => {
  test("every shape has a Dockerfile under docker/<target>/Dockerfile", () => {
    for (const t of TARGET_SHAPES) {
      expect(dockerfileSize(t)).toBeGreaterThan(100);
    }
  });

  test("listAvailableTargets returns all 12 shapes", () => {
    expect(listAvailableTargets()).toEqual(TARGET_SHAPES);
  });

  test("dockerRoot points inside the package", () => {
    expect(dockerRoot()).toMatch(/packages\/docker-images\/docker$/);
  });
});

describe("Dockerfile structural contract (T2)", () => {
  for (const target of TARGET_SHAPES) {
    test(`${target} → multi-stage, non-root, healthchecked, has bun runtime`, () => {
      const text = readDockerfile(target);
      const fp = fingerprintDockerfile(text);
      expect(fp.stages.length).toBeGreaterThanOrEqual(2);
      expect(fp.hasHealthcheck).toBe(true);
      expect(fp.nonRootUser).toBe("crewhaus");
      expect(fp.workdir).toBe("/app");
      expect(fp.envs).toContain("CREWHAUS_TARGET");
      expect(fp.entrypoint?.includes("bun")).toBe(true);
      // multi-stage: at least one named stage (deps/build/runtime)
      expect(fp.stages.some((s) => s.stage === "deps" || s.stage === "build")).toBe(true);
    });
  }

  test("daemon shapes (channel/managed/crew/voice/browser) expose a port and curl healthcheck", () => {
    const daemonShapes = ["channel", "managed", "crew", "voice", "browser"] as const;
    for (const t of daemonShapes) {
      const text = readDockerfile(t);
      const fp = fingerprintDockerfile(text);
      expect(fp.exposedPorts.length).toBeGreaterThan(0);
      expect(text).toContain("curl");
    }
  });

  test("voice image installs libopus", () => {
    expect(readDockerfile("voice")).toContain("libopus");
  });

  test("browser image installs chromium and Playwright env vars", () => {
    const text = readDockerfile("browser");
    expect(text).toContain("chromium");
    expect(text).toContain("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH");
  });
});

describe("buildImage()", () => {
  test("rejects unknown targets", async () => {
    await expect(buildImage({ target: "unknown" as never, tag: "smoke" })).rejects.toThrow(
      DockerImagesError,
    );
  });

  test("rejects empty/whitespace tags", async () => {
    await expect(buildImage({ target: "cli", tag: "" })).rejects.toThrow(/invalid tag/);
    await expect(buildImage({ target: "cli", tag: "bad tag" })).rejects.toThrow(/invalid tag/);
  });

  test("happy path emits the documented argv shape", async () => {
    const captured: string[][] = [];
    const runner: BuildRunner = async (argv) => {
      captured.push([...argv]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await buildImage({
      target: "cli",
      tag: "smoke",
      runner,
    });
    expect(result.tag).toBe("smoke");
    expect(result.target).toBe("cli");
    expect(captured.length).toBe(1);
    const argv = captured[0] ?? [];
    expect(argv[0]).toBe("docker");
    expect(argv).toContain("buildx");
    expect(argv).toContain("build");
    expect(argv).toContain("--tag");
    expect(argv).toContain("crewhaus/cli:smoke");
    expect(argv).toContain("--load");
    expect(argv.includes("--push")).toBe(false);
    expect(argv).toContain(dockerfilePath("cli"));
  });

  test("--push instead of --load when push:true", async () => {
    let argv: readonly string[] = [];
    await buildImage({
      target: "channel",
      tag: "v1",
      push: true,
      runner: async (a) => {
        argv = a;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(argv).toContain("--push");
    expect(argv.includes("--load")).toBe(false);
  });

  test("non-zero exit propagates as DockerImagesError with stderr captured", async () => {
    const runner: BuildRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "no docker daemon",
    });
    await expect(buildImage({ target: "cli", tag: "smoke", runner })).rejects.toThrow(
      /no docker daemon/,
    );
  });

  test("platform passes through to argv", async () => {
    let argv: readonly string[] = [];
    await buildImage({
      target: "graph",
      tag: "multi",
      platform: "linux/amd64,linux/arm64",
      runner: async (a) => {
        argv = a;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(argv).toContain("--platform");
    expect(argv).toContain("linux/amd64,linux/arm64");
  });
});

describe("digests lockfile", () => {
  test("loadDigests returns _format_version: 1 when file missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-digests-"));
    const path = join(dir, "missing.json");
    expect(loadDigests(path)).toEqual({ _format_version: 1 });
  });

  test("recordDigest writes and round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-digests-"));
    const path = join(dir, "digests.json");
    const sha = `sha256:${"a".repeat(64)}`;
    recordDigest("cli", "smoke", sha, path);
    const loaded = loadDigests(path) as { cli?: Record<string, { sha256: string }> };
    expect(loaded.cli?.["smoke"]?.sha256).toBe(sha);
  });

  test("recordDigest rejects malformed digests", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-digests-"));
    const path = join(dir, "digests.json");
    expect(() => recordDigest("cli", "tag", "not-a-digest", path)).toThrow(/invalid sha256/);
    expect(() => recordDigest("cli", "tag", "sha256:short", path)).toThrow();
  });

  test("loadDigests propagates JSON parse errors as DockerImagesError", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-digests-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, "not json");
    expect(() => loadDigests(path)).toThrow(DockerImagesError);
  });

  test("recordDigest preserves prior entries across multiple records", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-digests-"));
    const path = join(dir, "digests.json");
    const shaA = `sha256:${"a".repeat(64)}`;
    const shaB = `sha256:${"b".repeat(64)}`;
    recordDigest("cli", "v1", shaA, path);
    recordDigest("channel", "v1", shaB, path);
    const final = JSON.parse(readFileSync(path, "utf8"));
    expect(final.cli.v1.sha256).toBe(shaA);
    expect(final.channel.v1.sha256).toBe(shaB);
  });
});

describe("fingerprintDockerfile (T1 unit)", () => {
  test("parses a minimal multi-stage Dockerfile", () => {
    const text = `FROM alpine AS base
FROM base AS runtime
WORKDIR /work
ENV FOO=bar BAZ=qux
USER nobody
EXPOSE 9000
HEALTHCHECK CMD echo
ENTRYPOINT ["bun", "x"]
CMD ["--help"]
`;
    const fp = fingerprintDockerfile(text);
    expect(fp.stages.map((s) => s.stage)).toEqual(["base", "runtime"]);
    expect(fp.hasHealthcheck).toBe(true);
    expect(fp.nonRootUser).toBe("nobody");
    expect(fp.workdir).toBe("/work");
    expect(fp.exposedPorts).toEqual([9000]);
    expect([...fp.envs].sort()).toEqual(["BAZ", "FOO"]);
    expect(fp.entrypoint).toContain("bun");
    expect(fp.cmd).toContain("--help");
  });

  test("absent fields surface as undefined / empty", () => {
    const fp = fingerprintDockerfile("FROM alpine\n");
    expect(fp.hasHealthcheck).toBe(false);
    expect(fp.nonRootUser).toBeUndefined();
    expect(fp.exposedPorts).toEqual([]);
  });
});
