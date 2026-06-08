import { describe, expect, spyOn, test } from "bun:test";
import * as nodeCrypto from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CloudConfig,
  type CloudRunner,
  CrewhausCloudError,
  PROVIDERS,
  TIERS,
  defaultCloudConfig,
  deployCloud,
  isCloudProvider,
  listProviders,
  recipesRoot,
  renderKustomizeOverlay,
  renderTerraformModule,
  summariseDeploy,
  teardownCloud,
  tierShapes,
} from "./index";

describe("PROVIDERS / TIERS / defaultCloudConfig", () => {
  test("listProviders returns canonical list", () => {
    expect(listProviders()).toEqual(PROVIDERS);
  });

  test("defaultCloudConfig sets sensible defaults", () => {
    const c = defaultCloudConfig("aws", "us-east-1");
    expect(c.provider).toBe("aws");
    expect(c.region).toBe("us-east-1");
    expect(c.tier).toBe("default");
    expect(c.imageTag).toBe("latest");
    expect(c.clusterName).toBe("crewhaus-aws-us-east-1");
  });

  test("rejects unknown provider", () => {
    expect(() => defaultCloudConfig("dropbox" as never, "us-east-1")).toThrow(CrewhausCloudError);
  });

  test("rejects whitespace region", () => {
    expect(() => defaultCloudConfig("aws", "us east 1")).toThrow();
  });

  test("isCloudProvider acts as a type guard", () => {
    expect(isCloudProvider("aws")).toBe(true);
    expect(isCloudProvider("gcp")).toBe(true);
    expect(isCloudProvider("digitalocean")).toBe(false);
  });

  test("tierShapes covers all tiers", () => {
    for (const t of TIERS) {
      const shapes = tierShapes(t);
      expect(shapes.length).toBeGreaterThan(0);
      for (const s of shapes) expect(s.replicas).toBeGreaterThan(0);
    }
  });
});

describe("renderKustomizeOverlay", () => {
  test("default config produces a well-formed kustomization.yaml", () => {
    const config = defaultCloudConfig("aws", "us-east-1");
    const overlay = renderKustomizeOverlay(config);
    expect(overlay.kustomization).toContain("kind: Kustomization");
    expect(overlay.kustomization).toContain(`namespace: ${config.clusterName}`);
    expect(overlay.kustomization).toContain("crewhaus.ai/provider: aws");
    expect(overlay.kustomization).toContain("crewhaus.ai/region: us-east-1");
    expect(Object.keys(overlay.manifests).length).toBeGreaterThan(0);
    expect(Object.keys(overlay.manifests).some((k) => k.startsWith("managed-"))).toBe(true);
  });

  test("each rendered manifest contains a Kubernetes kind", () => {
    const config = defaultCloudConfig("gcp", "us-central1");
    const overlay = renderKustomizeOverlay(config);
    for (const body of Object.values(overlay.manifests)) {
      // Some are blank if the if-gate evaluated false (e.g., ingress disabled);
      // we only require the non-empty ones to declare a kind.
      if (body.trim().length > 0) {
        expect(/^kind: \w+$/m.test(body)).toBe(true);
      }
    }
  });

  test("output is deterministic across two renders", () => {
    const config = defaultCloudConfig("aws", "us-east-1");
    const a = renderKustomizeOverlay(config);
    const b = renderKustomizeOverlay(config);
    expect(a.kustomization).toBe(b.kustomization);
    expect(Object.keys(a.manifests)).toEqual(Object.keys(b.manifests));
  });
});

