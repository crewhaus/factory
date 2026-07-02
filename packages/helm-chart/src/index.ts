import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGET_SHAPES, type TargetShape, isTargetShape } from "@crewhaus/docker-images";
/**
 * Section 32 — `@crewhaus/helm-chart`
 *
 * Kubernetes Helm chart for crewhaus deployments. Ships:
 *   - The chart itself under `helm/crewhaus/` (Chart.yaml, values.yaml,
 *     templates/, _helpers.tpl) — installable via `helm install`.
 *   - `renderChart()` — a tiny in-process renderer that supports the
 *     subset of helm's templating used in our templates (just enough
 *     to assert structural correctness in unit tests without requiring
 *     `helm` in CI).
 *   - `validateValues()` — Zod-free runtime validator for the
 *     values.yaml schema.
 *
 * The in-process renderer is intentionally minimal — it handles
 * variable interpolation (`{{ .Values.foo }}`), the `if`/`else`/`end`
 * directive, the `has` and `eq` predicates, the `quote` and `nindent`
 * filters, and the `include` template call. It does **not** replace
 * helm; the production install path is `helm install crewhaus
 * helm/crewhaus -f values.yaml`.
 */
import { CrewhausError } from "@crewhaus/errors";

export class HelmChartError extends CrewhausError {
  override readonly name = "HelmChartError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHART_ROOT = join(PACKAGE_ROOT, "helm", "crewhaus");
const TEMPLATES_DIR = join(CHART_ROOT, "templates");

export function chartRoot(): string {
  return CHART_ROOT;
}

export function templateFiles(): readonly string[] {
  if (!existsSync(TEMPLATES_DIR)) {
    throw new HelmChartError(`templates directory missing at ${TEMPLATES_DIR}`);
  }
  return readdirSync(TEMPLATES_DIR)
    .filter((f) => /\.(ya?ml|tpl)$/.test(f))
    .sort();
}

export function readTemplate(name: string): string {
  if (name.includes("/") || name.includes("..")) {
    throw new HelmChartError(`invalid template name: ${name}`);
  }
  const path = join(TEMPLATES_DIR, name);
  if (!existsSync(path)) {
    throw new HelmChartError(`template not found: ${name}`);
  }
  return readFileSync(path, "utf8");
}

// ─── Values shape ────────────────────────────────────────────────────────────

export type ChartValues = {
  readonly target: TargetShape;
  readonly nameOverride?: string;
  readonly image: {
    readonly repository?: string;
    readonly tag: string;
    /**
     * Optional content-digest pin (`sha256:<64 hex>`, as recorded in
     * packages/docker-images/docker/digests.json — item 47). When set, the
     * Deployment references `crewhaus/<target>@sha256:...` and `tag` is
     * ignored: reproducible, tamper-evident deploys. Unset → tag-based ref.
     */
    readonly digest?: string;
    readonly pullPolicy: "IfNotPresent" | "Always" | "Never";
    readonly pullSecrets: ReadonlyArray<{ readonly name: string }>;
  };
  readonly replicas: number;
  readonly spec: { readonly configMap: string; readonly fileName: string };
  readonly secrets: {
    readonly anthropic?: { readonly secretName: string; readonly key: string };
    readonly slack?: {
      readonly signing: { readonly secretName: string; readonly key: string };
      readonly bot: { readonly secretName: string; readonly key: string };
    };
    /**
     * Generic provider secret list — one container env var per entry,
     * each sourced from a Kubernetes Secret. The escape hatch for
     * non-Anthropic models (OPENAI_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY,
     * AWS_BEARER_TOKEN_BEDROCK/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, …).
     * Presets are documented in values.yaml.
     */
    readonly provider?: ReadonlyArray<{
      readonly name: string;
      readonly secretName: string;
      readonly key: string;
    }>;
  };
  /**
   * Plain (non-secret) env vars appended to the container — provider
   * region/endpoint selectors like AWS_REGION, OPENAI_BASE_URL,
   * GOOGLE_CLOUD_PROJECT.
   */
  readonly extraEnv?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly service: {
    readonly type: "ClusterIP" | "LoadBalancer" | "NodePort";
    readonly port: number;
    readonly targetPort: number;
  };
  readonly ingress: {
    readonly enabled: boolean;
    readonly className: string;
    readonly annotations: Readonly<Record<string, string>>;
    readonly hosts: ReadonlyArray<{
      readonly host: string;
      readonly paths: ReadonlyArray<{ readonly path: string; readonly pathType: string }>;
    }>;
    readonly tls: ReadonlyArray<{ readonly hosts: readonly string[]; readonly secretName: string }>;
  };
  readonly otel: { readonly enabled: boolean; readonly endpoint: string; readonly headers: string };
  readonly serviceMonitor: {
    readonly enabled: boolean;
    readonly interval: string;
    readonly labels: Readonly<Record<string, string>>;
  };
  readonly podSecurityContext: Readonly<Record<string, unknown>>;
  readonly securityContext: Readonly<Record<string, unknown>>;
  readonly resources: Readonly<Record<string, unknown>>;
};

export function defaultValues(): ChartValues {
  return {
    target: "channel",
    image: { tag: "latest", pullPolicy: "IfNotPresent", pullSecrets: [] },
    replicas: 1,
    spec: { configMap: "crewhaus-spec", fileName: "crewhaus.yaml" },
    secrets: {
      anthropic: { secretName: "crewhaus-creds", key: "ANTHROPIC_AUTH_TOKEN" },
      slack: {
        signing: { secretName: "crewhaus-creds", key: "SLACK_SIGNING_SECRET" },
        bot: { secretName: "crewhaus-creds", key: "SLACK_BOT_TOKEN" },
      },
      provider: [],
    },
    extraEnv: [],
    service: { type: "ClusterIP", port: 80, targetPort: 3000 },
    ingress: {
      enabled: false,
      className: "",
      annotations: {},
      hosts: [],
      tls: [],
    },
    otel: { enabled: true, endpoint: "", headers: "" },
    serviceMonitor: { enabled: true, interval: "30s", labels: {} },
    podSecurityContext: {
      runAsNonRoot: true,
      runAsUser: 10001,
      fsGroup: 10001,
    },
    securityContext: {
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    },
    resources: {
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: "1000m", memory: "1Gi" },
    },
  };
}

