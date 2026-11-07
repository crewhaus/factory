import { cachedPerPath, isCount, isText, readWholeRecord } from "./fail-closed";
/**
 * The operator record: whether intake is paused and the deployment disabled, by whom
 * and since when, and whether the harness should be running. Absent means open. Present
 * but unreadable means closed: intake paused and starts refused, because it is a safety
 * control and an atomic write never leaves a torn file. No environment variable or
 * harness file switches it off.
 */
import { asObject } from "./io";
import { controlPaths } from "./paths";

const OPERATOR_MAX_BYTES = 64 * 1024;

export type OperatorIntake = {
  readonly paused: boolean;
  readonly since?: string;
  readonly by?: string;
  readonly reason?: string;
  /** Text to show; `null` is a pause recorded as quiet; absent means the fixed text. */
  readonly notice?: string | null;
  readonly cmd?: string;
};

export type OperatorDeployment = {
  readonly disabled: boolean;
  readonly since?: string;
  readonly by?: string;
  readonly reason?: string;
  readonly cmd?: string;
};

export type OperatorRecord = {
  readonly v: 1;
  readonly rev: number;
  readonly intake: OperatorIntake | null;
  readonly deployment: OperatorDeployment | null;
  readonly desired: "running" | "stopped";
};

export type OperatorRead =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly record: OperatorRecord }
  | { readonly state: "unreadable"; readonly reason: string };

/** A block's text fields, those present, or the name of the first bad one. */
function textFields<K extends string>(
  block: Record<string, unknown>,
  names: readonly K[],
): { readonly fields: Partial<Record<K, string>> } | { readonly bad: K } {
  const fields: Partial<Record<K, string>> = {};
  for (const name of names) {
    const value = block[name];
    if (!isText(value)) return { bad: name };
    if (value !== undefined) fields[name] = value as string;
  }
  return { fields };
}

/** What a body says, or the fault to report. Unknown keys are ignored. */
function parseOperator(body: Record<string, unknown>): OperatorRecord | string {
  if (body["v"] !== 1) return "its version is not 1";
  if (!isCount(body["rev"])) return "rev is not a non-negative integer";
  const desired = body["desired"];
  if (desired !== "running" && desired !== "stopped") {
    return "desired is not running or stopped";
  }

  let intake: OperatorIntake | null = null;
  if (body["intake"] !== undefined && body["intake"] !== null) {
    const block = asObject(body["intake"]);
    if (block === undefined) return "intake is not an object";
    if (typeof block["paused"] !== "boolean") return "intake.paused is not a boolean";
    const text = textFields(block, ["since", "by", "reason", "cmd"]);
    if ("bad" in text) return `intake.${text.bad} is not a string`;
    const notice = block["notice"];
    if (notice !== undefined && notice !== null && typeof notice !== "string") {
      return "intake.notice is not a string or null";
    }
    intake = {
      paused: block["paused"],
      ...text.fields,
      ...(notice !== undefined ? { notice } : {}),
    };
  }

  let deployment: OperatorDeployment | null = null;
  if (body["deployment"] !== undefined && body["deployment"] !== null) {
    const block = asObject(body["deployment"]);
    if (block === undefined) return "deployment is not an object";
    if (typeof block["disabled"] !== "boolean") return "deployment.disabled is not a boolean";
    const text = textFields(block, ["since", "by", "reason", "cmd"]);
    if ("bad" in text) return `deployment.${text.bad} is not a string`;
    deployment = { disabled: block["disabled"], ...text.fields };
  }

  return { v: 1, rev: body["rev"] as number, intake, deployment, desired };
}

function readOperatorNow(harnessDir: string): OperatorRead {
  const rel = controlPaths(harnessDir).operatorFile;
  const read = readWholeRecord(harnessDir, rel, OPERATOR_MAX_BYTES);
  if (read.state !== "body") return read;
  const parsed = parseOperator(read.body);
  return typeof parsed === "string"
    ? { state: "unreadable", reason: `${rel}: ${parsed}` }
    : { state: "present", record: parsed };
}

/**
 * A reader over `operator.json`: synchronous, no lock, creates nothing, consults no
 * environment variable, and caches for one second per path by the injected clock.
 *
 * First consumer: the supervisor's start gate.
 */
export function createOperatorReader(
  options: { readonly now?: () => number } = {},
): (harnessDir: string) => OperatorRead {
  return cachedPerPath(readOperatorNow, options.now ?? (() => Date.now()));
}

/**
 * The default reader.
 *
 * First consumer: the supervisor's start gate.
 */
export const readOperatorRecord: (harnessDir: string) => OperatorRead = createOperatorReader();

export type OperatorVerdict = {
  readonly intake: "open" | "paused" | "disabled";
  readonly start: "allowed" | "refused";
  readonly unreadable: boolean;
};

/**
 * What an operator read means. Disabled wins over paused. Unreadable means paused and
 * refused; raising the attention signal is the consumer's job.
 *
 * First consumer: the supervisor's start gate, which needs `start`.
 */
export function operatorVerdict(read: OperatorRead): OperatorVerdict {
  if (read.state === "unreadable") return { intake: "paused", start: "refused", unreadable: true };
  if (read.state === "present") {
    if (read.record.deployment?.disabled === true) {
      return { intake: "disabled", start: "refused", unreadable: false };
    }
    if (read.record.intake?.paused === true) {
      return { intake: "paused", start: "allowed", unreadable: false };
    }
  }
  return { intake: "open", start: "allowed", unreadable: false };
}
