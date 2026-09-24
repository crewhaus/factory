/**
 * Every builtin tool, loaded — for the guard tests that hold a property over
 * all of them (operativeArgs, egress sinks, the justification rule, the
 * auto-mode and read-only-process lists).
 *
 * The set is read from the code, never written out: every tool
 * `BUILTIN_TOOL_MAP` compiles in, loaded the way a bundle loads it, plus every
 * `export const …: RegisteredTool` in a `packages/tool-*` package. The second
 * half catches the builtins other targets emit and the CLI's map leaves out
 * (`SendMessage`, `EvmSendTransaction`, the chain readers). Test-only: nothing
 * in the CLI imports this.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TOOL_MAP } from "@crewhaus/target-cli";
import type { RegisteredTool } from "@crewhaus/tool-catalog";

export type LoadedBuiltins = {
  /** One entry per registered name. */
  readonly tools: ReadonlyArray<RegisteredTool>;
  /** The package each tool came from, by registered name. */
  readonly packageOf: ReadonlyMap<string, string>;
  /** How many the CLI's builtin map contributed — the sweep's hit count. */
  readonly fromMap: number;
  /** How many `export const …: RegisteredTool` the package scan found. */
  readonly fromPackages: number;
};

const packagesDir = join(import.meta.dir, "..", "..", "..", "packages");

export async function loadAllBuiltinTools(): Promise<LoadedBuiltins> {
  const byName = new Map<string, RegisteredTool>();
  const packageOf = new Map<string, string>();
  for (const entry of Object.values(BUILTIN_TOOL_MAP)) {
    const mod = (await import(entry.package)) as Record<string, unknown>;
    const tool = mod[entry.export] as RegisteredTool | undefined;
    if (tool === undefined) continue;
    byName.set(tool.name, tool);
    packageOf.set(tool.name, entry.package);
  }
  const fromMap = byName.size;
  let fromPackages = 0;
  for (const dir of readdirSync(packagesDir).filter((d) => d.startsWith("tool-"))) {
    const entry = join(packagesDir, dir, "src", "index.ts");
    if (!existsSync(entry)) continue;
    const exported = [
      ...readFileSync(entry, "utf-8").matchAll(/^export const ([A-Za-z0-9_]+): RegisteredTool\b/gm),
    ].map((m) => m[1] as string);
    if (exported.length === 0) continue;
    const mod = (await import(entry)) as Record<string, unknown>;
    for (const name of exported) {
      const tool = mod[name] as RegisteredTool | undefined;
      if (tool === undefined) continue;
      fromPackages++;
      if (!byName.has(tool.name)) {
        byName.set(tool.name, tool);
        packageOf.set(tool.name, `@crewhaus/${dir}`);
      }
    }
  }
  return { tools: [...byName.values()], packageOf, fromMap, fromPackages };
}
