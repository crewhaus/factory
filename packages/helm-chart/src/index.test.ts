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
});

describe("renderChart() — full render per shape (T1)", () => {
  for (const target of TARGET_SHAPES) {
    test(`${target}: deployment.yaml is a Deployment with the right image + replicas`, () => {
      const out = renderChart({ ...defaultValues(), target, replicas: 2 });
      expect(out["deployment.yaml"]).toContain("kind: Deployment");
      expect(out["deployment.yaml"]).toContain(`crewhaus/${target}:`);
      expect(out["deployment.yaml"]).toContain("replicas: 2");
      expect(out["deployment.yaml"]).toContain("livenessProbe");
    });
  }

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
