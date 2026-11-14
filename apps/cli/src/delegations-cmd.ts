/**
 * `crewhaus delegations <verb>`: an owner's rules that let a harness decide one narrow
 * kind of change on its own, under a rule that expires, can be turned off at once and is
 * re-checked before every use (#517). The verbs read and write the harness's records
 * through the same control service Home uses, so they work with Home stopped.
 *
 * | Verb | Who | What |
 * |---|---|---|
 * | `list [--harness <h>] [--all]` · `show <rule>` | anyone | the rules, their state, ends and uses |
 * | `preview <action> --harness <h> [--days N] [--uses N]` | anyone | the consequences page, and the exact command that turns it on |
 * | `enable <action> --harness <h>` | the owner | prints the page and the exact command that confirms it |
 * | `enable <action> --harness <h> --digest <d> --confirm <name>` | the owner | turns the rule on, if the page still reads as it did |
 * | `propose <action> --harness <h>` | a maintainer | asks the owner for the rule |
 * | `change <rule> --expect N` · `resume <rule> --expect N` | the owner | the same two steps: the page, then `--digest <d> --confirm <name>` |
 * | `pause <rule>` | a maintainer | stops it applying until an owner resumes it |
 * | `revoke <rule>` · `revoke --all` | the owner | turns it off |
 * | `apply [--harness <h>]` | an operator | one pass of what Home's sweep runs every minute |
 *
 * Every write refuses when the command was started by an agent's tool. `apply` is the
 * one write that takes the harness's mutating lease: a pass waits for nothing a person is
 * doing, and a refusal names who holds it. On a computer without Home's service, a cron
 * line running `crewhaus delegations apply --harness <h>` applies the rules.
 */
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { LocalIdentity } from "@crewhaus/access-control";
import {
  DELEGATION_ACTIONS,
  type DelegationAction,
  type DelegationPage,
  type DelegationTermsRequest,
  EXIT_FOR_ERROR,
  isId,
} from "@crewhaus/control-contract";
import { readHarnessIdentity, withMutatingLease } from "@crewhaus/control-records";
import {
  type ControlService,
  type DecisionActor,
  type DelegationHarness,
  type DelegationRefusal,
  type DelegationWrite,
  currentLocalIdentity,
} from "@crewhaus/control-service";
import { HARNESS_ID_RE, openHangarRegistry, slugOf } from "@crewhaus/harness-registry";
import { AGENT_TOOL_ENV } from "./approvals-cmd";
import { directControl } from "./daemon-cmd";
import { parseFamilyArgs as parseArgs } from "./family-args";
import type { CliFamily } from "./verbs";

const TERMS = { days: "value", uses: "value" } as const;

export const CLI_FAMILY = {
  verb: "delegations",
  since: "0.9.0",
  sub: {
    list: { flags: { harness: "value", all: "boolean", json: "boolean" } },
    show: { flags: { harness: "value", json: "boolean" } },
    preview: { flags: { harness: "value", ...TERMS, json: "boolean" } },
    enable: {
      flags: {
        harness: "value",
        ...TERMS,
        digest: "value",
        confirm: "value",
        proposal: "value",
        json: "boolean",
      },
    },
    propose: { flags: { harness: "value", ...TERMS, json: "boolean" } },
    change: {
      flags: {
        harness: "value",
        ...TERMS,
        digest: "value",
        confirm: "value",
        expect: "value",
        json: "boolean",
      },
    },
    pause: { flags: { harness: "value", reason: "value", json: "boolean" } },
    resume: {
      flags: {
        harness: "value",
        digest: "value",
        confirm: "value",
        expect: "value",
        json: "boolean",
      },
    },
    revoke: { flags: { harness: "value", all: "boolean", expect: "value", json: "boolean" } },
    apply: { flags: { harness: "value", json: "boolean" } },
  },
} as const satisfies CliFamily;

type Sub = keyof typeof CLI_FAMILY.sub;

export type DelegationsDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** The control service; the CLI's direct one by default, opened only when needed. */
  readonly control?: () => ControlService;
  readonly identity?: LocalIdentity;
};

