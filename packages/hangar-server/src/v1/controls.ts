/**
 * Controls through the API: each submits the operation's own command kind. Pause,
 * resume, disable and enable write the operator record inline (the daemon reads it);
 * start, stop, restart and drain are carried out by the control service's executors
 * through Home's supervisor. Retire is a dry run by default: it lists the steps and hands
 * back a nonce, bound to this harness and this caller for ten minutes, that the real run
 * needs with the harness's typed name.
 */
import { randomBytes } from "node:crypto";
import {
  AREA_RUNTIMES,
  type OperatorControlKind,
  applyOperatorControl,
  retireRevokers,
  retireSteps,
} from "@crewhaus/control-service";
import { readHarnessEnvFiles } from "@crewhaus/harness-supervisor";
import { resolveHarnessSessionRoot } from "@crewhaus/session-store";
import type { V1Handler } from "./context";
import { V1Error } from "./errors";
import { harnessOf, liveDirOr409 } from "./resolve";
import { acceptedAnswer, submitCommand } from "./submit";

function operatorControl(kind: OperatorControlKind): V1Handler {
  return async (ctx) => {
    const entry = harnessOf(ctx);
    const dir = liveDirOr409(entry);
    const submitted = await submitCommand(ctx, {
      target: `home/harness/${entry.id}`,
      ledger: { harness: dir },
      effect: async (receipt) => {
        const answer = await applyOperatorControl(
          { receipt, harnessDir: dir, now: ctx.deps.now },
          { kind, ...(ctx.body["quiet"] === true ? { quiet: true } : {}) },
        );
        return { settle: answer.settle, value: answer.line };
      },
    });
    return acceptedAnswer(
      submitted,
      submitted.value !== undefined ? { line: submitted.value } : {},
      dir,
    );
  };
}

function daemonControl(): V1Handler {
  return async (ctx) => {
    const entry = harnessOf(ctx);
    const dir = liveDirOr409(entry);
    // Carried out by the kind's executor, through Home's supervisor.
    const submitted = await submitCommand(ctx, {
      target: `home/harness/${entry.id}`,
      ledger: { harness: dir },
    });
    return acceptedAnswer(submitted, {}, dir);
  };
}

/** The steps a retirement runs from Home, in order. The archive is the CLI's. */
const RETIRE_STEPS = [
  "stopAndDisable",
  "cancelQueuedRuns",
  "expireDecisions",
  "revokeStandingRules",
  "revokeConnections",
  "keepDisabled",
  "recordLifecycle",
  "archiveRegistryRow",
] as const;

const NONCE_TTL_MS = 10 * 60_000;
const nonces = new Map<
  string,
  { readonly harness: string; readonly caller: string; readonly exp: number }
>();

function mintNonce(harness: string, caller: string, now: number): string {
  for (const [key, held] of nonces) if (held.exp <= now) nonces.delete(key);
  const nonce = randomBytes(16).toString("hex");
  nonces.set(nonce, { harness, caller, exp: now + NONCE_TTL_MS });
  return nonce;
}

function spendNonce(nonce: string, harness: string, caller: string, now: number): boolean {
  const held = nonces.get(nonce);
  nonces.delete(nonce);
  return held !== undefined && held.harness === harness && held.caller === caller && held.exp > now;
}

const retire: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  const caller = ctx.access.caller.principal;
  const slug = entry.slug ?? entry.specName;
  const archiveNote = {
    kind: "archive",
    status: "manual",
    note: "Its files stay where they are. Run `crewhaus retire <spec>` on Home's computer to archive them.",
  };
  if (ctx.body["dryRun"] !== false) {
    return {
      status: 200,
      body: {
        dryRun: true,
        steps: [...RETIRE_STEPS.map((kind) => ({ kind, status: "planned" })), archiveNote],
        nonce: mintNonce(entry.id, caller, ctx.deps.now()),
      },
      scrubDir: dir,
    };
  }
  if (ctx.body["confirmName"] !== slug) {
    throw new V1Error({
      status: 412,
      code: "precondition_failed",
      reason: "confirm_name",
      message: `Type the harness's name, ${slug}, to retire it.`,
      current: { name: slug },
    });
  }
  const nonce = ctx.body["nonce"];
  if (typeof nonce !== "string" || !spendNonce(nonce, entry.id, caller, ctx.deps.now())) {
    throw new V1Error({
      status: 412,
      code: "precondition_failed",
      reason: "nonce",
      message:
        "Ask for the plan again: retiring needs the nonce a dry run handed back, once, within ten minutes.",
    });
  }
  const stop = ctx.body["stop"] === true;
  const state = await ctx.deps.daemonState(entry);
  if (!stop && (state === "running" || state === "starting" || state === "draining")) {
    throw new V1Error({
      status: 409,
      code: "conflict",
      reason: "daemon_live",
      message: "The daemon is running. Stop it first, or retire with stop: true.",
      current: { daemon: state },
    });
  }
  const submitted = await submitCommand(ctx, {
    target: `home/harness/${entry.id}`,
    ledger: "workspace",
    effect: async (receipt) => {
      const steps = retireSteps({
        harnessDir: dir,
        harnessId: entry.id,
        hangarRoot: ctx.deps.hangarRoot,
        receipt,
        stop,
        stopDaemon: () => ctx.deps.stopDaemon(entry),
        now: ctx.deps.now,
        revokers: retireRevokers(AREA_RUNTIMES),
        sessionRoot: resolveHarnessSessionRoot(dir, readHarnessEnvFiles(dir).vars).root,
        registry: ctx.deps.registry,
        holder: { pid: process.pid },
      });
      const outcomes = [];
      for (const step of RETIRE_STEPS) outcomes.push(await steps[step]());
      const ok = outcomes.every((outcome) => outcome.ok);
      return {
        settle: { state: ok ? "succeeded" : "failed", effects: [...steps.effects()] },
        value: [
          ...outcomes.map((o) => ({
            kind: o.step,
            status: o.ok ? "done" : "failed",
            note: o.detail,
          })),
          archiveNote,
        ],
      };
    },
  });
  return {
    status: 200,
    body: { dryRun: false, steps: submitted.value ?? [], receipt: submitted.receipt },
    scrubDir: dir,
  };
};

export const CONTROL_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "controls.pause": operatorControl("controls.pause"),
  "controls.resume": operatorControl("controls.resume"),
  "controls.disable": operatorControl("controls.disable"),
  "controls.enable": operatorControl("controls.enable"),
  "controls.start": daemonControl(),
  "controls.stop": daemonControl(),
  "controls.restart": daemonControl(),
  "controls.drain": daemonControl(),
  "controls.retire": retire,
};
