/**
 * The one seam in this package that looks at the machine.
 *
 * Every other file here is a function of its arguments: `src/index.ts` and
 * everything under `src/lib/` are held to that by the "reaches outside for
 * nothing" grep in `index.test.ts`, which bans `process.`, the clock, the
 * filesystem and the network outright. `LocalTime` needs one fact that is not
 * an argument — the zone the operator's machine is set to — so that read lives
 * here, alone, in a file the grep covers under a narrower rule: the only thing
 * this module may read from the environment is `TZ` (and `NODE_ENV`, for the
 * gate below). A second test asserts exactly that, so the exception cannot
 * quietly widen into a second clock.
 *
 * The clock is *not* part of the exception. `LocalTime` still takes its
 * instant as an input, like every other tool here. Only the zone comes from
 * the host.
 *
 * ── THE HOSTILE DEFAULT ────────────────────────────────────────────────────
 *
 * Under `bun test` (`NODE_ENV=test`) the un-injected read does not fall back
 * to the real machine — it returns `ok: false` with the gate as the reason, on
 * every box, identically. This is `tool-desktop`'s rule and it is here for the
 * same reason: a test that forgets to install the seam would otherwise read
 * the author's zone (`America/Los_Angeles`) and CI's (`UTC`), pass in one
 * place and take a different branch in the other. Making the ambient answer
 * useless is cheaper than remembering not to use it.
 *
 * `integration.test.ts` is the one file allowed near the real host: it calls
 * `_allowRealHost(true)`, asserts that the un-injected path then really does
 * read the machine, and puts the gate back in the same `finally`.
 *
 * The residual cost is stated plainly: a harness deliberately run with
 * `NODE_ENV=test` gets a refusal from `LocalTime` unless it passes `timeZone`.
 * That is fail-closed, the reason names the gate, and it is visible rather
 * than a timestamp that is quietly in the wrong zone.
 *
 * ── WHY THE PROVENANCE IS PART OF THE ANSWER ───────────────────────────────
 *
 * A wrong zone is invisible: it does not look like an error, it looks like a
 * correct time. The one that bites is a `TZ` the runtime silently ignored —
 * recorded on bun 1.3.14, `TZ="EST5EDT,M3.2.0,M11.1.0"` (legal POSIX, not an
 * IANA identifier) resolves to the *system* zone with no warning of any kind.
 * An operator who set `TZ` and got their neighbour's timezone back has no way
 * to tell from the timestamps. So every reading carries where it came from,
 * and when `TZ` and the runtime disagree the answer says so instead of picking
 * one and moving on.
 */
import { isValidTimeZone } from "./lib/civil";

/** Where a zone came from. A caller-supplied zone never reaches this module. */
export type ZoneSource = "env" | "system";

/**
 * What the host had to say about its zone.
 *
 * "Could not determine" is a distinct answer from any zone, which is why this
 * is a union and not a string that is sometimes empty: a caller that treats an
 * unreadable zone as UTC has silently moved every timestamp it prints.
 */
export type HostZoneReading =
  | {
      readonly ok: true;
      readonly timeZone: string;
      readonly source: ZoneSource;
      /** Prose naming where this zone came from, for the tool to pass through. */
      readonly detail: string;
      /** `TZ` exactly as it was set, when it was set at all. */
      readonly tzEnv?: string;
      /** What `Intl` resolves as this process's default zone. */
      readonly runtimeZone?: string;
      /** Set only when `TZ` and the runtime's resolved zone name different zones. */
      readonly conflict?: string;
    }
  | {
      readonly ok: false;
      readonly source: ZoneSource | "none";
      readonly reason: string;
      readonly tzEnv?: string;
      readonly runtimeZone?: string;
    };

let zoneOverride: HostZoneReading | undefined;

/** See THE HOSTILE DEFAULT above. `bun test` sets `NODE_ENV=test` itself. */
let realHostAllowed = process.env["NODE_ENV"] !== "test";

/**
 * This process's default zone according to `Intl`, or `undefined` when it
 * cannot be had.
 *
 * The locale is pinned for the same reason `lib/civil.ts` pins it — nothing
 * here may depend on the host's locale — even though `timeZone` does not vary
 * with it. A runtime built without tzdata can return an empty string here, and
 * an empty string is not a zone.
 */
