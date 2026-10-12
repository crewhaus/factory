/**
 * Replacing every redacted value with its marker, in one pass over the text.
 *
 * The rule has always been a sequence of replace-all passes, widest value
 * first: `text.split(value).join(marker)` for each value in turn, so a
 * narrower value inside a wider one is never cut out of it. Each pass read
 * the whole text, so k distinct values cost k times the text — memory and
 * feedback text is model-written, and a page holding ten thousand e-mail
 * addresses cost a hundred billion characters.
 *
 * {@link replaceValues} gives the same text from one scan. Where every value
 * ends is found at once (Aho–Corasick), and the passes are then replayed
 * over those places: a value takes, left to right, each of its occurrences
 * that overlaps neither one it took itself nor text an earlier, wider value
 * took. That replay is exactly the sequence of passes whenever a
 * value can only ever match the text it was found in — whenever no value can
 * match across, or inside, a marker an earlier pass put in. {@link
 * markersStayPut} decides that from the values and markers alone, and when
 * it cannot rule it out, the passes run one at a time as they always did.
 * With the shipped detectors and `[REDACTED:<kind>]` markers it always rules
 * it out: no detected value holds a bracket, or fits inside a marker.
 */
import type { PiiHit } from "@crewhaus/grader-safety-classifiers";

/** Work a replacement did, for a test to read; see {@link replaceValues}. */
export type ReplaceMeter = { steps: number };

/**
 * `text` with each hit's value replaced by `replacement(hit)`, exactly as
 * replacing them one at a time would: values sorted widest first (a stable
 * sort, so equal widths keep their order), each replaced everywhere with
 * `split`/`join`. `replacement` is called once per hit, in that order, and
 * must return the same marker for the same hit.
 *
 * `meter`, when given, is charged for the one-pass path's work: automaton
 * transitions, places a value ends that were looked at, and characters
 * claimed or copied.
 */
export function replaceValues(
  text: string,
  hits: ReadonlyArray<PiiHit>,
  replacement: (hit: PiiHit) => string,
  meter?: ReplaceMeter,
): string {
  if (hits.length === 0) return text;
  // Sort by descending length so we don't accidentally redact a sub-string
  // of a wider match (e.g. SSN-shaped substring inside a longer numeric
  // token).
  const sorted = [...hits].sort((a, b) => b.value.length - a.value.length);
  const values = sorted.map((hit) => hit.value);
  const markers = sorted.map(replacement);
  if (!markersStayPut(values, markers)) {
    let out = text;
    for (let i = 0; i < values.length; i++) {
      out = out.split(values[i] as string).join(markers[i] as string);
    }
    return out;
  }
  return replaceInOnePass(text, values, markers, meter ?? { steps: 0 });
}

/**
 * True when no pass can match across or inside a marker an earlier pass put
 * in, so every match lies in text that was there from the start. A match
 * that touches an inserted marker either sits inside it, or holds one end of
 * it: its last character when the match starts inside the marker and runs
 * past it, its first when the match starts before it. So it is enough that
 * no value holds the first or last character of an earlier value's marker,
 * and that no value is a substring of an earlier value's marker. An empty
 * value or marker is never ruled safe: an empty marker joins the text either
 * side of it with nothing between.
 */
export function markersStayPut(
  values: ReadonlyArray<string>,
  markers: ReadonlyArray<string>,
): boolean {
  const ends = new Set<number>();
  const inMarkers = new Set<number>();
  let widestMarker = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as string;
    const marker = markers[i] as string;
    if (value.length === 0 || marker.length === 0) return false;
    if (ends.size > 0) {
      for (let at = 0; at < value.length; at++) {
        if (ends.has(value.charCodeAt(at))) return false;
      }
    }
    ends.add(marker.charCodeAt(0));
    ends.add(marker.charCodeAt(marker.length - 1));
    for (let at = 0; at < marker.length; at++) inMarkers.add(marker.charCodeAt(at));
    widestMarker = Math.max(widestMarker, marker.length);
  }
  // The values that could be a substring of a marker at all: short enough,
  // and made only of characters some marker has.
  const candidates: number[] = [];
  const widths = new Set<number>();
  for (let j = 1; j < values.length; j++) {
    const value = values[j] as string;
    if (value.length > widestMarker) continue;
    let inside = true;
    for (let at = 0; at < value.length && inside; at++) {
      inside = inMarkers.has(value.charCodeAt(at));
    }
    if (!inside) continue;
    candidates.push(j);
    widths.add(value.length);
  }
  if (candidates.length === 0) return true;
  // Each substring of those widths of each distinct marker, with the first
  // pass whose marker holds it.
  const firstHolder = new Map<string, number>();
  const seen = new Set<string>();
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i] as string;
    if (seen.has(marker)) continue;
    seen.add(marker);
    for (const width of widths) {
      for (let at = 0; at + width <= marker.length; at++) {
        const piece = marker.slice(at, at + width);
        if (!firstHolder.has(piece)) firstHolder.set(piece, i);
      }
    }
  }
  for (const j of candidates) {
    const holder = firstHolder.get(values[j] as string);
    if (holder !== undefined && holder < j) return false;
  }
  return true;
}

/** No node, no value. */
const NONE = -1;
/** Code units per trie level in the transition key. */
const UNITS = 0x10000;

/**
 * The passes replayed over every occurrence of every value in `text`, found
 * in one Aho–Corasick scan. Only correct when {@link markersStayPut} holds.
 */
