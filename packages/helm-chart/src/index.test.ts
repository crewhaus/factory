import { describe, expect, test } from "bun:test";
import { TARGET_SHAPES } from "@crewhaus/docker-images";

import {
  HelmChartError,
  chartRoot,
  defaultValues,
  isDaemonShape,
  readTemplate,
  renderChart,
  renderContext,
  renderTemplate,
  templateFiles,
  validateValues,
} from "./index";

describe("chart on disk", () => {
  test("Chart.yaml + values.yaml + templates/ exist", () => {
    expect(chartRoot()).toMatch(/helm-chart\/helm\/crewhaus$/);
    const files = templateFiles();
    expect(files).toContain("deployment.yaml");
    expect(files).toContain("service.yaml");
    expect(files).toContain("ingress.yaml");
    expect(files).toContain("servicemonitor.yaml");
    expect(files).toContain("otel-collector.yaml");
    expect(files).toContain("_helpers.tpl");
  });

  test("readTemplate refuses traversal", () => {
    expect(() => readTemplate("../../../etc/passwd")).toThrow(HelmChartError);
    expect(() => readTemplate("nope.yaml")).toThrow(/template not found/);
  });
});

describe("defaultValues + validateValues", () => {
  test("default values pass validation", () => {
    expect(() => validateValues(defaultValues())).not.toThrow();
  });

  test("rejects unknown target", () => {
    const v = { ...defaultValues(), target: "bogus" } as never;
    expect(() => validateValues(v)).toThrow(/unknown target/);
  });

  test("rejects negative replicas + invalid port + empty tag", () => {
    expect(() => validateValues({ ...defaultValues(), replicas: -1 })).toThrow();
    expect(() =>
      validateValues({ ...defaultValues(), service: { ...defaultValues().service, port: 0 } }),
    ).toThrow();
    expect(() =>
      validateValues({ ...defaultValues(), image: { ...defaultValues().image, tag: "" } }),
    ).toThrow();
  });

  test("rejects an empty, whitespace-carrying, or trailing-slash image.registry (F3)", () => {
    for (const bad of ["", "ghcr.io/crewhaus/", "ghcr .io/crewhaus", "ghcr.io/crew\nhaus"]) {
      expect(() =>
        validateValues({
          ...defaultValues(),
          image: { ...defaultValues().image, registry: bad },
        }),
      ).toThrow(/image\.registry/);
    }
  });

  test("accepts a well-formed image.digest and rejects malformed ones", () => {
    const good = `sha256:${"ab".repeat(32)}`;
    expect(() =>
      validateValues({ ...defaultValues(), image: { ...defaultValues().image, digest: good } }),
    ).not.toThrow();
    for (const bad of ["latest", "sha256:short", `sha512:${"ab".repeat(32)}`, ""]) {
      expect(() =>
        validateValues({ ...defaultValues(), image: { ...defaultValues().image, digest: bad } }),
      ).toThrow(/image\.digest/);
    }
  });
});

describe("isDaemonShape", () => {
  test("daemon shapes are channel/managed/crew/voice/browser", () => {
    expect(isDaemonShape("channel")).toBe(true);
    expect(isDaemonShape("managed")).toBe(true);
    expect(isDaemonShape("crew")).toBe(true);
    expect(isDaemonShape("voice")).toBe(true);
    expect(isDaemonShape("browser")).toBe(true);
  });

  test("non-daemon shapes do not get a Service rendered", () => {
    expect(isDaemonShape("cli")).toBe(false);
    expect(isDaemonShape("workflow")).toBe(false);
    expect(isDaemonShape("graph")).toBe(false);
    expect(isDaemonShape("pipeline")).toBe(false);
    expect(isDaemonShape("research")).toBe(false);
    expect(isDaemonShape("batch")).toBe(false);
    expect(isDaemonShape("eval")).toBe(false);
  });
});