describe("renderTerraformModule", () => {
  test("AWS module declares aws_eks_cluster + aws_db_instance + aws_s3_bucket", () => {
    const tf = renderTerraformModule(defaultCloudConfig("aws", "us-east-1"));
    expect(tf).toContain("hashicorp/aws");
    expect(tf).toContain('aws_eks_cluster" "crewhaus"');
    expect(tf).toContain('aws_db_instance" "spec_registry"');
    expect(tf).toContain('aws_s3_bucket" "audit_log"');
  });

  test("aws-localstack module wires endpoints to LocalStack", () => {
    const tf = renderTerraformModule(defaultCloudConfig("aws-localstack", "us-east-1"));
    expect(tf).toContain("var.localstack_endpoint");
    expect(tf).toContain("s3_use_path_style");
  });

  test("GCP module uses google_container_cluster + google_sql_database_instance", () => {
    const tf = renderTerraformModule(defaultCloudConfig("gcp", "us-central1"));
    expect(tf).toContain("hashicorp/google");
    expect(tf).toContain('google_container_cluster" "crewhaus"');
    expect(tf).toContain('google_sql_database_instance" "spec_registry"');
  });

  test("Azure module uses azurerm_kubernetes_cluster + azurerm_postgresql_flexible_server", () => {
    const tf = renderTerraformModule(defaultCloudConfig("azure", "eastus"));
    expect(tf).toContain("hashicorp/azurerm");
    expect(tf).toContain('azurerm_kubernetes_cluster" "crewhaus"');
    expect(tf).toContain('azurerm_postgresql_flexible_server" "spec_registry"');
  });
});

describe("deployCloud (T2 dry-run with fake runner)", () => {
  test("when no runner is supplied, all steps are marked skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-cloud-deploy-"));
    const result = await deployCloud({
      config: defaultCloudConfig("aws", "us-east-1"),
      workingDir: dir,
    });
    expect(result.workingDir).toBe(dir);
    for (const step of result.steps) {
      expect(step.skipped).toBe(true);
    }
    // Files were still written
    expect(readFileSync(join(dir, "terraform", "main.tf"), "utf8")).toContain("aws_eks_cluster");
    expect(readFileSync(join(dir, "kustomize", "kustomization.yaml"), "utf8")).toContain(
      "kind: Kustomization",
    );
  });

  test("with a fake runner, the documented argv sequence is invoked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-cloud-deploy-"));
    const calls: string[][] = [];
    const runner: CloudRunner = async (argv) => {
      calls.push([...argv]);
      // Simulate `terraform output -json` returning two outputs
      if (argv.includes("output")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            cluster_endpoint: { value: "https://example.eks" },
            audit_bucket: { value: "crewhaus-aws-us-east-1-audit" },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await deployCloud({
      config: defaultCloudConfig("aws", "us-east-1"),
      workingDir: dir,
      tfBin: "terraform",
      runner,
    });
    const argvs = calls.map((c) => c[1]);
    expect(argvs).toContain("init");
    expect(argvs).toContain("apply");
    expect(argvs).toContain("output");
    // kubectl apply step
    const kubectlApply = calls.find((c) => c[0] === "kubectl");
    expect(kubectlApply).toBeDefined();
    expect(kubectlApply).toContain("apply");
    expect(result.outputs["cluster_endpoint"]).toBe("https://example.eks");
  });

  test("non-zero exit on terraform apply propagates as CrewhausCloudError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-cloud-deploy-"));
    const runner: CloudRunner = async (argv) =>
      argv.includes("apply")
        ? { exitCode: 1, stdout: "", stderr: "no AWS credentials" }
        : { exitCode: 0, stdout: "", stderr: "" };
    await expect(
      deployCloud({
        config: defaultCloudConfig("aws", "us-east-1"),
        workingDir: dir,
        runner,
      }),
    ).rejects.toThrow(/no AWS credentials/);
  });
});

