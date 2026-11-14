/**
 * Device sign-in: a CLI or a script on another computer starts a sign-in on the sign-in
 * routes and shows a code; a member signed in to Home in a browser looks the code up and
 * allows or denies it here; the client's next poll collects a personal token, sealed to
 * that poll's own key. A code travels only in a request body, never a path or a query.
 */
import type { DeviceRefusal } from "@crewhaus/access-control";
import { outcomeOf } from "@crewhaus/control-service";
import type { V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { acceptedAnswer, submitCommand } from "./submit";

/** A device refusal as a v1 error. */
export function deviceError(
  refusal: DeviceRefusal,
  details?: Readonly<Record<string, unknown>>,
): V1Error {
  return new V1Error({
    status: refusal.status,
    code: refusal.code,
    reason: refusal.reason,
    message: refusal.message,
    ...(refusal.retryAfterMs !== undefined ? { retryAfterMs: refusal.retryAfterMs } : {}),
    ...(details !== undefined ? { details } : {}),
  });
}

/** The member a decision is recorded as: the signed-in principal, or the owner for Home's own key. */
function memberOf(ctx: V1Context): string {
  const caller = ctx.access.caller;
  if (caller.actor !== null) return caller.principal;
  const read = ctx.deps.home.signIn.snapshot();
  return read.state === "present" ? (read.snapshot.owner ?? caller.principal) : caller.principal;
}

const lookup: V1Handler = async (ctx) => {
  const answer = await ctx.deps.devices.lookup(memberOf(ctx), String(ctx.body["code"]));
  if (!answer.ok) throw deviceError(answer);
  return { status: 200, body: answer.request };
};

const decide: V1Handler = async (ctx) => {
  const choice = ctx.body["choice"] === "allow" ? "allow" : "deny";
  const submitted = await submitCommand<
    Awaited<ReturnType<V1Context["deps"]["devices"]["decide"]>>
  >(ctx, {
    ledger: "workspace",
    effect: async (receipt) => {
      const answer = await ctx.deps.devices.decide({
        caller: memberOf(ctx),
        code: String(ctx.body["code"]),
        choice,
        cmd: receipt.id,
      });
      return {
        settle: answer.ok
          ? { state: "succeeded" }
          : { state: "rejected", outcome: outcomeOf(answer.code) },
        value: answer,
      };
    },
  });
  const answer = submitted.value;
  if (answer !== undefined && !answer.ok) throw deviceError(answer, { receipt: submitted.receipt });
  return acceptedAnswer(submitted, answer?.ok === true ? { state: answer.state } : {});
};

export const DEVICE_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "auth.device.lookup": lookup,
  "auth.device.decide": decide,
};
