#!/usr/bin/env bun
/**
 * Test fixture: a child that refuses SIGTERM, so the stop escalation to
 * SIGKILL after the grace period is exercised for real.
 */
process.on("SIGTERM", () => {
  process.stdout.write("fixture: ignoring SIGTERM\n");
});
process.stdout.write("fixture: up\n");
setInterval(() => {}, 1_000);