describe("renderTemplate primitives (T1)", () => {
  test("variable interpolation", () => {
    const ctx = renderContext(defaultValues(), "smoke");
    expect(renderTemplate("name: {{ .Release.Name }}", ctx)).toBe("name: smoke");
  });

  test("if true / if false branches", () => {
    const ctx = renderContext({
      ...defaultValues(),
      serviceMonitor: { enabled: true, interval: "30s", labels: {} },
    });
    expect(
      renderTemplate("{{ if .Values.serviceMonitor.enabled }}YES{{ else }}NO{{ end }}", ctx),
    ).toContain("YES");
    const ctxOff = renderContext({
      ...defaultValues(),
      serviceMonitor: { enabled: false, interval: "30s", labels: {} },
    });
    expect(
      renderTemplate("{{ if .Values.serviceMonitor.enabled }}YES{{ else }}NO{{ end }}", ctxOff),
    ).toContain("NO");
  });

  test("has X (list ...) predicate", () => {
    const ctxChannel = renderContext({ ...defaultValues(), target: "channel" });
    expect(
      renderTemplate(
        '{{ if has .Values.target (list "channel" "managed") }}DAEMON{{ end }}',
        ctxChannel,
      ),
    ).toContain("DAEMON");
    const ctxCli = renderContext({ ...defaultValues(), target: "cli" });
    expect(
      renderTemplate(
        '{{ if has .Values.target (list "channel" "managed") }}DAEMON{{ end }}',
        ctxCli,
      ),
    ).not.toContain("DAEMON");
  });

  test("eq predicate", () => {
    const ctx = renderContext({ ...defaultValues(), target: "channel" });
    expect(renderTemplate('{{ if eq .Values.target "channel" }}YES{{ end }}', ctx)).toContain(
      "YES",
    );
  });

  test("quote filter wraps strings in double quotes", () => {
    const ctx = renderContext({ ...defaultValues(), target: "channel" });
    expect(renderTemplate("{{ .Values.target | quote }}", ctx)).toBe(`"channel"`);
  });

  // `and`/`or` operands are split at top-level spaces; the mini-evaluator
  // resolves bare boolean dot-paths per operand. (Parenthesised operands are
  // only special-cased for has/list, so we use plain boolean paths here.)
  test("and predicate is true only when every operand is truthy", () => {
    const bothOn = renderContext({
      ...defaultValues(),
      ingress: { ...defaultValues().ingress, enabled: true },
      otel: { enabled: true, endpoint: "", headers: "" },
    });
    expect(
      renderTemplate("{{ if and .Values.ingress.enabled .Values.otel.enabled }}A{{ end }}", bothOn),
    ).toBe("A");
    const oneOff = renderContext({
      ...defaultValues(),
      ingress: { ...defaultValues().ingress, enabled: true },
      otel: { enabled: false, endpoint: "", headers: "" },
    });
    expect(
      renderTemplate(
        "{{ if and .Values.ingress.enabled .Values.otel.enabled }}A{{ else }}N{{ end }}",
        oneOff,
      ),
    ).toBe("N");
  });

  test("or predicate is true when any operand is truthy", () => {
    // first operand false, second true → true
    const oneOn = renderContext({
      ...defaultValues(),
      ingress: { ...defaultValues().ingress, enabled: false },
      otel: { enabled: true, endpoint: "", headers: "" },
    });
    expect(
      renderTemplate("{{ if or .Values.ingress.enabled .Values.otel.enabled }}O{{ end }}", oneOn),
    ).toBe("O");
    // every operand false → false (exercises the else arm)
    const allOff = renderContext({
      ...defaultValues(),
      ingress: { ...defaultValues().ingress, enabled: false },
      otel: { enabled: false, endpoint: "", headers: "" },
    });
    expect(
      renderTemplate(
        "{{ if or .Values.ingress.enabled .Values.otel.enabled }}O{{ else }}N{{ end }}",
        allOff,
      ),
    ).toBe("N");
  });
});