export function validateValues(values: ChartValues): void {
  if (!isTargetShape(values.target)) {
    throw new HelmChartError(
      `unknown target: ${values.target} (allowed: ${TARGET_SHAPES.join(", ")})`,
    );
  }
  if (values.replicas < 0 || !Number.isInteger(values.replicas)) {
    throw new HelmChartError(`replicas must be a non-negative integer; got ${values.replicas}`);
  }
  if (values.service.port <= 0 || values.service.port > 65535) {
    throw new HelmChartError(`service.port out of range: ${values.service.port}`);
  }
  if (!values.image.tag) {
    throw new HelmChartError("image.tag must be non-empty");
  }
  if (values.image.digest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(values.image.digest)) {
    throw new HelmChartError(
      `image.digest must be "sha256:<64 hex>" (as recorded in docker/digests.json); got ${JSON.stringify(
        values.image.digest,
      )}`,
    );
  }
  for (const entry of values.secrets.provider ?? []) {
    if (!entry.name || !entry.secretName || !entry.key) {
      throw new HelmChartError(
        `secrets.provider entries need name + secretName + key; got ${JSON.stringify(entry)}`,
      );
    }
  }
  for (const entry of values.extraEnv ?? []) {
    if (!entry.name || typeof entry.value !== "string") {
      throw new HelmChartError(
        `extraEnv entries need name + string value; got ${JSON.stringify(entry)}`,
      );
    }
  }
}

// ─── Minimal helm-shape renderer ─────────────────────────────────────────────

export type RenderContext = {
  readonly Values: ChartValues;
  readonly Release: { readonly Name: string; readonly Service: string };
  readonly Chart: { readonly Name: string; readonly AppVersion: string };
};

