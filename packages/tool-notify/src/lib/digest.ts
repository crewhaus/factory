/**
 * Folding many events into one message.
 *
 * This is the function that stops a harness sending forty notifications when
 * one would do. A watcher loop that fires per event will, on a bad morning,
 * page a channel forty times with the same failure; a digest turns that into
 * "38× connection refused (host-a, host-b), 2× timeout" and the reader
 * learns more from it.
 *
 * Pure, and deliberately boring about order: groups are ranked by count and
 * ties are broken by key, with a plain codepoint comparison rather than
 * `localeCompare`, so the same events always fold to the same bytes.
 */
import type { Block } from "./blocks";

export type DigestEvent = {
  /** What makes two events "the same". Events sharing a key are counted. */
  readonly key: string;
  /** One line about this occurrence. The first one seen is the exemplar. */
  readonly summary?: string;
  /** Free-form labels; distinct values are listed under the group. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Severity, used only for ordering when `sort` is "severity". */
  readonly severity?: "info" | "warning" | "error" | "critical";
};

export type DigestGroup = {
  readonly key: string;
  readonly count: number;
  readonly summary?: string;
  readonly severity?: DigestEvent["severity"];
  /** label name → the distinct values seen, sorted and capped. */
  readonly labels: Readonly<Record<string, readonly string[]>>;
};

export type Digest = {
  readonly total: number;
  readonly distinct: number;
  readonly groups: readonly DigestGroup[];
  /** Groups that did not fit under `maxGroups`, and how many events they held. */
  readonly omittedGroups: number;
  readonly omittedEvents: number;
};

const SEVERITY_RANK: Readonly<Record<string, number>> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
};

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Cap on distinct values listed per label, so one group cannot flood the digest. */
const MAX_LABEL_VALUES = 8;

/**
 * Fold events into groups.
 *
 * `maxGroups` caps what is rendered, not what is counted: the totals always
 * describe every event handed in, and the omitted tail is reported as a
 * number rather than dropped silently. A digest that quietly loses events is
 * the failure mode that makes people distrust digests.
 */
export function buildDigest(
  events: readonly DigestEvent[],
  options: { readonly maxGroups?: number; readonly sort?: "count" | "severity" | "key" } = {},
): Digest {
  const maxGroups = Math.max(1, options.maxGroups ?? 10);
  const sort = options.sort ?? "count";

  type Accum = {
    key: string;
    count: number;
    summary?: string;
    severity?: DigestEvent["severity"];
    labels: Map<string, Set<string>>;
    firstIndex: number;
  };
  const groups = new Map<string, Accum>();

  events.forEach((event, index) => {
    let group = groups.get(event.key);
    if (group === undefined) {
      group = {
        key: event.key,
        count: 0,
        labels: new Map(),
        firstIndex: index,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
        ...(event.severity !== undefined ? { severity: event.severity } : {}),
      };
      groups.set(event.key, group);
    }
    group.count += 1;
    // The most severe occurrence wins: a group that was warning-then-critical
    // is a critical group, and rendering it as a warning would understate it.
    if (event.severity !== undefined) {
      const current = group.severity;
      if (
        current === undefined ||
        (SEVERITY_RANK[event.severity] ?? 9) < (SEVERITY_RANK[current] ?? 9)
      ) {
        group.severity = event.severity;
      }
    }
    for (const [name, value] of Object.entries(event.labels ?? {})) {
      let values = group.labels.get(name);
      if (values === undefined) {
        values = new Set<string>();
        group.labels.set(name, values);
      }
      values.add(value);
    }
  });

  const ordered = [...groups.values()].sort((a, b) => {
    if (sort === "key") return byString(a.key, b.key);
    if (sort === "severity") {
      const sa = SEVERITY_RANK[a.severity ?? "info"] ?? 9;
      const sb = SEVERITY_RANK[b.severity ?? "info"] ?? 9;
      if (sa !== sb) return sa - sb;
    }
    if (b.count !== a.count) return b.count - a.count;
    return byString(a.key, b.key);
  });

  const kept = ordered.slice(0, maxGroups);
  const omitted = ordered.slice(maxGroups);

  return {
    total: events.length,
    distinct: ordered.length,
    omittedGroups: omitted.length,
    omittedEvents: omitted.reduce((sum, g) => sum + g.count, 0),
    groups: kept.map((group) => {
      const labels: Record<string, readonly string[]> = {};
      for (const name of [...group.labels.keys()].sort(byString)) {
        const values = [...(group.labels.get(name) ?? new Set<string>())].sort(byString);
        labels[name] = values.slice(0, MAX_LABEL_VALUES);
      }
      return {
        key: group.key,
        count: group.count,
        labels,
        ...(group.summary !== undefined ? { summary: group.summary } : {}),
        ...(group.severity !== undefined ? { severity: group.severity } : {}),
      };
    }),
  };
}

/** One line per group: `12× build failed — host: a, b`. */
export function digestToText(digest: Digest, title?: string): string {
  const lines: string[] = [];
  if (title !== undefined && title !== "") lines.push(title);
  lines.push(`${digest.total} events in ${digest.distinct} groups`);
  for (const group of digest.groups) {
    const labelText = Object.entries(group.labels)
      .map(([name, values]) => `${name}: ${values.join(", ")}`)
      .join("; ");
    const head = `${group.count}× ${group.summary ?? group.key}`;
    const severity = group.severity !== undefined ? ` [${group.severity}]` : "";
    lines.push(`${head}${severity}${labelText === "" ? "" : ` — ${labelText}`}`);
  }
  if (digest.omittedGroups > 0) {
    lines.push(
      `…and ${digest.omittedGroups} more groups covering ${digest.omittedEvents} events, not shown`,
    );
  }
  return lines.join("\n");
}

/** The same digest as blocks, for a platform that renders them. */
export function digestToBlocks(digest: Digest, title?: string): Block[] {
  const blocks: Block[] = [];
  if (title !== undefined && title !== "") blocks.push({ kind: "heading", text: title });
  blocks.push({
    kind: "paragraph",
    text: `${digest.total} events in ${digest.distinct} groups`,
  });
  blocks.push({ kind: "divider" });
  for (const group of digest.groups) {
    const fields: Array<{ name: string; value: string }> = [
      { name: "count", value: String(group.count) },
    ];
    if (group.severity !== undefined) fields.push({ name: "severity", value: group.severity });
    for (const [name, values] of Object.entries(group.labels)) {
      fields.push({ name, value: values.join(", ") });
    }
    blocks.push({ kind: "paragraph", text: group.summary ?? group.key });
    blocks.push({ kind: "fields", fields });
  }
  if (digest.omittedGroups > 0) {
    blocks.push({
      kind: "paragraph",
      text: `…and ${digest.omittedGroups} more groups covering ${digest.omittedEvents} events, not shown`,
    });
  }
  return blocks;
}
