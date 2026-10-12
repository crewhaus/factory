/**
 * Critic8 (0.7.1): the permission gate reads a secret reference the way this
 * package's `parseRef` reads it. SecretLookup's `refs`, SecretRotate's `ref`
 * and `newValueFrom`, and EnvFileUpsert's `valueFrom` declare `secretRef`, and
 * the gate (`@crewhaus/tool-executor`) extracts the file a `file:` or
 * `envfile:` reference opens with its own copy of the split. This holds the
 * two together: over a fixed corpus and a seeded generator, every file the
 * tool would open is a file the gate read, and the gate reads no other file
 * for a reference the tool accepts.
 *
 * The canonicaliser here only records what it is handed; where the file
 * lands is runtime-core's business and has its own tests.
 */
import { describe, expect, test } from "bun:test";
import { lexicalPathValues, operativeValuesFor } from "@crewhaus/tool-executor";
import { envFileUpsert, secretLookup, secretRotate } from "./index";
import { parseRef } from "./lib/refs";

/** The files the gate reads for one call: what it hands the canonicaliser. */
function gateReads(tool: typeof secretLookup, input: unknown): string[] {
  const seen: string[] = [];
  operativeValuesFor(tool, input, {
    canonicalizePath: (raw) => {
      seen.push(raw);
      return lexicalPathValues(raw);
    },
  });
  return seen;
}

/** The file the tool opens for a reference, as parseRef reads it; none when it refuses. */
function toolOpens(raw: string): { readonly paths: string[]; readonly refused: boolean } {
  const parsed = parseRef(raw);
  if (!parsed.ok) return { paths: [], refused: true };
  const ref = parsed.value;
  return { paths: ref.kind === "file" || ref.kind === "envfile" ? [ref.path] : [], refused: false };
}

/** mulberry32: a seeded generator, so a failing reference reproduces. */
function seeded(seed: number): () => number {
  const state = { a: seed >>> 0 };
  return () => {
    state.a = (state.a + 0x6d2b79f5) >>> 0;
    let t = state.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CORPUS = [
  "file:secrets/token",
  "file:./secrets/token",
  "file:secrets//token",
  "file:pub/../secrets/token",
  "file:pub/lnk/token",
  " file:secrets/token",
  "\tfile:secrets/token \n",
  " file:secrets/token﻿",
  "file: secrets/token",
  "file:",
  "File:secrets/token",
  "envfile:.env#KEY",
  "envfile:./secrets/.env#KEY",
  "envfile:a#b/.env#KEY",
  "envfile:secrets/.env",
  "envfile:#KEY",
  "envfile:secrets/.env#bad-key",
  "env:HOME",
  "keychain:acme#deploy",
  "op://vault/item/field",
  "SLACK_TOKEN",
  "file:secrets/token\nx",
];

function generated(count: number, seed: number): string[] {
  const next = seeded(seed);
  const pick = <T>(list: ReadonlyArray<T>): T => list[Math.floor(next() * list.length)] as T;
  const around = ["", "", " ", "\t", " ", "﻿", "\n", "\r", " "];
  const schemes = ["file:", "file:", "envfile:", "envfile:", "env:", "File:", "op://", "pass:", ""];
  const segments = ["secrets", ".", "..", "", "pub", "lnk", "a#b", "token", ".env", " x", "é", "#"];
  const joins = ["/", "/", "//", "\\"];
  const keys = ["", "#KEY", "#KEY", "#bad-key", "#", "#A#B"];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    const n = 1 + Math.floor(next() * 4);
    for (let j = 0; j < n; j++) parts.push(pick(segments));
    const path = parts.join(pick(joins));
    out.push(`${pick(around)}${pick(schemes)}${path}${pick(keys)}${pick(around)}`);
  }
  return out;
}

describe("the gate reads a secret reference as parseRef reads it", () => {
  test("every file the tool opens is a file the gate read, and no other for an accepted reference", () => {
    const refs = [...CORPUS, ...generated(20_000, 0x0c8)];
    const tally = { opens: 0, refused: 0, ids: 0 };
    const mismatches: Array<{ ref: string; tool: string[]; gate: string[] }> = [];
    for (const ref of refs) {
      const tool = toolOpens(ref);
      const gate = gateReads(secretLookup, { refs: [ref] });
      if (tool.refused) tally.refused++;
      else if (tool.paths.length > 0) tally.opens++;
      else tally.ids++;
      const missing = tool.paths.filter((p) => !gate.includes(p));
      // A reference the tool refuses opens nothing; the gate may still read
      // the file it names, which can only make a deny fire.
      const extra = tool.refused ? [] : gate.filter((p) => !tool.paths.includes(p));
      if (missing.length > 0 || extra.length > 0) {
        mismatches.push({ ref: JSON.stringify(ref), tool: tool.paths, gate });
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    // The work the sweep did: each kind of reading came up many times.
    expect(tally.opens).toBeGreaterThan(2_000);
    expect(tally.refused).toBeGreaterThan(2_000);
    expect(tally.ids).toBeGreaterThan(500);
  });

  test("each tool that takes a reference routes it through the same reading", () => {
    // SecretRotate's target and source, and EnvFileUpsert's source beside
    // the file it writes.
    expect(
      gateReads(secretRotate, { ref: " file:./a/t", newValueFrom: "envfile:b/.env#K" }),
    ).toEqual(["./a/t", "b/.env"]);
    expect(
      gateReads(envFileUpsert, {
        entries: [
          { key: "A", valueFrom: "file:pub/../secrets/token" },
          { key: "B", value: "plain" },
        ],
      }),
    ).toEqual([".env", "pub/../secrets/token"]);
  });
});
