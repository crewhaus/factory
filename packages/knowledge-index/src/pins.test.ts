/** Names two packages hold separately, held equal. */
import { expect, test } from "bun:test";
import { controlPaths } from "@crewhaus/control-records";

/** Loaded from its file: the wiring package is not a dependency of this one. */
const WIRING = new URL("../../memory-service/src/index.ts", import.meta.url).pathname;

test("the fallback markers are where the sweep looks for them", async () => {
  const wiring = (await import(WIRING)) as { readonly BACKEND_MARKERS_FILE: string };
  expect(wiring.BACKEND_MARKERS_FILE).toBe(controlPaths("").knowledgeBackendsFile);
});
