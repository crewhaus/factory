/**
 * Path safety for a server that reads files on behalf of HTTP callers —
 * re-exported.
 *
 * Two independent layers, both mandatory:
 *
 *   1. Shape validation — every id that becomes a path segment must match
 *      its format regex (`hrn_…`, `sess_…`, `run_…`, `SAFE_SEGMENT_RE`)
 *      BEFORE any filesystem work.
 *   2. Realpath containment — every resolved path must land inside the
 *      harness's registered directory AFTER symlink resolution. Shape checks
 *      stop `../` traversal; the realpath check additionally stops a symlink
 *      planted inside a harness tree from walking the read outside it.
 *
 * The containment helpers moved to `@crewhaus/harness-supervisor`, together
 * with the run-detail reader that reads through them. This module
 * re-exports every name it used to define, as the same bindings, for one
 * release; import from `@crewhaus/harness-supervisor` instead.
 */
export { isSafePathSegment, resolveContained, resolveInside } from "@crewhaus/harness-supervisor";
