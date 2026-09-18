/**
 * Reconciling two exports, and matching records that do not share a key.
 *
 * "What changed between yesterday's file and today's" and "is this the same
 * customer as that one" are the two questions that make a person open two
 * spreadsheets side by side. Both are mechanical, and both are done badly by
 * eye at any real size.
 */

export type Row = Readonly<Record<string, string>>;

export type TableDiff = {
  readonly keyColumns: ReadonlyArray<string>;
  readonly added: ReadonlyArray<Row>;
  readonly removed: ReadonlyArray<Row>;
  readonly changed: ReadonlyArray<{
    readonly key: string;
    readonly changes: ReadonlyArray<{
      readonly column: string;
      readonly from: string;
      readonly to: string;
    }>;
  }>;
  readonly unchanged: number;
  /** Keys appearing more than once on either side — the diff is unreliable. */
  readonly duplicateKeys: ReadonlyArray<{
    readonly key: string;
    readonly side: "before" | "after";
    readonly count: number;
  }>;
  readonly columnsOnlyInBefore: ReadonlyArray<string>;
  readonly columnsOnlyInAfter: ReadonlyArray<string>;
};

const keyOf = (row: Row, columns: ReadonlyArray<string>): string =>
  JSON.stringify(columns.map((c) => row[c] ?? ""));

/**
 * Reconcile two tables by key.
 *
 * Duplicate keys are reported rather than silently resolved. With a
 * duplicated key there is no fact of the matter about which row changed into
 * which, and picking one produces a diff that looks authoritative and is
 * arbitrary.
 */
export function diffTables(
  before: ReadonlyArray<Row>,
  after: ReadonlyArray<Row>,
  keyColumns: ReadonlyArray<string>,
  ignoreColumns: ReadonlyArray<string> = [],
): TableDiff {
  if (keyColumns.length === 0) throw new Error("a diff needs at least one key column");

  const beforeColumns = new Set(before.flatMap((r) => Object.keys(r)));
  const afterColumns = new Set(after.flatMap((r) => Object.keys(r)));
  for (const column of keyColumns) {
    if (before.length > 0 && !beforeColumns.has(column)) {
      throw new Error(`the key column "${column}" is not in the before table`);
    }
    if (after.length > 0 && !afterColumns.has(column)) {
      throw new Error(`the key column "${column}" is not in the after table`);
    }
  }

  const index = (rows: ReadonlyArray<Row>, side: "before" | "after") => {
    const map = new Map<string, Row>();
    const duplicates: Array<{ key: string; side: "before" | "after"; count: number }> = [];
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = keyOf(row, keyColumns);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!map.has(key)) map.set(key, row);
    }
    for (const [key, count] of counts) if (count > 1) duplicates.push({ key, side, count });
    return { map, duplicates };
  };

  const a = index(before, "before");
  const b = index(after, "after");
  const ignored = new Set([...ignoreColumns, ...keyColumns]);
  const compared = [...new Set([...beforeColumns, ...afterColumns])]
    .filter((c) => !ignored.has(c))
    .sort();

  const added: Row[] = [];
  const removed: Row[] = [];
  const changed: TableDiff["changed"] = [];
  let unchanged = 0;

  for (const [key, row] of b.map) {
    const prior = a.map.get(key);
    if (prior === undefined) {
      added.push(row);
      continue;
    }
    const changes = compared
      .filter((column) => (prior[column] ?? "") !== (row[column] ?? ""))
      .map((column) => ({ column, from: prior[column] ?? "", to: row[column] ?? "" }));
    if (changes.length === 0) unchanged++;
    else (changed as Array<TableDiff["changed"][number]>).push({ key, changes });
  }
  for (const [key, row] of a.map) if (!b.map.has(key)) removed.push(row);

  return {
    keyColumns,
    added,
    removed,
    changed,
    unchanged,
    duplicateKeys: [...a.duplicates, ...b.duplicates],
    columnsOnlyInBefore: [...beforeColumns].filter((c) => !afterColumns.has(c)).sort(),
    columnsOnlyInAfter: [...afterColumns].filter((c) => !beforeColumns.has(c)).sort(),
  };
}

// ---------------------------------------------------------------------------

/** Normalized forms of the fields every join and dedupe depends on. */
export type NormalizedContact = {
  readonly email: string;
  readonly emailDomain: string;
  readonly phone: string;
  readonly name: string;
  readonly nameKey: string;
  readonly company: string;
  readonly notes: ReadonlyArray<string>;
};

const NAME_NOISE = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
  "prof",
  "sir",
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
  "phd",
  "md",
]);
const COMPANY_NOISE = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "sa",
  "sas",
  "bv",
  "nv",
  "plc",
  "ag",
  "pty",
  "srl",
  "spa",
  "oy",
  "ab",
  "as",
]);

