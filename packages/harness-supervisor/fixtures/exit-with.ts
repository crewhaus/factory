#!/usr/bin/env bun
/**
 * Test fixture: print a line, then exit with the requested code.
 * Usage: bun exit-with.ts <code> [linger-ms]
 *
 * Stands in for a harness that dies with a CrewHaus exit code (20 spec,
 * 31 billing, 33 budget, …) so the classification and restart policy can be
 * exercised against a REAL process without compiling a harness.
 */
const code = Number(process.argv[2] ?? "0");
const linger = Number(process.argv[3] ?? "0");
process.stdout.write(`fixture: exiting with ${code}\n`);
if (linger > 0) await new Promise((r) => setTimeout(r, linger));
process.exit(Number.isFinite(code) ? code : 1);
