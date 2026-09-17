/**
 * Deterministic archive builders, used by this package's tests.
 *
 * They exist because the security property that matters most here — that
 * `ArchiveExtract` refuses a member whose path escapes the destination —
 * cannot be tested with archives made by `tar` or `zip`. Both refuse to
 * STORE a `../` member in the first place, which is exactly why a malicious
 * archive has to be hand-written. Building the bytes here also means the
 * fixture is byte-identical on every machine: every timestamp is fixed and
 * nothing consults the clock.
 *
 * Not part of the tool surface, and not exported from the package entry
 * point; kept in `src` so the tests can import it without a build step.
 */

export type FixtureEntry = {
  readonly name: string;
  readonly data?: string;
  /** "file" (default), "dir", or "symlink" with `linkTarget`. */
  readonly kind?: "file" | "dir" | "symlink";
  readonly linkTarget?: string;
};

const BLOCK = 512;

function writeOctal(block: Buffer, value: number, offset: number, width: number): void {
  block.write(value.toString(8).padStart(width - 1, "0"), offset, "ascii");
}

/** One 512-byte ustar header with a correct checksum. */
function tarHeader(entry: FixtureEntry, size: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  const typeflag = entry.kind === "dir" ? "5" : entry.kind === "symlink" ? "2" : "0";
  block.write(entry.name.slice(0, 100), 0, "ascii");
  writeOctal(block, entry.kind === "dir" ? 0o755 : 0o644, 100, 8);
  writeOctal(block, 0, 108, 8);
  writeOctal(block, 0, 116, 8);
  writeOctal(block, size, 124, 12);
  // A fixed mtime keeps the fixture's bytes identical from run to run.
  writeOctal(block, 0, 136, 12);
  block.write("        ", 148, "ascii"); // checksum placeholder: eight spaces
  block.write(typeflag, 156, "ascii");
  if (entry.linkTarget !== undefined) block.write(entry.linkTarget.slice(0, 100), 157, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

/** Build an uncompressed tar containing exactly the entries given. */
export function buildTar(entries: ReadonlyArray<FixtureEntry>): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(
      entry.kind === "file" || entry.kind === undefined ? (entry.data ?? "") : "",
      "utf8",
    );
    parts.push(tarHeader(entry, data.length));
    if (data.length > 0) {
      const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK, 0);
      data.copy(padded);
      parts.push(padded);
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive marker
  return Buffer.concat(parts);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = ((crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a zip with STORED (uncompressed) entries. Local headers and the
 * central directory agree, so a real `unzip` reads it happily — which is the
 * point: a refusal has to come from our own check, not from a broken file.
 */
export function buildZip(entries: ReadonlyArray<FixtureEntry>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const isDir = entry.kind === "dir";
    const name = Buffer.from(
      isDir && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name,
      "utf8",
    );
    const data = Buffer.from(
      entry.kind === "symlink" ? (entry.linkTarget ?? "") : (entry.data ?? ""),
      "utf8",
    );
    const checksum = crc32(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // fixed time
    local.writeUInt16LE(0x21, 12); // fixed date (1980-01-01)
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, data);

    const mode = entry.kind === "symlink" ? 0o120777 : isDir ? 0o040755 : 0o100644;
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made on unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, eocd]);
}
