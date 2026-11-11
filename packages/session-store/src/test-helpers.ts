/**
 * Shared fixtures for the approvals tests: a temp root, a parked record, the two
 * files read back line by line, and a seam that holds a writer until released.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVALS_DIRNAME,
  DEFAULT_APPROVALS_FILENAME,
  type PendingApproval,
  allowSingleOwner,
  generateApprovalId,
  hashApprovalInput,
} from "./index";

const made: string[] = [];

export function tempRoot(prefix = "crewhaus-approvals-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function removeTempRoots(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const ALLOW = { authorize: allowSingleOwner } as const;

export function pending(overrides: Partial<PendingApproval> = {}): PendingApproval {
  const input = { path: "/etc/x" };
  return {
    id: generateApprovalId(),
    toolName: "write_file",
    inputHash: hashApprovalInput("write_file", input),
    input,
    runId: "run_abcd1234",
    sessionId: "sess_00000000000000aa",
    surface: "single-turn",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function jsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every line of `approvals.jsonl`, parsed. */
export function rendezvousLines(root: string): Record<string, unknown>[] {
  return jsonLines(join(root, DEFAULT_APPROVALS_FILENAME));
}

/** The decision log's raw text, every segment in order. */
export function logText(root: string): string {
  const dir = join(root, APPROVALS_DIRNAME, "decisions");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => /^\d{6}\.jsonl$/.test(name))
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("");
}

/** Every decision-log line, parsed, every segment in order. */
export function logLines(root: string): Record<string, unknown>[] {
  return logText(root)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A seam that resolves `reached` when a writer arrives, and holds it until `release()`. */
export function hold(): {
  readonly reached: Promise<void>;
  readonly hook: () => Promise<void>;
  readonly release: () => void;
} {
  let arrive = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    hook: async () => {
      arrive();
      await released;
    },
    release: () => release(),
  };
}
