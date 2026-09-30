/**
 * EIP-55 address checksums and unit conversion.
 *
 * An Ethereum address has no check digits of its own — it is 20 raw bytes,
 * and any 20 bytes are a valid address. EIP-55 adds a checksum by varying
 * the CASE of the hex, which is why a mixed-case address can be validated
 * and an all-lowercase one cannot. Sending to a mistyped address is
 * irreversible, so this is the one check available and it is worth making.
 */
import { keccak256Hex } from "@crewhaus/tool-encode";

export type AddressResult = {
  readonly valid: boolean;
  /** The EIP-55 mixed-case form, when the input was a well-formed address. */
  readonly checksummed: string;
  readonly lowercase: string;
  /** True when the input carried a checksum that this verified. */
  readonly hadChecksum: boolean;
  readonly reason: string;
  readonly isZero: boolean;
};

/** Apply the EIP-55 case checksum to a lowercase address. */
export function toChecksumAddress(lowercase: string): string {
  const body = lowercase.replace(/^0x/i, "").toLowerCase();
  const hash = keccak256Hex(body);
  let out = "0x";
  for (let i = 0; i < body.length; i++) {
    const char = body[i] as string;
    // A nibble of 8 or more uppercases the corresponding hex digit; digits
    // have no case, so they are unaffected.
    out += Number.parseInt(hash[i] as string, 16) >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

export function validateAddress(raw: string): AddressResult {
  const text = raw.trim();
  const body = text.replace(/^0x/i, "");
  const base = { lowercase: `0x${body.toLowerCase()}`, isZero: /^0*$/.test(body) };

  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
    return {
      ...base,
      valid: false,
      checksummed: "",
      hadChecksum: false,
      reason: text.startsWith("0X")
        ? "an address starts with a lowercase 0x; this starts with 0X"
        : text.startsWith("0x")
          ? `an address is 0x followed by 40 hex characters; this has ${body.length}`
          : "an address starts with 0x",
    };
  }

  const checksummed = toChecksumAddress(body);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && `0x${body}` !== checksummed) {
    return {
      ...base,
      valid: false,
      checksummed,
      hadChecksum: true,
      // This is the case worth catching: the address is well-formed and the
      // checksum says at least one character is wrong.
      reason: "the EIP-55 checksum does not match — at least one character is wrong",
    };
  }

  return {
    ...base,
    valid: true,
    checksummed,
    hadChecksum: mixed,
    reason: mixed
      ? ""
      : "this address carries no EIP-55 checksum, so only its shape was checked; a typo in an all-lowercase address cannot be detected",
  };
}

/**
 * An address a coder may put into calldata or a digest: 0x and 40 hex
 * characters, whose EIP-55 checksum holds when it carries one. Returns the
 * checksummed form; throws the reason otherwise.
 *
 * Every path that writes an address goes through this, not only
 * `AddressCheck`: the encoder is the last point where a re-typed character
 * can still be caught, and ethers and viem refuse the same input.
 */
export function checkedAddress(raw: unknown, what: string): string {
  if (typeof raw !== "string") throw new Error(`${what}: an address is a 0x hex string`);
  const result = validateAddress(raw);
  if (!result.valid) throw new Error(`${what}: ${result.reason}`);
  return result.checksummed;
}

/**
 * Parse a decimal amount into base units, exactly.
 *
 * `parseFloat("0.1") * 1e18` is not 10^17, and the difference is real money.
 * This is string arithmetic: no value ever becomes a double.
 */
export function parseUnits(amount: string, decimals: number): bigint {
  const text = amount.trim();
  if (!/^-?\d*\.?\d*$/.test(text) || text === "" || text === "." || text === "-") {
    throw new Error(`"${amount}" is not a decimal amount`);
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole = "", fraction = ""] = unsigned.split(".");
  if (fraction.length > decimals) {
    throw new Error(
      `"${amount}" has ${fraction.length} decimal places but the unit has ${decimals}; the extra digits would be silently dropped`,
    );
  }
  const scaled = `${whole === "" ? "0" : whole}${fraction.padEnd(decimals, "0")}`;
  const value = BigInt(scaled === "" ? "0" : scaled);
  return negative ? -value : value;
}

/** Render base units as a decimal string, exactly, with no trailing zeros. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}