function replaceInOnePass(
  text: string,
  values: ReadonlyArray<string>,
  markers: ReadonlyArray<string>,
  meter: ReplaceMeter,
): string {
  // The distinct values, each with the first pass that replaces it. A later
  // pass for the same value (another kind) finds nothing: the first took
  // every occurrence that did not overlap one it took.
  const idOf = new Map<string, number>();
  const distinct: string[] = [];
  const passOf: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as string;
    if (idOf.has(value)) continue;
    idOf.set(value, distinct.length);
    distinct.push(value);
    passOf.push(i);
  }

  // The trie: node 0 is the root, `next` maps node * UNITS + code unit to the
  // child, and the children of a node are a linked list for the walk below.
  const next = new Map<number, number>();
  const child: number[] = [NONE];
  const sibling: number[] = [NONE];
  const unit: number[] = [0];
  const valueAt: number[] = [NONE];
  /** The node each distinct value ends at. */
  const nodeOf: number[] = [];
  for (let id = 0; id < distinct.length; id++) {
    const value = distinct[id] as string;
    let node = 0;
    for (let at = 0; at < value.length; at++) {
      const code = value.charCodeAt(at);
      const key = node * UNITS + code;
      let to = next.get(key);
      if (to === undefined) {
        to = child.length;
        next.set(key, to);
        child.push(NONE);
        sibling.push(child[node] as number);
        child[node] = to;
        unit.push(code);
        valueAt.push(NONE);
      }
      node = to;
      meter.steps += 1;
    }
    valueAt[node] = id;
    nodeOf.push(node);
  }

  // Failure links, breadth first, and for each node the nearest node on its
  // failure chain where a value ends.
  const nodes = child.length;
  const fail = new Int32Array(nodes);
  const output = new Int32Array(nodes).fill(NONE);
  const queue = new Int32Array(nodes);
  let head = 0;
  let tail = 0;
  for (let c = child[0] as number; c !== NONE; c = sibling[c] as number) {
    fail[c] = 0;
    queue[tail++] = c;
  }
  while (head < tail) {
    const node = queue[head++] as number;
    for (let c = child[node] as number; c !== NONE; c = sibling[c] as number) {
      const code = unit[c] as number;
      let f = fail[node] as number;
      let to = next.get(f * UNITS + code);
      while (to === undefined && f !== 0) {
        f = fail[f] as number;
        to = next.get(f * UNITS + code);
        meter.steps += 1;
      }
      const target = to ?? 0;
      fail[c] = target;
      output[c] = (valueAt[target] as number) !== NONE ? target : (output[target] as number);
      queue[tail++] = c;
      meter.steps += 1;
    }
  }

  // Where values end, by value. Only the widest value ending at a position is
  // listed for it here; the narrower ones that end there too (its suffixes,
  // reached by `output`) are listed one at a time below, and only while the
  // wider one was turned away with the position still free. Listing them all
  // up front cost the length of the chain at every position: a text that
  // nests addresses inside one another (`za@b.co`, `zza@b.co`, …) ends
  // dozens of values at each character.
  const endsAt: number[][] = distinct.map(() => []);
  const ordered: boolean[] = distinct.map(() => true);
  const list = (id: number, end: number): void => {
    const ending = endsAt[id] as number[];
    if (ending.length > 0 && (ending[ending.length - 1] as number) > end) ordered[id] = false;
    ending.push(end);
    meter.steps += 1;
  };
  let state = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    let to = next.get(state * UNITS + code);
    while (to === undefined && state !== 0) {
      state = fail[state] as number;
      to = next.get(state * UNITS + code);
      meter.steps += 1;
    }
    state = to ?? 0;
    meter.steps += 1;
    const widest = (valueAt[state] as number) !== NONE ? state : (output[state] as number);
    if (widest !== NONE) list(valueAt[widest] as number, at);
  }

  // The passes, replayed. `owner[p]` is one more than the pass that took
  // position p. Every earlier pass took spans at least as wide as this one's,
  // so a span of this width touches one only if it holds one of its own two
  // ends: checking those two positions is checking all of them.
  const owner = new Int32Array(text.length);
  for (let id = 0; id < distinct.length; id++) {
    const pass = passOf[id] as number;
    const width = (distinct[id] as string).length;
    const ending = endsAt[id] as number[];
    if (!ordered[id]) ending.sort((a, b) => a - b);
    // The next narrower value that ends wherever this one does.
    const narrower = output[nodeOf[id] as number] as number;
    let free = 0;
    for (const end of ending) {
      meter.steps += 1;
      // Taken already: so is every narrower value ending here.
      if ((owner[end] as number) !== 0) continue;
      const start = end - width + 1;
      if (start < free || (owner[start] as number) !== 0) {
        // Turned away with this position still free: the next narrower value
        // ending here may yet take it.
        if (narrower !== NONE) list(valueAt[narrower] as number, end);
        continue;
      }
      owner.fill(pass + 1, start, end + 1);
      meter.steps += width;
      free = end + 1;
    }
  }

  // Wide values first means pass order is not position order; the claims are
  // read back left to right.
  const parts: string[] = [];
  let copied = 0;
  for (let at = 0; at < text.length; ) {
    const taken = owner[at] as number;
    if (taken === 0) {
      at += 1;
      continue;
    }
    parts.push(text.slice(copied, at), markers[taken - 1] as string);
    at += (values[taken - 1] as string).length;
    copied = at;
  }
  parts.push(text.slice(copied));
  meter.steps += text.length;
  return parts.join("");
}