/**
 * Canonicalize a contact's identifying fields.
 *
 * Gmail's dots and `+tags` are folded ONLY for gmail-family domains, because
 * they are a Gmail feature and not a rule of email: treating `a.b@other.com`
 * as `ab@other.com` merges two different people. The original is never
 * discarded — this returns a comparison key beside it, and any fold that
 * happened is named in `notes`.
 */
export function normalizeContact(input: {
  email?: string;
  phone?: string;
  name?: string;
  company?: string;
  defaultCountryCode?: string;
}): NormalizedContact {
  const notes: string[] = [];

  let email = (input.email ?? "").trim().toLowerCase();
  let emailDomain = "";
  if (email.includes("@")) {
    const at = email.lastIndexOf("@");
    let local = email.slice(0, at);
    emailDomain = email.slice(at + 1);
    const plus = local.indexOf("+");
    if (plus > 0) {
      local = local.slice(0, plus);
      notes.push("dropped an email +tag");
    }
    if (["gmail.com", "googlemail.com"].includes(emailDomain)) {
      const withoutDots = local.split(".").join("");
      if (withoutDots !== local) notes.push("folded gmail dots");
      local = withoutDots;
      if (emailDomain === "googlemail.com") emailDomain = "gmail.com";
    }
    email = `${local}@${emailDomain}`;
  } else if (email !== "") {
    notes.push("the email has no @, so it was left as written");
  }

  // Phones keep only digits, and a leading + is preserved as the sign of an
  // international number. A national number is prefixed only when the caller
  // said which country to assume.
  const rawPhone = (input.phone ?? "").trim();
  let phone = "";
  if (rawPhone !== "") {
    const international = rawPhone.trimStart().startsWith("+");
    const digits = rawPhone.replace(/\D/g, "");
    if (international) phone = `+${digits}`;
    else if (digits.startsWith("00")) phone = `+${digits.slice(2)}`;
    else if (input.defaultCountryCode !== undefined && input.defaultCountryCode !== "") {
      const trimmed = digits.replace(/^0+/, "");
      phone = `+${input.defaultCountryCode.replace(/\D/g, "")}${trimmed}`;
      notes.push(`assumed country code ${input.defaultCountryCode}`);
    } else {
      phone = digits;
      notes.push("no country code, so the number is national and may not compare across regions");
    }
  }

  const name = (input.name ?? "").trim().replace(/\s+/g, " ");
  const nameKey = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((part) => part !== "" && !NAME_NOISE.has(part))
    .sort()
    .join(" ");

  const company = (input.company ?? "").trim().replace(/\s+/g, " ");
  const companyKey = company
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((part) => part !== "" && !COMPANY_NOISE.has(part))
    .join(" ");

  return { email, emailDomain, phone, name, nameKey, company: companyKey, notes };
}

// ---------------------------------------------------------------------------