export function renderContext(values: ChartValues, releaseName = "crewhaus"): RenderContext {
  return {
    Values: values,
    Release: { Name: releaseName, Service: "Helm" },
    Chart: { Name: "crewhaus", AppVersion: "1.0.0" },
  };
}

const DAEMON_SHAPES = ["channel", "managed", "crew", "voice", "browser"];

/**
 * Tokenise a template into actions and literals so we can do depth-aware
 * matching of nested if/range/with blocks (regex won't cut it once the
 * templates nest).
 */
type Token = { kind: "text"; value: string } | { kind: "action"; value: string };

function tokenise(text: string): Token[] {
  const out: Token[] = [];
  // Strip helm comments first
  const stripped = text.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, "");
  const re = /\{\{-?\s*([\s\S]*?)\s*-?\}\}/g;
  let last = 0;
  let m = re.exec(stripped);
  while (m !== null) {
    if (m.index > last) out.push({ kind: "text", value: stripped.slice(last, m.index) });
    out.push({ kind: "action", value: (m[1] ?? "").trim() });
    last = m.index + m[0].length;
    m = re.exec(stripped);
  }
  if (last < stripped.length) out.push({ kind: "text", value: stripped.slice(last) });
  return out;
}

type Node =
  | { kind: "text"; value: string }
  | { kind: "expr"; expr: string }
  | { kind: "if"; cond: string; consequent: Node[]; alternate: Node[] }
  | { kind: "range"; expr: string; body: Node[] }
  | { kind: "with"; expr: string; body: Node[] }
  | { kind: "define"; name: string; body: Node[] }
  | { kind: "include"; name: string; filter?: { name: string; arg?: string } };

function parseAst(tokens: Token[]): Node[] {
  const it = { i: 0 };
  return parseUntil(tokens, it, []);
}

function parseUntil(tokens: Token[], it: { i: number }, stoppers: string[]): Node[] {
  const nodes: Node[] = [];
  while (it.i < tokens.length) {
    const tok = tokens[it.i];
    if (tok === undefined) break;
    if (tok.kind === "text") {
      nodes.push({ kind: "text", value: tok.value });
      it.i++;
      continue;
    }
    const action = tok.value;
    if (stoppers.includes(actionKeyword(action))) {
      return nodes;
    }
    it.i++;
    const kw = actionKeyword(action);
    if (kw === "if") {
      const cond = action.slice(2).trim();
      const thenBranch = parseUntil(tokens, it, ["else", "end"]);
      let elseBranch: Node[] = [];
      const next = tokens[it.i];
      if (next && next.kind === "action" && actionKeyword(next.value) === "else") {
        it.i++;
        elseBranch = parseUntil(tokens, it, ["end"]);
      }
      if (it.i < tokens.length) it.i++;
      nodes.push({ kind: "if", cond, consequent: thenBranch, alternate: elseBranch });
    } else if (kw === "range") {
      const expr = action.slice(5).trim();
      const body = parseUntil(tokens, it, ["end"]);
      if (it.i < tokens.length) it.i++;
      nodes.push({ kind: "range", expr, body });
    } else if (kw === "with") {
      const expr = action.slice(4).trim();
      const body = parseUntil(tokens, it, ["end"]);
      if (it.i < tokens.length) it.i++;
      nodes.push({ kind: "with", expr, body });
    } else if (kw === "define") {
      const m = /^define\s+"([^"]+)"\s*$/.exec(action);
      const name = m?.[1] ?? "";
      const body = parseUntil(tokens, it, ["end"]);
      if (it.i < tokens.length) it.i++;
      nodes.push({ kind: "define", name, body });
    } else if (kw === "include") {
      const m = /^include\s+"([^"]+)"\s+\.\s*(?:\|\s*(\w+)(?:\s+(\S+))?)?\s*$/.exec(action);
      if (m) {
        const name = m[1] ?? "";
        nodes.push({
          kind: "include",
          name,
          filter: m[2] ? { name: m[2], arg: m[3] } : undefined,
        });
      }
    } else if (kw === "end" || kw === "else") {
      // Stray; drop.
    } else {
      nodes.push({ kind: "expr", expr: action });
    }
  }
  return nodes;
}