function runtimeDefaultZone(): string | undefined {
  try {
    const resolved = new Intl.DateTimeFormat("en-US").resolvedOptions().timeZone;
    return typeof resolved === "string" && resolved !== "" ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the machine actually says, gate or no gate. Only the smoke test in
 * `integration.test.ts` and `readHostZone` below call it.
 */
export function realHostZone(): HostZoneReading {
  const runtimeZone = runtimeDefaultZone();
  const runtimePart = runtimeZone !== undefined ? { runtimeZone } : {};
  const raw = process.env["TZ"];
  const tz = raw === undefined ? undefined : raw.trim();

  if (tz !== undefined && tz !== "") {
    // Parse before acting, and act on the parsed value: `TZ` is a POSIX
    // variable and only some of its legal values are IANA identifiers. The
    // string is validated here and the *validated* string is what gets
    // returned, so nothing downstream can re-derive a different zone from the
    // raw one.
    if (isValidTimeZone(tz)) {
      const conflict =
        runtimeZone !== undefined && runtimeZone !== tz
          ? `TZ names ${tz} but this process's Intl default resolves to ${runtimeZone}; TZ is reported here because it is what the operator declared, but formatting done without an explicit zone elsewhere in this process may use ${runtimeZone}`
          : undefined;
      return {
        ok: true,
        timeZone: tz,
        source: "env",
        detail: `the TZ environment variable, set to ${tz}`,
        tzEnv: tz,
        ...runtimePart,
        ...(conflict !== undefined ? { conflict } : {}),
      };
    }
    // TZ is set to something this runtime's tzdb does not know. The runtime
    // does not fail on that — it silently uses the system zone instead — so
    // the answer is the system zone WITH the discarded TZ named. Reporting
    // this as the env zone would be a lie; reporting it as a plain system zone
    // would hide the operator's ignored intent.
    if (runtimeZone === undefined || !isValidTimeZone(runtimeZone)) {
      return {
        ok: false,
        source: "env",
        reason: `TZ is set to "${tz}", which is not an IANA zone this runtime knows, and the runtime's own default zone could not be read either`,
        tzEnv: tz,
        ...runtimePart,
      };
    }
    return {
      ok: true,
      timeZone: runtimeZone,
      source: "system",
      detail: `the system zone (${runtimeZone}); TZ is set to "${tz}", which is not an IANA zone this runtime knows, so the runtime ignored it`,
      tzEnv: tz,
      runtimeZone,
    };
  }

  if (runtimeZone === undefined) {
    return {
      ok: false,
      source: "system",
      reason:
        "this runtime's Intl did not resolve a default timezone, which happens on a build without tzdata — pass timeZone explicitly",
    };
  }
  if (!isValidTimeZone(runtimeZone)) {
    return {
      ok: false,
      source: "system",
      reason: `the runtime resolved its default zone to "${runtimeZone}", which its own Intl then refuses to format with`,
      runtimeZone,
    };
  }
  return {
    ok: true,
    timeZone: runtimeZone,
    source: "system",
    detail: `the system zone (${runtimeZone}); TZ is not set in this process`,
    runtimeZone,
  };
}

/** The host's zone, through the seam. This is what `LocalTime` calls. */
export function readHostZone(): HostZoneReading {
  if (zoneOverride !== undefined) return zoneOverride;
  if (!realHostAllowed) {
    return {
      ok: false,
      source: "none",
      reason:
        "the real-host zone read is gated off (NODE_ENV=test), so there is no host zone to report — pass timeZone, or install one with _setHostZone",
    };
  }
  return realHostZone();
}

/** Test seam: pretend the machine is somewhere else, or nowhere. */
export function _setHostZone(reading: HostZoneReading | undefined): void {
  zoneOverride = reading;
}

/** Opt in to (or out of) the real machine for an un-injected read. */
export function _allowRealHost(allowed: boolean): void {
  realHostAllowed = allowed;
}

export function _realHostAllowed(): boolean {
  return realHostAllowed;
}

/** Put every seam in this file back. Called from `afterEach`. */
export function _resetHostSeams(): void {
  zoneOverride = undefined;
  realHostAllowed = process.env["NODE_ENV"] !== "test";
}
