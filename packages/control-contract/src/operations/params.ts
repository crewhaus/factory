/** What each `{param}` in an operation's path accepts. Closed. */
import { CANONICAL_RUN_ID_RE, HARNESS_ID_RE, isId, parseId } from "../ids.js";
import { isRef } from "../refs.js";
import { deepFreeze } from "../util.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function prefixed(prefix: string) {
  return (segments: readonly string[]): boolean =>
    segments.length === 1 && isId(prefix, segments[0]);
}

/**
 * `{ref}` spans three path segments because proxies may refuse `%2F`. It may also
 * be one segment, a bare id, so a bare legacy id reaches the resolver that asks
 * for a harness.
 */
function refParam(segments: readonly string[]): boolean {
  if (segments.length === 3) return isRef(segments.join("/"));
  return segments.length === 1 && parseId(segments[0]) !== null;
}

export const PATH_PARAMS = deepFreeze({
  h: (segments: readonly string[]): boolean => {
    const value = segments[0] ?? "";
    return segments.length === 1 && (HARNESS_ID_RE.test(value) || SLUG_RE.test(value));
  },
  dep: prefixed("dep"),
  cmd: prefixed("cmd"),
  rule: prefixed("rule"),
  inv: prefixed("inv"),
  grt: prefixed("grt"),
  crd: prefixed("crd"),
  lnk: prefixed("lnk"),
  dev: prefixed("dev"),
  run: (segments: readonly string[]): boolean =>
    segments.length === 1 && CANONICAL_RUN_ID_RE.test(segments[0] ?? ""),
  ref: refParam,
});

export type PathParam = keyof typeof PATH_PARAMS;

/** How many path segments a param may span. */
export function pathParamSpans(param: string): readonly number[] {
  return param === "ref" ? [1, 3] : [1];
}

/** Whether these path segments fit the param. An unknown param answers `false`. */
export function isPathParam(param: string, segments: readonly string[]): boolean {
  return Object.hasOwn(PATH_PARAMS, param) ? PATH_PARAMS[param as PathParam](segments) : false;
}
