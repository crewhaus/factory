/**
 * Rewrites `absent-corpus.digests.json` and `schedule-object.digests.json`. Run
 * it only for a deliberate emitter change, and append a delta note to this
 * directory's README:
 *
 *   bun packages/compiler/src/__fixtures__/delta-090/regenerate.ts
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { ABSENT_CORPUS } from "../../absent-corpus";
import { compile } from "../../index";
import { SCHEDULE_OBJECT_CORPUS } from "../../schedule-corpus";

/** The date the corpus compiles at, so the model-sunset check cannot move a digest. */
export const CORPUS_TODAY = "2026-09-04";

/** `{path: sha256hex}` for every file one spec compiles to, README included. */
export function corpusFileDigests(yaml: string): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const file of compile(yaml, { today: CORPUS_TODAY }).files) {
    digests[file.path] = createHash("sha256").update(file.content).digest("hex");
  }
  return digests;
}

/** `{spec name: {path: sha256hex}}` for every spec of a corpus, in name order. */
export function corpusDigests(
  corpus: Readonly<Record<string, string>>,
): Record<string, Record<string, string>> {
  const all: Record<string, Record<string, string>> = {};
  for (const name of Object.keys(corpus).sort()) {
    all[name] = corpusFileDigests(corpus[name] as string);
  }
  return all;
}

function write(name: string, corpus: Readonly<Record<string, string>>): void {
  const file = new URL(`./${name}`, import.meta.url);
  writeFileSync(file, `${JSON.stringify(corpusDigests(corpus), null, 2)}\n`);
}

if (import.meta.main) {
  write("absent-corpus.digests.json", ABSENT_CORPUS);
  write("schedule-object.digests.json", SCHEDULE_OBJECT_CORPUS);
}
