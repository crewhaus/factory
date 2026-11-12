/**
 * Every verb family the CLI has: each `<verb>-cmd.ts` module beside this
 * directory that exports `CLI_FAMILY`, imported for real.
 *
 * A module without one (`knowledge-edit-cmd.ts`, `services-cmd.ts`) is fine
 * only because its name is not a family's dispatch label: `verbs.test.ts`
 * holds every label that is not a legacy row to a module that exports one, so
 * there is no list of modules to exempt here.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CliFamily } from "../verbs";

export const CLI_SRC = join(import.meta.dir, "..");

/** The `<verb>-cmd.ts` file names in the CLI's source directory. */
export function familyModuleFiles(): readonly string[] {
  return readdirSync(CLI_SRC)
    .filter((name) => name.endsWith("-cmd.ts") && !name.endsWith(".test.ts"))
    .sort();
}

/** Each module's `CLI_FAMILY` export, with the file it came from. */
export async function loadFamilyModules(): Promise<
  ReadonlyArray<{ readonly file: string; readonly family: CliFamily }>
> {
  const out: Array<{ file: string; family: CliFamily }> = [];
  for (const file of familyModuleFiles()) {
    const mod = (await import(join(CLI_SRC, file))) as { CLI_FAMILY?: CliFamily };
    if (mod.CLI_FAMILY !== undefined) out.push({ file, family: mod.CLI_FAMILY });
  }
  return out;
}

/** Every `CLI_FAMILY` the CLI's modules export. */
export async function loadFamilies(): Promise<readonly CliFamily[]> {
  return (await loadFamilyModules()).map((m) => m.family);
}
