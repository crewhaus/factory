/**
 * One harness as the adapters read it, and the only ways they read a file: contained in the
 * harness directory per file, a link at the file's own name refused, capped, and never
 * written. A read that cannot be made answers nothing and leaves a note; it never throws a
 * whole list away.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { harnessSpecName } from "@crewhaus/harness-lifecycle/knowledge-sync";
import { DEFAULT_TTL_DAYS } from "@crewhaus/session-store";
import { openForReadSync, resolveContained } from "@crewhaus/tool-safety/fs";

/** What an answer could not cover, and why: a code, and how many times. */
export type CoverageNote = {
  readonly code:
    | "unaddressable"
    | "not-listed"
    | "unreadable"
    | "outside-harness"
    | "customers-outside"
    | "document-source-failed";
  readonly store: string;
  readonly count: number;
  readonly message: string;
};

/** A Thredz workspace, read through a client the caller supplies. */
export type ThredzSource = {
  readonly state: "live" | "cached";
  list(): Promise<{
    readonly wiki?: readonly ThredzRow[];
    readonly records?: readonly ThredzRow[];
    readonly tasks?: readonly ThredzRow[];
  }>;
};

/** One Thredz row: an id, a name, and where it is kept. */
export type ThredzRow = {
  readonly id: string;
  readonly title: string;
  readonly updatedAt?: string;
  readonly version?: number;
  readonly status?: string;
  readonly space?: string;
  readonly role?: string;
  readonly tags?: readonly string[];
};

export type HarnessReadOptions = {
  readonly harnessDir: string;
  /** The harness's own id (`hrn_<16 hex>`), or a stand-in for one that has none yet. */
  readonly hrn: string;
  readonly harnessName?: string;
  readonly now?: () => Date;
  /** Where customers' stores are kept, when the deployment moved them. Default `.crewhaus/tenants`. */
  readonly tenantsRoot?: string;
  readonly thredz?: ThredzSource;
  /** How long a session log is kept, in days. Default: the harness's own policy, else 30. */
  readonly sessionMaxAgeDays?: number;
};

/** The id a harness that was never registered is read under; it is never written. */
export const UNREGISTERED_HRN = "hrn_0000000000000000";

/** Files past this are left out with a note rather than buffered. */
const READ_MAX_BYTES = 64 * 1024 * 1024;

export class HarnessRead {
  readonly dir: string;
  readonly hrn: string;
  readonly name: string;
  readonly now: () => Date;
  readonly tenantsRoot: string;
  readonly thredz: ThredzSource | undefined;
  readonly sessionMaxAgeDays: number;
  private readonly noted: Map<string, CoverageNote>;

  constructor(opts: HarnessReadOptions) {
    this.dir = opts.harnessDir;
    this.hrn = opts.hrn;
    this.now = opts.now ?? (() => new Date());
    this.tenantsRoot = opts.tenantsRoot ?? join(".crewhaus", "tenants");
    this.thredz = opts.thredz;
    this.noted = new Map();
    this.name = opts.harnessName ?? harnessSpecName(opts.harnessDir) ?? "harness";
    this.sessionMaxAgeDays = opts.sessionMaxAgeDays ?? this.policyDays();
  }

  /** `sessions.maxAgeDays`, read leniently: a file the sweep would refuse still says 30 here. */
  private policyDays(): number {
    const days = (this.policy() as { sessions?: { maxAgeDays?: unknown } } | undefined)?.sessions
      ?.maxAgeDays;
    return typeof days === "number" && Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS;
  }

  private retention: { readonly policy: Record<string, unknown> | undefined } | undefined;

  /** `.crewhaus/retention.json`, read once per read of the harness. */
  private policy(): Record<string, unknown> | undefined {
    this.retention ??= { policy: this.json(join(".crewhaus", "retention.json")) };
    return this.retention.policy;
  }

  /** The sessions the retention policy pins: never removed by its sweep. */
  pinnedSessions(): ReadonlySet<string> {
    const pins = this.policy()?.["pins"];
    return new Set(
      Array.isArray(pins) ? pins.filter((pin): pin is string => typeof pin === "string") : [],
    );
  }

  note(code: CoverageNote["code"], store: string, message: string): void {
    const at = `${code}\0${store}`;
    const before = this.noted.get(at);
    this.noted.set(at, { code, store, message, count: (before?.count ?? 0) + 1 });
  }

  notes(): readonly CoverageNote[] {
    return [...this.noted.values()].sort((a, b) =>
      `${a.store}\0${a.code}` < `${b.store}\0${b.code}` ? -1 : 1,
    );
  }

  /** The whole text of one file, or `undefined`. A file that is there and cannot be read is noted. */
  text(rel: string, store = "harness"): string | undefined {
    const read = openForReadSync(this.dir, rel, {
      maxBytes: READ_MAX_BYTES,
      followLeafSymlink: false,
    });
    if (read.ok && !read.truncated) return read.text;
    if (read.ok || read.code !== "not-found") {
      this.note("unreadable", store, "A file here could not be read, so it is left out.");
    }
    return undefined;
  }

  /** The non-blank lines of one JSONL file, each parsed to an object; what does not parse is skipped. */
  records(rel: string, store: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const line of (this.text(rel, store) ?? "").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          out.push(value as Record<string, unknown>);
        }
      } catch {
        // A torn or foreign line.
      }
    }
    return out;
  }

  /** One JSON object, or `undefined`. */
  json(rel: string, store = "harness"): Record<string, unknown> | undefined {
    const text = this.text(rel, store);
    if (text === undefined) return undefined;
    try {
      const value = JSON.parse(text) as unknown;
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Where a directory is, inside the harness; `undefined` when it is absent or leads out. */
  directory(rel: string, store = "harness"): string | undefined {
    const at = resolveContained(this.dir, rel);
    if (!at.ok) {
      if (at.code !== "not-found") {
        this.note("outside-harness", store, "This part is kept outside the harness's folder.");
      }
      return undefined;
    }
    try {
      return lstatSync(at.real).isDirectory() ? at.real : undefined;
    } catch {
      return undefined;
    }
  }

  /** The names in a contained directory, sorted: regular files or directories, never links. */
  names(rel: string, kind: "files" | "dirs", store = "harness"): string[] {
    const dir = this.directory(rel, store);
    if (dir === undefined) return [];
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => (kind === "files" ? entry.isFile() : entry.isDirectory()))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** `size:mtime` of what is at `rel`, or `-` when nothing is: how a changed store is noticed. */
  sourceMark(rel: string): string {
    const at = resolveContained(this.dir, rel, { followLeaf: false });
    if (!at.ok) return "-";
    try {
      const stats = lstatSync(at.real);
      return `${stats.isDirectory() ? "d" : stats.size}:${stats.mtimeMs}`;
    } catch {
      return "-";
    }
  }

  /** The modification time of a file, or `undefined`. */
  modifiedAt(rel: string): Date | undefined {
    const at = resolveContained(this.dir, rel, { followLeaf: false });
    if (!at.ok) return undefined;
    try {
      const stats = lstatSync(at.real);
      return stats.isFile() ? stats.mtime : undefined;
    } catch {
      return undefined;
    }
  }
}

/** A path under a harness, with forward slashes on every platform. */
export function relOf(first: string, ...rest: readonly string[]): string {
  // One part at a time: a list is never spread into `join`.
  let at = join(first);
  for (const part of rest) at = join(at, part);
  return at.split("\\").join("/");
}
