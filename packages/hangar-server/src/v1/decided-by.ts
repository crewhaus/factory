/**
 * Who decided a request, in the words every surface shows (`decidedByText` from
 * control-contract), read once per request: a delegated decision names its rule, its
 * revision and the owner who turned it on, and never a person; a fallback is the
 * agreement's outcome; anything else names the person who decided, by the display name
 * Home's access records give them. A stored local actor (`local:#…`) or a system actor is
 * never shown as it is stored.
 */
import { isId } from "@crewhaus/control-contract";
import { decidedByText, ruleLabelOf } from "@crewhaus/control-contract/delegation";
import { readDelegations } from "@crewhaus/control-records";
import { type HangarHarnessEntry, slugOf } from "@crewhaus/harness-registry";
import type { V1Context } from "./context";

/** What a decided row says about who decided it, as the stores keep it. */
export type DecidedFields = {
  readonly decision?: unknown;
  readonly resolvedBy?: unknown;
  readonly delegation?: { readonly rule?: unknown; readonly revision?: unknown };
  readonly decidedByPrincipal?: unknown;
  readonly decidedBy?: unknown;
};

type RuleFacts = {
  readonly label: string;
  readonly ownerLabel?: string;
  readonly enabledAt?: string;
};

export type DecidedByReader = {
  /** The text for one row, or `undefined` while it waits for a decision. */
  textOf(entry: HangarHarnessEntry, dir: string, row: DecidedFields): string | undefined;
  /** The display name of a stored actor, or `undefined` when Home has none to show. */
  labelOf(actor: unknown): string | undefined;
};

/**
 * One request's reader. The access snapshot is read once, each harness's delegation
 * rules once, and each rule's first revision once, however many rows name them.
 */
export function decidedByReader(ctx: V1Context): DecidedByReader {
  let names: ReadonlyMap<string, string> | undefined;
  const namesOf = (): ReadonlyMap<string, string> => {
    if (names !== undefined) return names;
    const out = new Map<string, string>();
    try {
      const read = ctx.deps.home.signIn.snapshot();
      if (read.state === "present") {
        for (const [id, subject] of Object.entries(read.snapshot.subjects.principals)) {
          const name = (subject as { readonly displayName?: unknown }).displayName;
          if (typeof name === "string" && name.trim() !== "") out.set(id, name);
        }
      }
    } catch {
      // Unreadable access records name nobody: the text says "a person".
    }
    names = out;
    return out;
  };
  const labelOf = (actor: unknown): string | undefined =>
    typeof actor === "string" && isId("prn", actor) ? namesOf().get(actor) : undefined;

  const rules = new Map<string, Map<string, RuleFacts | null>>();
  const ruleFacts = (entry: HangarHarnessEntry, dir: string, rule: string): RuleFacts | null => {
    let byRule = rules.get(entry.id);
    if (byRule === undefined) {
      byRule = new Map();
      rules.set(entry.id, byRule);
    }
    const known = byRule.get(rule);
    if (known !== undefined) return known;
    let facts: RuleFacts | null = null;
    try {
      const read = readDelegations(dir);
      const row = read.state === "present" ? read.rows.find((r) => r.id === rule) : undefined;
      if (row !== undefined) {
        const detail = ctx.deps.control.delegations.get(
          { dir, id: entry.id, name: entry.slug ?? slugOf(entry.specName) },
          rule,
        );
        const enabledAt = detail.ok ? detail.detail.revisions[0]?.at : undefined;
        const ownerLabel = labelOf(row.owner);
        facts = {
          label: ruleLabelOf(row.action),
          ...(ownerLabel !== undefined ? { ownerLabel } : {}),
          ...(enabledAt !== undefined ? { enabledAt } : {}),
        };
      }
    } catch {
      facts = null;
    }
    byRule.set(rule, facts);
    return facts;
  };

  return {
    labelOf,
    textOf(entry, dir, row) {
      const decided = row.decision === "grant" || row.decision === "deny";
      if (!decided && row.resolvedBy === undefined) return undefined;
      if (row.resolvedBy === "delegation") {
        const rule = row.delegation?.rule;
        const facts = typeof rule === "string" ? ruleFacts(entry, dir, rule) : null;
        // Never a decider label: a delegated decision is the rule's.
        return decidedByText({
          resolvedBy: "delegation",
          delegation: { rule, revision: row.delegation?.revision },
          ...(facts !== null ? { ruleLabel: facts.label } : {}),
          ...(facts?.ownerLabel !== undefined ? { ownerLabel: facts.ownerLabel } : {}),
          ...(facts?.enabledAt !== undefined ? { enabledAt: facts.enabledAt } : {}),
        });
      }
      if (row.resolvedBy === "policy") return decidedByText({ resolvedBy: "policy" });
      const named = labelOf(row.decidedByPrincipal) ?? legacyLabel(row.decidedBy, labelOf);
      return decidedByText(named !== undefined ? { deciderLabel: named } : {});
    },
  };
}

/**
 * The free-text `decidedBy` an older record carries, when it reads as a name: a principal
 * id becomes its display name, and a stored or system actor is never shown.
 */
function legacyLabel(
  value: unknown,
  labelOf: (actor: unknown) => string | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (isId("prn", trimmed)) return labelOf(trimmed);
  if (/^(local|sys|svc|crd|prn|appr|dec)[:_#]/i.test(trimmed) || trimmed.includes("#")) {
    return undefined;
  }
  return trimmed;
}
