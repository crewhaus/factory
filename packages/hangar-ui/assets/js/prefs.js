/**
 * Readability preferences, per device: text size, density, motion,
 * contrast, single-key shortcuts and whether the first-run card has been
 * answered. They live in this browser's `localStorage["hangar.prefs"]` and
 * nowhere else — they are how one person reads one screen, never harness
 * state, and nothing here is sent to the server.
 *
 * The theme keeps its own key (`hangar.theme`), which predates this record;
 * its read, write and apply live here too, so the Settings screen can change
 * it without importing the app entry.
 *
 * Every storage call is wrapped (a private window may refuse them all), and
 * {@link normalizePrefs} turns anything unexpected into the default, so a
 * bad value can never reach the document.
 */

export const PREFS_KEY = "hangar.prefs";
export const THEME_KEY = "hangar.theme";

/** The choices each preference may take; the first is the default. */
export const PREF_CHOICES = Object.freeze({
  textSize: Object.freeze(["default", "large", "larger"]),
  density: Object.freeze(["comfortable", "compact"]),
  motion: Object.freeze(["system", "reduce"]),
  contrast: Object.freeze(["system", "more"]),
});

export const DEFAULT_PREFS = Object.freeze({
  v: 1,
  textSize: "default",
  density: "comfortable",
  motion: "system",
  contrast: "system",
  singleKeys: true,
  firstRunDone: false,
});

/** Any value → a well-formed preferences record. Pure. */
export function normalizePrefs(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const pick = (name) => {
    const allowed = PREF_CHOICES[name];
    return allowed.includes(r[name]) ? r[name] : allowed[0];
  };
  return {
    v: 1,
    textSize: pick("textSize"),
    density: pick("density"),
    motion: pick("motion"),
    contrast: pick("contrast"),
    singleKeys: typeof r.singleKeys === "boolean" ? r.singleKeys : DEFAULT_PREFS.singleKeys,
    firstRunDone: r.firstRunDone === true,
  };
}

function localStore(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored preferences, normalized; the defaults when nothing reads. */
export function readPrefs(storage) {
  const store = localStore(storage);
  if (store === null) return normalizePrefs(null);
  try {
    const text = store.getItem(PREFS_KEY);
    return normalizePrefs(typeof text === "string" ? JSON.parse(text) : null);
  } catch {
    return normalizePrefs(null);
  }
}

/** Merge `patch` into the stored preferences and return the result. A write
 *  that fails still returns what applies to this page. */
export function writePrefs(patch, storage) {
  const next = normalizePrefs({ ...readPrefs(storage), ...(patch ?? {}) });
  const store = localStore(storage);
  if (store !== null) {
    try {
      store.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // the choice applies to this page, and will not persist
    }
  }
  return next;
}

function setOrClear(dataset, name, value, whenDefault) {
  if (value === whenDefault) Reflect.deleteProperty(dataset, name);
  else dataset[name] = value;
}

/**
 * Put `prefs` on the root element's data attributes, which the stylesheet
 * reads. A default leaves no attribute at all, so "System" defers to the
 * media queries. `root` is anything with a `dataset`.
 */
export function applyPrefs(root, prefs) {
  const p = normalizePrefs(prefs);
  const dataset = root.dataset;
  setOrClear(dataset, "textSize", p.textSize, "default");
  setOrClear(dataset, "density", p.density, "comfortable");
  setOrClear(dataset, "motion", p.motion, "system");
  setOrClear(dataset, "contrast", p.contrast, "system");
  return p;
}

/** The stored theme: `"light"` or `"dark"` (the default). */
export function readTheme(storage) {
  const store = localStore(storage);
  if (store === null) return "dark";
  try {
    return store.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Store the theme. */
export function writeTheme(theme, storage) {
  const value = theme === "light" ? "light" : "dark";
  const store = localStore(storage);
  if (store !== null) {
    try {
      store.setItem(THEME_KEY, value);
    } catch {
      // the theme applies to this page, and will not persist
    }
  }
  return value;
}

/** Put the theme on the root element. */
export function applyTheme(root, theme) {
  root.dataset.theme = theme === "light" ? "light" : "dark";
}

let pendingFocus = null;

/** Ask the next screen that can to take focus to `name` (the first-run
 *  card's Adjust asks Settings to focus Readability). */
export function requestFocus(name) {
  pendingFocus = String(name);
}

/** True, once, when focus was asked for `name`. */
export function takeFocusRequest(name) {
  if (pendingFocus !== name) return false;
  pendingFocus = null;
  return true;
}
