import { describe, expect, test } from "bun:test";
import {
  CLOUD_DEPLOY_PROVIDERS,
  CLOUD_DEPLOY_PROVIDER_NAMES,
  CLOUD_DEPLOY_TARGET_SHAPES,
  cloudDeployTokenPresent,
  defaultCloudDeployBaseImage,
  formatCloudDeployNextSteps,
  isCloudDeployProvider,
  isCloudDeployTargetShape,
  resolveCloudDeployAppName,
} from "./cloud-deploy";

describe("cloud-deploy provider registry", () => {
  test("the four providers each map to a token env + an adapter package", () => {
    expect(CLOUD_DEPLOY_PROVIDER_NAMES).toEqual(["fly", "render", "railway", "heroku"]);
    expect(CLOUD_DEPLOY_PROVIDERS.fly.tokenEnv).toBe("FLY_API_TOKEN");
    expect(CLOUD_DEPLOY_PROVIDERS.render.tokenEnv).toBe("RENDER_API_KEY");
    expect(CLOUD_DEPLOY_PROVIDERS.railway.tokenEnv).toBe("RAILWAY_API_TOKEN");
    expect(CLOUD_DEPLOY_PROVIDERS.heroku.tokenEnv).toBe("HEROKU_API_KEY");
    expect(CLOUD_DEPLOY_PROVIDERS.fly.importPath).toBe("@crewhaus/cloud-adapter-flyio");
    expect(CLOUD_DEPLOY_PROVIDERS.render.importPath).toBe("@crewhaus/cloud-adapter-render");
    expect(CLOUD_DEPLOY_PROVIDERS.railway.importPath).toBe("@crewhaus/cloud-adapter-railway");
    expect(CLOUD_DEPLOY_PROVIDERS.heroku.importPath).toBe("@crewhaus/cloud-adapter-heroku");
  });

  test("isCloudDeployProvider narrows the four names, rejects others", () => {
    expect(isCloudDeployProvider("fly")).toBe(true);
    expect(isCloudDeployProvider("heroku")).toBe(true);
    expect(isCloudDeployProvider("aws")).toBe(false);
    expect(isCloudDeployProvider("promote")).toBe(false);
    expect(isCloudDeployProvider("")).toBe(false);
  });
});

describe("cloud-deploy target-shape gate", () => {
  test("daemon shapes are supported; single-shot shapes are not", () => {
    expect([...CLOUD_DEPLOY_TARGET_SHAPES]).toEqual([
      "channel",
      "managed",
      "batch",
      "voice",
      "browser",
    ]);
    for (const shape of CLOUD_DEPLOY_TARGET_SHAPES) {
      expect(isCloudDeployTargetShape(shape)).toBe(true);
    }
    for (const shape of ["cli", "workflow", "graph", "crew", "research", "eval"]) {
      expect(isCloudDeployTargetShape(shape)).toBe(false);
    }
  });
});

describe("cloudDeployTokenPresent", () => {
  test("reflects whether the provider's env var is a non-empty string", () => {
    const fly = CLOUD_DEPLOY_PROVIDERS.fly;
    expect(cloudDeployTokenPresent(fly, { FLY_API_TOKEN: "tok" })).toBe(true);
    expect(cloudDeployTokenPresent(fly, { FLY_API_TOKEN: "" })).toBe(false);
    expect(cloudDeployTokenPresent(fly, {})).toBe(false);
    // Only its OWN var counts.
    expect(cloudDeployTokenPresent(fly, { RENDER_API_KEY: "tok" })).toBe(false);
  });
});

describe("resolveCloudDeployAppName", () => {
  test("sanitizes a spec name to the strict Fly app-name grammar", () => {
    expect(resolveCloudDeployAppName("Support Bot")).toBe("support-bot");
    expect(resolveCloudDeployAppName("my_agent!!")).toBe("my-agent");
    expect(resolveCloudDeployAppName("--weird--")).toBe("weird");
    // Every result matches Fly's validator.
    const pattern = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
    for (const name of ["Support Bot", "my_agent!!", "A", "x".repeat(50), "123 456"]) {
      expect(resolveCloudDeployAppName(name)).toMatch(pattern);
    }
  });

  test("caps at 30 chars without a trailing hyphen", () => {
    const long = resolveCloudDeployAppName("a".repeat(40));
    expect(long.length).toBeLessThanOrEqual(30);
    expect(long.endsWith("-")).toBe(false);
  });

  test("an explicit override wins over the spec name", () => {
    expect(resolveCloudDeployAppName("support-bot", "prod-bot")).toBe("prod-bot");
    // The override is sanitized too.
    expect(resolveCloudDeployAppName("support-bot", "Prod Bot")).toBe("prod-bot");
  });

  test("empty input falls back to crewhaus-app", () => {
    expect(resolveCloudDeployAppName("")).toBe("crewhaus-app");
    expect(resolveCloudDeployAppName("!!!")).toBe("crewhaus-app");
  });
});

describe("defaultCloudDeployBaseImage", () => {
  test("is the published per-shape image at latest", () => {
    expect(defaultCloudDeployBaseImage("channel")).toBe("crewhaus/channel:latest");
    expect(defaultCloudDeployBaseImage("managed")).toBe("crewhaus/managed:latest");
  });
});

describe("formatCloudDeployNextSteps", () => {
  test("names the token env and points at --live when the token is absent", () => {
    const out = formatCloudDeployNextSteps({
      provider: CLOUD_DEPLOY_PROVIDERS.fly,
      outDir: "/tmp/deploy/fly",
      tokenPresent: false,
      files: ["fly.toml", "Dockerfile.fly"],
    });
    expect(out).toContain("scaffolded Fly.io deploy manifests → /tmp/deploy/fly");
    expect(out).toContain("wrote fly.toml");
    expect(out).toContain("set FLY_API_TOKEN and re-run with --live");
  });

  test("acknowledges a present token", () => {
    const out = formatCloudDeployNextSteps({
      provider: CLOUD_DEPLOY_PROVIDERS.render,
      outDir: "/tmp/deploy/render",
      tokenPresent: true,
      files: ["render.yaml"],
    });
    expect(out).toContain("RENDER_API_KEY is set — re-run with --live");
  });
});
