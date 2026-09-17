/**
 * Unit conversion across ten dimensions, with the exact factors where an
 * exact factor exists.
 *
 * How it works: every unit in a dimension carries a factor to that
 * dimension's base unit, and a conversion is value * fromFactor / toFactor.
 * Temperature is the exception and is handled separately, because it is
 * AFFINE, not a scale: 20°C is not "20 times some constant" of anything, and
 * multiplying a Celsius value by a factor is the single most common unit-bug
 * there is. Celsius, Fahrenheit and Rankine all go through kelvin with an
 * offset.
 *
 * Exactness. Many of these factors are exact by definition, not measured:
 * one inch is exactly 0.0254 m, one pound is exactly 0.45359237 kg, one
 * calorie (thermochemical) is exactly 4.184 J, one electronvolt is exactly
 * 1.602176634e-19 J since the 2019 SI redefinition. Those are marked `exact`.
 * The rest (mmHg, psi as commonly used, BTU) are conventional values and are
 * marked as such, because a caller doing metrology needs to know which is
 * which. Where the value is not exactly representable as a double — 1/3.6 for
 * km/h — the nearest double is used and the factor is marked inexact.
 *
 * Deliberate refusals:
 *   - Months and years are NOT time units here. They have no fixed length, so
 *     converting "3 months to days" would be a guess wearing a number's
 *     clothing. Use a calendar tool.
 *   - Mass and force are not interchangeable: kg is mass, and there is no
 *     pound-force or newton in the mass table.
 *   - Cross-dimension conversion (metres to seconds) is refused, with both
 *     dimensions named.
 *   - US and imperial volumes differ (a US gallon is not a UK gallon), so
 *     every such unit is suffixed `_us` or `_uk` and there is no bare "gal".
 */

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitError";
  }
}

export type UnitSpec = {
  /** Multiply by this to reach the dimension's base unit. */
  factor: number;
  /** True when the factor is exact by definition rather than conventional. */
  exact: boolean;
  aliases: ReadonlyArray<string>;
  label: string;
};

export type DimensionSpec = {
  base: string;
  units: Readonly<Record<string, UnitSpec>>;
};

const u = (
  factor: number,
  exact: boolean,
  label: string,
  aliases: ReadonlyArray<string> = [],
): UnitSpec => ({ factor, exact, label, aliases });

