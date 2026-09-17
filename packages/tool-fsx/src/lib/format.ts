/**
 * Small pure helpers shared by the tools: byte formatting, POSIX mode
 * rendering, ISO-instant parsing and the tree renderer.
 *
 * Nothing here reads the clock, the filesystem or the locale. Byte sizes use
 * binary units with a fixed one-decimal form, and `formatMode` prints the
 * permission bits the way `ls -l` does, so an operator reading a result does
 * not have to translate an octal number in their head.
 */

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** "1.5 MiB". Exact for byte counts under 1024, one decimal above that. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes}`;
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** The low 12 bits of a POSIX mode as four octal digits, e.g. "0644". */
export function formatModeOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/** The permission bits as `rwxr-xr-x`, including the setuid/setgid/sticky marks. */
export function formatModeSymbolic(mode: number): string {
  const bit = (mask: number, ch: string): string => ((mode & mask) !== 0 ? ch : "-");
  const special = (setMask: number, execMask: number, on: string, off: string): string => {
    const hasExec = (mode & execMask) !== 0;
    if ((mode & setMask) === 0) return hasExec ? "x" : "-";
    return hasExec ? on : off;
  };
  return [
    bit(0o400, "r"),
    bit(0o200, "w"),
    special(0o4000, 0o100, "s", "S"),
    bit(0o40, "r"),
    bit(0o20, "w"),
    special(0o2000, 0o10, "s", "S"),
    bit(0o4, "r"),
    bit(0o2, "w"),
    special(0o1000, 0o1, "t", "T"),
  ].join("");
}

/**
 * Parse a caller-supplied instant. Accepts anything `Date.parse` accepts but
 * insists the result is a real time, so a typo becomes an error the caller
 * sees rather than a silent epoch-0 bound. Never falls back to "now" — the
 * tools that take time bounds must get them from the caller, not the clock.
 */
export function parseInstant(value: string): number | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** A file's mtime as a stable UTC ISO-8601 string, millisecond precision. */
export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** One node in a rendered tree. `children` is already in display order. */
export type TreeNode = {
  readonly name: string;
  readonly kind: "file" | "dir" | "symlink";
  readonly size?: number;
  readonly children?: ReadonlyArray<TreeNode>;
  /** Set when the node's children were cut short by a depth or entry cap. */
  readonly elided?: string;
};

/**
 * Render a node list with the box-drawing connectors `tree(1)` uses. The
 * caller supplies the root label; sorting happened during the walk, so this
 * function only draws.
 */
export function renderTree(root: string, nodes: ReadonlyArray<TreeNode>): string {
  const lines: string[] = [root];
  const walk = (list: ReadonlyArray<TreeNode>, prefix: string): void => {
    list.forEach((node, index) => {
      const last = index === list.length - 1;
      const connector = last ? "└── " : "├── ";
      const suffix = node.kind === "dir" ? "/" : node.kind === "symlink" ? "@" : "";
      const size =
        node.kind === "file" && node.size !== undefined ? `  ${formatBytes(node.size)}` : "";
      lines.push(`${prefix}${connector}${node.name}${suffix}${size}`);
      const childPrefix = `${prefix}${last ? "    " : "│   "}`;
      if (node.children !== undefined && node.children.length > 0) {
        walk(node.children, childPrefix);
      }
      if (node.elided !== undefined) {
        lines.push(`${childPrefix}└── ${node.elided}`);
      }
    });
  };
  walk(nodes, "");
  return lines.join("\n");
}
