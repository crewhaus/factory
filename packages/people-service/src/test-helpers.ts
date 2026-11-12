/**
 * Test-only: an admin over a temp Hangar root, with the real control service writing
 * its receipts to Home's workspace ledger, as the CLI wires it.
 */
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandReceipt, mintId } from "@crewhaus/control-contract";
import { foldStates } from "@crewhaus/control-records";
import { type ControlService, receiptOf, wireControl } from "@crewhaus/control-service";
import {
  type OpenVaultOptions,
  type SecretsPort,
  type Vault,
  openVault,
} from "@crewhaus/people/vault";
import { type PeopleAdmin, type ReceiptsPort, createPeopleAdmin } from "./admin";

const made: string[] = [];

export function removeTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function fakeSecrets(): SecretsPort & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    async get({ service, name }) {
      return items.get(`${service}|${name}`) ?? null;
    },
    async set({ service, name, value }) {
      items.set(`${service}|${name}`, value);
    },
    async delete({ service, name }) {
      return items.delete(`${service}|${name}`);
    },
  };
}

export type Clock = { now: () => number; advance(ms: number): void };

export function fakeClock(start = Date.parse("2026-11-12T09:00:00.000Z")): Clock {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

export type Fixture = {
  readonly hangarRoot: string;
  readonly vaultRoot: string;
  readonly owner: string;
  readonly secrets: ReturnType<typeof fakeSecrets>;
  readonly clock: Clock;
  readonly control: ControlService;
  readonly receipts: ReceiptsPort;
  readonly vault: Vault;
  readonly admin: PeopleAdmin;
  /** An admin acting as someone else, over the same vault and ledger. */
  as(principal: string, extra?: Partial<OpenVaultOptions>): PeopleAdmin;
  /** Every receipt in the workspace ledger, as it stands. */
  receiptsNow(): CommandReceipt[];
};

export async function fixture(
  options: {
    readonly custody?: "keychain" | "environment" | "file";
    readonly setUp?: boolean;
  } & Partial<OpenVaultOptions> = {},
): Promise<Fixture> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "people-service-")));
  made.push(base);
  const hangarRoot = join(base, "hangar");
  const vaultRoot = join(hangarRoot, "people");
  const owner = mintId("prn");
  const secrets = fakeSecrets();
  const clock = fakeClock();
  const control = wireControl(
    {
      hangarRoot,
      identity: { username: "sam", hostname: "laptop" },
      now: clock.now,
      probe: { isAlive: () => true, startTimeMs: () => undefined },
      supervisorFor: () => undefined,
      drainRequest: () => async () => undefined,
    },
    { mode: "direct" },
  );
  const receipts: ReceiptsPort = (request, effect) => control.commands.submit(request, effect);
  const open = (extra: Partial<OpenVaultOptions> = {}): Vault => {
    const vault = openVault({
      root: vaultRoot,
      secrets,
      env: { CREWHAUS_PEOPLE_SPACE_KEY: "ab".repeat(32) },
      now: clock.now,
      ...options,
      ...extra,
    });
    if (!vault.ok) throw new Error(vault.reason);
    return vault;
  };
  const vault = open();
  const as = (principal: string, extra: Partial<OpenVaultOptions> = {}): PeopleAdmin =>
    createPeopleAdmin({ vault: open(extra), receipts, actor: principal, now: clock.now });
  const admin = createPeopleAdmin({ vault, receipts, actor: owner, now: clock.now });
  if (options.setUp !== false) {
    const done = await admin.setup({ custody: options.custody ?? "keychain" });
    if (!done.ok) throw new Error(done.message);
  }
  return {
    hangarRoot,
    vaultRoot,
    owner,
    secrets,
    clock,
    control,
    receipts,
    vault,
    admin,
    as,
    receiptsNow() {
      const fold = foldStates(control.ledgers.workspace());
      if (!fold.ok) return [];
      return [...fold.objects.values()].map((found) => receiptOf(found.record));
    },
  };
}

/** Every regular file under `dir`. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) out.push(...filesUnder(path));
    else if (stats.isFile()) out.push(path);
  }
  return out;
}

export function scan(roots: readonly string[], marker: string): { hits: string[]; files: number } {
  const hits: string[] = [];
  let files = 0;
  for (const root of roots) {
    for (const file of filesUnder(root)) {
      files++;
      if (readFileSync(file).includes(Buffer.from(marker))) hits.push(file);
    }
  }
  return { hits, files };
}

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

/** Throw unless the answer is ok, and hand back its value. */
export function ok<T>(
  answer: { ok: true; value: T } | { ok: false; message: string; reason: string },
): T {
  if (!answer.ok) throw new Error(`${answer.reason}: ${answer.message}`);
  return answer.value;
}
