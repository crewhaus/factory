/**
 * robots.txt parsing and evaluation.
 *
 * There is no standard that everyone follows, so this implements the widely
 * deployed behaviour that RFC 9309 codified, which is what a well-behaved
 * crawler is judged against:
 *
 *   - consecutive `User-agent` lines share the group that follows them;
 *   - the group whose agent token is the LONGEST case-insensitive prefix of
 *     the crawler's name wins, and `*` is the fallback group;
 *   - within a group the LONGEST matching path pattern wins, and a tie goes
 *     to `Allow`;
 *   - `*` matches any run of characters and `$` anchors the end;
 *   - an empty `Disallow:` allows everything;
 *   - `Sitemap` is file-wide, not per-group.
 *
 * What it does not do: no `Crawl-delay` enforcement (it is reported, not
 * obeyed — that is the caller's pacing decision), no `Host` directive, and
 * no fetching. A missing or unreachable robots.txt is the CALLER's decision
 * to interpret; `evaluateRobots` only answers about text it was given.
 */

export type RobotsGroup = {
  readonly agents: readonly string[];
  readonly allow: readonly string[];
  readonly disallow: readonly string[];
  readonly crawlDelay?: number;
};

export type RobotsFile = {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
};

export type RobotsVerdict = {
  readonly allowed: boolean;
  /** The rule that decided it, or `undefined` when nothing matched. */
  readonly rule?: string;
  readonly ruleType?: "allow" | "disallow";
  /** The `User-agent` token of the group that applied. */
  readonly matchedAgent?: string;
  readonly crawlDelay?: number;
};

type MutableGroup = {
  agents: string[];
  allow: string[];
  disallow: string[];
  crawlDelay?: number;
};

/** Parse a robots.txt body. Unknown directives are ignored, never fatal. */
export function parseRobots(source: string): RobotsFile {
  const groups: MutableGroup[] = [];
  const sitemaps: string[] = [];
  let current: MutableGroup | null = null;
  /** True while we are still collecting the agent lines of a new group. */
  let collectingAgents = false;

  for (const rawLine of source.split(/\r\n|\r|\n/)) {
    const hash = rawLine.indexOf("#");
    const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "sitemap") {
      if (value !== "") sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (current === null || !collectingAgents) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
        collectingAgents = true;
      }
      if (value !== "") current.agents.push(value.toLowerCase());
      continue;
    }
    if (current === null) continue; // a rule before any user-agent belongs to nothing
    collectingAgents = false;
    if (field === "allow") current.allow.push(value);
    else if (field === "disallow") current.disallow.push(value);
    else if (field === "crawl-delay") {
      const delay = Number.parseFloat(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = delay;
    }
  }

  return {
    groups: groups.map((g) => ({
      agents: g.agents,
      allow: g.allow,
      disallow: g.disallow,
      ...(g.crawlDelay !== undefined ? { crawlDelay: g.crawlDelay } : {}),
    })),
    sitemaps,
  };
}

/**
 * True when a robots path pattern matches `path`.
 *
 * `*` is any run of characters and `$` anchors the end, which makes this a
 * glob and means the leftmost match of a literal is not always the right one:
 * `/a*b$` against `/axxbyb` has to let `*` swallow the first `b` so the final
 * `b` can land on the end. A single left-to-right scan answers "no" there,
 * which would wrongly report a disallowed path as crawlable. The unanchored
 * scan is greedy-safe (the earliest match always leaves the most room), so
 * only the anchored tail needs the extra care.
 */
export function pathMatches(pattern: string, path: string): boolean {
  if (pattern === "") return false; // an empty Disallow is "allow all", handled by the caller
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split("*");
  const first = parts[0] as string;
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return anchored ? path === body : true;

  let cursor = first.length;
  // Every literal except the last: the earliest occurrence is optimal.
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    if (part === "") continue;
    const found = path.indexOf(part, cursor);
    if (found === -1) return false;
    cursor = found + part.length;
  }

  const last = parts[parts.length - 1] as string;
  if (!anchored) {
    if (last === "") return true; // the pattern ended in `*`
    return path.indexOf(last, cursor) !== -1;
  }
  // Anchored: the last literal must sit flush against the end of the path,
  // and there must still be room for it after everything matched so far.
  if (last === "") return true; // `…*$` — `*` absorbs the remainder
  return path.length - last.length >= cursor && path.endsWith(last);
}

/**
 * The group that governs `userAgent`: the longest agent token that is a
 * case-insensitive prefix of the name, else the `*` group, else none.
 */
export function selectGroup(file: RobotsFile, userAgent: string): RobotsGroup | undefined {
  const name = userAgent.toLowerCase();
  let best: RobotsGroup | undefined;
  let bestLength = -1;
  let wildcard: RobotsGroup | undefined;
  for (const group of file.groups) {
    for (const agent of group.agents) {
      if (agent === "*") {
        wildcard ??= group;
        continue;
      }
      if (name.startsWith(agent) && agent.length > bestLength) {
        best = group;
        bestLength = agent.length;
      }
    }
  }
  return best ?? wildcard;
}

/**
 * Decide whether `path` (a path + query, not a full URL) may be fetched.
 * Nothing matching means allowed — robots.txt is a deny-list.
 */
export function evaluateRobots(file: RobotsFile, userAgent: string, path: string): RobotsVerdict {
  const group = selectGroup(file, userAgent);
  if (group === undefined) return { allowed: true };
  const agentLabel = group.agents[0] ?? "*";
  const base = {
    matchedAgent: agentLabel,
    ...(group.crawlDelay !== undefined ? { crawlDelay: group.crawlDelay } : {}),
  };

  let best: { rule: string; type: "allow" | "disallow" } | undefined;
  for (const rule of group.disallow) {
    if (rule === "") continue; // "Disallow:" with no value allows everything
    if (!pathMatches(rule, path)) continue;
    if (best === undefined || rule.length > best.rule.length) best = { rule, type: "disallow" };
  }
  for (const rule of group.allow) {
    if (rule === "" || !pathMatches(rule, path)) continue;
    // Equal length is a tie, and a tie goes to Allow.
    if (best === undefined || rule.length >= best.rule.length) best = { rule, type: "allow" };
  }

  if (best === undefined) return { allowed: true, ...base };
  return { allowed: best.type === "allow", rule: best.rule, ruleType: best.type, ...base };
}
