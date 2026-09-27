/**
 * The Windows backends, run on a Windows host (reliability#7).
 *
 * Every other test here drives recorded fixtures, and the Windows fixtures
 * are DOCUMENTED, NOT RECORDED: nobody writing this package had a Windows
 * desktop. That is how 0.7.0 shipped a printer probe whose output the lpstat
 * parser cut at the first space of "Microsoft Print to PDF". This file runs
 * ONLY on win32 (the windows-tools CI job) and runs only READ-ONLY probes —
 * the printer list, presence and the window list — through the real runner.
 * It asserts what the parsers make of the output, never what the machine
 * holds, and logs the raw bytes so the CI log is the recording the fixture
 * comments ask for. A CI runner is a service session, so its answers (no
 * windows, no printers, no idle time) are not a desktop's; the shape is what
 * is being checked.
 *
 * It is the second real-host test in this package, next to
 * integration.test.ts; nothing it runs changes the machine.
 */
import { afterEach, expect, test } from "bun:test";
import { powershellArgv } from "./lib/escape";
import { WINDOWS_PRESENCE, parseWindowsPresence } from "./lib/presence";
import { WINDOWS_PRINTER_LIST, parseWindowsQueues } from "./lib/print";
import { WINDOWS_WINDOW_LIST, parseDelimitedWindows } from "./lib/windows";
import { _allowRealHost, _resetRunSeams, runHostCommand } from "./run";

afterEach(() => {
  _resetRunSeams();
});

async function record(label: string, argv: readonly string[]) {
  const result = await runHostCommand({ argv, timeoutMs: 60_000 });
  console.log(
    `RECORDED ${label} code=${result.code} timedOut=${result.timedOut} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
  );
  return result;
}

test.skipIf(process.platform !== "win32")(
  "each read-only Windows probe answers in the shape its parser reads",
  async () => {
    _allowRealHost(true);
    try {
      const printers = await record("printer-list", powershellArgv(WINDOWS_PRINTER_LIST, {}).argv);
      const queues = parseWindowsQueues(printers.stdout, printers.stderr);
      if (queues.unreadable === null) {
        // A name is whole: the runner's in-box "Microsoft Print to PDF", if
        // it has one, is one printer, not a printer called "Microsoft".
        for (const printer of queues.printers) expect(printer.name.trim()).toBe(printer.name);
        expect(queues.printers.some((p) => p.name === "Microsoft")).toBe(false);
      } else {
        expect(queues.printers).toEqual([]);
      }

      const presence = await record("presence", powershellArgv(WINDOWS_PRESENCE, {}).argv);
      const facts = parseWindowsPresence(presence.stdout);
      expect(facts.idleSeconds === null || Number.isInteger(facts.idleSeconds)).toBe(true);
      expect([true, false, null]).toContain(facts.locked);

      const windows = await record("window-list", powershellArgv(WINDOWS_WINDOW_LIST, {}).argv);
      for (const row of parseDelimitedWindows(windows.stdout)) {
        expect(typeof row.app).toBe("string");
        expect(row.focused).toBeNull();
      }
    } finally {
      _allowRealHost(false);
    }
  },
  180_000,
);
