/** Test-only: temp vault roots, a fake credential store, and a byte scanner. */
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import type { SecretsPort } from "./custody";
import { type OpenVaultOptions, type Vault, openVault } from "./vault";

const made: string[] = [];

export function tempDir(prefix = "people-vault-"): string {
  // The real path: macOS's tmpdir is a link, and the root check reads physical paths.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A credential store in memory, with switches for an unreachable one. */
export function fakeSecrets(): SecretsPort & {
  readonly items: Map<string, string>;
  throwing: boolean;
} {
  const items = new Map<string, string>();
  const store = {
    items,
    throwing: false,
    async get({ service, name }: { service: string; name: string }) {
      if (store.throwing) throw new Error("no secret service");
      return items.get(`${service}|${name}`) ?? null;
    },
    async set({ service, name, value }: { service: string; name: string; value: string }) {
      if (store.throwing) throw new Error("no secret service");
      items.set(`${service}|${name}`, value);
    },
    async delete({ service, name }: { service: string; name: string }) {
      if (store.throwing) throw new Error("no secret service");
      return items.delete(`${service}|${name}`);
    },
  };
  return store;
}

export const OWNER = mintId("prn");

export function mustOpen(options: OpenVaultOptions): Vault {
  const vault = openVault(options);
  if (!vault.ok) throw new Error(vault.reason);
  return vault;
}

/** A ready keychain vault in a fresh temp directory. */
export async function readyVault(
  extra: Partial<OpenVaultOptions> = {},
): Promise<{ vault: Vault; root: string; secrets: ReturnType<typeof fakeSecrets>; base: string }> {
  const base = tempDir();
  const root = join(base, "hangar", "people");
  const secrets = fakeSecrets();
  const vault = mustOpen({ root, secrets, ...extra });
  await vault.setUp({ custody: extra.custody ?? "keychain", owner: OWNER });
  return { vault, root, secrets, base };
}

/** Every regular file under `dir`, recursively. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) out.push(...filesUnder(path));
    else if (stats.isFile()) out.push(path);
  }
  return out;
}

/** Which files under the roots hold `marker`, and how many files were read. */
export function scan(roots: readonly string[], marker: string): { hits: string[]; files: number } {
  const hits: string[] = [];
  let files = 0;
  const needle = Buffer.from(marker);
  for (const root of roots) {
    for (const file of filesUnder(root)) {
      files++;
      if (readFileSync(file).includes(needle)) hits.push(file);
    }
  }
  return { hits, files };
}

/** Bytes and modification time of every file under the roots. */
export function snapshot(roots: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const root of roots) {
    for (const file of filesUnder(root)) {
      const stats = statSync(file);
      out.set(file, `${stats.mtimeMs}|${readFileSync(file).toString("base64")}`);
    }
  }
  return out;
}
