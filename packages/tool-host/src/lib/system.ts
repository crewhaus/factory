/**
 * Parsers for what a machine says about itself.
 *
 * Every function here takes a STRING and returns a value — no spawning, no
 * file reads, no platform sniffing. That is what makes them testable: the
 * fixtures in ../fixtures.ts are real captures from a macOS host and a real
 * Linux container, and each parser is checked against the bytes those hosts
 * actually printed rather than against whatever the test machine answers.
 *
 * The shared convention: a field that the input does not contain comes back
 * `null`, never 0 and never "". The caller turns each null into an entry in
 * `unknown` with the probe that produced it.
 */

/** Value of `key` in a `key: value` block, or null. Split at the FIRST
 *  colon: `kern.boottime` prints a date whose own colons would otherwise
 *  truncate it, and `sw_vers` separates with two TABS rather than a space. */
export function pairValue(pairs: ReadonlyMap<string, string>, key: string): string | null {
  const value = pairs.get(key);
  return value === undefined || value.trim() === "" ? null : value.trim();
}

/** Parse `key: value` lines into a map. Later duplicates lose to earlier
 *  ones, matching how `sysctl` and `sw_vers` behave (they do not repeat). */
export function parseColonPairs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    // \r: every Windows probe in this package arrives CRLF-terminated, and a
    // trailing \r silently becomes part of the value (and of the last field
    // of a CSV row) if it is not stripped here.
    const line = raw.replace(/\r$/, "");
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key === "" || out.has(key)) continue;
    out.set(key, value);
  }
  return out;
}

/** Parse `key=value` lines (`wmic /format:list`, os-release). */
export function parseEqualsPairs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (out.has(key)) continue;
    out.set(key, unquote(line.slice(at + 1).trim()));
  }
  return out;
}

/** os-release values are shell-quoted: `PRETTY_NAME="Debian GNU/Linux 13
 *  (trixie)"`, and a quoted value may contain escaped quotes. */
function unquote(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1).replace(/\\(["'\\$`])/g, "$1");
  }
  return value;
}

export type UnameFacts = {
  readonly kernelName: string;
  readonly kernelRelease: string;
  readonly kernelVersion: string;
  readonly machine: string;
};

/**
 * Parse `uname -srvm`.
 *
 * The trap is the VERSION field, which contains spaces — on the machine
 * these fixtures came from it is `Darwin Kernel Version 25.6.0: Fri Jul 31
 * 19:17:12 PDT 2026; root:xnu-12377.161.14~5/RELEASE_ARM64_T8103`, eleven
 * tokens with colons in it. Splitting into four fields loses everything
 * after the first space of the version and, worse, reports a date fragment
 * as the machine. So the first two tokens and the LAST token are fixed and
 * the version is whatever lies between them.
 */
export function parseUname(text: string): UnameFacts | null {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 4) return null;
  const kernelName = tokens[0] as string;
  const kernelRelease = tokens[1] as string;
  const machine = tokens[tokens.length - 1] as string;
  const kernelVersion = tokens.slice(2, -1).join(" ");
  return { kernelName, kernelRelease, kernelVersion, machine };
}

export type SwVers = {
  readonly productName: string | null;
  readonly productVersion: string | null;
  readonly buildVersion: string | null;
};

/** Parse `sw_vers`. A Rapid Security Response adds `ProductVersionExtra`
 *  (e.g. "(a)"), which is appended when present because the two together
 *  are what Apple calls the version. */
export function parseSwVers(text: string): SwVers {
  const pairs = parseColonPairs(text);
  const base = pairValue(pairs, "ProductVersion");
  const extra = pairValue(pairs, "ProductVersionExtra");
  return {
    productName: pairValue(pairs, "ProductName"),
    productVersion: base === null ? null : extra === null ? base : `${base} ${extra}`,
    buildVersion: pairValue(pairs, "BuildVersion"),
  };
}

export type CpuinfoFacts = {
  /** Number of `processor:` entries, or null when the file said nothing. */
  readonly logicalCores: number | null;
  /** Unique (physical id, core id) pairs, or null when the file omits them —
   *  which it does on every ARM kernel. */
  readonly physicalCores: number | null;
  readonly model: string | null;
};