export type DelegationsOut = { readonly lines: readonly string[]; readonly exitCode: number };

const USAGE = [
  "usage: crewhaus delegations list [--harness <h> | --all] [--json]",
  "       crewhaus delegations show <rule> --harness <h> [--json]",
  "       crewhaus delegations preview <action> --harness <h> [--days N] [--uses N] [--json]",
  "       crewhaus delegations enable <action> --harness <h> [--days N] [--uses N] [--proposal <dec_>] [--digest <d> --confirm <name>]",
  "       crewhaus delegations propose <action> --harness <h> [--days N] [--uses N]",
  "       crewhaus delegations change <rule> --harness <h> --expect N [--days N] [--uses N] [--digest <d> --confirm <name>]",
  "       crewhaus delegations pause <rule> --harness <h> [--reason paused-by-member]",
  "       crewhaus delegations resume <rule> --harness <h> --expect N [--digest <d> --confirm <name>]",
  "  Without --digest, enable, change and resume print the page and the exact command that confirms it.",
  "       crewhaus delegations revoke <rule> --harness <h> | revoke --all --harness <h>",
  "       crewhaus delegations apply [--harness <h>]",
  `  <action> is one of ${DELEGATION_ACTIONS.join(", ")}. <h> is a harness id, its name, or its directory.`,
  "  Rules are applied while Home is running and whenever `crewhaus delegations apply` runs.",
  "  Without Home's service, a cron line applies them: crewhaus delegations apply --harness <h>",
];

/** The sub-verbs that change something, and so refuse under an agent's tool. */
const WRITES: ReadonlySet<Sub> = new Set([
  "enable",
  "propose",
  "change",
  "pause",
  "resume",
  "revoke",
  "apply",
]);

const KIND: Readonly<Record<string, string>> = {
  enable: "delegations.enable",
  propose: "delegations.propose",
  change: "delegations.update",
  pause: "delegations.pause",
  resume: "delegations.resume",
  revoke: "delegations.revoke",
};

type Args = ReturnType<typeof parseArgs>;

class Refused extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

function flagValue(args: Args, flag: string): string | undefined {
  return args.values.get(flag)?.[0];
}

function requireValue(sub: Sub, args: Args, flag: string): string {
  const value = flagValue(args, flag);
  if (value === undefined) {
    throw new Refused(`delegations ${sub}: missing --${flag} <value>`, EXIT_FOR_ERROR.invalid);
  }
  return value;
}

function positional(sub: Sub, args: Args, what: string): string {
  const value = args.positional[0];
  if (value === undefined || args.positional.length > 1) {
    throw new Refused(`delegations ${sub}: name ${what}`, EXIT_FOR_ERROR.invalid);
  }
  return value;
}

function ruleIdOf(sub: Sub, args: Args): string {
  const id = positional(sub, args, "the rule, rule_…");
  if (!isId("rule", id))
    throw new Refused(`delegations ${sub}: name the rule, rule_…`, EXIT_FOR_ERROR.invalid);
  return id;
}

function actionOf(sub: Sub, args: Args): DelegationAction {
  const action = positional(sub, args, `the action (${DELEGATION_ACTIONS.join(", ")})`);
  if (!(DELEGATION_ACTIONS as readonly string[]).includes(action)) {
    throw new Refused(
      `delegations ${sub}: the action is one of ${DELEGATION_ACTIONS.join(", ")}`,
      EXIT_FOR_ERROR.invalid,
    );
  }
  return action as DelegationAction;
}

function wholeNumber(sub: Sub, flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) {
    throw new Refused(`delegations ${sub}: --${flag} is a whole number`, EXIT_FOR_ERROR.invalid);
  }
  return n;
}

function termsOf(sub: Sub, args: Args): DelegationTermsRequest | undefined {
  const days = wholeNumber(sub, "days", flagValue(args, "days"));
  const uses = wholeNumber(sub, "uses", flagValue(args, "uses"));
  if (days === undefined && uses === undefined) return undefined;
  return {
    ...(days !== undefined ? { days } : {}),
    ...(uses !== undefined ? { maxUses: uses } : {}),
  };
}

