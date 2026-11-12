/**
 * Regenerate `apps/cli/verbs.json`: the CLI's verb inventory (every legacy
 * verb in `apps/cli/src/verbs.ts` and every family module's `CLI_FAMILY`), for
 * readers outside this repository that need to know which commands exist
 * without running the CLI.
 *
 * The file carries no CLI version, so a release never changes it; it changes
 * only when a verb, a sub-verb or a flag does. `apps/cli/src/verbs.test.ts`
 * fails when the checked-in file no longer matches the inventory.
 *
 *   bun scripts/generate-verbs-json.ts           write the file
 *   bun scripts/generate-verbs-json.ts --check   exit 1 if it is out of date
 *
 * The output is formatted with the repository's pinned biome, because
 * `biome check .` formats JSON too and would reject `JSON.stringify` output.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFamilies } from "../apps/cli/src/__test__/families";
import { composeInventory, inventoryDocument } from "../apps/cli/src/verbs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REL = join("apps", "cli", "verbs.json");
const OUT = join(REPO_ROOT, REL);
const BIOME = join(REPO_ROOT, "node_modules", ".bin", "biome");

/** `text` as the pinned biome formats a file at `apps/cli/verbs.json`. */
function biomeFormat(text: string): string {
  const result = Bun.spawnSync([BIOME, "format", `--stdin-file-path=${REL}`], {
    cwd: REPO_ROOT,
    stdin: new TextEncoder().encode(text),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`biome format failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

const document = inventoryDocument(composeInventory(await loadFamilies()));
const formatted = biomeFormat(`${JSON.stringify(document, null, 2)}\n`);

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== formatted) {
    process.stderr.write(`${REL} is out of date: run bun scripts/generate-verbs-json.ts\n`);
    process.exit(1);
  }
  process.stdout.write(`${REL} is current (${document.verbs.length} verbs)\n`);
} else {
  writeFileSync(OUT, formatted);
  process.stdout.write(`wrote ${REL} (${document.verbs.length} verbs)\n`);
}