export const DIMENSIONS: Readonly<Record<string, DimensionSpec>> = Object.freeze({
  length: {
    base: "m",
    units: {
      nm: u(1e-9, true, "nanometre"),
      um: u(1e-6, true, "micrometre", ["µm", "micron"]),
      mm: u(0.001, true, "millimetre"),
      cm: u(0.01, true, "centimetre"),
      m: u(1, true, "metre", ["meter"]),
      km: u(1000, true, "kilometre", ["kilometer"]),
      in: u(0.0254, true, "inch", ["inch", "inches"]),
      ft: u(0.3048, true, "foot", ["foot", "feet"]),
      yd: u(0.9144, true, "yard"),
      mi: u(1609.344, true, "mile", ["mile", "miles"]),
      nmi: u(1852, true, "nautical mile"),
    },
  },
  mass: {
    base: "kg",
    units: {
      mg: u(1e-6, true, "milligram"),
      g: u(0.001, true, "gram"),
      kg: u(1, true, "kilogram"),
      t: u(1000, true, "tonne", ["tonne", "metric_ton"]),
      oz: u(0.028349523125, true, "ounce (avoirdupois)"),
      lb: u(0.45359237, true, "pound (avoirdupois)", ["lbs", "pound"]),
      st: u(6.35029318, true, "stone"),
      ton_us: u(907.18474, true, "short ton"),
      ton_uk: u(1016.0469088, true, "long ton"),
    },
  },
  volume: {
    base: "l",
    units: {
      ml: u(0.001, true, "millilitre", ["milliliter"]),
      l: u(1, true, "litre", ["liter"]),
      m3: u(1000, true, "cubic metre"),
      cm3: u(0.001, true, "cubic centimetre", ["cc"]),
      ft3: u(28.316846592, true, "cubic foot"),
      tsp_us: u(0.00492892159375, true, "US teaspoon"),
      tbsp_us: u(0.01478676478125, true, "US tablespoon"),
      floz_us: u(0.0295735295625, true, "US fluid ounce"),
      cup_us: u(0.2365882365, true, "US cup"),
      pt_us: u(0.473176473, true, "US pint"),
      qt_us: u(0.946352946, true, "US quart"),
      gal_us: u(3.785411784, true, "US gallon"),
      floz_uk: u(0.0284130625, true, "imperial fluid ounce"),
      pt_uk: u(0.56826125, true, "imperial pint"),
      gal_uk: u(4.54609, true, "imperial gallon"),
    },
  },
  time: {
    base: "s",
    units: {
      ns: u(1e-9, true, "nanosecond"),
      us: u(1e-6, true, "microsecond", ["µs"]),
      ms: u(0.001, true, "millisecond"),
      s: u(1, true, "second", ["sec", "second", "seconds"]),
      min: u(60, true, "minute", ["minute", "minutes"]),
      h: u(3600, true, "hour", ["hr", "hour", "hours"]),
      d: u(86400, true, "day (exactly 86400 s; calendar days can differ)", ["day", "days"]),
      wk: u(604800, true, "week", ["week", "weeks"]),
    },
  },
  area: {
    base: "m2",
    units: {
      mm2: u(1e-6, true, "square millimetre"),
      cm2: u(1e-4, true, "square centimetre"),
      m2: u(1, true, "square metre"),
      ha: u(10_000, true, "hectare"),
      km2: u(1e6, true, "square kilometre"),
      in2: u(0.00064516, true, "square inch"),
      ft2: u(0.09290304, true, "square foot"),
      yd2: u(0.83612736, true, "square yard"),
      acre: u(4046.8564224, true, "acre"),
      mi2: u(2_589_988.110336, true, "square mile"),
    },
  },
  speed: {
    base: "mps",
    units: {
      mps: u(1, true, "metre per second", ["m/s"]),
      kph: u(1 / 3.6, false, "kilometre per hour", ["km/h", "kmh"]),
      mph: u(0.44704, true, "mile per hour", ["mi/h"]),
      fps: u(0.3048, true, "foot per second", ["ft/s"]),
      kn: u(1852 / 3600, false, "knot (nautical mile per hour)", ["knot", "knots", "kt"]),
    },
  },
  data: {
    base: "B",
    units: {
      bit: u(0.125, true, "bit", ["b"]),
      B: u(1, true, "byte", ["byte", "bytes"]),
      kB: u(1000, true, "kilobyte (decimal, 1000 B)"),
      MB: u(1e6, true, "megabyte (decimal)"),
      GB: u(1e9, true, "gigabyte (decimal)"),
      TB: u(1e12, true, "terabyte (decimal)"),
      PB: u(1e15, true, "petabyte (decimal)"),
      KiB: u(1024, true, "kibibyte (binary, 1024 B)"),
      MiB: u(1_048_576, true, "mebibyte (binary)"),
      GiB: u(1_073_741_824, true, "gibibyte (binary)"),
      TiB: u(1_099_511_627_776, true, "tebibyte (binary)"),
      PiB: u(1_125_899_906_842_624, true, "pebibyte (binary)"),
      kbit: u(125, true, "kilobit (decimal)"),
      Mbit: u(125_000, true, "megabit (decimal)"),
      Gbit: u(125_000_000, true, "gigabit (decimal)"),
    },
  },
  pressure: {
    base: "Pa",
    units: {
      Pa: u(1, true, "pascal"),
      hPa: u(100, true, "hectopascal"),
      kPa: u(1000, true, "kilopascal"),
      MPa: u(1e6, true, "megapascal"),
      bar: u(100_000, true, "bar"),
      mbar: u(100, true, "millibar"),
      atm: u(101_325, true, "standard atmosphere"),
      torr: u(101_325 / 760, false, "torr (1/760 atm)"),
      mmHg: u(133.322387415, false, "millimetre of mercury (conventional)"),
      inHg: u(3386.388640341, false, "inch of mercury (conventional)"),
      psi: u(6894.757293168361, false, "pound-force per square inch"),
    },
  },
  energy: {
    base: "J",
    units: {
      J: u(1, true, "joule"),
      kJ: u(1000, true, "kilojoule"),
      MJ: u(1e6, true, "megajoule"),
      Wh: u(3600, true, "watt-hour"),
      kWh: u(3_600_000, true, "kilowatt-hour"),
      cal: u(4.184, true, "thermochemical calorie"),
      kcal: u(4184, true, "kilocalorie (food calorie)", ["Cal"]),
      BTU: u(1055.05585262, false, "British thermal unit (IT)"),
      eV: u(1.602176634e-19, true, "electronvolt (exact since the 2019 SI)"),
      erg: u(1e-7, true, "erg"),
      // 1 ft-lbf = 0.3048 m * 0.45359237 kg * 9.80665 m/s^2, each factor exact;
      // the product is not exactly representable as a double, hence exact: false.
      ftlb: u(0.3048 * 0.45359237 * 9.80665, false, "foot-pound force", ["ft_lb", "ft-lb"]),
    },
  },
});