/** Levenshtein distance, bounded so a long pair cannot become quadratic cost. */
export function editDistance(a: string, b: string, max = 64): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const s = a.length > b.length ? b : a;
  const t = a.length > b.length ? a : b;
  let previous = Array.from({ length: s.length + 1 }, (_, i) => i);
  for (let i = 1; i <= t.length; i++) {
    const current = [i];
    for (let j = 1; j <= s.length; j++) {
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + (s[j - 1] === t[i - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[s.length] as number;
}

/** 1 for identical, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  if (a === "" && b === "") return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return Math.max(0, 1 - editDistance(a, b) / longest);
}

export const FIELD_NORMALIZERS = ["none", "name", "email", "phone", "company"] as const;
export type FieldNormalizer = (typeof FIELD_NORMALIZERS)[number];

export type LinkageRule = {
  readonly field: string;
  /** `exact` contributes its full weight or nothing; `fuzzy` scales. */
  readonly compare: "exact" | "fuzzy";
  readonly weight: number;
  /** `fuzzy` only: similarity below this contributes nothing. */
  readonly threshold?: number;
  /**
   * Canonicalize before comparing, with the same rules `normalizeContact`
   * uses. Without this a rule compares raw columns, and "Dr Jane Smith" and
   * "Smith Jane" score far apart on an edit distance while obviously being
   * the same person — which is the case the tool exists for.
   */
  readonly normalize?: FieldNormalizer;
};

/** Apply one field normalizer, reusing the contact rules. */
export function normalizeField(value: string, how: FieldNormalizer | undefined): string {
  const text = value.trim();
  switch (how) {
    case "name":
      return normalizeContact({ name: text }).nameKey;
    case "email":
      return normalizeContact({ email: text }).email;
    case "phone":
      return normalizeContact({ phone: text }).phone;
    case "company":
      return normalizeContact({ company: text }).company;
    default:
      return text.toLowerCase();
  }
}

/**
 * How much of a value a fuzzy comparison looks at.
 *
 * Edit distance is quadratic in the length, so the real cost of a linkage
 * run is comparisons times length squared — and the comparison cap alone
 * bounds the wrong quantity. Thirty records against thirty, with
 * three-thousand-character values, is 900 comparisons (far under any
 * sensible cap) and took forty-five seconds.
 *
 * The fields this tool exists to match — names, companies, addresses — are
 * nowhere near this long, and two values that agree for 256 characters and
 * differ afterwards are the same value for matching purposes.
 */
const MAX_COMPARE_CHARS = 256;

const bounded = (value: string): string =>
  value.length <= MAX_COMPARE_CHARS ? value : value.slice(0, MAX_COMPARE_CHARS);

export type Match = {
  readonly leftIndex: number;
  readonly rightIndex: number;
  readonly score: number;
  readonly evidence: ReadonlyArray<{
    readonly field: string;
    readonly similarity: number;
    readonly weight: number;
  }>;
};

export type LinkageResult = {
  readonly matched: ReadonlyArray<Match>;
  readonly unmatchedLeft: ReadonlyArray<number>;
  readonly unmatchedRight: ReadonlyArray<number>;
  /** Pairs above the review floor but below the accept floor. */
  readonly review: ReadonlyArray<Match>;
  readonly comparisons: number;
};

/**
 * Match records between two lists that share no key.
 *
 * Every accepted pair carries its evidence — which field matched and how
 * well — because "these are the same customer" is a claim somebody will have
 * to defend, and a bare score cannot be defended. Pairs between the review
 * floor and the accept floor are returned separately rather than guessed at.
 *
 * Matching is greedy over the scored pairs, and one record is used once: a
 * record matched to two others is not a match, it is a question.
 */
export function linkRecords(
  left: ReadonlyArray<Row>,
  right: ReadonlyArray<Row>,
  rules: ReadonlyArray<LinkageRule>,
  options: { accept?: number; review?: number; maxComparisons?: number } = {},
): LinkageResult {
  if (rules.length === 0) throw new Error("linkage needs at least one rule");
  const totalWeight = rules.reduce((s, r) => s + r.weight, 0);
  if (totalWeight <= 0)
    throw new Error("the rule weights sum to zero, so every score would be zero");

  const accept = options.accept ?? 0.85;
  const review = options.review ?? 0.6;
  const maxComparisons = options.maxComparisons ?? 5_000_000;
  if (left.length * right.length > maxComparisons) {
    throw new Error(
      `${left.length} x ${right.length} is ${left.length * right.length} comparisons, over the ${maxComparisons} limit — narrow the inputs first`,
    );
  }

  const scored: Match[] = [];
  for (const [i, a] of left.entries()) {
    for (const [j, b] of right.entries()) {
      const evidence: Array<{ field: string; similarity: number; weight: number }> = [];
      let score = 0;
      for (const rule of rules) {
        const x = bounded(normalizeField(a[rule.field] ?? "", rule.normalize));
        const y = bounded(normalizeField(b[rule.field] ?? "", rule.normalize));
        if (x === "" || y === "") continue;
        const sim = rule.compare === "exact" ? (x === y ? 1 : 0) : similarity(x, y);
        const counted = rule.compare === "fuzzy" && sim < (rule.threshold ?? 0.8) ? 0 : sim;
        if (counted > 0) {
          score += counted * rule.weight;
          evidence.push({
            field: rule.field,
            similarity: Number(sim.toFixed(4)),
            weight: rule.weight,
          });
        }
      }
      const normalized = score / totalWeight;
      if (normalized >= review) {
        scored.push({
          leftIndex: i,
          rightIndex: j,
          score: Number(normalized.toFixed(4)),
          evidence,
        });
      }
    }
  }

  scored.sort(
    (p, q) => q.score - p.score || p.leftIndex - q.leftIndex || p.rightIndex - q.rightIndex,
  );
  const usedLeft = new Set<number>();
  const usedRight = new Set<number>();
  const matched: Match[] = [];
  const reviewPairs: Match[] = [];

  for (const pair of scored) {
    if (usedLeft.has(pair.leftIndex) || usedRight.has(pair.rightIndex)) continue;
    if (pair.score >= accept) {
      matched.push(pair);
      usedLeft.add(pair.leftIndex);
      usedRight.add(pair.rightIndex);
    } else {
      reviewPairs.push(pair);
    }
  }

  return {
    matched,
    review: reviewPairs,
    unmatchedLeft: left.map((_, i) => i).filter((i) => !usedLeft.has(i)),
    unmatchedRight: right.map((_, i) => i).filter((i) => !usedRight.has(i)),
    comparisons: left.length * right.length,
  };
}
