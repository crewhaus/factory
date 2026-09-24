import type { RegisteredTool } from "@crewhaus/tool-catalog";
/**
 * How `crewhaus run`, `crewhaus eval` and the `crewhaus tools` commands load a
 * builtin tool: WHICH tool lives in which package comes from the one builtin
 * table in `@crewhaus/tool-categories`; this file only knows how to import a
 * package.
 *
 * Why a table of package loaders instead of `import(entry.package)`: the CLI
 * also ships as a single binary built with `bun build --compile`, which embeds
 * a module only when its specifier is a literal it can see. A computed
 * `import(name)` works from a checkout and fails in the binary. One literal
 * loader per PACKAGE keeps the binary whole without restating any tool.
 *
 * `apps/cli/src/tool-registry.test.ts` holds this table to the builtin table
 * in both directions: every package a cli-shape builtin lives in has a
 * loader, and every loader is such a package. `scripts/wire-tool-package.ts`
 * adds the line for a new package.
 */
import { BUILTIN_TOOLS } from "@crewhaus/tool-categories";

type ToolModule = Record<string, unknown>;

export const TOOL_PACKAGE_LOADERS: Readonly<Record<string, () => Promise<ToolModule>>> = {
  "@crewhaus/tool-approvals": () => import("@crewhaus/tool-approvals"),
  "@crewhaus/tool-bash": () => import("@crewhaus/tool-bash"),
  "@crewhaus/tool-buildperf": () => import("@crewhaus/tool-buildperf"),
  "@crewhaus/tool-capability": () => import("@crewhaus/tool-capability"),
  "@crewhaus/tool-chaincall": () => import("@crewhaus/tool-chaincall"),
  "@crewhaus/tool-chainread": () => import("@crewhaus/tool-chainread"),
  "@crewhaus/tool-changeset": () => import("@crewhaus/tool-changeset"),
  "@crewhaus/tool-code": () => import("@crewhaus/tool-code"),
  "@crewhaus/tool-code-execution": () => import("@crewhaus/tool-code-execution"),
  "@crewhaus/tool-codegraph": () => import("@crewhaus/tool-codegraph"),
  "@crewhaus/tool-codehost": () => import("@crewhaus/tool-codehost"),
  "@crewhaus/tool-containers": () => import("@crewhaus/tool-containers"),
  "@crewhaus/tool-crewhaus": () => import("@crewhaus/tool-crewhaus"),
  "@crewhaus/tool-cron": () => import("@crewhaus/tool-cron"),
  "@crewhaus/tool-data": () => import("@crewhaus/tool-data"),
  "@crewhaus/tool-dataset": () => import("@crewhaus/tool-dataset"),
  "@crewhaus/tool-datetime": () => import("@crewhaus/tool-datetime"),
  "@crewhaus/tool-defi": () => import("@crewhaus/tool-defi"),
  "@crewhaus/tool-deploy": () => import("@crewhaus/tool-deploy"),
  "@crewhaus/tool-desktop": () => import("@crewhaus/tool-desktop"),
  "@crewhaus/tool-discovery": () => import("@crewhaus/tool-discovery"),
  "@crewhaus/tool-distribution": () => import("@crewhaus/tool-distribution"),
  "@crewhaus/tool-docs": () => import("@crewhaus/tool-docs"),
  "@crewhaus/tool-document-ingest": () => import("@crewhaus/tool-document-ingest"),
  "@crewhaus/tool-einvoice": () => import("@crewhaus/tool-einvoice"),
  "@crewhaus/tool-encode": () => import("@crewhaus/tool-encode"),
  "@crewhaus/tool-evalops": () => import("@crewhaus/tool-evalops"),
  "@crewhaus/tool-fetch": () => import("@crewhaus/tool-fetch"),
  "@crewhaus/tool-fleet": () => import("@crewhaus/tool-fleet"),
  "@crewhaus/tool-flow": () => import("@crewhaus/tool-flow"),
  "@crewhaus/tool-fs": () => import("@crewhaus/tool-fs"),
  "@crewhaus/tool-fsx": () => import("@crewhaus/tool-fsx"),
  "@crewhaus/tool-git": () => import("@crewhaus/tool-git"),
  "@crewhaus/tool-host": () => import("@crewhaus/tool-host"),
  "@crewhaus/tool-hostfs": () => import("@crewhaus/tool-hostfs"),
  "@crewhaus/tool-html": () => import("@crewhaus/tool-html"),
  "@crewhaus/tool-http": () => import("@crewhaus/tool-http"),
  "@crewhaus/tool-image": () => import("@crewhaus/tool-image"),
  "@crewhaus/tool-image-generation": () => import("@crewhaus/tool-image-generation"),
  "@crewhaus/tool-kyc": () => import("@crewhaus/tool-kyc"),
  "@crewhaus/tool-ledger": () => import("@crewhaus/tool-ledger"),
  "@crewhaus/tool-lifecycle": () => import("@crewhaus/tool-lifecycle"),
  "@crewhaus/tool-math": () => import("@crewhaus/tool-math"),
  "@crewhaus/tool-media": () => import("@crewhaus/tool-media"),
  "@crewhaus/tool-money": () => import("@crewhaus/tool-money"),
  "@crewhaus/tool-notify": () => import("@crewhaus/tool-notify"),
  "@crewhaus/tool-objectstore": () => import("@crewhaus/tool-objectstore"),
  "@crewhaus/tool-obs": () => import("@crewhaus/tool-obs"),
  "@crewhaus/tool-onchain": () => import("@crewhaus/tool-onchain"),
  "@crewhaus/tool-pkg": () => import("@crewhaus/tool-pkg"),
  "@crewhaus/tool-pkgmgr": () => import("@crewhaus/tool-pkgmgr"),
  "@crewhaus/tool-proc": () => import("@crewhaus/tool-proc"),
  "@crewhaus/tool-registry": () => import("@crewhaus/tool-registry"),
  "@crewhaus/tool-routing": () => import("@crewhaus/tool-routing"),
  "@crewhaus/tool-schema": () => import("@crewhaus/tool-schema"),
  "@crewhaus/tool-secrets": () => import("@crewhaus/tool-secrets"),
  "@crewhaus/tool-secure": () => import("@crewhaus/tool-secure"),
  "@crewhaus/tool-specops": () => import("@crewhaus/tool-specops"),
  "@crewhaus/tool-sql": () => import("@crewhaus/tool-sql"),
  "@crewhaus/tool-state": () => import("@crewhaus/tool-state"),
  "@crewhaus/tool-supplychain": () => import("@crewhaus/tool-supplychain"),
  "@crewhaus/tool-table": () => import("@crewhaus/tool-table"),
  "@crewhaus/tool-text": () => import("@crewhaus/tool-text"),
  "@crewhaus/tool-todo": () => import("@crewhaus/tool-todo"),
  "@crewhaus/tool-token": () => import("@crewhaus/tool-token"),
  "@crewhaus/tool-verify": () => import("@crewhaus/tool-verify"),
  "@crewhaus/tool-web": () => import("@crewhaus/tool-web"),
};

