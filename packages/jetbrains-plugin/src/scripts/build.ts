import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * @crewhaus/jetbrains-plugin/scripts/build — Section 35
 *
 * Two responsibilities the bun-side build serves:
 *
 *   1. Validate plugin.xml structurally (parse it, assert it declares
 *      the right extension points, action IDs, and schema provider).
 *      This runs in workspace `bun test` so the marketplace bundle
 *      can't drift undetected.
 *
 *   2. Build the gradle bundle. Gates on JBR_BIN env. When JBR is
 *      absent (the common dev case) the function returns
 *      `{ skipped: true, reason }` so callers don't have to special-case.
 */
import { CrewhausError } from "@crewhaus/errors";

export class JetbrainsPluginError extends CrewhausError {
  override readonly name = "JetbrainsPluginError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

// Walk up from this file to the nearest package.json. Source layout is
// `src/scripts/build.ts` (2 levels deep); `tsc -b` flattens to `dist/build.js`
// (1 level deep). A marker-based walk handles both without hard-coding depth.
function findPackageRoot(start: string): string {
  let cur = start;
  while (cur !== dirname(cur)) {
    if (existsSync(join(cur, "package.json"))) return cur;
    cur = dirname(cur);
  }
  throw new JetbrainsPluginError(`package.json not found above ${start}`);
}
const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_XML_PATH = join(PACKAGE_ROOT, "src", "main", "resources", "META-INF", "plugin.xml");
const BUILD_GRADLE_PATH = join(PACKAGE_ROOT, "build.gradle.kts");

export function packageRoot(): string {
  return PACKAGE_ROOT;
}

export function pluginXmlPath(): string {
  return PLUGIN_XML_PATH;
}

/** Read plugin.xml from disk. */
export function readPluginXml(): string {
  if (!existsSync(PLUGIN_XML_PATH)) {
    throw new JetbrainsPluginError(`plugin.xml missing at ${PLUGIN_XML_PATH}`);
  }
  return readFileSync(PLUGIN_XML_PATH, "utf8");
}

/** Read build.gradle.kts from disk. */
export function readBuildGradle(): string {
  if (!existsSync(BUILD_GRADLE_PATH)) {
    throw new JetbrainsPluginError(`build.gradle.kts missing at ${BUILD_GRADLE_PATH}`);
  }
  return readFileSync(BUILD_GRADLE_PATH, "utf8");
}

export type PluginXmlFingerprint = {
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly extensionImplementations: readonly string[];
  readonly toolWindowIds: readonly string[];
  readonly actionIds: readonly string[];
  readonly configurationTypeImpls: readonly string[];
  readonly dependencies: readonly string[];
};

/**
 * Parse plugin.xml structurally — XML-light, regex-based, focused on
 * the slots IntelliJ requires for the plugin to load. Production
 * marketplace publishing always re-validates with the JBR-bundled
 * `verifyPlugin` task; this layer just catches local drift.
 */
export function fingerprintPluginXml(text: string): PluginXmlFingerprint {
  const id = text.match(/<id>([^<]+)<\/id>/)?.[1];
  const name = text.match(/<name>([^<]+)<\/name>/)?.[1];
  const extensions: string[] = [];
  for (const m of text.matchAll(/implementation="([^"]+)"/g)) {
    extensions.push(m[1] ?? "");
  }
  const factories: string[] = [];
  for (const m of text.matchAll(/factoryClass="([^"]+)"/g)) {
    factories.push(m[1] ?? "");
  }
  const toolWindowIds: string[] = [];
  for (const m of text.matchAll(/<toolWindow\s+id="([^"]+)"/g)) {
    toolWindowIds.push(m[1] ?? "");
  }
  const actionIds: string[] = [];
  for (const m of text.matchAll(/<action\s+id="([^"]+)"/g)) {
    actionIds.push(m[1] ?? "");
  }
  const configurationTypeImpls: string[] = [];
  for (const m of text.matchAll(/<configurationType\s+implementation="([^"]+)"/g)) {
    configurationTypeImpls.push(m[1] ?? "");
  }
  const dependencies: string[] = [];
  for (const m of text.matchAll(/<depends>([^<]+)<\/depends>/g)) {
    dependencies.push(m[1] ?? "");
  }
  return {
    id,
    name,
    extensionImplementations: [...extensions, ...factories],
    toolWindowIds,
    actionIds,
    configurationTypeImpls,
    dependencies,
  };
}

export type BuildPluginRunner = (
  argv: readonly string[],
  cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type BuildPluginOptions = {
  readonly jbrBin?: string;
  /** Test injection point. */
  readonly runner?: BuildPluginRunner;
};

export type BuildPluginResult =
  | { readonly skipped: true; readonly reason: string }
  | {
      readonly skipped: false;
      readonly outPath: string;
      readonly buildArgv: readonly string[];
    };

/**
 * Run `./gradlew buildPlugin`. Returns `{skipped:true,...}` when JBR is
 * absent so callers can branch without a try/catch.
 */
export async function buildPlugin(opts: BuildPluginOptions = {}): Promise<BuildPluginResult> {
  const jbr = opts.jbrBin ?? process.env["JBR_BIN"];
  if (!jbr) {
    return {
      skipped: true,
      reason: "JBR_BIN not set; gradle build skipped (marketplace publish runs in CI)",
    };
  }
  const argv: string[] = ["./gradlew", "buildPlugin"];
  const runner = opts.runner ?? defaultRunner;
  const { exitCode, stderr } = await runner(argv, PACKAGE_ROOT);
  if (exitCode !== 0) {
    throw new JetbrainsPluginError(
      `gradle buildPlugin exited with ${exitCode}: ${stderr.slice(0, 1024)}`,
    );
  }
  // Convention: gradle outputs to build/distributions/<name>-<version>.zip
  return {
    skipped: false,
    outPath: join(PACKAGE_ROOT, "build", "distributions"),
    buildArgv: argv,
  };
}

const defaultRunner: BuildPluginRunner = async (argv, cwd) => {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve_) => {
    const head = argv[0] ?? "./gradlew";
    const child = spawn(head, argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", (e) =>
      resolve_({ exitCode: 1, stdout: "", stderr: String((e as Error).message) }),
    );
    child.on("close", (code) =>
      resolve_({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
};

// ─── Kotlin source layout helpers ───────────────────────────────────────────

export function kotlinSourceFiles(): readonly string[] {
  const root = join(PACKAGE_ROOT, "src", "main", "kotlin");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && p.endsWith(".kt")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

export function kotlinSourceSize(path: string): number {
  return statSync(path).size;
}