describe("renderChart() — full render per shape (T1)", () => {
  for (const target of TARGET_SHAPES) {
    test(`${target}: deployment.yaml is a Deployment with the right image + replicas`, () => {
      const out = renderChart({ ...defaultValues(), target, replicas: 2 });
      expect(out["deployment.yaml"]).toContain("kind: Deployment");
      // F3 regression: the default image ref points at ghcr.io/crewhaus —
      // where the release workflow publishes. A bare `crewhaus/<target>`
      // would resolve to docker.io, where nothing is ever pushed.
      expect(out["deployment.yaml"]).toContain(`ghcr.io/crewhaus/${target}:`);
      expect(out["deployment.yaml"]).toContain("replicas: 2");
      expect(out["deployment.yaml"]).toContain("livenessProbe");
    });
  }

  test("image.digest pins the container image by registry digest (item 47)", () => {
    const digest = `sha256:${"ab".repeat(32)}`;
    const out = renderChart({
      ...defaultValues(),
      target: "channel",
      image: { ...defaultValues().image, digest },
    });
    expect(out["deployment.yaml"]).toContain(`image: "ghcr.io/crewhaus/channel@${digest}"`);
    expect(out["deployment.yaml"]).not.toContain("crewhaus/channel:");
  });

  test("without image.digest the tag-based image reference is unchanged", () => {
    const out = renderChart({ ...defaultValues(), target: "cli" });
    expect(out["deployment.yaml"]).toContain('image: "ghcr.io/crewhaus/cli:latest"');
    expect(out["deployment.yaml"]).not.toContain("@sha256:");
  });

  test("image.registry is configurable — tag form (F3)", () => {
    const out = renderChart({
      ...defaultValues(),
      target: "cli",
      image: { ...defaultValues().image, registry: "registry.example.com/mirror", tag: "1.2.3" },
    });
    expect(out["deployment.yaml"]).toContain('image: "registry.example.com/mirror/cli:1.2.3"');
    expect(out["deployment.yaml"]).not.toContain('image: "ghcr.io');
  });

  test("image.registry is configurable — digest form (F3)", () => {
    const digest = `sha256:${"cd".repeat(32)}`;
    const out = renderChart({
      ...defaultValues(),
      target: "channel",
      image: { ...defaultValues().image, registry: "registry.example.com/mirror", digest },
    });
    expect(out["deployment.yaml"]).toContain(
      `image: "registry.example.com/mirror/channel@${digest}"`,
    );
    expect(out["deployment.yaml"]).not.toContain('image: "ghcr.io');
  });

  test("daemon shape (channel) renders Service", () => {
    const out = renderChart({ ...defaultValues(), target: "channel" });
    expect(out["service.yaml"]).toContain("kind: Service");
    expect(out["service.yaml"]).toContain("port: 80");
  });

  test("non-daemon shape (cli) does NOT render Service", () => {
    const out = renderChart({ ...defaultValues(), target: "cli" });
    expect(out["service.yaml"]?.includes("kind: Service")).toBeFalsy();
  });

  test("ServiceMonitor render gates on serviceMonitor.enabled", () => {
    const enabled = renderChart({ ...defaultValues(), target: "channel" });
    expect(enabled["servicemonitor.yaml"]).toContain("kind: ServiceMonitor");
    const disabled = renderChart({
      ...defaultValues(),
      target: "channel",
      serviceMonitor: { enabled: false, interval: "30s", labels: {} },
    });
    expect(disabled["servicemonitor.yaml"]?.includes("kind: ServiceMonitor")).toBeFalsy();
  });

  test("OTel ConfigMap renders only when otel.enabled", () => {
    const enabled = renderChart({ ...defaultValues(), target: "channel" });
    expect(enabled["otel-collector.yaml"]).toContain("kind: ConfigMap");
    const disabled = renderChart({
      ...defaultValues(),
      target: "channel",
      otel: { enabled: false, endpoint: "", headers: "" },
    });
    expect(disabled["otel-collector.yaml"]?.includes("kind: ConfigMap")).toBeFalsy();
  });

  test("channel deployment wires Slack secret env vars", () => {
    const out = renderChart({ ...defaultValues(), target: "channel" });
    expect(out["deployment.yaml"]).toContain("SLACK_SIGNING_SECRET");
    expect(out["deployment.yaml"]).toContain("SLACK_BOT_TOKEN");
  });

  test("cli deployment does NOT wire Slack env vars", () => {
    const out = renderChart({ ...defaultValues(), target: "cli" });
    expect(out["deployment.yaml"]).not.toContain("SLACK_SIGNING_SECRET");
  });
});

