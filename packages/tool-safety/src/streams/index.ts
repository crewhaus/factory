/**
 * `@crewhaus/tool-safety/streams` — reading things of unknown size without
 * letting their size decide how much memory, time or blocking that costs.
 *
 * - {@link collectBounded}: any byte stream, capped as it arrives, drained to
 *   the end, with the discarded amount reported.
 * - {@link spawnBounded}: a child process with capped output, a process-group
 *   kill on timeout/abort, and an honest `outputComplete`.
 * - {@link readResponseBounded} + {@link withRawBody}: an HTTP body with its
 *   DECODED size bounded, gzip/deflate/br/zstd bombs included.
 * - {@link readFileBounded}: at most N bytes of a regular file; FIFOs,
 *   devices and sockets refused before they are opened.
 */
export {
  type CollectOptions,
  type CollectResult,
  collectBounded,
} from "./collect";
export {
  SPAWN_DEFAULTS,
  type SpawnBoundedOptions,
  type SpawnBoundedResult,
  spawnBounded,
} from "./spawn";
export {
  type ResponseReadOptions,
  type ResponseReadResult,
  readResponseBounded,
  withRawBody,
} from "./response";
export {
  type FileKind,
  type FileReadOptions,
  type FileReadResult,
  fileKind,
  readFileBounded,
  readFileBoundedSync,
} from "./file";
