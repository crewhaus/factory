#!/usr/bin/env bun
/**
 * Test fixture: a child that stays up until it is stopped — the stand-in
 * for a daemon in liveness and adoption tests.
 */
process.stdout.write(`fixture: pid ${process.pid}\n`);
setInterval(() => {}, 1_000);