/** Temperature scales, handled affinely: value -> kelvin -> value. */
export const TEMPERATURE_SCALES = ["C", "F", "K", "R"] as const;
export type TemperatureScale = (typeof TEMPERATURE_SCALES)[number];

const TEMPERATURE_ALIASES: Readonly<Record<string, TemperatureScale>> = Object.freeze({
  c: "C",
  celsius: "C",
  centigrade: "C",
  "°c": "C",
  f: "F",
  fahrenheit: "F",
  "°f": "F",
  k: "K",
  kelvin: "K",
  r: "R",
  rankine: "R",
});

/** Absolute zero, per scale — a temperature below it is refused as unphysical. */
const ABSOLUTE_ZERO: Readonly<Record<TemperatureScale, number>> = Object.freeze({
  C: -273.15,
  F: -459.67,
  K: 0,
  R: 0,
});

export function toKelvin(value: number, scale: TemperatureScale): number {
  switch (scale) {
    case "C":
      return value + 273.15;
    case "F":
      return (value + 459.67) * (5 / 9);
    case "R":
      return value * (5 / 9);
    default:
      return value;
  }
}

export function fromKelvin(kelvin: number, scale: TemperatureScale): number {
  switch (scale) {
    case "C":
      return kelvin - 273.15;
    case "F":
      return kelvin * (9 / 5) - 459.67;
    case "R":
      return kelvin * (9 / 5);
    default:
      return kelvin;
  }
}

/**
 * Convert DIRECTLY between two scales rather than in two hops through kelvin.
 *
 * The relation is the same affine one either way — going C -> K -> F and
 * applying `v * 9/5 + 32` are equal in exact arithmetic — but the two-hop
 * route rounds twice in binary, so 100 °C came back as 211.99999999999994
 * instead of 212. Each pair below is the single expression for that pair, so
 * the only rounding is the one the arithmetic genuinely needs. Kelvin is still
 * the reference the offsets are defined against, and the conversion is still
 * affine, not a scale factor.
 */
export function convertTemperature(
  value: number,
  from: TemperatureScale,
  to: TemperatureScale,
): number {
  if (from === to) return value;
  switch (`${from}${to}`) {
    case "CF":
      return value * (9 / 5) + 32;
    case "FC":
      return (value - 32) * (5 / 9);
    case "CK":
      return value + 273.15;
    case "KC":
      return value - 273.15;
    case "CR":
      return (value + 273.15) * (9 / 5);
    case "RC":
      return value * (5 / 9) - 273.15;
    case "FK":
      return (value + 459.67) * (5 / 9);
    case "KF":
      return value * (9 / 5) - 459.67;
    case "FR":
      return value + 459.67;
    case "RF":
      return value - 459.67;
    case "KR":
      return value * (9 / 5);
    case "RK":
      return value * (5 / 9);
    default:
      // Unreachable while TEMPERATURE_SCALES has four members; kept so a new
      // scale fails loudly rather than silently returning the wrong number.
      throw new UnitError(`no conversion is defined from ${from} to ${to}`);
  }
}

export function resolveTemperatureScale(name: string): TemperatureScale | undefined {
  const trimmed = name.trim();
  if ((TEMPERATURE_SCALES as ReadonlyArray<string>).includes(trimmed)) {
    return trimmed as TemperatureScale;
  }
  return ownProperty(TEMPERATURE_ALIASES, trimmed.toLowerCase());
}

/**
 * Look a name up as an OWN property only.
 *
 * These tables are object literals, so they inherit from `Object.prototype`:
 * `spec.units["toString"]` is a function, not `undefined`, and treating it as a
 * `UnitSpec` produced `value: null` with `method: "value * undefined / 1"` —
 * a confident-looking answer to a unit that does not exist. Likewise
 * `TEMPERATURE_ALIASES["constructor"]` made `UnitConvert(20, "constructor", "F")`
 * return -423.67. Every lookup on a caller-supplied name goes through here.
 */
