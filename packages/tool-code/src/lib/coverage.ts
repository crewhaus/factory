/**
 * Coverage reports into per-file percentages.
 *
 * Both formats here are what a coverage tool already writes to disk, so
 * nothing is re-run: the tool reads the report the last test run produced.
 * Worst-first ordering is the whole point — the answer to "where is the
 * coverage hole" is the first three rows, not a 400-file table.
 *
 * Pure: text in, records out.
 */

export type CoverageMetric = {
  readonly covered: number;
  readonly total: number;
  /** Percentage to one decimal place; 100 when there is nothing to cover. */
  readonly pct: number;
};

export type FileCoverage = {
  readonly file: string;
  readonly lines: CoverageMetric;
  readonly functions?: CoverageMetric;
  readonly branches?: CoverageMetric;
};

const metric = (covered: number, total: number): CoverageMetric => ({
  covered,
  total,
  pct: total === 0 ? 100 : Math.round((covered / total) * 1000) / 10,
});

const toPosix = (p: string): string => p.replace(/\\/g, "/");

/**
 * Parse an `lcov.info`.
 *
 * Only the record-level totals are read (`LF`/`LH`, `FNF`/`FNH`,
 * `BRF`/`BRH`); the per-line `DA:` entries are counted as a fallback for
 * generators that omit `LF`/`LH`, but individual hit counts are not returned —
 * a caller that wants them should read the file, and a caller that wants to
 * decide something wants the percentage.
 */
export function parseLcov(text: string): FileCoverage[] {
  const out: FileCoverage[] = [];
  let file: string | undefined;
  let lf = 0;
  let lh = 0;
  let fnf = 0;
  let fnh = 0;
  let brf = 0;
  let brh = 0;
  let daTotal = 0;
  let daHit = 0;
  let sawFn = false;
  let sawBr = false;

  const flush = (): void => {
    if (file === undefined) return;
    const lines = lf > 0 || daTotal === 0 ? metric(lh, lf) : metric(daHit, daTotal);
    out.push({
      file: toPosix(file),
      lines,
      ...(sawFn ? { functions: metric(fnh, fnf) } : {}),
      ...(sawBr ? { branches: metric(brh, brf) } : {}),
    });
    file = undefined;
    lf = lh = fnf = fnh = brf = brh = daTotal = daHit = 0;
    sawFn = false;
    sawBr = false;
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "") continue;
    if (line === "end_of_record") {
      flush();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);
    switch (key) {
      case "SF":
        flush();
        file = value.trim();
        break;
      case "DA": {
        const parts = value.split(",");
        if (parts.length >= 2) {
          daTotal += 1;
          if (Number(parts[1]) > 0) daHit += 1;
        }
        break;
      }
      case "LF":
        lf = Number(value);
        break;
      case "LH":
        lh = Number(value);
        break;
      case "FNF":
        fnf = Number(value);
        sawFn = true;
        break;
      case "FNH":
        fnh = Number(value);
        sawFn = true;
        break;
      case "BRF":
        brf = Number(value);
        sawBr = true;
        break;
      case "BRH":
        brh = Number(value);
        sawBr = true;
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

type Unknown = Record<string, unknown>;
const asRecord = (value: unknown): Unknown | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Unknown)
    : undefined;

function istanbulMetric(value: unknown): CoverageMetric | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const covered = typeof record["covered"] === "number" ? (record["covered"] as number) : 0;
  const total = typeof record["total"] === "number" ? (record["total"] as number) : 0;
  // `pct` is already in the file, but it is recomputed so an lcov report and
  // a json-summary of the same run round identically.
  return metric(covered, total);
}

export type IstanbulSummary = {
  readonly files: readonly FileCoverage[];
  readonly total?: FileCoverage;
};

/**
 * Parse istanbul's `coverage-summary.json` — `{ total: {...}, "<path>": {...} }`.
 *
 * This is the shape jest, vitest and nyc all write with the `json-summary`
 * reporter, and bun's `--coverage-reporter=lcov` writes the other one, which
 * is why both parsers are here and the tool accepts either file.
 */
export function parseIstanbulSummary(text: string): IstanbulSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const root = asRecord(parsed);
  if (root === undefined) return undefined;
  const files: FileCoverage[] = [];
  let total: FileCoverage | undefined;
  for (const [key, value] of Object.entries(root)) {
    const record = asRecord(value);
    if (record === undefined) continue;
    const lines = istanbulMetric(record["lines"]);
    if (lines === undefined) continue;
    const entry: FileCoverage = {
      file: toPosix(key),
      lines,
      ...(istanbulMetric(record["functions"]) === undefined
        ? {}
        : { functions: istanbulMetric(record["functions"]) as CoverageMetric }),
      ...(istanbulMetric(record["branches"]) === undefined
        ? {}
        : { branches: istanbulMetric(record["branches"]) as CoverageMetric }),
    };
    if (key === "total") total = entry;
    else files.push(entry);
  }
  if (files.length === 0 && total === undefined) return undefined;
  return { files, ...(total === undefined ? {} : { total }) };
}

/**
 * Worst line coverage first, ties broken by uncovered COUNT (a 60%-covered
 * thousand-line file is a bigger hole than a 60%-covered ten-line one) and
 * then by path, so the order never depends on the order of the input.
 */
export function worstFirst(files: readonly FileCoverage[], limit?: number): FileCoverage[] {
  const sorted = [...files].sort(
    (a, b) =>
      a.lines.pct - b.lines.pct ||
      b.lines.total - b.lines.covered - (a.lines.total - a.lines.covered) ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/** Roll a set of per-file records into one total. */
export function totalOf(files: readonly FileCoverage[]): FileCoverage {
  let covered = 0;
  let total = 0;
  for (const file of files) {
    covered += file.lines.covered;
    total += file.lines.total;
  }
  return { file: "total", lines: metric(covered, total) };
}