type Entry = {
  id: string;
  dir: string;
  specName: string;
  slug?: string;
  missingSince: string | null;
};

function registryOf(deps: DelegationsDeps): Entry[] {
  const env = { ...(deps.env ?? process.env), CREWHAUS_NO_REGISTRY: "1" };
  try {
    return openHangarRegistry({ env }).list() as unknown as Entry[];
  } catch {
    return [];
  }
}

/** A harness by its id, its name, or its directory: its live directory, id and name. */
function harnessOf(deps: DelegationsDeps, raw: string): DelegationHarness | undefined {
  const entries = registryOf(deps);
  const named = HARNESS_ID_RE.test(raw)
    ? entries.find((e) => e.id === raw)
    : entries.find((e) => (e.slug ?? slugOf(e.specName)) === raw);
  if (named !== undefined) {
    return { dir: named.dir, id: named.id, name: named.slug ?? slugOf(named.specName) };
  }
  const dir = isAbsolute(raw) ? raw : resolve(deps.cwd ?? process.cwd(), raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  const row = entries.find((e) => e.dir === dir);
  if (row !== undefined) return { dir, id: row.id, name: row.slug ?? slugOf(row.specName) };
  const identity = readHarnessIdentity(dir);
  if (identity.state !== "present") return undefined;
  return {
    dir,
    id: identity.identity.id,
    name: identity.identity.slug ?? slugOf(basename(dir)),
  };
}

function requireHarness(sub: Sub, args: Args, deps: DelegationsDeps): DelegationHarness {
  const raw = requireValue(sub, args, "harness");
  const found = harnessOf(deps, raw);
  if (found === undefined) {
    throw new Refused(
      `delegations ${sub}: no harness "${raw}". Run \`crewhaus harness list\`.`,
      EXIT_FOR_ERROR.not_found,
    );
  }
  return found;
}

const EXIT: Readonly<Record<DelegationRefusal["code"], number>> = {
  forbidden: EXIT_FOR_ERROR.forbidden,
  invalid: EXIT_FOR_ERROR.invalid,
  unsupported: EXIT_FOR_ERROR.unsupported,
  "not-allowed": EXIT_FOR_ERROR.conflict,
  "precondition-failed": EXIT_FOR_ERROR.precondition_failed,
  "not-found": EXIT_FOR_ERROR.not_found,
  conflict: EXIT_FOR_ERROR.conflict,
  "already-decided": EXIT_FOR_ERROR.already_decided,
  unavailable: EXIT_FOR_ERROR.unavailable,
};

function refusedOut(sub: Sub, refusal: DelegationRefusal, json: boolean): DelegationsOut {
  return {
    lines: json
      ? [
          JSON.stringify(
            {
              ok: false,
              code: refusal.code,
              reason: refusal.reason,
              ...(refusal.page !== undefined ? { page: refusal.page } : {}),
            },
            null,
            2,
          ),
        ]
      : [`delegations ${sub}: ${refusal.reason}`],
    exitCode: EXIT[refusal.code],
  };
}

/** A page's digest, as its CLI line prints it. */
const DIGEST_RE = /^[0-9a-f]{64}$/;

/** The page to read, and the line that confirms it: nothing was written. */
function toConfirm(sub: Sub, page: DelegationPage, json: boolean): DelegationsOut {
  const reason =
    "Nothing changed yet. Read the page, then run the command on its CLI line to confirm.";
  return json
    ? {
        lines: [JSON.stringify({ ok: false, code: "precondition-failed", reason, page }, null, 2)],
        exitCode: EXIT["precondition-failed"],
      }
    : {
        lines: [...pageLines(page), "", `delegations ${sub}: ${reason}`],
        exitCode: EXIT["precondition-failed"],
      };
}

/** The page in words: the server's own text, with the command that turns it on. */
function pageLines(page: DelegationPage): string[] {
  return [
    ...page.text.trimEnd().split("\n"),
    ...(page.note !== undefined ? [`note: ${page.note}`] : []),
  ];
}

/** Run one write as its own receipted command, after this process's recovery of the harness. */
async function receipted(
  control: ControlService,
  sub: Sub,
  harness: DelegationHarness,
  target: string,
  body: Readonly<Record<string, unknown>>,
  write: (cmd: string) => Promise<DelegationWrite | DelegationRefusal>,
): Promise<DelegationWrite | DelegationRefusal> {
  try {
    await control.commands.recover({ harness: harness.dir });
  } catch {
    // Recovery is the writer's courtesy to the last crash, never a gate on this verb.
  }
  const answer = await control.commands.submit<DelegationWrite | DelegationRefusal>(
    { kind: KIND[sub] as string, target, ledger: { harness: harness.dir }, via: "cli", body },
    async (receipt) => {
      const value = await write(receipt.id);
      return {
        settle: value.ok
          ? { state: "succeeded" }
          : {
              state: value.code === "unavailable" ? "failed" : "rejected",
              outcome: {
                code:
                  value.code === "precondition-failed"
                    ? "precondition_failed"
                    : value.code === "not-allowed"
                      ? "conflict"
                      : value.code === "not-found"
                        ? "not_found"
                        : value.code === "already-decided"
                          ? "already_decided"
                          : value.code,
                message: "refused: a check before it ran did not pass",
              },
            },
        value,
      };
    },
  );
  if (!answer.ok) {
    return { ok: false, code: "unavailable", reason: answer.refusal.message };
  }
  if (answer.replayed || answer.value === undefined) {
    return { ok: false, code: "conflict", reason: "the command was already recorded" };
  }
  return answer.value;
}

export async function runDelegationsCommand(
  argv: readonly string[],
  deps: DelegationsDeps = {},
): Promise<DelegationsOut> {
  const sub = argv[0];
  if (
    sub === undefined ||
    sub === "--help" ||
    sub === "-h" ||
    argv.includes("--help") ||
    argv.includes("-h")
  ) {
    return { lines: USAGE, exitCode: 0 };
  }
  if (!Object.hasOwn(CLI_FAMILY.sub, sub)) {
    throw new Error(
      `unknown delegations verb "${sub}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
    );
  }
  const verb = sub as Sub;
  const env = deps.env ?? process.env;
  const agentTool = env[AGENT_TOOL_ENV];
  if (WRITES.has(verb) && agentTool !== undefined && agentTool !== "") {
    return {
      lines: [
        `delegations ${verb}: this command was started by an agent's tool; a person does this`,
      ],
      exitCode: EXIT_FOR_ERROR.forbidden,
    };
  }
  const label = `delegations ${verb}`;
  const args = parseArgs(label, argv.slice(1), CLI_FAMILY.sub[verb].flags);
  const json = args.booleans.has("json");
  const control = () =>
    deps.control?.() ?? directControl({ ...(deps.env !== undefined ? { env: deps.env } : {}) });
  const actor: DecisionActor = { kind: "local", identity: deps.identity ?? currentLocalIdentity() };
  const out = (lines: readonly string[], exitCode = 0): DelegationsOut => ({ lines, exitCode });
  try {
    switch (verb) {
      case "list": {
        // No harness named, or --all: every live harness this Home has.
        const harnesses: DelegationHarness[] =
          args.booleans.has("all") || flagValue(args, "harness") === undefined
            ? registryOf(deps)
                .filter((e) => e.missingSince === null && existsSync(e.dir))
                .map((e) => ({ dir: e.dir, id: e.id, name: e.slug ?? slugOf(e.specName) }))
            : [requireHarness(verb, args, deps)];
        const service = control().delegations;
        const listings = harnesses.map((h) => ({ harness: h, listing: service.list(h) }));
        if (json)
          return out([
            JSON.stringify(
              listings.map((l) => ({ harness: l.harness.id, ...l.listing })),
              null,
              2,
            ),
          ]);
        const lines: string[] = [];
        for (const { harness, listing } of listings) {
          if (listings.length > 1) lines.push(`${harness.name} (${harness.id})`);
          if (listing.items.length === 0) {
            lines.push(
              listing.empty?.reason === "unreadable"
                ? (listing.empty.remedy ?? "The deployment records cannot be read.")
                : listing.ceiling.present
                  ? "No delegation rules yet."
                  : "Nothing can be delegated on this harness yet. Its agreement doesn't allow it.",
            );
          }
          for (const rule of listing.items) {
            lines.push(
              `  ${rule.id}  ${rule.state.padEnd(9)}  ${rule.label}  ends ${rule.endsAt}  uses ${rule.uses}${rule.maxUses !== undefined ? `/${rule.maxUses}` : ""}${rule.suspendedReason !== undefined ? `  (${rule.suspendedReason})` : ""}`,
            );
          }
          for (const proposal of listing.proposals) {
            lines.push(`  asked for: ${proposal.action}, ${proposal.days} days  ${proposal.id}`);
            lines.push(`    ${proposal.verb}`);
          }
          for (const offer of listing.offers)
            lines.push(`  can delegate: ${offer.label}  ${offer.verb}`);
          for (const problem of listing.unreadable) lines.push(`note: ${problem}`);
        }
        lines.push(listings[0]?.listing.note ?? "");
        return out(lines.filter((line) => line !== ""));
      }
      case "show": {
        const harness = requireHarness(verb, args, deps);
        const rule = ruleIdOf(verb, args);
        const answer = control().delegations.get(harness, rule);
        if (!answer.ok) return refusedOut(verb, answer, json);
        if (json) return out([JSON.stringify(answer.detail, null, 2)]);
        const { detail } = answer;
        return out([
          `${detail.rule.id}  ${detail.rule.state}  ${detail.rule.label}`,
          `  revision ${detail.rule.revision}, ends ${detail.rule.endsAt}, ${detail.terms.days} days, uses ${detail.rule.uses}`,
          ...detail.revisions.map(
            (r) =>
              `  rev ${r.revision}  ${r.state}  ${r.at}${r.reason !== undefined ? `  (${r.reason})` : ""}`,
          ),
          ...detail.log.map(
            (l) =>
              `  ${l.at}  ${l.event}${l.reason !== undefined ? ` (${l.reason})` : ""}${l.decidedByText !== undefined ? `  ${l.decidedByText}` : ""}`,
          ),
        ]);
      }
      case "preview": {
        const harness = requireHarness(verb, args, deps);
        const action = actionOf(verb, args);
        const terms = termsOf(verb, args);
        const answer = await control().delegations.preview(harness, {
          action,
          ...(terms !== undefined ? { terms } : {}),
        });
        if (!answer.ok) return refusedOut(verb, answer, json);
        return json
          ? out([
              JSON.stringify(
                {
                  text: answer.page.text,
                  consequencesDigest: answer.page.consequencesDigest ?? null,
                  page: answer.page,
                },
                null,
                2,
              ),
            ])
          : out(pageLines(answer.page));
      }
      case "enable":
      case "change":
      case "resume": {
        const harness = requireHarness(verb, args, deps);
        const digest = flagValue(args, "digest");
        if (digest !== undefined && !DIGEST_RE.test(digest)) {
          throw new Refused(
            `delegations ${verb}: --digest is the digest on the page's CLI line`,
            EXIT_FOR_ERROR.invalid,
          );
        }
        // Without --digest nothing is written: the page is printed with the exact command
        // that confirms it, so what is turned on is the page the owner read.
        const confirm =
          digest === undefined
            ? (flagValue(args, "confirm") ?? "")
            : requireValue(verb, args, "confirm");
        const service = control();
        const terms = termsOf(verb, args);
        const rule = verb === "enable" ? undefined : ruleIdOf(verb, args);
        const action = verb === "enable" ? actionOf(verb, args) : undefined;
        const proposal = verb === "enable" ? flagValue(args, "proposal") : undefined;
        const expect =
          verb === "enable"
            ? undefined
            : (wholeNumber(verb, "expect", requireValue(verb, args, "expect")) as number);
        const attempt = (bound: string) =>
          receipted(
            service,
            verb,
            harness,
            rule === undefined ? `home/harness/${harness.id}` : `${harness.id}/rule/${rule}`,
            {
              ...(action !== undefined ? { action } : {}),
              ...(terms !== undefined ? { terms } : {}),
              confirm,
            },
            (cmd) =>
              verb === "enable"
                ? service.delegations.enable(harness, {
                    action: action as DelegationAction,
                    ...(terms !== undefined ? { terms } : {}),
                    consequencesDigest: bound,
                    confirm,
                    ...(proposal !== undefined ? { proposal } : {}),
                    actor,
                    cmd,
                  })
                : verb === "change"
                  ? service.delegations.update(harness, {
                      rule: rule as string,
                      expect: expect as number,
                      ...(terms !== undefined ? { terms } : {}),
                      consequencesDigest: bound,
                      confirm,
                      actor,
                      cmd,
                    })
                  : service.delegations.resume(harness, {
                      rule: rule as string,
                      expect: expect as number,
                      consequencesDigest: bound,
                      confirm,
                      actor,
                      cmd,
                    }),
          );
        if (digest === undefined) {
          const shown =
            verb === "enable"
              ? await service.delegations.preview(harness, {
                  action: action as DelegationAction,
                  ...(terms !== undefined ? { terms } : {}),
                })
              : await service.delegations.previewRule(harness, {
                  rule: rule as string,
                  mode: verb === "change" ? "change" : "resume",
                  ...(terms !== undefined ? { terms } : {}),
                });
          if (!shown.ok) return refusedOut(verb, shown, json);
          if (shown.page.consequencesDigest !== undefined && proposal === undefined) {
            return toConfirm(verb, shown.page, json);
          }
          // A harness with no key yet, or a request's own command line: asking once sets
          // up the key and answers the page with its digest. Nothing is turned on.
          const asked = await attempt("");
          if (!asked.ok && asked.page?.consequencesDigest !== undefined) {
            return toConfirm(verb, asked.page, json);
          }
          return asked.ok ? out([]) : refusedOut(verb, asked, json);
        }
        const answer = await attempt(digest);
        if (!answer.ok) {
          const refused = refusedOut(verb, answer, json);
          // A page that changed since it was read: the page as it is now, and its command.
          const page = answer.page !== undefined && !json ? [...pageLines(answer.page), ""] : [];
          return { lines: [...page, ...refused.lines], exitCode: refused.exitCode };
        }
        if (json) return out([JSON.stringify(answer, null, 2)]);
        return out([
          `${verb === "enable" ? "Turned on" : verb === "change" ? "Changed" : "Resumed"}: ${answer.rule?.id ?? ""}`,
        ]);
      }
      case "propose": {
        const harness = requireHarness(verb, args, deps);
        const action = actionOf(verb, args);
        const terms = termsOf(verb, args);
        const service = control();
        const answer = await receipted(
          service,
          verb,
          harness,
          `home/harness/${harness.id}`,
          { action, ...(terms !== undefined ? { terms } : {}) },
          (cmd) =>
            service.delegations.propose(harness, {
              action,
              ...(terms !== undefined ? { terms } : {}),
              actor,
              cmd,
            }),
        );
        if (!answer.ok) return refusedOut(verb, answer, json);
        return json
          ? out([JSON.stringify(answer, null, 2)])
          : out([`Asked the owner: ${answer.proposal ?? ""}`]);
      }
      case "pause": {
        const harness = requireHarness(verb, args, deps);
        const rule = ruleIdOf(verb, args);
        const reason = flagValue(args, "reason") ?? "paused-by-member";
        if (reason !== "paused-by-member") {
          throw new Refused(
            "delegations pause: --reason is paused-by-member",
            EXIT_FOR_ERROR.invalid,
          );
        }
        const service = control();
        const answer = await receipted(
          service,
          verb,
          harness,
          `${harness.id}/rule/${rule}`,
          { reason },
          (cmd) =>
            service.delegations.pause(harness, { rule, reason: "paused-by-member", actor, cmd }),
        );
        if (!answer.ok) return refusedOut(verb, answer, json);
        return json
          ? out([JSON.stringify(answer, null, 2)])
          : out([`Paused: ${rule}. Only an owner can resume it.`]);
      }
      case "revoke": {
        const harness = requireHarness(verb, args, deps);
        const all = args.booleans.has("all");
        if (all && args.positional.length > 0) {
          throw new Refused(
            "delegations revoke: name a rule or --all, not both",
            EXIT_FOR_ERROR.invalid,
          );
        }
        const rule = all ? undefined : ruleIdOf(verb, args);
        const expect = wholeNumber(verb, "expect", flagValue(args, "expect"));
        const service = control();
        const answer = await receipted(
          service,
          verb,
          harness,
          rule === undefined ? `home/harness/${harness.id}` : `${harness.id}/rule/${rule}`,
          { ...(all ? { all } : {}), ...(expect !== undefined ? { expect } : {}) },
          (cmd) =>
            rule === undefined
              ? service.delegations.revoke(harness, { all: true, actor, cmd })
              : service.delegations.revoke(harness, {
                  rule,
                  ...(expect !== undefined ? { expect } : {}),
                  actor,
                  cmd,
                }),
        );
        if (!answer.ok) return refusedOut(verb, answer, json);
        const ended = answer.rules ?? (answer.rule !== undefined ? [answer.rule] : []);
        return json
          ? out([JSON.stringify(answer, null, 2)])
          : out([
              `Turned off: ${ended.length === 0 ? "nothing was on" : ended.map((r) => r.id).join(", ")}`,
            ]);
      }
      case "apply": {
        const raw = flagValue(args, "harness");
        const harnesses: DelegationHarness[] =
          raw === undefined
            ? registryOf(deps)
                .filter((e) => e.missingSince === null && existsSync(e.dir))
                .map((e) => ({ dir: e.dir, id: e.id }))
            : [requireHarness(verb, args, deps)];
        const service = control();
        const lines: string[] = [];
        let exitCode = 0;
        for (const harness of harnesses) {
          const held = await withMutatingLease(
            harness.dir,
            { head: "cli", kind: "delegations.apply" },
            async () => {
              const appliedBy = await service.decisions.storedActorOf(harness.dir, actor);
              const submitted = await service.commands.submit(
                {
                  kind: "delegations.apply",
                  target: `home/harness/${harness.id}`,
                  ledger: { harness: harness.dir },
                  via: "cli",
                },
                async (receipt) => {
                  const value = await service.delegations.apply(harness, {
                    appliedBy,
                    cmd: receipt.id,
                  });
                  return { settle: { state: "succeeded" }, value };
                },
              );
              return submitted;
            },
            { waitMs: 0 },
          );
          if (!held.ok) {
            exitCode = EXIT_FOR_ERROR.conflict;
            lines.push(
              "holder" in held
                ? `delegations apply: ${harness.id} is busy (${held.holder.kind}, pid ${held.holder.pid} on ${held.holder.host} since ${held.holder.since}); nothing was applied`
                : `delegations apply: ${harness.id}: ${held.reason}`,
            );
            continue;
          }
          const submitted = held.value;
          if (!submitted.ok) {
            exitCode = EXIT_FOR_ERROR[submitted.refusal.code];
            lines.push(`delegations apply: ${harness.id}: ${submitted.refusal.message}`);
            continue;
          }
          const value = submitted.replayed ? undefined : submitted.value;
          lines.push(
            json
              ? JSON.stringify({
                  harness: harness.id,
                  receipt: submitted.receipt.id,
                  summary: value ?? null,
                })
              : `${harness.id}: ${value === undefined || !value.ran ? "nothing to apply" : `${value.decided} decided, ${value.refused} refused, ${value.notApplied} not applied, ${value.suspended} suspended, ${value.rolledBack} rolled back, ${value.kept} kept`}`,
          );
        }
        if (harnesses.length === 0)
          lines.push("delegations apply: no live harness is registered here");
        return { lines, exitCode };
      }
    }
  } catch (err) {
    if (err instanceof Refused) return { lines: [err.message], exitCode: err.exitCode };
    throw err;
  }
}