function ownProperty<T>(table: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

export type ResolvedUnit = { dimension: string; unit: string; spec: UnitSpec };

/**
 * Find a unit by canonical name or alias. Exact match wins; a
 * case-insensitive match is accepted only when it is UNAMBIGUOUS, so "mb"
 * (MB megabyte vs mbar millibar) is refused with both candidates named
 * rather than silently resolved.
 */
export function resolveUnit(name: string): ResolvedUnit | { ambiguous: string[] } | undefined {
  const trimmed = name.trim();
  for (const [dimension, spec] of Object.entries(DIMENSIONS)) {
    const direct = ownProperty(spec.units, trimmed);
    if (direct !== undefined) return { dimension, unit: trimmed, spec: direct };
  }
  const lower = trimmed.toLowerCase();
  const matches: ResolvedUnit[] = [];
  for (const [dimension, spec] of Object.entries(DIMENSIONS)) {
    for (const [unit, unitSpec] of Object.entries(spec.units)) {
      if (unit.toLowerCase() === lower || unitSpec.aliases.some((a) => a.toLowerCase() === lower)) {
        matches.push({ dimension, unit, spec: unitSpec });
      }
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    return { ambiguous: matches.map((m) => `${m.unit} (${m.dimension})`).sort() };
  }
  return undefined;
}

/** Every unit this package knows, grouped by dimension and sorted. */
export function unitCatalog(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [dimension, spec] of Object.entries(DIMENSIONS)) {
    out[dimension] = Object.keys(spec.units).sort();
  }
  out["temperature"] = [...TEMPERATURE_SCALES];
  return out;
}

export type ConversionResult = {
  value: number;
  from: string;
  to: string;
  dimension: string;
  /** The multiplication applied, or "affine" for temperature. */
  method: string;
  exact: boolean;
};

export function convertUnits(value: number, fromName: string, toName: string): ConversionResult {
  if (!Number.isFinite(value)) throw new UnitError(`value must be a finite number, got ${value}`);
  const fromTemp = resolveTemperatureScale(fromName);
  const toTemp = resolveTemperatureScale(toName);
  if (fromTemp !== undefined || toTemp !== undefined) {
    if (fromTemp === undefined || toTemp === undefined) {
      // Only one side is a temperature. Say WHICH problem it is: a name that is
      // not a unit at all deserves "unknown unit", not a lecture about
      // dimensions that implies the name was recognised.
      const otherName = fromTemp === undefined ? fromName : toName;
      assertResolved(resolveUnit(otherName), otherName);
      throw new UnitError(
        `cannot convert between "${fromName}" and "${toName}": temperature is a dimension of its own and does not convert to anything else`,
      );
    }
    if (value < ABSOLUTE_ZERO[fromTemp]) {
      throw new UnitError(
        `${value}°${fromTemp} is below absolute zero (${ABSOLUTE_ZERO[fromTemp]}°${fromTemp})`,
      );
    }
    return {
      value: convertTemperature(value, fromTemp, toTemp),
      from: fromTemp,
      to: toTemp,
      dimension: "temperature",
      method:
        "affine: an offset and a ratio relative to kelvin, not a scale factor; applied in one step so no intermediate rounding is introduced",
      exact: false,
    };
  }
  const from = resolveUnit(fromName);
  const to = resolveUnit(toName);
  const fromResolved = assertResolved(from, fromName);
  const toResolved = assertResolved(to, toName);
  if (fromResolved.dimension !== toResolved.dimension) {
    throw new UnitError(
      `cannot convert ${fromResolved.unit} (${fromResolved.dimension}) to ${toResolved.unit} (${toResolved.dimension}): different dimensions`,
    );
  }
  const base = DIMENSIONS[fromResolved.dimension] as DimensionSpec;
  return {
    value: (value * fromResolved.spec.factor) / toResolved.spec.factor,
    from: fromResolved.unit,
    to: toResolved.unit,
    dimension: fromResolved.dimension,
    method: `value * ${fromResolved.spec.factor} / ${toResolved.spec.factor} (both factors relative to 1 ${base.base})`,
    exact: fromResolved.spec.exact && toResolved.spec.exact,
  };
}

function assertResolved(
  resolved: ResolvedUnit | { ambiguous: string[] } | undefined,
  name: string,
): ResolvedUnit {
  if (resolved === undefined) {
    throw new UnitError(
      `unknown unit "${name}" — call UnitConvert with list: true to see every supported unit`,
    );
  }
  if ("ambiguous" in resolved) {
    throw new UnitError(
      `"${name}" matches more than one unit (${resolved.ambiguous.join(", ")}); use the exact spelling`,
    );
  }
  return resolved;
}