describe("randomPassword (CWE-338 regression — CSPRNG, not Math.random)", () => {
  function passwordFromCalls(calls: string[][]): string | undefined {
    for (const argv of calls) {
      const varArg = argv.find((a) => a.startsWith("spec_registry_password="));
      if (varArg) return varArg.slice("spec_registry_password=".length);
    }
    return undefined;
  }

  test("deploy injects a 24-char hex password sourced from node:crypto.randomBytes", async () => {
    const randomBytesSpy = spyOn(nodeCrypto, "randomBytes");
    try {
      const dir = mkdtempSync(join(tmpdir(), "crewhaus-cloud-pw-"));
      const calls: string[][] = [];
      const runner: CloudRunner = async (argv) => {
        calls.push([...argv]);
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      await deployCloud({
        config: defaultCloudConfig("aws", "us-east-1"),
        workingDir: dir,
        runner,
      });
      const pw = passwordFromCalls(calls);
      expect(pw).toBeDefined();
      // Same shape as before the fix: exactly 24 lowercase-hex characters.
      expect(pw).toMatch(/^[0-9a-f]{24}$/);
      // Proves the placeholder is drawn from the CSPRNG, not Math.random().
      expect(randomBytesSpy).toHaveBeenCalled();
    } finally {
      randomBytesSpy.mockRestore();
    }
  });

  test("two separate deploys produce different passwords (not a constant)", async () => {
    const collect = async (): Promise<string | undefined> => {
      const dir = mkdtempSync(join(tmpdir(), "crewhaus-cloud-pw-"));
      const calls: string[][] = [];
      const runner: CloudRunner = async (argv) => {
        calls.push([...argv]);
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      await deployCloud({
        config: defaultCloudConfig("gcp", "us-central1"),
        workingDir: dir,
        runner,
      });
      return passwordFromCalls(calls);
    };
    const [a, b] = [await collect(), await collect()];
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(b).toMatch(/^[0-9a-f]{24}$/);
    expect(a).not.toBe(b);
  });

  test("teardown also injects a CSPRNG-sourced 24-char hex password", async () => {
    const randomBytesSpy = spyOn(nodeCrypto, "randomBytes");
    try {
      const dir = mkdtempSync(join(tmpdir(), "crewhaus-cloud-pw-td-"));
      await deployCloud({ config: defaultCloudConfig("aws", "us-east-1"), workingDir: dir });
      randomBytesSpy.mockClear();
      const calls: string[][] = [];
      const runner: CloudRunner = async (argv) => {
        calls.push([...argv]);
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      await teardownCloud({
        config: defaultCloudConfig("aws", "us-east-1"),
        workingDir: dir,
        runner,
      });
      const pw = passwordFromCalls(calls);
      expect(pw).toMatch(/^[0-9a-f]{24}$/);
      expect(randomBytesSpy).toHaveBeenCalled();
    } finally {
      randomBytesSpy.mockRestore();
    }
  });
});

describe("teardownCloud", () => {
  test("refuses if working dir does not exist", async () => {
    await expect(
      teardownCloud({
        config: defaultCloudConfig("aws", "us-east-1"),
        workingDir: "/nonexistent/path",
      }),
    ).rejects.toThrow(/no working directory/);
  });

  test("calls terraform destroy with the right cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-cloud-teardown-"));
    // Bootstrap a working dir first
    await deployCloud({ config: defaultCloudConfig("aws", "us-east-1"), workingDir: dir });
    const calls: string[][] = [];
    const runner: CloudRunner = async (argv) => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await teardownCloud({
      config: defaultCloudConfig("aws", "us-east-1"),
      workingDir: dir,
      runner,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("destroy");
    expect(calls[0]).toContain("-auto-approve");
  });
});

describe("recipesRoot + summariseDeploy + sanity", () => {
  test("recipesRoot lives inside the package", () => {
    expect(recipesRoot()).toMatch(/crewhaus-cloud\/recipes$/);
  });

  test("summariseDeploy emits readable lines", () => {
    const summary = summariseDeploy({
      workingDir: "/tmp/x",
      steps: [{ name: "terraform-init" }, { name: "terraform-apply", skipped: true }],
      outputs: { cluster_endpoint: "https://eks.example" },
    });
    expect(summary).toContain("/tmp/x");
    expect(summary).toContain("ok  terraform-init");
    expect(summary).toContain("skip  terraform-apply");
    expect(summary).toContain("cluster_endpoint = https://eks.example");
  });
});
