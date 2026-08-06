/**
 * Compile-time-embedded bodies of the chart's `helm/crewhaus/templates/*`
 * files.
 *
 * The `with { type: "text" }` import attribute makes Bun inline each file's
 * text: on the interpreter path (`bun`/`bunx`) it reads the file from disk at
 * module load, and under `bun build --compile` it bakes the text into the
 * standalone binary's `/$bunfs` image. Either way, no `readdirSync`/
 * `readFileSync` of a package-relative path runs at render time.
 *
 * That runtime read is exactly what broke `crewhaus cloud deploy` on every
 * PUBLISHED channel, in two different ways at once:
 *
 *   - the compiled binary derived `TEMPLATES_DIR` from `import.meta.url`,
 *     which resolves under `/$bunfs` where the chart was never present, so
 *     rendering threw `templates directory missing at
 *     /$bunfs/helm/crewhaus/templates`;
 *   - the npm tarball omitted the directory outright, because this package's
 *     `files` array listed only `src`, so the same read failed against a real
 *     but absent `node_modules/@crewhaus/helm-chart/helm/`.
 *
 * Neither reproduced in CI, which runs from a source checkout where
 * `packages/helm-chart/helm/` is on disk — the same blind spot that let the
 * `default-skills` ENOENT ship in 0.3.0.
 *
 * The checked-in chart files stay the single source of truth; this module only
 * re-exports their text keyed by filename, so there is no second copy to
 * drift. `helm/` is now also in `files`, so a published consumer can still
 * `helm install` the real chart from `chartRoot()` — that path is for humans
 * and tooling, and is no longer what rendering depends on.
 */
import helpersTpl from "../helm/crewhaus/templates/_helpers.tpl" with { type: "text" };
import deploymentYaml from "../helm/crewhaus/templates/deployment.yaml" with { type: "text" };
import ingressYaml from "../helm/crewhaus/templates/ingress.yaml" with { type: "text" };
import otelCollectorYaml from "../helm/crewhaus/templates/otel-collector.yaml" with {
  type: "text",
};
import serviceYaml from "../helm/crewhaus/templates/service.yaml" with { type: "text" };
import serviceMonitorYaml from "../helm/crewhaus/templates/servicemonitor.yaml" with {
  type: "text",
};

/**
 * Template filename → body. Insertion order is the sorted order
 * `readdirSync().sort()` used to produce, so `templateFiles()` keeps returning
 * the same sequence and rendered output stays byte-stable across this change.
 */
export const TEMPLATE_BODIES: Readonly<Record<string, string>> = {
  "_helpers.tpl": helpersTpl,
  "deployment.yaml": deploymentYaml,
  "ingress.yaml": ingressYaml,
  "otel-collector.yaml": otelCollectorYaml,
  "service.yaml": serviceYaml,
  "servicemonitor.yaml": serviceMonitorYaml,
};
