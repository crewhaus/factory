/**
 * One tab never mixes two releases of Home. The version Home answered when the tab
 * booted is kept; it is read again when the tab becomes visible, when the connection
 * comes back, and before every screen the console loads lazily. Once it differs:
 *
 * - the next navigation loads the page whole, at its address, instead of importing a
 *   screen of the new release into the old one;
 * - a tab that comes back to the new release shows a banner ("Home was updated. Reload
 *   to use the new version.") and never reloads on its own, so an unsaved edit stays.
 *
 * A version that cannot be read changes nothing. No DOM here: the shell gives it how to
 * read the version, how to load a page whole and how to show the banner, so a test
 * drives it with stubs.
 */

/**
 * @param {{
 *   readVersion: () => Promise<unknown>,
 *   fullLoad: (target: string) => void,
 *   onUpdated?: (info: { readonly draft: boolean }) => void,
 *   hasDraft?: () => boolean,
 * }} deps
 */
export function createVersionGuard(deps) {
  let known = null;
  let changed = false;
  let announced = false;

  /** Read the version once more; whether it now differs from the one the tab booted on. */
  async function check() {
    let answer;
    try {
      answer = await deps.readVersion();
    } catch {
      return changed;
    }
    const version = answer && typeof answer === "object" ? answer.hangar : undefined;
    if (typeof version !== "string" || version === "") return changed;
    if (known === null) known = version;
    else if (version !== known) changed = true;
    return changed;
  }

  return {
    /** The version the tab booted on: read once at boot. */
    boot: () => check(),
    /** Whether Home's version differs from the one this tab booted on. */
    changed: () => changed,
    /**
     * Before a lazy import for a navigation to `target`: `true` when the page was loaded
     * whole instead, so the caller imports nothing.
     */
    async beforeImport(target) {
      if (!(await check())) return false;
      deps.fullLoad(String(target ?? ""));
      return true;
    },
    /** The tab came back (visible again, or online): say so once when Home was updated. */
    async resumed() {
      if (!(await check()) || announced) return;
      announced = true;
      deps.onUpdated?.({ draft: deps.hasDraft?.() === true });
    },
  };
}

/**
 * Run `load` for a navigation to `target`, unless the guard loaded the page whole: then
 * nothing is imported and the answer is `null`.
 */
export async function guardedLoad(guard, load, target) {
  if (guard !== null && guard !== undefined && (await guard.beforeImport(target))) return null;
  return load();
}

/** Whether this tab holds an unsent draft (`ui/draft.js` keys) in its session storage. */
export function tabHasDraft(storage, prefix = "hangar.draft.") {
  try {
    for (let i = 0; i < storage.length; i++) {
      if (String(storage.key(i) ?? "").startsWith(prefix)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Load the page whole at `target` (a `#/…` address): the address is set first, then the
 * document is loaded again, so the new release's shell draws it. A hash alone changing
 * never reloads a page, so the reload is explicit.
 */
export function fullLoad(target) {
  const url = new URL(window.location.href);
  if (typeof target === "string" && target.startsWith("#")) url.hash = target;
  window.history.replaceState(window.history.state, "", url.toString());
  window.location.reload();
}