function actionKeyword(action: string): string {
  return action.split(/\s+/)[0] ?? "";
}

function renderNodes(nodes: Node[], ctx: RenderContext, defines: Map<string, Node[]>): string {
  let out = "";
  for (const n of nodes) {
    switch (n.kind) {
      case "text":
        out += n.value;
        break;
      case "expr":
        out += renderExpr(n.expr, ctx);
        break;
      case "if": {
        const cond = evalExpression(n.cond, ctx);
        out += renderNodes(cond ? n.consequent : n.alternate, ctx, defines);
        break;
      }
      case "range": {
        const list = evalExpression(n.expr, ctx);
        if (Array.isArray(list)) {
          for (const item of list) {
            const itemCtx = withDot(ctx, item);
            out += renderNodes(n.body, itemCtx, defines);
          }
        }
        break;
      }
      case "with": {
        const value = evalExpression(n.expr, ctx);
        if (value && (typeof value !== "object" || Object.keys(value as object).length > 0)) {
          const itemCtx = withDot(ctx, value);
          out += renderNodes(n.body, itemCtx, defines);
        }
        break;
      }
      case "define":
        defines.set(n.name, n.body);
        break;
      case "include": {
        const body = defines.get(n.name);
        let rendered =
          body === undefined ? `<missing:${n.name}>` : renderNodes(body, ctx, defines).trim();
        const indentArg = n.filter?.arg;
        if (n.filter?.name === "nindent" && indentArg) {
          rendered = `\n${rendered
            .split("\n")
            .map((l) => " ".repeat(Number(indentArg)) + l)
            .join("\n")}`;
        }
        out += rendered;
        break;
      }
    }
  }
  return out;
}

function renderExpr(expr: string, ctx: RenderContext): string {
  const m = /^(.+?)(?:\s*\|\s*(\w+)(?:\s+(\S+))?)?$/.exec(expr.trim());
  if (!m || !m[1]) return "";
  const value = evalExpression(m[1].trim(), ctx);
  const filter = m[2];
  const arg = m[3];
  let s = stringifyValue(value);
  switch (filter) {
    case "quote":
      s = JSON.stringify(s);
      break;
    case "upper":
      s = s.toUpperCase();
      break;
    case "trunc":
      if (arg) s = s.slice(0, Number(arg));
      break;
    case "trimSuffix":
      if (arg) {
        const suffix = JSON.parse(arg);
        s = s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
      }
      break;
    case "nindent":
      if (arg)
        s = `\n${s
          .split("\n")
          .map((l) => " ".repeat(Number(arg)) + l)
          .join("\n")}`;
      break;
    case "toYaml":
      s = simpleYaml(value, 0);
      break;
  }
  return s;
}

function withDot(ctx: RenderContext, dot: unknown): RenderContext {
  return { ...ctx, _dot: dot } as unknown as RenderContext;
}

/**
 * Render a single template against (values + release) → YAML string.
 * Supports define/include/if/else/range/with and the filters used in our templates.
 */
export function renderTemplate(
  text: string,
  ctx: RenderContext,
  defines: Map<string, Node[]> = new Map(),
): string {
  const tokens = tokenise(text);
  const ast = parseAst(tokens);
  return renderNodes(ast, ctx, defines);
}

