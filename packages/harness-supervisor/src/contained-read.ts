/**
 * A harness's own small record, read as text only when it is a regular file inside the
 * harness: the open never waits (a named pipe with no writer opens at once and reads as
 * nothing), a link at its name is followed only while it stays inside, and a file larger
 * than `maxBytes` reads as nothing too.
 *
 * First consumers: the manager settings and retention readers (`.crewhaus/settings.json`).
 */
import { closeSync } from "node:fs";
import { openRecordFd, readAt } from "@crewhaus/control-records";

/** The text of `path` (inside `harnessDir`), or `undefined` when it is anything else. */
export function readHarnessRecordText(
  harnessDir: string,
  path: string,
  maxBytes: number,
): string | undefined {
  const opened = openRecordFd(harnessDir, path, true);
  if (!opened.ok) return undefined;
  try {
    const size = opened.stats.size;
    if (size > maxBytes) return undefined;
    const bytes = new Uint8Array(size);
    const got = size === 0 ? 0 : readAt(opened.fd, bytes, size, 0);
    return new TextDecoder().decode(bytes.subarray(0, got));
  } catch {
    return undefined;
  } finally {
    closeSync(opened.fd);
  }
}