/** Import one tool package through its literal loader. */
export async function importToolPackage(pkg: string): Promise<ToolModule> {
  const load = TOOL_PACKAGE_LOADERS[pkg];
  if (load === undefined) {
    throw new Error(
      `the crewhaus CLI has no loader for ${pkg} — add it to TOOL_PACKAGE_LOADERS in apps/cli/src/tool-packages.ts (scripts/wire-tool-package.ts does this)`,
    );
  }
  return load();
}

/**
 * Resolve builtin keys to their `RegisteredTool`s. Every package involved is
 * imported once, in parallel. A key that is not a builtin, or a package that
 * no longer exports what the table says, throws — naming the key.
 */
export async function loadBuiltinTools(
  keys: ReadonlyArray<string>,
): Promise<Record<string, RegisteredTool>> {
  const packages = new Set<string>();
  for (const key of keys) {
    const entry = BUILTIN_TOOLS[key];
    if (entry === undefined) throw new Error(`"${key}" is not a builtin tool`);
    packages.add(entry.package);
  }
  const modules = new Map(
    await Promise.all(
      [...packages].map(async (pkg) => [pkg, await importToolPackage(pkg)] as const),
    ),
  );
  const map: Record<string, RegisteredTool> = {};
  for (const key of keys) {
    const entry = BUILTIN_TOOLS[key];
    if (entry === undefined) continue;
    const tool = modules.get(entry.package)?.[entry.export] as RegisteredTool | undefined;
    if (tool === undefined || typeof tool.name !== "string") {
      throw new Error(
        `${entry.package} does not export the tool "${entry.export}" that the builtin table names for "${key}"`,
      );
    }
    map[key] = tool;
  }
  return map;
}
