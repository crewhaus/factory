/**
 * The next page's URL for `HttpPaginate`'s cursor style.
 *
 * The next page is the first URL with the current page's query parameters
 * copied over it and the cursor set. That copy was one
 * `URLSearchParams#set` per parameter on a URL, and each `set` searches the
 * list for the name and then writes the whole query back into the URL: the
 * parameters times the query, for every page. The first URL is the model's,
 * with no length limit. This works out the same list in one pass and writes
 * the query once.
 */

/** A name and value as `URLSearchParams` holds them. */
type Param = [name: string, value: string];

/**
 * `first` with each of `current`'s query parameters set on it, in order,
 * and then `cursorParam` set to `cursor`: the URL that
 *
 *     const next = new URL(first.toString());
 *     for (const [key, value] of current.searchParams.entries())
 *       next.searchParams.set(key, value);
 *     next.searchParams.set(cursorParam, cursor);
 *
 * leaves. `set` gives the FIRST parameter of that name the new value and
 * drops the others, or adds the parameter at the end when there is none, so
 * a name keeps the place it first had and the last value set; a name that
 * is never set keeps every parameter it had.
 */
export function cursorPageUrl(first: URL, current: URL, cursorParam: string, cursor: string): URL {
  const next = new URL(first.toString());
  const params: Param[] = [];
  /** Each name's parameters in `params`, until it is set and keeps one. */
  const places = new Map<string, number[]>();
  for (const [name, value] of next.searchParams) {
    const at = places.get(name);
    if (at === undefined) places.set(name, [params.length]);
    else at.push(params.length);
    params.push([name, value]);
  }
  const dropped = new Set<number>();
  /** Names already set, at the one place each keeps. */
  const kept = new Map<string, number>();
  const set = (name: string, value: string): void => {
    const at = kept.get(name);
    if (at !== undefined) {
      (params[at] as Param)[1] = value;
      return;
    }
    const listed = places.get(name);
    if (listed === undefined) {
      kept.set(name, params.length);
      params.push([name, value]);
      return;
    }
    const [place, ...rest] = listed as [number, ...number[]];
    for (const other of rest) dropped.add(other);
    (params[place] as Param)[1] = value;
    kept.set(name, place);
  };
  for (const [name, value] of current.searchParams) set(name, value);
  // As a URLSearchParams method would read them: a lone surrogate is U+FFFD,
  // so the cursor's name matches the parameter the URL already spells so.
  set(cursorParam.toWellFormed(), cursor.toWellFormed());
  const query = new URLSearchParams();
  for (let i = 0; i < params.length; i++) {
    if (dropped.has(i)) continue;
    const [name, value] = params[i] as Param;
    query.append(name, value);
  }
  next.search = query.toString();
  return next;
}