/**
 * Parse /proc/cpuinfo.
 *
 * Two things this must NOT do, both checked against a real aarch64
 * /proc/cpuinfo captured for the fixtures:
 *
 *   1. Report 0 cores when the file is unreadable or empty. Null, and the
 *      caller says which probe was missing.
 *   2. Report physical cores as equal to logical cores when the file has no
 *      `physical id` / `core id` lines. ARM kernels print neither, so an
 *      assumption there is a fabricated number — and it is wrong in exactly
 *      the case a caller cares about (SMT), where logical is double.
 *
 * The separator is inconsistent within one file: `processor\t: 0` but `CPU
 * architecture: 8`, so the key is everything before the first colon, trimmed.
 */
export function parseProcCpuinfo(text: string): CpuinfoFacts {
  const blocks = text.split(/\n\s*\n/).filter((b) => b.trim() !== "");
  let logical = 0;
  const cores = new Set<string>();
  let missingTopology = false;
  let model: string | null = null;

  for (const block of blocks) {
    const pairs = parseColonPairs(block);
    if (!pairs.has("processor")) continue;
    logical++;
    if (model === null) {
      // x86 says "model name"; some ARM boards say "Hardware" or "Model";
      // a plain kernel on ARM says nothing at all, and null is the answer.
      model =
        pairValue(pairs, "model name") ?? pairValue(pairs, "Model") ?? pairValue(pairs, "Hardware");
    }
    const physicalId = pairValue(pairs, "physical id");
    const coreId = pairValue(pairs, "core id");
    if (physicalId === null || coreId === null) missingTopology = true;
    else cores.add(`${physicalId}/${coreId}`);
  }

  return {
    logicalCores: logical > 0 ? logical : null,
    physicalCores: missingTopology || cores.size === 0 ? null : cores.size,
    model,
  };
}

export type MeminfoFacts = {
  readonly totalBytes: number | null;
  readonly freeBytes: number | null;
  /** MemAvailable: what a new allocation can actually get, counting
   *  reclaimable page cache. Several times MemFree on a warm machine, and
   *  the only one of the two worth gating on. */
  readonly availableBytes: number | null;
};

/** Parse /proc/meminfo. Values are `NNN kB`; a line whose unit is anything
 *  else is refused rather than multiplied by 1024 on a guess. */
export function parseProcMeminfo(text: string): MeminfoFacts {
  const pairs = parseColonPairs(text);
  const bytes = (key: string): number | null => {
    const raw = pairValue(pairs, key);
    if (raw === null) return null;
    const match = raw.match(/^(\d+)(?:\s+(\S+))?$/);
    if (match === null) return null;
    const value = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    if (unit === undefined) return value;
    if (unit === "kb") return value * 1024;
    if (unit === "mb") return value * 1024 * 1024;
    return null;
  };
  return {
    totalBytes: bytes("MemTotal"),
    freeBytes: bytes("MemFree"),
    availableBytes: bytes("MemAvailable"),
  };
}

export type BatteryFacts = {
  /** null means "could not tell", NOT "no battery". */
  readonly present: boolean | null;
  readonly percent: number | null;
  readonly charging: boolean | null;
  readonly powerSource: "ac" | "battery" | null;
};

const NO_BATTERY: BatteryFacts = {
  present: false,
  percent: null,
  charging: null,
  powerSource: null,
};

/**
 * Parse `pmset -g batt`.
 *
 * On a desktop Mac the whole output is one line — `Now drawing from 'AC
 * Power'` — with no battery line at all. That is the case that has to come
 * back as `present: false` rather than as 0%: the catalog's own example use
 * ("skip the 8 GB pull below 20% battery") fires on every desktop in the
 * fleet if a missing battery reads as empty. The fixture is that exact
 * capture, byte for byte.
 *
 * The second trap is the status word, and it bites TWICE.
 * `"discharging".includes("charging")` is true, so the match is anchored on
 * a word boundary — but a word boundary alone is not enough either, because
 * macOS prints `AC attached; not charging` for a battery a charge limiter
 * (Optimized Battery Charging, or an 80% cap) is holding below full. There
 * the word "charging" IS its own word, preceded by a space, and reading it
 * as `charging: true` says a battery is filling when it is deliberately
 * parked. The negation is checked before the positive, the same way the
 * sysfs parser maps Linux's identical "Not charging" to null.
 */