function evalExpression(expr: string, ctx: RenderContext): unknown {
  // Function-style helpers we support: has X (list ...), eq A B, default A B, and pipelines like (list ...).
  const trimmed = expr.trim();

  // has X (list ...)
  const hasMatch = /^has\s+([^()]+?)\s*\(\s*list\s+(.+)\s*\)\s*$/.exec(trimmed);
  if (hasMatch?.[1] && hasMatch[2]) {
    const target = stringifyValue(evalExpression(hasMatch[1].trim(), ctx));
    const items = parseListLiteral(hasMatch[2]);
    return items.includes(target);
  }

  // and A B / and A B C
  if (/^and\s+/.test(trimmed)) {
    const parts = splitTopLevel(trimmed.slice(4));
    return parts.every((p) => Boolean(evalExpression(p, ctx)));
  }
  if (/^or\s+/.test(trimmed)) {
    const parts = splitTopLevel(trimmed.slice(3));
    return parts.some((p) => Boolean(evalExpression(p, ctx)));
  }

  // eq A B
  const eqMatch = /^eq\s+(.+?)\s+(.+)$/.exec(trimmed);
  if (eqMatch?.[1] && eqMatch[2]) {
    return (
      stringifyValue(evalExpression(eqMatch[1].trim(), ctx)) ===
      stringifyValue(evalExpression(eqMatch[2].trim(), ctx))
    );
  }

  // default A B
  const defMatch = /^default\s+(.+?)\s+(.+)$/.exec(trimmed);
  if (defMatch?.[1] && defMatch[2]) {
    const fallback = evalExpression(defMatch[1].trim(), ctx);
    const value = evalExpression(defMatch[2].trim(), ctx);
    return value === undefined || value === null || value === "" ? fallback : value;
  }

  // (list ...) literal
  if (/^\(\s*list\s/.test(trimmed)) {
    return parseListLiteral(trimmed.replace(/^\(\s*list\s+/, "").replace(/\s*\)$/, ""));
  }

  // String literal
  if (/^".*"$/.test(trimmed)) return JSON.parse(trimmed);

  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  // .Values.foo / .Release.Name / .Chart.Name dot path
  if (trimmed.startsWith(".")) {
    return resolveDotPath(trimmed, ctx);
  }

  // Bare identifier (could be a chart helper we ignore) → return the literal string
  return trimmed;
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === " " && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.filter((s) => s.length > 0);
}

function parseListLiteral(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"/g;
  let m = re.exec(text);
  while (m !== null) {
    out.push(m[1] ?? "");
    m = re.exec(text);
  }
  return out;
}

function resolveDotPath(path: string, ctx: RenderContext): unknown {
  const dotCtx = (ctx as unknown as { _dot?: unknown })._dot;
  if (path === "." || path === "") return dotCtx ?? ctx;
  // `.foo.bar` reads from `_dot` first if present, else from ctx.
  const parts = path.replace(/^\./, "").split(".");
  let cur: unknown = dotCtx ?? ctx;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else if (dotCtx && ctx && typeof ctx === "object" && p in (ctx as Record<string, unknown>)) {
      // Fall back to outer context for absolute paths after we lost track in $-iter.
      cur = (ctx as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function stringifyValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(stringifyValue).join(",");
  return JSON.stringify(v);
}

function simpleYaml(v: unknown, indent: number): string {
  const pad = " ".repeat(indent);
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return v.map((item) => `${pad}- ${simpleYaml(item, indent + 2).trimStart()}`).join("\n");
  }
  if (typeof v === "object") {
    const entries = Object.entries(v);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, val]) => {
        const inner = simpleYaml(val, indent + 2);
        if (inner.includes("\n")) return `${pad}${k}:\n${inner}`;
        return `${pad}${k}: ${inner}`;
      })
      .join("\n");
  }
  return String(v);
}

// ─── High-level API: render all templates for a values set ───────────────────

export function renderChart(values: ChartValues, releaseName = "crewhaus"): Record<string, string> {
  validateValues(values);
  const ctx = renderContext(values, releaseName);
  const defines = new Map<string, Node[]>();
  // Pre-load every helpers file so include() resolves.
  for (const file of templateFiles()) {
    if (file.endsWith(".tpl")) {
      // Drains define blocks into the shared map but produces no output.
      renderTemplate(readTemplate(file), ctx, defines);
    }
  }
  const result: Record<string, string> = {};
  for (const file of templateFiles()) {
    if (file.endsWith(".tpl")) continue;
    result[file] = renderTemplate(readTemplate(file), ctx, defines).trim();
  }
  return result;
}

/** Daemon shapes that get a Service + Ingress rendered. */
export function isDaemonShape(target: TargetShape): boolean {
  return DAEMON_SHAPES.includes(target);
}
