/** Fixtures for this package's tests. Not compiled, not published. */
import {
  type Dirent,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAccessSetUp, localActorOf } from "@crewhaus/access-control";
import { type CommandReceipt, mintId } from "@crewhaus/control-contract";
import { type LeaseProbe, type Ledger, append } from "@crewhaus/control-records";
import type { HarnessSupervisor, StartResult, StopResult } from "@crewhaus/harness-supervisor";
import {
  type PendingApproval,
  createPendingApprovalStore,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import type { AreaRuntime } from "./executor";
import { type ControlService, wireControl } from "./wire";

const roots: string[] = [];

export function tempDir(name = "control-service-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), name)));
  roots.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const HOST = hostname();
export const NOW = Date.parse("2026-11-11T12:00:00.000Z");
/** A boot long before NOW, so nothing in a test predates it unless the test says so. */
export const BOOTED = NOW - 86_400_000;
export const IDENTITY = { username: "sam", hostname: "laptop" } as const;

/** A probe over a table of pids: absent is gone, `undefined` alive is unanswered. */
export function fakeProbe(
  table: Record<number, { readonly alive: boolean | undefined; readonly start?: number }> = {},
): LeaseProbe & { set(pid: number, row: { alive: boolean | undefined; start?: number }): void } {
  const rows = new Map(Object.entries(table).map(([pid, row]) => [Number(pid), row]));
  return {
    isAlive: (pid) => (rows.has(pid) ? rows.get(pid)?.alive : false),
    startTimeMs: (pid) => rows.get(pid)?.start,
    set: (pid, row) => rows.set(pid, row),
  };
}

export type FakeSupervisor = HarnessSupervisor & {
  readonly calls: string[];
  startAnswer: StartResult;
  stopAnswer: StopResult;
  /** Held before a verb answers, when set. */
  hold?: Promise<void>;
};

export function fakeSupervisor(): FakeSupervisor {
  const calls: string[] = [];
  const sup = {
    calls,
    startAnswer: { ok: true, runId: "run_0000000000000001", pid: 77 } as StartResult,
    stopAnswer: { stopped: true, forced: false } as StopResult,
    hold: undefined as Promise<void> | undefined,
    async adoptIfRunfile() {
      calls.push("adopt");
      return "none" as const;
    },
    async start() {
      calls.push("start");
      await sup.hold;
      return sup.startAnswer;
    },
    async restart() {
      calls.push("restart");
      await sup.hold;
      return sup.startAnswer;
    },
    async stop() {
      calls.push("stop");
      await sup.hold;
      return sup.stopAnswer;
    },
    async drain(request: () => Promise<void>) {
      calls.push("drain");
      await request().catch(() => undefined);
      return sup.stopAnswer;
    },
    close() {
      calls.push("close");
    },
  };
  return sup as unknown as FakeSupervisor;
}

export type Rig = {
  readonly hangarRoot: string;
  readonly harness: string;
  readonly service: ControlService;
  readonly supervisor: FakeSupervisor;
  readonly probe: ReturnType<typeof fakeProbe>;
  readonly warnings: string[];
  readonly clock: { now: number };
};

/** A service over a temp Home and one temp harness, with a fake probe and supervisor. */
export function rig(
  options: {
    readonly mode?: "server" | "resident" | "direct";
    readonly pid?: number;
    readonly probe?: ReturnType<typeof fakeProbe>;
    readonly areas?: readonly AreaRuntime[];
    readonly hostBootedAt?: number;
    readonly hangarRoot?: string;
    readonly harness?: string;
    readonly harnessDirs?: () => readonly string[];
    readonly authorizeActor?: (
      actor: string,
      permission: string,
      target: string,
      credentialRef?: string,
    ) => boolean | undefined;
  } = {},
): Rig {
  const hangarRoot = options.hangarRoot ?? tempDir("control-service-home-");
  const harness = options.harness ?? tempDir("control-service-harness-");
  const pid = options.pid ?? 1000;
  const probe = options.probe ?? fakeProbe({ [pid]: { alive: true, start: BOOTED + 1000 } });
  const supervisor = fakeSupervisor();
  const warnings: string[] = [];
  const clock = { now: NOW };
  const service = wireControl(
    {
      hangarRoot,
      harnessDirOf: () => harness,
      harnessDirs: options.harnessDirs ?? (() => [harness]),
      supervisorFor: () => supervisor,
      drainRequest: () => async () => undefined,
      identity: IDENTITY,
      now: () => clock.now,
      probe,
      hostBootedAt: () => options.hostBootedAt ?? BOOTED,
      pid,
      host: HOST,
      onWarn: (m) => warnings.push(m),
      ...(options.authorizeActor !== undefined ? { authorizeActor: options.authorizeActor } : {}),
    },
    {
      mode: options.mode ?? "direct",
      ...(options.areas !== undefined ? { areas: options.areas } : {}),
    },
  );
  HOME_OF.set(harness, hangarRoot);
  return { hangarRoot, harness, service, supervisor, probe, warnings, clock };
}

/** The Home root each rig's harness was made with: the root its projection names by default. */
const HOME_OF = new Map<string, string>();

/** Every line of every segment of a ledger, in order. */
export function rowsOf(ledger: Ledger): Record<string, unknown>[] {
  if (!("dir" in ledger.records)) throw new Error("segmented ledgers only");
  const dir = join(ledger.root, ledger.records.dir);
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => /^\d{6}\.jsonl$/.test(n))
      .sort();
  } catch {
    return [];
  }
  return names.flatMap((name) =>
    readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

/** Every byte under a directory, path by path: what "nothing changed" compares. */
export function treeBytes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(path, readFileSync(path, "latin1"));
    }
  };
  walk(dir);
  return out;
}