export function parsePmsetBatt(text: string): BatteryFacts {
  const source = text.match(/Now drawing from '([^']+)'/)?.[1]?.toLowerCase();
  const powerSource: "ac" | "battery" | null =
    source === undefined ? null : source.startsWith("ac") ? "ac" : "battery";

  const line = text.split("\n").find((l) => /-\w*Battery/.test(l));
  if (line === undefined) return { ...NO_BATTERY, powerSource };

  // pmset states the flag itself on modern macOS; trust it over inference.
  const presentFlag = line.match(/present:\s*(true|false)/i)?.[1]?.toLowerCase();
  if (presentFlag === "false") return { ...NO_BATTERY, powerSource };

  const percentText = line.match(/(\d{1,3})%/)?.[1];
  const percent = percentText === undefined ? null : clampPercent(Number(percentText));
  // Checked FIRST, and mapped to null rather than to false: "not charging"
  // is a stated non-state — on mains, not filling, not draining — and both
  // answers would be acted on. `false` would tell a caller the battery is
  // draining; `true` (what a bare word-boundary match on "charging" gives)
  // would tell it to wait for a charge that will never arrive.
  const parked = /\bnot\s+charging\b/i.test(line) || /\bno\s+longer\s+charging\b/i.test(line);
  const charging = parked
    ? null
    : /(?:^|[\s;(])charging\b/i.test(line)
      ? true
      : /\bdischarging\b/i.test(line)
        ? false
        : /\bcharged\b|\bfinishing charge\b/i.test(line)
          ? false
          : null;
  return { present: true, percent, charging, powerSource };
}

/** Reads one attribute file of one /sys/class/power_supply device. */
export type PowerSupplyReader = (device: string, attribute: string) => string | undefined;

/**
 * Which device under /sys/class/power_supply is THIS MACHINE's battery.
 *
 * Not "the first name containing 'battery'". That directory holds every
 * power supply the kernel knows about, and on a DESKTOP with a wireless
 * mouse it holds `hidpp_battery_0` — the mouse's cell, reported by the
 * HID++ driver with its own capacity and a status of Discharging. Matched
 * on its name, a desktop plugged into the wall comes back as a machine
 * running on battery at 55%, and the catalog's own example use ("skip the
 * 8 GB pull below 20% battery") then fires on the charge of a mouse.
 *
 * The kernel already distinguishes them: `type` is "Battery" for a cell and
 * "Mains" for a charger, and `scope` is "Device" for a supply that powers a
 * PERIPHERAL rather than the system (the attribute exists for exactly this
 * reason, and upower uses it the same way). A supply whose scope says
 * Device is skipped whatever it is called.
 *
 * When `type` cannot be read at all, the fallback is the slot names a
 * system battery actually uses — BAT0, CMB0, macsmc-battery — and not a
 * substring, because every peripheral in that directory has "battery" in
 * its name and no system battery is called `hidpp_battery_0`.
 *
 * Returns null when no device qualifies, which is a measurement: the
 * directory listed, and nothing in it is this machine's battery.
 */
export function chooseSystemBattery(
  entries: ReadonlyArray<string>,
  read: PowerSupplyReader,
): string | null {
  const SLOT_NAMES = /^(bat\d*|cmb\d*|macsmc-battery)$/i;
  for (const name of entries) {
    if (read(name, "scope")?.trim().toLowerCase() === "device") continue;
    const type = read(name, "type")?.trim().toLowerCase();
    if (type === "battery") return name;
    if (type === undefined && SLOT_NAMES.test(name)) return name;
  }
  return null;
}

/**
 * Battery from /sys/class/power_supply/<name>/{capacity,status}.
 *
 * Preferred over `upower` on Linux for a reason about argv rather than about
 * data: `upower` needs the device path discovered by `upower -e` first, and
 * feeding one command's output into the next command's argv is how a value
 * that begins with `-` becomes a flag. Reading two files whose paths are
 * built from a directory listing has no such surface.
 *
 * `status` is one of Charging / Discharging / Full / Not charging /
 * Unknown. The last two are a genuinely unknown charge DIRECTION (a laptop
 * held at 80% by a charge limiter says "Not charging" while on mains), so
 * they come back null rather than false.
 */