describe("provider secrets + extraEnv (provider-agnostic deployments)", () => {
  test("secrets.provider entries render as secretKeyRef env vars", () => {
    const base = defaultValues();
    const out = renderChart({
      ...base,
      target: "cli",
      secrets: {
        ...base.secrets,
        provider: [
          { name: "OPENAI_API_KEY", secretName: "crewhaus-creds", key: "OPENAI_API_KEY" },
          { name: "GEMINI_API_KEY", secretName: "gemini-creds", key: "api-key" },
        ],
      },
    });
    const d = out["deployment.yaml"] ?? "";
    expect(d).toContain("- name: OPENAI_API_KEY");
    expect(d).toContain("name: crewhaus-creds");
    expect(d).toContain("- name: GEMINI_API_KEY");
    expect(d).toContain("name: gemini-creds");
    expect(d).toContain("key: api-key");
  });

  test("extraEnv entries render as plain name/value env vars (quoted)", () => {
    const out = renderChart({
      ...defaultValues(),
      target: "cli",
      extraEnv: [
        { name: "AWS_REGION", value: "us-east-1" },
        { name: "OPENAI_BASE_URL", value: "http://vllm.internal:8000/v1" },
      ],
    });
    const d = out["deployment.yaml"] ?? "";
    expect(d).toContain("- name: AWS_REGION");
    expect(d).toContain('value: "us-east-1"');
    expect(d).toContain("- name: OPENAI_BASE_URL");
    expect(d).toContain('value: "http://vllm.internal:8000/v1"');
  });

  test("default (empty) provider/extraEnv lists render nothing extra", () => {
    const out = renderChart({ ...defaultValues(), target: "cli" });
    const d = out["deployment.yaml"] ?? "";
    expect(d).not.toContain("OPENAI_API_KEY");
    expect(d).not.toContain("AWS_REGION");
  });

  test("validateValues rejects malformed provider/extraEnv entries", () => {
    const base = defaultValues();
    expect(() =>
      validateValues({
        ...base,
        secrets: {
          ...base.secrets,
          provider: [{ name: "OPENAI_API_KEY", secretName: "", key: "k" }],
        },
      }),
    ).toThrow(HelmChartError);
    expect(() =>
      validateValues({
        ...base,
        extraEnv: [{ name: "", value: "x" }],
      }),
    ).toThrow(HelmChartError);
  });

  test("non-daemon exec probes call doctor --liveness (plain doctor always failed in-pod)", () => {
    const out = renderChart({ ...defaultValues(), target: "cli" });
    const d = out["deployment.yaml"] ?? "";
    expect(d).toContain('["bun", "/app/crewhaus.js", "doctor", "--liveness"]');
    expect(d).not.toContain('"doctor"]');
    // Daemon shapes keep their httpGet probes untouched.
    const daemon = renderChart({ ...defaultValues(), target: "channel" });
    expect(daemon["deployment.yaml"]).toContain("path: /healthz");
    expect(daemon["deployment.yaml"]).not.toContain("--liveness");
  });
});

describe("range / with bind dot (withDot)", () => {
  // The `range` body re-binds `.` to each item; `.host` then resolves off
  // the per-item dot rather than the outer context. This exercises withDot()
  // and the resolveDotPath `_dot` branch.
  test("range over a non-empty list rebinds `.` to each element", () => {
    const ctx = renderContext({
      ...defaultValues(),
      ingress: {
        ...defaultValues().ingress,
        hosts: [
          { host: "a.example.com", paths: [] },
          { host: "b.example.com", paths: [] },
        ],
      },
    });
    const out = renderTemplate("{{ range .Values.ingress.hosts }}host={{ .host }};{{ end }}", ctx);
    expect(out).toBe("host=a.example.com;host=b.example.com;");
  });

  test("range over an empty list yields nothing (no withDot call)", () => {
    const ctx = renderContext({ ...defaultValues() });
    const out = renderTemplate("{{ range .Values.ingress.hosts }}X{{ end }}", ctx);
    expect(out).toBe("");
  });

  test("with binds `.` to a non-empty object", () => {
    const ctx = renderContext({
      ...defaultValues(),
      ingress: {
        ...defaultValues().ingress,
        annotations: { "kubernetes.io/ingress.class": "nginx" },
      },
    });
    // Non-empty object → `with` body executes and dot is rebound via withDot().
    expect(renderTemplate("{{ with .Values.ingress.annotations }}IN{{ end }}", ctx)).toBe("IN");
  });

  test("with skips an empty object (falsy guard, no withDot call)", () => {
    const ctx = renderContext({ ...defaultValues() });
    // The mini-renderer's `with` has no else arm — the whole body (incl. any
    // stray `else`) is skipped when the value is an empty object, so we get "".
    expect(renderTemplate("{{ with .Values.ingress.annotations }}IN{{ end }}", ctx)).toBe("");
  });
});

