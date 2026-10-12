/**
 * An archive's index is untrusted, and reading it costs no more than its
 * names, link targets and members add up to: counted, never timed.
 *
 *   - The link check (`unsafeArchiveLinks`, run by ArchiveList, ArchiveCreate
 *     and ArchiveExtract including `dryRun`) kept every prefix of every name
 *     as its own string, so a member d directories deep cost d² characters:
 *     a 206-byte .tar.gz made ArchiveList hold 64 million. Each link's walk
 *     also copied its queue at every step and expanded every link it passed
 *     through again, so n links through one long target cost n times it.
 *     Then, once a link's outcome was kept, a walk it placed inside a long
 *     name read that name back at each `..`, so n links that went through it
 *     and climbed back out cost n times the name.
 *   - A pax header's length field was re-read from each offset inside it, so
 *     a header of k zeros before `1 ` cost k² character reads.
 *   - A zip symlink's target was inflated whole before its length was
 *     checked, once per member, and members can share one bomb. Then each
 *     was bounded, but still read once per member that named it.
 *   - ArchiveExtract looked each staged top-level name up in the list of the
 *     index's, n² comparisons for n names.
 *
 * Each rewrite is held to the 0.7.1 code it replaced, kept below as the
 * reference, on generated and hostile archives.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { deflateRawSync, gzipSync, inflateRawSync } from "node:zlib";
import { archiveExtract, archiveList } from "./index";
import {
  type ArchiveEntry,
  _setInflateRawForTest,
  readTarEntries,
  readZipEntries,
} from "./lib/archive-format";
import { memberComponents, unsafeArchiveLinks } from "./lib/archive-links";

// ---------------------------------------------------------------------------
// the meter
// ---------------------------------------------------------------------------

type Fn = (this: unknown, ...args: unknown[]) => unknown;
type Methods = Record<string, Fn>;

const OVER = Symbol("over the work limit");

/** Where `next` lives for every array iterator and every string iterator. */
const ITERATORS = [
  Object.getPrototypeOf([][Symbol.iterator]()),
  Object.getPrototypeOf(""[Symbol.iterator]()),
] as Methods[];

/**
 * Install the counters; returns the count and the undo. While installed,
 * each of these charges what it reads, copies or hashes:
 *
 *   - string copies and scans: `slice`, `substring` and `substr` (the
 *     characters returned), `split` and `replace` (the characters of the
 *     string), `indexOf` and `lastIndexOf` (the characters between where
 *     they start and where they stop), `startsWith` (the characters
 *     compared), and one for each `charCodeAt`;
 *   - array copies and scans: `join` (the characters returned), `slice` (the
 *     elements returned), `shift`, `reverse` and `indexOf` (the array's
 *     length), each callback `some`, `every`, `filter` and `map` run, and
 *     each element an array or string iterator hands out (a spread, a
 *     `for…of`);
 *   - each key a Map or a Set hashes in `get`, `set`, `has` and `add` (its
 *     length when it is a string).
 *
 * Past `limit` the next charge throws, so a quadratic walk stops at once
 * instead of running. What it cannot see is work inside native code that
 * calls none of these (`TextDecoder`, `JSON.stringify`).
 */
function install(limit: number): { counter: { work: number; over: boolean }; restore(): void } {
  const counter = { work: 0, over: false };
  const charge = (n: number): void => {
    if (counter.over) throw OVER;
    counter.work += n;
    if (counter.work > limit) {
      counter.over = true;
      throw OVER;
    }
  };
  const saved: Array<{ target: Methods; name: string; real: Fn }> = [];
  const wrap = (target: Methods, name: string, make: (real: Fn) => Fn): void => {
    const real = target[name] as Fn;
    saved.push({ target, name, real });
    target[name] = make(real);
  };
  const strings = String.prototype as unknown as Methods;
  const arrays = Array.prototype as unknown as Methods;
  for (const name of ["slice", "substring", "substr"]) {
    wrap(
      strings,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          const out = real.apply(this, args) as string;
          charge(out.length);
          return out;
        },
    );
  }
  for (const name of ["split", "replace"]) {
    wrap(
      strings,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          charge(String(this).length);
          return real.apply(this, args);
        },
    );
  }
  wrap(
    strings,
    "indexOf",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        const length = String(this).length;
        const from = Math.min(length, Math.max(0, Math.trunc(Number(args[1] ?? 0)) || 0));
        const at = real.apply(this, args) as number;
        charge(at === -1 ? length - from + 1 : at - from + String(args[0]).length);
        return at;
      },
  );
  wrap(
    strings,
    "lastIndexOf",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        const length = String(this).length;
        const from =
          args[1] === undefined
            ? length
            : Math.min(length, Math.max(0, Math.trunc(Number(args[1])) || 0));
        const at = real.apply(this, args) as number;
        charge(at === -1 ? from + 1 : from - at + 1);
        return at;
      },
  );
  wrap(
    strings,
    "startsWith",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        charge(String(args[0]).length + 1);
        return real.apply(this, args);
      },
  );
  wrap(
    strings,
    "charCodeAt",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        charge(1);
        return real.apply(this, args);
      },
  );
  wrap(
    arrays,
    "join",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        const out = real.apply(this, args) as string;
        charge(out.length);
        return out;
      },
  );
  wrap(
    arrays,
    "slice",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        const out = real.apply(this, args) as unknown[];
        charge(out.length);
        return out;
      },
  );
  for (const name of ["shift", "reverse", "indexOf"]) {
    wrap(
      arrays,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          charge((this as unknown[]).length);
          return real.apply(this, args);
        },
    );
  }
  for (const name of ["some", "every", "filter", "map"]) {
    wrap(
      arrays,
      name,
      (real) =>
        function (this: unknown, fn: unknown, thisArg?: unknown) {
          const visit = fn as Fn;
          return real.call(this, (...args: unknown[]) => {
            charge(1);
            return visit.apply(thisArg, args);
          });
        },
    );
  }
  const keyed = (real: Fn): Fn =>
    function (this: unknown, ...args: unknown[]) {
      charge(typeof args[0] === "string" ? args[0].length : 1);
      return real.apply(this, args);
    };
  for (const name of ["get", "set", "has"]) wrap(Map.prototype as unknown as Methods, name, keyed);
  for (const name of ["add", "has"]) wrap(Set.prototype as unknown as Methods, name, keyed);
  // The iterators last, and everything from here on by index: a `for…of`
  // or a destructuring would run through the wrapper and be charged.
  for (let i = 0; i < ITERATORS.length; i++) {
    wrap(
      ITERATORS[i] as Methods,
      "next",
      (real) =>
        function (this: unknown) {
          const out = real.call(this) as IteratorResult<unknown>;
          if (out.done !== true) charge(1);
          return out;
        },
    );
  }
  return {
    counter,
    restore: () => {
      for (let i = saved.length - 1; i >= 0; i--) {
        const one = saved[i] as (typeof saved)[number];
        one.target[one.name] = one.real;
      }
    },
  };
}