export function parseSysfsBattery(
  capacityText: string | undefined,
  statusText: string | undefined,
): BatteryFacts {
  if (capacityText === undefined && statusText === undefined) {
    return { present: null, percent: null, charging: null, powerSource: null };
  }
  const capacity = capacityText === undefined ? null : Number.parseInt(capacityText.trim(), 10);
  const percent = capacity === null || Number.isNaN(capacity) ? null : clampPercent(capacity);
  const status = statusText?.trim().toLowerCase();
  const charging =
    status === "charging"
      ? true
      : status === "discharging"
        ? false
        : status === "full"
          ? false
          : null;
  const powerSource: "ac" | "battery" | null =
    status === "discharging"
      ? "battery"
      : status === undefined || status === "unknown" || status === "not charging"
        ? null
        : "ac";
  return { present: true, percent, charging, powerSource };
}

/**
 * Battery from `wmic path Win32_Battery ... /format:list`.
 *
 * BatteryStatus is a CIM enumeration and only some of its values say
 * anything about charging: 1/4/5 are discharging states, 6/7/8/9 are
 * charging states, 3 is fully charged, and 2 ("Unknown", in practice "on
 * mains") plus 10/11 say nothing definite. The ambiguous codes map to null,
 * not to false — a wrong `charging: false` is what makes a workflow wait for
 * a charge that is already happening.
 */
export function parseWmicBattery(text: string): BatteryFacts {
  const pairs = parseEqualsPairs(text);
  if (pairs.size === 0) {
    // wmic ran and returned no instance: this host has no battery. That IS a
    // measurement, so `present: false` rather than null.
    return NO_BATTERY;
  }
  const percentRaw = pairs.get("EstimatedChargeRemaining");
  const percentNum = percentRaw === undefined ? Number.NaN : Number.parseInt(percentRaw, 10);
  const percent = Number.isNaN(percentNum) ? null : clampPercent(percentNum);
  const statusNum = Number.parseInt(pairs.get("BatteryStatus") ?? "", 10);
  const chargingCode = statusNum >= 6 && statusNum <= 9;
  const dischargingCode = statusNum === 1 || statusNum === 4 || statusNum === 5;
  const charging = chargingCode ? true : dischargingCode || statusNum === 3 ? false : null;
  const powerSource: "ac" | "battery" | null = dischargingCode
    ? "battery"
    : chargingCode || statusNum === 2 || statusNum === 3
      ? "ac"
      : null;
  return { present: true, percent, charging, powerSource };
}

/** A percentage outside 0..100 is a misread, not a reading. */
function clampPercent(value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value);
}

export type DiskFacts = {
  readonly totalBytes: number | null;
  readonly freeBytes: number | null;
  readonly availableBytes: number | null;
};

/**
 * Turn a statfs reading into bytes.
 *
 * `bfree` and `bavail` are different numbers and the difference is the
 * reserved-block pool only root may use: gating a download on `bfree` on a
 * full ext4 filesystem writes until ENOSPC with five per cent still "free".
 * `availableBytes` is the one to gate on, which is why both are reported
 * rather than one being quietly chosen.
 *
 * A non-positive block size or count is treated as a failed reading rather
 * than as an empty disk — `statfsSync` on APFS returns NEGATIVE inode counts
 * (verified on macOS 26), so its numbers are not blindly trustworthy.
 */
export function statfsToBytes(
  reading: { bsize: number; blocks: number; bfree: number; bavail: number } | undefined,
): DiskFacts {
  if (reading === undefined || reading.bsize <= 0 || reading.blocks <= 0) {
    return { totalBytes: null, freeBytes: null, availableBytes: null };
  }
  const size = (blocks: number): number | null =>
    blocks < 0 || !Number.isFinite(blocks) ? null : blocks * reading.bsize;
  return {
    totalBytes: size(reading.blocks),
    freeBytes: size(reading.bfree),
    availableBytes: size(reading.bavail),
  };
}