describe("toYaml filter (simpleYaml)", () => {
  // toYaml is only reachable as a *pipe* filter: `{{ X | toYaml }}`. (The
  // chart templates' `{{- toYaml . | nindent N }}` head form is treated as a
  // literal by this mini-renderer, which is why simpleYaml was uncovered.)
  test("renders a nested object with multiline children", () => {
    // .Values.resources is { requests: {...}, limits: {...} } — exercises the
    // object branch, the nested-object (inner includes '\n') branch, strings,
    // and the recursive descent.
    const ctx = renderContext({ ...defaultValues() });
    const out = renderTemplate("{{ .Values.resources | toYaml }}", ctx);
    expect(out).toContain("requests:");
    expect(out).toContain('cpu: "100m"');
    expect(out).toContain('memory: "256Mi"');
    expect(out).toContain("limits:");
    expect(out).toContain('cpu: "1000m"');
  });

  test("renders booleans and numbers unquoted", () => {
    const ctx = renderContext({
      ...defaultValues(),
      podSecurityContext: { runAsNonRoot: true, runAsUser: 10001 },
    });
    const out = renderTemplate("{{ .Values.podSecurityContext | toYaml }}", ctx);
    expect(out).toContain("runAsNonRoot: true");
    expect(out).toContain("runAsUser: 10001");
  });

  test("renders a non-empty array as YAML list items", () => {
    const ctx = renderContext({
      ...defaultValues(),
      image: {
        ...defaultValues().image,
        pullSecrets: [{ name: "regcred" }, { name: "ghcr" }],
      },
    });
    const out = renderTemplate("{{ .Values.image.pullSecrets | toYaml }}", ctx);
    expect(out).toContain('- name: "regcred"');
    expect(out).toContain('- name: "ghcr"');
  });

  test("renders an empty array as []", () => {
    const ctx = renderContext({ ...defaultValues() });
    // defaultValues().image.pullSecrets is [].
    expect(renderTemplate("{{ .Values.image.pullSecrets | toYaml }}", ctx)).toBe("[]");
  });

  test("renders an empty object as {}", () => {
    const ctx = renderContext({ ...defaultValues() });
    // defaultValues().serviceMonitor.labels is {}.
    expect(renderTemplate("{{ .Values.serviceMonitor.labels | toYaml }}", ctx)).toBe("{}");
  });

  test("renders a missing path (undefined) as null", () => {
    const ctx = renderContext({ ...defaultValues() });
    expect(renderTemplate("{{ .Values.doesNotExist | toYaml }}", ctx)).toBe("null");
  });

  test("renders a nested array-of-objects (recursive list + object branch)", () => {
    const ctx = renderContext({
      ...defaultValues(),
      ingress: {
        ...defaultValues().ingress,
        tls: [{ hosts: ["a.example.com", "b.example.com"], secretName: "tls-cert" }],
      },
    });
    const out = renderTemplate("{{ .Values.ingress.tls | toYaml }}", ctx);
    expect(out).toContain('secretName: "tls-cert"');
    // hosts is a string array nested under an object inside a list item.
    expect(out).toContain("a.example.com");
    expect(out).toContain("b.example.com");
  });
});

/**
 * The chart is EMBEDDED at build time (`embedded.ts`), not read from disk at
 * render time. That distinction is the whole fix for a bug that shipped from
 * at least 0.4.2 through 0.5.0: a package-relative read fails under `/$bunfs`
 * in the compiled binary AND against an npm tarball that omitted `helm/`.
 *
 * These tests guard the two ways the embedding can silently rot. Neither can
 * catch a broken *binary* — only the release workflow's compiled smoke does
 * that — but they catch the authoring mistake that causes it.
 */
describe("embedded chart templates", () => {
  test("every template on disk is embedded — adding one without wiring it fails here", async () => {
    const { readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const onDisk = readdirSync(join(chartRoot(), "templates"))
      .filter((f) => /\.(ya?ml|tpl)$/.test(f))
      .sort();
    // templateFiles() now serves the embedded map; if the two ever diverge,
    // rendering silently drops (or invents) a manifest.
    expect([...templateFiles()].sort()).toEqual(onDisk);
  });

  test("each embedded body is byte-identical to its file on disk", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const name of templateFiles()) {
      expect(readTemplate(name)).toBe(readFileSync(join(chartRoot(), "templates", name), "utf8"));
    }
  });

  test("readTemplate still refuses traversal and unknown names", () => {
    expect(() => readTemplate("../values.yaml")).toThrow(HelmChartError);
    expect(() => readTemplate("nope.yaml")).toThrow(HelmChartError);
  });
});