/**
 * Plant a receipt as a dead process would have left it: an `accepted` row, then, for any
 * other state, a row in that state (a fold applies only an entry state first).
 */
export function plantReceipt(
  ledger: Ledger,
  receipt: Partial<CommandReceipt> & { id: string },
): void {
  if (receipt.state !== undefined && receipt.state !== "accepted") {
    plantRow(ledger, { ...receipt, state: "accepted" });
  }
  plantRow(ledger, receipt);
}

function plantRow(ledger: Ledger, receipt: Partial<CommandReceipt> & { id: string }): void {
  const row = {
    v: 1,
    kind: "controls.stop",
    target: "home/harness/hrn_0123456789abcdef",
    actor: `local:#${"a".repeat(64)}`,
    via: "cli",
    fingerprint: "f".repeat(64),
    state: "accepted",
    acceptedAt: new Date(NOW - 60_000).toISOString(),
    executor: {
      pid: 999,
      startedAt: new Date(BOOTED + 500).toISOString(),
      host: HOST,
      head: "cli",
    },
    effects: [],
    retry: { retryable: true, safety: "idempotent" },
    ...receipt,
  };
  const answer = append(ledger, row);
  if (!answer.ok) throw new Error(answer.reason);
}

/** A promise a test opens by hand. */
export function deferred(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// ---------------------------------------------------------------------------
// Access, projections and parked approvals
// ---------------------------------------------------------------------------

/** Set Home's access records up with `identity` as the owner's linked local user. */
export async function setUpOwner(
  hangarRoot: string,
  identity: { readonly username: string; readonly hostname: string } = IDENTITY,
): Promise<string> {
  const done = await ensureAccessSetUp(hangarRoot, { localActor: localActorOf(identity) });
  if (!done.ok) throw new Error(done.reason);
  return done.result.owner;
}

/**
 * Plant a member whose active `local` link is `identity`, as access records hold one:
 * the principal row, the link row and its readable subject. `crewhaus access link`
 * links no local user, so a test that needs one plants it.
 */
export function linkLocalMember(
  hangarRoot: string,
  identity: { readonly username: string; readonly hostname: string },
  by: string,
  principal: string = mintId("prn"),
): string {
  const link = mintId("lnk");
  const at = new Date(NOW).toISOString();
  const dir = join(hangarRoot, "access");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, "principals.jsonl"),
    `${JSON.stringify({ id: principal, kind: "member", state: "active", at, by })}\n`,
  );
  appendFileSync(
    join(dir, "links.jsonl"),
    `${JSON.stringify({
      id: link,
      principal,
      provider: "local",
      subjectRef: "c".repeat(64),
      verifiedVia: "owner",
      state: "active",
      at,
      by,
    })}\n`,
  );
  const subjectsFile = join(dir, "subjects.json");
  const subjects = JSON.parse(readFileSync(subjectsFile, "utf8")) as {
    links: Record<string, string>;
  };
  subjects.links[link] = localActorOf(identity);
  writeFileSync(subjectsFile, `${JSON.stringify(subjects, null, 2)}\n`);
  return principal;
}

/**
 * Write a harness's approver projection: its owner and members by class, and the Hangar
 * root that wrote it (`accessRoot`, a real path). That root is, by default, the Home of
 * the rig the harness was made with; `accessRoot: null` writes a projection that names
 * none.
 */
export function plantProjection(
  harness: string,
  owner: string,
  members: ReadonlyArray<{ readonly principal: string; readonly decide: string }> = [],
  extra: { readonly accessRoot?: string | null } = {},
): void {
  const home = HOME_OF.get(harness);
  const accessRoot =
    extra.accessRoot === null
      ? undefined
      : (extra.accessRoot ?? (home !== undefined ? realpathSync(home) : undefined));
  const control = join(harness, ".crewhaus", "run", "control");
  mkdirSync(control, { recursive: true });
  writeFileSync(
    join(control, "approvers.json"),
    `${JSON.stringify({
      v: 1,
      epoch: 1,
      generatedAt: new Date(NOW).toISOString(),
      harness: "hrn_00000000000000c1",
      owner,
      governedSince: new Date(NOW - 86_400_000).toISOString(),
      members,
      links: [],
      ...(accessRoot !== undefined ? { accessRoot } : {}),
    })}\n`,
  );
}

/** Park a tool approval in the harness's default session root. */
export async function park(
  harness: string,
  toolName: string,
  input: unknown,
  overrides: Partial<PendingApproval> = {},
): Promise<PendingApproval> {
  const record: PendingApproval = {
    id: generateApprovalId(),
    toolName,
    inputHash: hashApprovalInput(toolName, input),
    input,
    runId: "run_abcd1234",
    sessionId: "sess_00000000000000aa",
    surface: "single-turn",
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
  const store = createPendingApprovalStore({
    rootDir: join(harness, ".crewhaus", "sessions"),
    now: () => new Date(NOW),
  });
  await store.persist(record);
  return record;
}

/** The harness's settings file, parsed; `undefined` when absent. */
export function settingsOf(harness: string): unknown {
  try {
    return JSON.parse(readFileSync(join(harness, ".crewhaus", "settings.json"), "utf8"));
  } catch {
    return undefined;
  }
}