type Work<T> = { readonly value: T | undefined; readonly work: number };

/** Run `body`, counting its work; Infinity (and no value) once it passes `limit`. */
function archiveWork<T>(limit: number, body: () => T): Work<T> {
  const { counter, restore } = install(limit);
  let value: T | undefined;
  try {
    value = body();
  } catch (err) {
    if (err !== OVER) throw err;
  } finally {
    restore();
  }
  return counter.over
    ? { value: undefined, work: Number.POSITIVE_INFINITY }
    : { value, work: counter.work };
}

/** {@link archiveWork} for an asynchronous body, counted until it settles. */
async function archiveWorkAsync<T>(limit: number, body: () => Promise<T>): Promise<Work<T>> {
  const { counter, restore } = install(limit);
  let value: T | undefined;
  try {
    value = await body();
  } catch (err) {
    if (err !== OVER) throw err;
  } finally {
    restore();
  }
  return counter.over
    ? { value: undefined, work: Number.POSITIVE_INFINITY }
    : { value, work: counter.work };
}

// ---------------------------------------------------------------------------
// archives
// ---------------------------------------------------------------------------

const BLOCK = 512;

function header(name: string, size: number, typeflag: string, linkName = ""): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(name.slice(0, 100), 0, "ascii");
  block.write("0000644\0", 100, "ascii");
  block.write("0000000\0", 108, "ascii");
  block.write("0000000\0", 116, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  block.write("00000000000\0", 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(typeflag, 156, "ascii");
  block.write(linkName.slice(0, 100), 157, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

function padded(data: Buffer): Buffer {
  const out = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK, 0);
  data.copy(out);
  return out;
}

type Member = { name: string; kind: "file" | "symlink"; linkTarget?: string };

/**
 * A tar whose every member carries its name in a GNU long-name header and
 * its link target in a long-link one, so nothing is cut at 100 bytes.
 */
function longNameTar(members: ReadonlyArray<Member>): Buffer {
  const parts: Buffer[] = [];
  for (const member of members) {
    const name = Buffer.from(`${member.name}\0`, "utf8");
    parts.push(header("././@LongLink", name.length, "L"), padded(name));
    if (member.linkTarget !== undefined) {
      const target = Buffer.from(`${member.linkTarget}\0`, "utf8");
      parts.push(header("././@LongLink", target.length, "K"), padded(target));
    }
    parts.push(header("long", 0, member.kind === "symlink" ? "2" : "0"));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** A tar of one pax header holding `records`, then one member, `plain.txt`. */
function paxTar(records: string, typeflag = "x"): Buffer {
  const data = Buffer.from(records, "utf8");
  return Buffer.concat([
    header("././@PaxHeader", data.length, typeflag),
    padded(data),
    header("plain.txt", 0, "0"),
    Buffer.alloc(BLOCK * 2, 0),
  ]);
}

/** A well-formed pax record: its length counts its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let n = body.length + 1;
  while (String(n).length + body.length !== n) n = String(n).length + body.length;
  return `${n}${body}`;
}

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
function parsed(result: unknown): any {
  return JSON.parse(String(result));
}

const charsOf = (entries: ReadonlyArray<ArchiveEntry>): number =>
  entries.reduce((sum, e) => sum + e.name.length + (e.linkTarget?.length ?? 0), 0);

const file = (name: string): ArchiveEntry => ({ name, size: 0, kind: "file" });
const dir = (name: string): ArchiveEntry => ({ name, size: 0, kind: "dir" });
const link = (name: string, linkTarget?: string): ArchiveEntry => ({
  name,
  size: 0,
  kind: "symlink",
  ...(linkTarget !== undefined ? { linkTarget } : {}),
});
const hard = (name: string, linkTarget: string): ArchiveEntry => ({
  name,
  size: 0,
  kind: "hardlink",
  linkTarget,
});

// ---------------------------------------------------------------------------
// the link check
// ---------------------------------------------------------------------------

/** One member d directories deep, a link beside it, and a link at the top that walks through it. */
function deepArchive(d: number): ArchiveEntry[] {
  const deep = "a/".repeat(d);
  return [file(`${deep}f`), link(`${deep}s`, "f"), link("top", `${deep}s`)];
}

/** n links at the top, every one through one link whose target is n components long. */
function fanInArchive(n: number): ArchiveEntry[] {
  const entries = [link("L", `${"x/".repeat(n)}y`)];
  for (let i = 0; i < n; i++) entries.push(link(`s${i}`, "L/z"));
  return entries;
}

/** n members under one n-deep directory, half of them links to the next. */
function sharedPrefixArchive(n: number): ArchiveEntry[] {
  const deep = "p/".repeat(n);
  const entries: ArchiveEntry[] = [];
  for (let i = 0; i < n; i++) {
    entries.push(i % 2 === 0 ? link(`${deep}m${i}`, `m${i + 1}`) : file(`${deep}m${i}`));
  }
  return entries;
}

/**
 * One name n characters long, a link to it, and n links that each go through
 * that link and climb back out. The walk is placed in the long name by the
 * link's kept outcome, never reading it, and each `..` read back over it
 * again: n² characters for names and targets 10n long.
 */
function climbOutArchive(n: number): ArchiveEntry[] {
  const long = "x".repeat(n);
  const entries = [file(`${long}/f`), link("m", long)];
  for (let i = 0; i < n; i++) entries.push(link(`s${i}`, "m/.."));
  return entries;
}

/** The same climb out of four long names, from a link that sits in a directory. */
function climbOutDeepArchive(n: number): ArchiveEntry[] {
  const longs = ["a", "b", "c", "d"].map((c) => c.repeat(n / 4));
  const entries = [file(`top/${longs.join("/")}/f`), link("top/m", longs.join("/"))];
  for (let i = 0; i < n; i++) entries.push(link(`top/s${i}`, "m/../../../.."));
  return entries;
}

/** At most this much work per character of names and targets; the rewrite does 6 to 8. */
const PER_CHAR = 16;

describe("the link check is linear in the archive's names and targets", () => {
  const shapes = [
    [
      "one member thousands of directories deep, with links beside and through it",
      deepArchive,
      4000,
    ],
    [
      "thousands of links through one link whose target is thousands of components long",
      fanInArchive,
      2000,
    ],
    [
      "thousands of links that go through one link and climb back out of its long name",
      climbOutArchive,
      2000,
    ],
    [
      "thousands of links that climb back out of four long names a kept link led into",
      climbOutDeepArchive,
      2000,
    ],
  ] as const;
  for (const [label, make, n] of shapes) {
    test(label, () => {
      const counted = [n, 2 * n].map((size) => {
        const entries = make(size);
        const chars = charsOf(entries);
        const { value, work } = archiveWork(PER_CHAR * chars, () => unsafeArchiveLinks(entries));
        return { chars, value, work };
      });
      for (const { chars, value, work } of counted) {
        expect(value).toEqual([]);
        expect(work).toBeLessThanOrEqual(PER_CHAR * chars);
        // Every character is read at least once: less means the meter no
        // longer sees how the names are read.
        expect(work).toBeGreaterThanOrEqual(chars);
      }
      const [small, large] = counted as [(typeof counted)[0], (typeof counted)[0]];
      // Double the archive, double the work, not four or eight times it.
      expect(large.work / small.work).toBeLessThan(2.25);
    }, 20_000);
  }

  test("members sharing one deep directory cost their own length, once each", () => {
    // n members of n directories each: the names themselves are n² long, and
    // that is all the work there is.
    const entries = sharedPrefixArchive(600);
    const chars = charsOf(entries);
    const { value, work } = archiveWork(PER_CHAR * chars, () => unsafeArchiveLinks(entries));
    expect(value).toEqual([]);
    expect(work).toBeLessThanOrEqual(PER_CHAR * chars);
    expect(work).toBeGreaterThanOrEqual(chars);
  }, 20_000);

  test("a climb out of where a kept link led gives the verdicts the 0.7.1 walk gave", () => {
    // `back` walks `m` first; every later link is placed by its kept outcome
    // and climbs from there, the kept answers for each place included.
    const long = "x".repeat(300);
    const entries = [
      file(`d/${long}/f`),
      link("d/m", long),
      link("d/back", "m/.."),
      link("d/top", "m/../.."),
      link("d/out", "m/../../.."),
      link("d/gone", "m/nope/.."),
      link("d/again", "m/../m/f"),
      link("d/twice", "m/../m/../../.."),
    ];
    expect(unsafeArchiveLinks(entries)).toEqual(referenceUnsafeArchiveLinks(entries));
    expect(unsafeArchiveLinks(entries)).toEqual([
      { name: "d/out", linkTarget: "m/../../..", why: "link points outside, through another link" },
      {
        name: "d/gone",
        linkTarget: "m/nope/..",
        why: "link target unresolvable: a '..' follows a name this archive does not contain",
      },
      {
        name: "d/twice",
        linkTarget: "m/../m/../../..",
        why: "link points outside, through another link",
      },
    ]);
  });

  test("an archive with no link members is not walked at all", () => {
    const entries = [file(`${"a/".repeat(5000)}f`), dir("b")];
    const { value, work } = archiveWork(10, () => unsafeArchiveLinks(entries));
    expect(value).toEqual([]);
    expect(work).toBeLessThanOrEqual(10);
  });
});

describe("the hop limit and loops, whichever link a chain is entered by", () => {
  const tooDeep = "link target unresolvable: links chain too deeply to resolve";

  /** c0 -> c1 -> … -> c39 -> real: forty links, the most a walk may pass. */
  const chain = (): ArchiveEntry[] => {
    const entries: ArchiveEntry[] = [dir("real")];
    for (let i = 0; i < 40; i++) entries.push(link(`c${i}`, i === 39 ? "real" : `c${i + 1}`));
    return entries;
  };

  test("forty hops resolve; one more, through the same links, is a chain too deep", () => {
    // `a` passes all forty links; `b` first passes `y`, then the same forty.
    // Each link's target is walked once and reused, so `b` must still meet
    // the limit inside the chain `a` walked whole.
    const verdict = [{ name: "b", linkTarget: "y/..", why: tooDeep }];
    expect(
      unsafeArchiveLinks([...chain(), link("a", "c0"), link("y", "c0"), link("b", "y/..")]),
    ).toEqual(verdict);
    // Entered from the other end, the same verdicts.
    expect(
      unsafeArchiveLinks([link("b", "y/.."), link("y", "c0"), link("a", "c0"), ...chain()]),
    ).toEqual(verdict);
  });

  test("a hard link counts the same hops", () => {
    const entries = [...chain(), link("y", "c0"), hard("h1", "c0"), hard("h2", "y")];
    expect(unsafeArchiveLinks(entries)).toEqual([
      { name: "h1", linkTarget: "c0", why: "hard link through a symlink" },
      { name: "h2", linkTarget: "y", why: "hard link: links chain too deeply to resolve" },
    ]);
  });

  test("a link met inside its own target is a loop, however it is entered", () => {
    const entries = [
      link("self", "self"),
      link("p", "q/x"),
      link("q", "p/.."),
      link("via", "p"),
      link("d/inner", "../p"),
    ];
    expect(unsafeArchiveLinks(entries).map((u) => [u.name, u.why])).toEqual([
      ["self", tooDeep],
      ["p", tooDeep],
      ["q", tooDeep],
      ["via", tooDeep],
      ["d/inner", tooDeep],
    ]);
  });

  test("a '..' through a link climbs from where the link led (security-11#5)", () => {
    const entries = [
      dir("a/b"),
      link("a/b/y", "../.."),
      link("x", "a/b/y/../f"),
      link("ok", "a/b/y/a"),
    ];
    expect(unsafeArchiveLinks(entries)).toEqual([
      { name: "x", linkTarget: "a/b/y/../f", why: "link points outside, through another link" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// the pax reader
// ---------------------------------------------------------------------------

describe("a pax header's length fields are read once", () => {
  const fields = [
    ["zeros", (k: number) => `${"0".repeat(k)}1 x=y\n`],
    ["tabs", (k: number) => `${"\t".repeat(k)}1 x=y\n`],
    [
      "no-break spaces, a sign and zeros",
      (k: number) => `${"\u00a0".repeat(k)}+${"0".repeat(k)}1 x=y\n`,
    ],
  ] as const;
  for (const [label, records] of fields) {
    test(`a field of thousands of ${label} before "1 "`, () => {
      const counted = [4000, 8000].map((k) => {
        const bytes = paxTar(records(k));
        return { k, ...archiveWork(16 * k, () => readTarEntries(bytes)) };
      });
      for (const { k, value, work } of counted) {
        expect(value?.map((e) => e.name)).toEqual(["plain.txt"]);
        expect(work).toBeLessThanOrEqual(16 * k);
        expect(work).toBeGreaterThanOrEqual(k);
      }
      const [small, large] = counted as [(typeof counted)[0], (typeof counted)[0]];
      expect(large.work / small.work).toBeLessThan(2.25);
    }, 20_000);
  }

  test("well-formed records still name the member, and the sparse name wins", () => {
    const bytes = paxTar(
      paxRecord("path", "decoy.txt") +
        paxRecord("linkpath", "../../x") +
        paxRecord("GNU.sparse.name", "real.txt"),
    );
    expect(readTarEntries(bytes)).toEqual([
      { name: "real.txt", size: 0, kind: "file", linkTarget: "../../x" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// a zip's link targets
// ---------------------------------------------------------------------------

type ZipMember = {
  readonly name: string;
  /** 0 stored, 8 deflated. */
  readonly method: number;
  readonly data: Buffer;
  /** Index of an earlier member whose local data this one's directory entry points at. */
  readonly sharesWith?: number;
  /** The compressed size this one's directory entry states, when not its data's length. */
  readonly statedSize?: number;
};

/** A zip of symlink members, each central-directory entry pointing at its own data or an earlier member's. */
function zipOfLinks(members: ReadonlyArray<ZipMember>): Buffer {
  const locals: Buffer[] = [];
  const offsets: number[] = [];
  let at = 0;
  for (const member of members) {
    if (member.sharesWith !== undefined) {
      offsets.push(offsets[member.sharesWith] as number);
      continue;
    }
    const name = Buffer.from(member.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(member.method, 8);
    local.writeUInt32LE(member.data.length, 18);
    local.writeUInt32LE(member.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    offsets.push(at);
    const part = Buffer.concat([local, name, member.data]);
    locals.push(part);
    at += part.length;
  }
  const directory: Buffer[] = [];
  members.forEach((member, i) => {
    const source =
      member.sharesWith === undefined ? member : (members[member.sharesWith] as ZipMember);
    const name = Buffer.from(member.name);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x031e, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(source.method, 10);
    entry.writeUInt32LE(member.statedSize ?? source.data.length, 20);
    entry.writeUInt32LE(source.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    // S_IFLNK in the high half of the external attributes: a symlink.
    entry.writeUInt32LE((0o120777 << 16) >>> 0, 38);
    entry.writeUInt32LE(offsets[i] as number, 42);
    directory.push(entry, name);
  });
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...locals, central, end]);
}

/** A deflate stream that writes `text` after `blocks` empty stored blocks, which read input and write nothing. */
function paddedDeflate(text: string, blocks: number): Buffer {
  const empty = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff]);
  return Buffer.concat([
    ...Array.from({ length: blocks }, () => empty),
    deflateRawSync(Buffer.from(text)),
  ]);
}

/**
 * Run `body` with the zip reader's inflater counted: the bytes it is handed
 * (`handed`), and those plus the bytes it returns (for a call stopped at its
 * output limit, the limit). Nothing is timed.
 */
function inflateWork<T>(body: () => T): { value: T; calls: number; handed: number; bytes: number } {
  const counter = { calls: 0, handed: 0, bytes: 0 };
  _setInflateRawForTest(((data: Uint8Array, options?: { maxOutputLength?: number }) => {
    counter.calls += 1;
    counter.handed += data.length;
    counter.bytes += data.length;
    try {
      const out = inflateRawSync(data, options);
      counter.bytes += out.length;
      return out;
    } catch (err) {
      counter.bytes += options?.maxOutputLength ?? 0;
      throw err;
    }
  }) as typeof inflateRawSync);
  try {
    return { value: body(), ...counter };
  } finally {
    _setInflateRawForTest(undefined);
  }
}

describe("a zip's link targets are read within their limits", () => {
  const unstated = "a link whose target this archive does not state";

  /** A kilobyte of deflate that inflates to a megabyte. */
  const bomb = deflateRawSync(Buffer.alloc(1 << 20, 0x61));

  test("hundreds of links sharing one deflate bomb: it is inflated once, within its limits", () => {
    // Each link's target was inflated whole before its length was checked
    // (a 102 KB zip made the listing inflate 2 GB), then each within its
    // limits but once per link: 24 KiB of work for a 46-byte entry.
    const counted = [200, 400].map((n) => {
      const members: ZipMember[] = [{ name: "l0", method: 8, data: bomb }];
      for (let i = 1; i < n; i++)
        members.push({ name: `l${i}`, method: 8, data: bomb, sharesWith: 0 });
      const zip = zipOfLinks(members);
      return { n, ...inflateWork(() => readZipEntries(zip)) };
    });
    for (const { n, value, calls, handed, bytes } of counted) {
      expect(calls).toBe(1);
      expect(handed).toBe(bomb.length);
      expect(bytes).toBeLessThanOrEqual(bomb.length + 8_192);
      // None was read, and every one is refused by name.
      expect(value.length).toBe(n);
      expect(
        value.every((entry) => entry.kind === "symlink" && entry.linkTarget === undefined),
      ).toBe(true);
      const refused = unsafeArchiveLinks(value);
      expect(refused.length).toBe(n);
      expect(refused.every((u) => u.why === unstated)).toBe(true);
    }
  }, 20_000);

  test("links naming one bomb at different lengths read no more than the archive holds", () => {
    // Each stated length is a different target to read, so sharing the
    // result does not help: n links would hand the inflater n kilobytes from
    // a zip of a few dozen. What is read for them stops at the zip's size.
    const counted = [200, 400].map((n) => {
      const members: ZipMember[] = [{ name: "l0", method: 8, data: bomb }];
      for (let i = 1; i < n; i++) {
        members.push({
          name: `l${i}`,
          method: 8,
          data: bomb,
          sharesWith: 0,
          statedSize: bomb.length - i,
        });
      }
      const zip = zipOfLinks(members);
      return { n, zip, ...inflateWork(() => readZipEntries(zip)) };
    });
    for (const { n, zip, value, calls, handed } of counted) {
      expect(handed).toBeLessThanOrEqual(zip.length);
      expect(calls).toBeGreaterThan(1);
      expect(calls).toBeLessThan(n);
      expect(value.length).toBe(n);
      const refused = unsafeArchiveLinks(value);
      expect(refused.length).toBe(n);
      expect(refused.every((u) => u.why === unstated)).toBe(true);
    }
  }, 20_000);

  test("data shared at different lengths reads as it would alone, until the archive's size is read", () => {
    // A stored target named by every link at a shorter length: each is a
    // different prefix, a target in its own right. The rule, step by step:
    // a target not read before is read while the data read for targets
    // stays within the archive's size, and reads as unstated past it.
    const text = "t/".repeat(100);
    const n = 60;
    const members: ZipMember[] = [{ name: "l00", method: 0, data: Buffer.from(text) }];
    for (let i = 1; i < n; i++) {
      members.push({
        name: `l${String(i).padStart(2, "0")}`,
        method: 0,
        data: Buffer.from(text),
        sharesWith: 0,
        statedSize: text.length - i,
      });
    }
    const zip = zipOfLinks(members);
    const rule = { spent: 0 };
    const expected = members.map((member) => {
      const size = member.statedSize ?? text.length;
      if (rule.spent + size > zip.length) return undefined;
      rule.spent += size;
      return text.slice(0, size);
    });
    expect(readZipEntries(zip).map((entry) => entry.linkTarget)).toEqual(expected);
    // Both sides of the line are reached.
    const read = expected.filter((target) => target !== undefined).length;
    expect(read).toBeGreaterThan(10);
    expect(read).toBeLessThan(n);
  });

  test("links with their own data, or sharing it whole, read as each would alone", () => {
    // What a zip writer makes: each member's data is its own, so what is
    // read for the targets never passes the archive's size. Targets of every
    // length up to past the limit, stored and deflated, and deflated streams
    // truncated, bit-flipped or followed by garbage; some links name an
    // earlier one's data whole, which is read once.
    const random = generator(75);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const decoder = new TextDecoder("utf-8");
    const alone = (data: Buffer, method: number): string | undefined => {
      if (method === 0) return data.length > 8192 ? undefined : decoder.decode(data);
      if (method !== 8 || data.length > 16_384) return undefined;
      try {
        const inflated = Bun.inflateSync(data as Uint8Array<ArrayBuffer>);
        return inflated.length > 8192 ? undefined : decoder.decode(inflated);
      } catch {
        return undefined;
      }
    };
    let targets = 0;
    let read = 0;
    let shared = 0;
    let mismatches = 0;
    for (let archive = 0; archive < 150; archive++) {
      const members: ZipMember[] = [];
      for (let i = 0, n = 1 + Math.floor(random() * 24); i < n; i++) {
        const own = members.filter((m) => m.sharesWith === undefined);
        if (own.length > 0 && random() < 0.25) {
          const source = pick(own);
          members.push({ ...source, name: `s${i}`, sharesWith: members.indexOf(source) });
          shared += 1;
          continue;
        }
        const length = pick([0, 1, 9, 120, 4000, 8191, 8192, 8193]);
        const text = Buffer.alloc(length);
        for (let j = 0; j < length; j++) text[j] = pick([47, 46, 97, 98, 0xc3, 0xa9]);
        if (random() < 0.4) {
          members.push({ name: `l${i}`, method: 0, data: text });
          continue;
        }
        let data: Buffer = deflateRawSync(text, { level: Math.floor(random() * 10) });
        const roll = random();
        if (roll < 0.15) data = data.subarray(0, Math.floor(random() * data.length));
        else if (roll < 0.3) data = Buffer.concat([data, Buffer.from([1, 2, 3])]);
        else if (roll < 0.45 && data.length > 0) {
          data = Buffer.from(data);
          const k = Math.floor(random() * data.length);
          data[k] = (data[k] as number) ^ (1 << Math.floor(random() * 8));
        }
        members.push({ name: `l${i}`, method: pick([8, 8, 8, 12]), data });
      }
      const got = readZipEntries(zipOfLinks(members));
      members.forEach((member, i) => {
        const expected = alone(member.data, member.method);
        targets += 1;
        if (expected !== undefined) read += 1;
        if (got[i]?.linkTarget !== expected) mismatches += 1;
      });
    }
    expect(mismatches).toBe(0);
    expect(targets).toBeGreaterThan(1500);
    expect(read).toBeGreaterThan(600);
    expect(shared).toBeGreaterThan(300);
  }, 60_000);

  test("a deflated target over 16 KiB compressed is refused unread, though it would inflate to a short path", () => {
    // 16,384 bytes is twice the longest target read; deflate never needs
    // that much for 8,192 bytes. Padding with empty blocks is how a stream
    // gets past it, and every link sharing it would be paid for again.
    const under = paddedDeflate("ok/target", 3_000); // 15,000 bytes of padding
    const over = paddedDeflate("ok/target", 3_400); // 17,000 bytes
    expect(under.length).toBeLessThanOrEqual(16_384);
    expect(over.length).toBeGreaterThan(16_384);
    const { value, calls } = inflateWork(() =>
      readZipEntries(
        zipOfLinks([
          { name: "read", method: 8, data: under },
          { name: "refused", method: 8, data: over },
        ]),
      ),
    );
    expect(calls).toBe(1);
    expect(value.map((e) => [e.name, e.linkTarget])).toEqual([
      ["read", "ok/target"],
      ["refused", undefined],
    ]);
    // What the operator sees: the link is refused, by name.
    expect(unsafeArchiveLinks(value)).toEqual([{ name: "refused", linkTarget: "", why: unstated }]);
  });

  test("every deflated target reads as 0.7.1's inflate-then-measure read it, up to the bound", () => {
    // 0.7.1 inflated with Bun.inflateSync and refused more than 8,192 bytes;
    // the reader now stops inflating there. Truncated, garbage-suffixed,
    // bit-flipped and random streams included.
    const random = generator(74);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const decoder = new TextDecoder("utf-8");
    let read = 0;
    let mismatches = 0;
    for (let i = 0; i < 2000; i++) {
      const length = pick([0, 1, 9, 120, 4000, 8191, 8192, 8193, 12000]);
      const text = Buffer.alloc(length);
      for (let j = 0; j < length; j++) {
        text[j] = random() < 0.5 ? pick([47, 46, 97, 98]) : Math.floor(random() * 256);
      }
      let data: Buffer = deflateRawSync(text, { level: Math.floor(random() * 10) });
      const roll = random();
      if (roll < 0.15) data = data.subarray(0, Math.floor(random() * data.length));
      else if (roll < 0.3)
        data = Buffer.concat([data, Buffer.from([1, 2, 3, Math.floor(random() * 256)])]);
      else if (roll < 0.45 && data.length > 0) {
        data = Buffer.from(data);
        const k = Math.floor(random() * data.length);
        data[k] = (data[k] as number) ^ (1 << Math.floor(random() * 8));
      } else if (roll < 0.55) {
        data = Buffer.from(
          Array.from({ length: Math.floor(random() * 64) }, () => Math.floor(random() * 256)),
        );
      }
      let expected: string | undefined;
      try {
        const inflated = Bun.inflateSync(data as Uint8Array<ArrayBuffer>);
        expected = inflated.length > 8192 ? undefined : decoder.decode(inflated);
      } catch {
        expected = undefined;
      }
      if (data.length > 16_384) expected = undefined;
      const [entry] = readZipEntries(zipOfLinks([{ name: "l", method: 8, data }]));
      if (expected !== undefined) read += 1;
      if (entry?.linkTarget !== expected) mismatches += 1;
    }
    expect(mismatches).toBe(0);
    expect(read).toBeGreaterThan(650);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// through the tools
// ---------------------------------------------------------------------------

describe("ArchiveList and ArchiveExtract's dry run, on a tiny archive with very deep names", () => {
  const originalCwd = process.cwd();
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(path.join(tmpdir(), "crewhaus-fsx-linear-"));
    process.chdir(ws);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(ws, { recursive: true, force: true });
  });

  const escaping = (d: number): string =>
    `${"a/".repeat(d)}out -> ${"../".repeat(d + 1)} (link points outside)`;

  /** The archive, and the characters of its names and link targets. */
  const deepTar = (d: number): { gz: Buffer; chars: number } => {
    const deep = "a/".repeat(d);
    const members: Member[] = [
      { name: `${deep}f`, kind: "file" },
      { name: `${deep}s`, kind: "symlink", linkTarget: "f" },
      { name: `${deep}out`, kind: "symlink", linkTarget: "../".repeat(d + 1) },
    ];
    const chars = members.reduce((n, m) => n + m.name.length + (m.linkTarget?.length ?? 0), 0);
    return { gz: gzipSync(longNameTar(members)), chars };
  };

  // Reading, sorting, the escape checks and the link check together come to
  // 8 to 10 per character of names and targets.
  const TOOL_PER_CHAR = 24;

  test("the listing's work doubles with the depth, and the verdicts are right", async () => {
    const counted: Array<{ d: number; work: number; out: ReturnType<typeof parsed> }> = [];
    for (const d of [4000, 8000]) {
      const { gz, chars } = deepTar(d);
      // A few hundred bytes on disk for names tens of thousands of bytes long.
      expect(gz.length).toBeLessThan(1000);
      writeFileSync("deep.tar.gz", gz);
      const { value, work } = await archiveWorkAsync(TOOL_PER_CHAR * chars, () =>
        archiveList.execute({ path: "deep.tar.gz" }),
      );
      expect(work).toBeLessThanOrEqual(TOOL_PER_CHAR * chars);
      expect(work).toBeGreaterThanOrEqual(chars);
      counted.push({ d, work, out: value === undefined ? undefined : parsed(value) });
    }
    for (const { d, out } of counted) {
      expect(out.count).toBe(3);
      expect(out.unsafeLinks).toEqual([escaping(d)]);
    }
    const [small, large] = counted as [(typeof counted)[0], (typeof counted)[0]];
    expect(large.work / small.work).toBeLessThan(2.25);
  }, 20_000);

  test("the dry run refuses the escaping link within the same count", async () => {
    const d = 8000;
    const { gz, chars } = deepTar(d);
    writeFileSync("deep.tar.gz", gz);
    mkdirSync("dest");
    const { value, work } = await archiveWorkAsync(TOOL_PER_CHAR * chars, () =>
      archiveExtract.execute({ archive: "deep.tar.gz", destination: "dest", dryRun: true }),
    );
    expect(work).toBeLessThanOrEqual(TOOL_PER_CHAR * chars);
    const out = parsed(value);
    expect(out.extracted).toBe(false);
    expect(out.refused).toEqual([escaping(d)]);
  }, 20_000);

  test("a pax header of zeros lists in work linear in its size", async () => {
    const k = 8000;
    writeFileSync("pax.tar.gz", gzipSync(paxTar(`${"0".repeat(k)}1 x=y\n`)));
    const { value, work } = await archiveWorkAsync(16 * k, () =>
      archiveList.execute({ path: "pax.tar.gz" }),
    );
    expect(work).toBeLessThanOrEqual(16 * k);
    expect(parsed(value).entries.map((e: { name: string }) => e.name)).toEqual(["plain.txt"]);
  }, 20_000);
});

/**
 * The elements the array searches visit while `body` runs: `includes`,
 * `indexOf` and `lastIndexOf` (the array's length), and each callback
 * `some`, `every`, `find`, `findIndex` and `filter` run. An extraction's
 * size watch runs on a timer and uses none of these, so the count is the
 * same however long the extractor takes.
 */
async function searchWork<T>(body: () => Promise<T>): Promise<{ value: T; visits: number }> {
  const arrays = Array.prototype as unknown as Methods;
  const counter = { visits: 0 };
  const saved: Array<{ name: string; real: Fn }> = [];
  for (const name of ["includes", "indexOf", "lastIndexOf"]) {
    const real = arrays[name] as Fn;
    saved.push({ name, real });
    arrays[name] = function (this: unknown, ...args: unknown[]) {
      counter.visits += (this as unknown[]).length;
      return real.apply(this, args);
    };
  }
  for (const name of ["some", "every", "find", "findIndex", "filter"]) {
    const real = arrays[name] as Fn;
    saved.push({ name, real });
    arrays[name] = function (this: unknown, fn: unknown, thisArg?: unknown) {
      return real.call(this, (...args: unknown[]) => {
        counter.visits += 1;
        return (fn as Fn).apply(thisArg, args);
      });
    };
  }
  try {
    return { value: await body(), visits: counter.visits };
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) {
      const one = saved[i] as (typeof saved)[number];
      arrays[one.name] = one.real;
    }
  }
}

const hasTar = Bun.which("tar") !== null;

describe.if(hasTar)("ArchiveExtract checks the staged top-level names once each", () => {
  const originalCwd = process.cwd();
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(path.join(tmpdir(), "crewhaus-fsx-linear-extract-"));
    process.chdir(ws);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(ws, { recursive: true, force: true });
  });

  test("hundreds of top-level names: double them, double the searching", async () => {
    // Each staged name was looked for in the index's list of top-level
    // names, n² visits in all; at the 200,000-member cap that is 2e10.
    const counted: Array<{ n: number; visits: number }> = [];
    for (const n of [300, 600]) {
      const names = Array.from({ length: n }, (_, i) => `f${String(i).padStart(4, "0")}`);
      writeFileSync(`t${n}.tar`, longNameTar(names.map((name) => ({ name, kind: "file" }))));
      mkdirSync(`d${n}`);
      const { value, visits } = await searchWork(() =>
        archiveExtract.execute({ archive: `t${n}.tar`, destination: `d${n}` }),
      );
      const out = parsed(value);
      expect(out.extracted).toBe(true);
      expect(out.entries).toEqual(names);
      expect(visits).toBeLessThanOrEqual(16 * n);
      counted.push({ n, visits });
    }
    const [small, large] = counted as [(typeof counted)[0], (typeof counted)[0]];
    expect(large.visits / small.visits).toBeLessThan(2.25);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// old against new
// ---------------------------------------------------------------------------

/**
 * The link check as 0.7.1 first shipped it (c8b5ac18), unchanged but for
 * names: the reference every verdict is held to.
 */
function referenceUnsafeArchiveLinks(entries: ReadonlyArray<ArchiveEntry>): unknown[] {
  type Node = { kind: ArchiveEntry["kind"]; linkTarget?: string };
  const members = new Map<string, Node>();
  const dirs = new Set<string>([""]);
  for (const entry of entries) {
    const parts = memberComponents(entry.name);
    if (parts.length === 0) continue;
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    const key = parts.join("/");
    members.set(key, {
      kind: entry.kind,
      ...(entry.linkTarget !== undefined ? { linkTarget: entry.linkTarget } : {}),
    });
    if (entry.kind === "dir") dirs.add(key);
  }
  const isAbsolute = (t: string): boolean =>
    t.startsWith("/") || t.startsWith("\\") || /^[A-Za-z]:/.test(t);
  const walk = (initial: string[]): { ok: boolean; why?: string; hops: number } => {
    const stack: string[] = [];
    let pending = initial;
    let hops = 0;
    let missing = false;
    while (pending.length > 0) {
      const comp = pending.shift() as string;
      if (comp === "." || comp === "") continue;
      if (comp === "..") {
        if (missing) {
          return { ok: false, why: "a '..' follows a name this archive does not contain", hops };
        }
        if (stack.length === 0) return { ok: false, why: "outside", hops };
        stack.pop();
        continue;
      }
      if (missing) {
        stack.push(comp);
        continue;
      }
      const key = [...stack, comp].join("/");
      const node = members.get(key);
      if (node?.kind === "symlink") {
        hops += 1;
        if (hops > 40) return { ok: false, why: "links chain too deeply to resolve", hops };
        const target = node.linkTarget ?? "";
        if (target === "")
          return { ok: false, why: "it passes through a link with no target", hops };
        if (isAbsolute(target)) return { ok: false, why: "outside", hops };
        pending = [...target.replace(/\\/g, "/").split("/"), ...pending];
        continue;
      }
      stack.push(comp);
      if (!dirs.has(key)) missing = true;
    }
    return { ok: true, hops };
  };
  const unsafe: unknown[] = [];
  for (const entry of entries) {
    if (entry.kind !== "symlink" && entry.kind !== "hardlink") continue;
    const target = entry.linkTarget ?? "";
    const refuse = (why: string): void => {
      unsafe.push({ name: entry.name, linkTarget: target, why });
    };
    if (target === "") {
      refuse("a link whose target this archive does not state");
      continue;
    }
    if (isAbsolute(target)) {
      refuse("link points outside");
      continue;
    }
    const targetParts = target.replace(/\\/g, "/").split("/");
    if (entry.kind === "hardlink") {
      const walked = walk(targetParts);
      if (!walked.ok) {
        refuse(walked.why === "outside" ? "link points outside" : `hard link: ${walked.why}`);
      } else if (walked.hops > 0) {
        refuse("hard link through a symlink");
      }
      continue;
    }
    const walked = walk([...memberComponents(entry.name).slice(0, -1), ...targetParts]);
    if (walked.ok) continue;
    if (walked.why !== "outside") refuse(`link target unresolvable: ${walked.why}`);
    else
      refuse(walked.hops > 0 ? "link points outside, through another link" : "link points outside");
  }
  return unsafe;
}

/** The pax record loop as 0.7.1 first shipped it: the member's path and link target. */
function referencePax(text: string): { path?: string; linkpath?: string } {
  const out: { path?: string; linkpath?: string } = {};
  let sparseName: string | undefined;
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) {
      const key = record.slice(0, eq);
      const value = record.slice(eq + 1);
      if (key === "path") out.path = value;
      if (key === "linkpath") out.linkpath = value;
      if (key === "GNU.sparse.name") sparseName = value;
    }
    offset += length;
  }
  if (sparseName !== undefined) out.path = sparseName;
  return out;
}

/** xorshift32: the same cases on every run and every machine. */
function generator(seed: number): () => number {
  const state = { x: seed >>> 0 || 1 };
  return () => {
    state.x ^= state.x << 13;
    state.x >>>= 0;
    state.x ^= state.x >>> 17;
    state.x ^= state.x << 5;
    state.x >>>= 0;
    return state.x / 4294967296;
  };
}

describe("every verdict is the one the 0.7.1 code gave", () => {
  test("generated archives: random names, trees with shared prefixes, chains, loops and hard links", () => {
    const random = generator(71);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const ALPHA = ["a", "b", "aa", "a.a", "__proto__", "c"];
    const comp = (): string => {
      const roll = random();
      return roll < 0.07 ? ".." : roll < 0.1 ? "." : roll < 0.12 ? "" : pick(ALPHA);
    };
    const randomPath = (depth: number): string => {
      const parts = Array.from({ length: 1 + Math.floor(random() * depth) }, comp);
      let name = parts.join(random() < 0.1 ? "\\" : "/");
      if (random() < 0.08) name = `./${name}`;
      if (random() < 0.08) name = `${name}/`;
      if (random() < 0.03) name = `/${name}`;
      return name;
    };
    const randomTarget = (depth: number): string | undefined => {
      const roll = random();
      if (roll < 0.04) return undefined;
      if (roll < 0.07) return "";
      if (roll < 0.1) return `/${randomPath(2)}`;
      if (roll < 0.12) return `C:${randomPath(2)}`;
      return (random() < 0.4 ? "../".repeat(Math.floor(random() * 4)) : "") + randomPath(depth);
    };
    const treeArchive = (): ArchiveEntry[] => {
      const nodes: string[][] = [[]];
      for (let i = 0, n = 2 + Math.floor(random() * 30); i < n; i++) {
        const parent = pick(nodes);
        if (parent.length < 12) nodes.push([...parent, pick(ALPHA)]);
      }
      const entries: ArchiveEntry[] = [];
      for (const node of nodes.slice(1)) {
        if (random() < 0.4) continue;
        const name = node.join("/") + (random() < 0.1 ? "/" : "");
        const to = pick(nodes);
        let shared = 0;
        while (shared < node.length - 1 && shared < to.length && node[shared] === to[shared]) {
          shared++;
        }
        const relative = [...Array(node.length - 1 - shared).fill(".."), ...to.slice(shared)];
        if (random() < 0.15) relative.push(pick(["..", ".", "zz"]));
        const roll = random();
        if (roll < 0.3) entries.push(file(name));
        else if (roll < 0.45) entries.push(dir(name));
        else if (roll < 0.85) entries.push(link(name, relative.join("/") || "."));
        else entries.push(hard(name, to.join("/") || "."));
        if (random() < 0.08) entries.push(link(name, pick(["..", "a", ""])));
      }
      if (random() < 0.25) {
        const n = 34 + Math.floor(random() * 12);
        for (let i = 0; i < n; i++) entries.push(link(`z/l${i}`, `l${i + 1}`));
        entries.push(random() < 0.5 ? dir(`z/l${n}`) : link(`z/l${n}`, "l0"));
        for (let k = 0; k < 4; k++) {
          entries.push(
            link(`z/in${k}`, `l${Math.floor(random() * n)}/${pick(["", "..", "../.."])}`),
          );
        }
      }
      return entries;
    };
    const randomArchive = (): ArchiveEntry[] => {
      const entries: ArchiveEntry[] = [];
      const depth = 1 + Math.floor(random() * 5);
      for (let i = 0, n = 1 + Math.floor(random() * 20); i < n; i++) {
        const kind = pick(["file", "dir", "symlink", "symlink", "hardlink", "other"] as const);
        const target = kind === "symlink" || kind === "hardlink" ? randomTarget(depth) : undefined;
        entries.push({
          name: randomPath(depth),
          size: 0,
          kind,
          ...(target !== undefined ? { linkTarget: target } : {}),
        });
      }
      return entries;
    };
    const whys = new Set<string>();
    let verdicts = 0;
    let mismatches = 0;
    for (let i = 0; i < 2500; i++) {
      const entries = i % 2 === 0 ? treeArchive() : randomArchive();
      for (let j = entries.length - 1; j > 0; j--) {
        if (random() < 0.4) {
          const k = Math.floor(random() * (j + 1));
          [entries[j], entries[k]] = [entries[k] as ArchiveEntry, entries[j] as ArchiveEntry];
        }
      }
      const expected = referenceUnsafeArchiveLinks(entries);
      for (const u of expected as Array<{ why: string }>) whys.add(u.why);
      verdicts += entries.filter((e) => e.kind === "symlink" || e.kind === "hardlink").length;
      if (JSON.stringify(unsafeArchiveLinks(entries)) !== JSON.stringify(expected)) mismatches += 1;
    }
    expect(mismatches).toBe(0);
    // The cases reach every way a link is refused.
    expect([...whys].sort()).toEqual([
      "a link whose target this archive does not state",
      "hard link through a symlink",
      "hard link: a '..' follows a name this archive does not contain",
      "hard link: it passes through a link with no target",
      "hard link: links chain too deeply to resolve",
      "link points outside",
      "link points outside, through another link",
      "link target unresolvable: a '..' follows a name this archive does not contain",
      "link target unresolvable: it passes through a link with no target",
      "link target unresolvable: links chain too deeply to resolve",
    ]);
    expect(verdicts).toBeGreaterThan(12_000);
  }, 60_000);

  test("generated pax headers: misstated lengths, zeros, signs, white space and huge numbers", () => {
    const random = generator(72);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const WHITE = [
      "\t",
      "\n",
      "\v",
      "\f",
      "\r",
      "\u00a0",
      "\u2003",
      "\u2028",
      "\u3000",
      "\ufeff",
      "\u180e",
      "\u200b",
      "\x7f",
    ];
    const KEYS = ["path", "linkpath", "GNU.sparse.name", "mtime", "", "pa=th"];
    const VALUES = ["evil.txt", "a/../b", "", "x=y", "two\nlines", ".git/config"];
    const token = (): string => {
      const roll = random();
      if (roll < 0.3) return paxRecord(pick(KEYS), pick(VALUES));
      if (roll < 0.4) {
        const record = paxRecord(pick(KEYS), pick(VALUES));
        const digits = record.match(/^\d+/)?.[0] ?? "1";
        const misstated = Math.max(0, Number(digits) + Math.floor(random() * 7) - 3);
        return `${misstated}${record.slice(digits.length)}`;
      }
      if (roll < 0.5) {
        return "0".repeat(Math.floor(random() * 30)) + pick(["1", "2", "9", "10", "0", ""]);
      }
      if (roll < 0.58) return pick(WHITE).repeat(1 + Math.floor(random() * 3));
      if (roll < 0.63) return pick(["+", "-", "-0", "+0", "0x1", "1e3"]);
      if (roll < 0.68) return " ";
      if (roll < 0.72) {
        return pick(["9".repeat(16), "1".repeat(20), "9".repeat(320), `00000${"1".repeat(17)}`]);
      }
      if (roll < 0.8) return `${pick(KEYS)}=${pick(VALUES)}`;
      return pick(["\n", "=", "a", "\u00e9", "7"]);
    };
    let mismatches = 0;
    let named = 0;
    for (let i = 0; i < 4000; i++) {
      let text = "";
      for (let j = 0, n = 1 + Math.floor(random() * 14); j < n; j++) text += token();
      // The reader decodes the bytes, and decoding drops a leading BOM.
      const expected = referencePax(new TextDecoder().decode(Buffer.from(text, "utf8")));
      const [entry] = readTarEntries(paxTar(text, pick(["x", "g"])));
      if (expected.path !== undefined) named += 1;
      const same =
        entry?.name === (expected.path ?? "plain.txt") &&
        entry?.linkTarget === (expected.linkpath === "" ? undefined : expected.linkpath);
      if (!same) mismatches += 1;
    }
    expect(mismatches).toBe(0);
    expect(named).toBeGreaterThan(400);
  }, 60_000);
});
