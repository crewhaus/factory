/**
 * `@crewhaus/tool-safety/streams` — reading things of unknown size without
 * letting their size decide how much memory, time or blocking that costs.
 *
 * - {@link collectBounded}: any byte stream, capped as it arrives, drained to
 *   the end, with the discarded amount reported.
 * - {@link spawnBounded}: a child process with capped output, a process-group
 *   kill on timeout/abort that escalates to SIGKILL, cleanup when the host
 *   exits, and an honest `outputComplete`.
 * - {@link readResponseBounded} / {@link decodeBody} + {@link fetchRaw} /
 *   {@link withRawBody}: an HTTP body with its DECODED size bounded,
 *   gzip/deflate/br/zstd bombs included, collected or chunk by chunk, and
 *   never held by a server that stalls.
 * - {@link readFileBounded}: at most N bytes of a regular file; FIFOs,
 *   devices and sockets refused before they are opened.
 *   {@link openRegularFile} makes the same checks and hands over the
 *   descriptor, for a reader that streams.
 *
 * Every budget is parsed first: NaN, a negative number or a missing value
 * throws a `RangeError` instead of reading nothing.
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
  setHostExitCleanup,
  spawnBounded,
} from "./spawn";
export {
  type DecodedBody,
  type DecodedBodyOutcome,
  type ResponseReadFailure,
  type ResponseReadOptions,
  type ResponseReadResult,
  decodeBody,
  fetchRaw,
  readResponseBounded,
  withRawBody,
} from "./response";
export {
  type FileFailure,
  type FileKind,
  type FileOpenOptions,
  type FileReadOptions,
  type FileReadResult,
  type OpenedFile,
  fileKind,
  openRegularFile,
  openRegularFileAsync,
  readFileBounded,
  readFileBoundedSync,
  readOpenedFile,
  readOpenedFileSync,
} from "./file";
