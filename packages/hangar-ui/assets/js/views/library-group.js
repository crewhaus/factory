/**
 * How the Harnesses list groups its rows: by Group (the registry's groups), by Owner
 * or by Purpose. Owner and purpose come from one `harnesses.list` read merged into the
 * registry's rows by id. A row with no owner groups under "No owner", one with no
 * purpose under "No purpose", one in no group under "No group". When that read failed,
 * nothing is grouped by owner or purpose: a failed read is never "nobody owns these".
 * Pure: no DOM.
 */

/** The ways to group, in the order the select offers them. */
export const GROUP_BY = Object.freeze([
  Object.freeze({ id: "group", label: "Group" }),
  Object.freeze({ id: "owner", label: "Owner" }),
  Object.freeze({ id: "purpose", label: "Purpose" }),
]);

/** The grouping a route asks for (`?by=`), else by group. Pure. */
export function groupByOf(route) {
  const by = route?.query?.by;
  return GROUP_BY.some((row) => row.id === by) ? by : "group";
}

const text = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/**
 * The registry's rows with each one's owner and purpose from the overview list,
 * matched by id. A row the overview list does not hold keeps neither. Pure.
 */
export function mergeOverviews(rows, overviews) {
  const byId = new Map();
  for (const item of Array.isArray(overviews) ? overviews : []) {
    if (item && typeof item.id === "string") byId.set(item.id, item);
  }
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const item = byId.get(row?.id);
    const owner = text(item?.owner);
    const ownerLabel = text(item?.ownerLabel);
    const purpose = text(item?.purpose);
    return {
      ...row,
      ...(owner !== null ? { owner } : {}),
      ...(ownerLabel !== null ? { ownerLabel } : {}),
      ...(purpose !== null ? { purpose } : {}),
    };
  });
}

/**
 * The rows in their groups, as `[{key, heading, rows}]`: headings in name order, the
 * group of rows without a value last. A row in several registry groups is listed under
 * each. Pure.
 */
export function groupHarnesses(rows, by) {
  const buckets = new Map();
  const add = (key, heading, row) => {
    const bucket = buckets.get(key) ?? { key, heading, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  };
  const NONE = { group: "No group", owner: "No owner", purpose: "No purpose" };
  const none = NONE[by] ?? NONE.group;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (by === "owner") {
      const owner = text(row?.owner);
      if (owner === null) add("", none, row);
      else add(owner, text(row?.ownerLabel) ?? owner, row);
    } else if (by === "purpose") {
      const purpose = text(row?.purpose);
      if (purpose === null) add("", none, row);
      else add(purpose, purpose, row);
    } else {
      const groups = Array.isArray(row?.groups) ? row.groups.filter((g) => text(g) !== null) : [];
      if (groups.length === 0) add("", none, row);
      for (const group of groups) add(group, group, row);
    }
  }
  const named = [...buckets.values()].filter((b) => b.key !== "");
  named.sort((a, b) => a.heading.localeCompare(b.heading));
  const without = buckets.get("");
  return without === undefined ? named : [...named, without];
}

/**
 * The rail's model for a grouping, from the registry's rows and the `harnesses.list`
 * answer: `{buckets}`, or `{failed: true, note}` when owners or purposes could not be
 * read. A list read only in part adds a `note`. Pure.
 */
export function railGroupsModel(rows, answer, by) {
  if (by === "group") return { buckets: groupHarnesses(rows, by) };
  const what = by === "owner" ? "Owners" : "Purposes";
  if (answer?.ok !== true || !Array.isArray(answer.body?.items)) {
    return { failed: true, note: `${what} couldn't be read. Showing all harnesses.` };
  }
  const buckets = groupHarnesses(mergeOverviews(rows, answer.body.items), by);
  return answer.body.truncated === undefined
    ? { buckets }
    : { buckets, note: `${what} of some harnesses weren't read.` };
}
