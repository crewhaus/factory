/**
 * D41 (partial) — `crewhaus schedule generate`: recurring eval automation for
 * teams that are not on GitHub Actions.
 *
 * Every scheduled eval surface we ship is a scaffolded GitHub workflow
 * (crewhaus-eval.yml, crewhaus-flywheel.yml, sentinel-drift.yml), so an
 * air-gapped or GitLab/Jenkins/laptop-only team had no recurring-eval story
 * at all. This verb closes that with the smallest honest thing: it PRINTS
 * ready-to-install scheduling text — a crontab line, a launchd plist, or a
 * systemd service+timer pair — wrapping the same `crewhaus` command the
 * corresponding workflow runs.
 *
 * Deliberately a SHIM, not a daemon: it installs nothing, writes nothing,
 * spawns nothing, and holds no state. The user reviews the text and installs
 * it themselves. The GitHub scaffolds are untouched — this is the
 * off-GitHub sibling, not a replacement.
 *
 * The wrapped commands are the shipped exit-code-clean entry points, so the
 * host scheduler's own failure reporting (cron mail, `systemctl --failed`,
 * launchd exit status) IS the alert: `eval --gate` and `eval --sentinel`
 * exit non-zero on regression/drift.
 *
 * Pure + deterministic (no timestamps in the output), so the generated text
 * is snapshot-testable.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Thrown on an unknown target/runner. The CLI routes it through `die()`. */
export class ScheduleGenerateError extends Error {
  override readonly name = "ScheduleGenerateError";
}

export type ScheduleTarget = "flywheel" | "eval-gate" | "sentinel";
export type ScheduleRunner = "cron" | "launchd" | "systemd";

export const SCHEDULE_TARGETS: ReadonlyArray<ScheduleTarget> = [
  "flywheel",
  "eval-gate",
  "sentinel",
];
export const SCHEDULE_RUNNERS: ReadonlyArray<ScheduleRunner> = ["cron", "launchd", "systemd"];

export function parseScheduleTarget(value: string | undefined): ScheduleTarget {
  if (value === undefined) {
    throw new ScheduleGenerateError(
      `schedule generate: --for is required (${SCHEDULE_TARGETS.join(" | ")})`,
    );
  }
  if (!SCHEDULE_TARGETS.includes(value as ScheduleTarget)) {
    throw new ScheduleGenerateError(
      `schedule generate: unknown --for "${value}" — supported: ${SCHEDULE_TARGETS.join(", ")}`,
    );
  }
  return value as ScheduleTarget;
}

export function parseScheduleRunner(value: string | undefined): ScheduleRunner {
  if (value === undefined) return "cron";
  if (!SCHEDULE_RUNNERS.includes(value as ScheduleRunner)) {
    throw new ScheduleGenerateError(
      `schedule generate: unknown --runner "${value}" — supported: ${SCHEDULE_RUNNERS.join(", ")}`,
    );
  }
  return value as ScheduleRunner;
}

export type ScheduleGenerateOptions = {
  readonly target: ScheduleTarget;
  readonly runner: ScheduleRunner;
  /** Working directory the scheduled command runs in (the harness root). */
  readonly dir: string;
  readonly spec?: string;
  readonly dataset?: string;
  readonly graders?: string;
  /** Sentinel only — the FROZEN baseline run directory to diff against. */
  readonly baseline?: string;
  /**
   * Home directory written into cron's `PATH=` line. Defaults to
   * `os.homedir()` — cron does NOT expand variables in environment
   * assignments (man 5 crontab: the value string is not parsed for
   * environmental substitutions), so a literal `$HOME/.bun/bin` would leave
   * a bun-installed `crewhaus` unfindable and the nightly job dying with
   * `command not found`. Injectable so the generated text stays snapshotable.
   */
  readonly home?: string;
};

/** The resolved job behind one target: what runs, when, and why. */
export type ScheduleJob = {
  readonly target: ScheduleTarget;
  readonly label: string;
  /** The `crewhaus …` command line, already quoted for a shell. */
  readonly command: string;
  readonly hour: number;
  readonly minute: number;
  /** One-line description of the cadence choice. */
  readonly cadence: string;
  /** What a non-zero exit from this job means. */
  readonly failureMeaning: string;
  /**
   * Path flags the CALLER passed that this target cannot consume, phrased
   * for stderr. Same doctrine as the `[eval-report] warning: --X only
   * applies to …` lines: a flag that silently vanishes makes the user
   * install a schedule that runs a different job than they asked for.
   */
  readonly warnings: ReadonlyArray<string>;
};

const DEFAULT_SPEC = "crewhaus.yaml";
const DEFAULT_DATASET = join("eval", "dataset.jsonl");
const DEFAULT_GRADERS = join("eval", "graders.yaml");
const DEFAULT_SENTINEL_BASELINE = join("eval", "sentinel-baseline");

/** Single-quote a shell word (POSIX), so a path with spaces survives. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve the command + cadence for a target. Times are off-the-hour and
 * mirror the GitHub scaffolds' own minutes (07:13 flywheel, 03:17 sentinel)
 * so a team running BOTH does not fire two evals in the same minute.
 */
export function resolveScheduleJob(opts: ScheduleGenerateOptions): ScheduleJob {
  const spec = opts.spec ?? DEFAULT_SPEC;
  const dataset = opts.dataset ?? DEFAULT_DATASET;
  const graders = opts.graders ?? DEFAULT_GRADERS;
  // `--baseline` names the FROZEN sentinel run to diff against; neither the
  // flywheel nor the gate has anywhere to put it (the gate's baseline is the
  // pinned one in run history). Say so instead of dropping it.
  const baselineWarning =
    opts.baseline !== undefined && opts.target !== "sentinel"
      ? [
          `--baseline only applies to --for sentinel (the frozen drift baseline) — ignored for ${opts.target}`,
        ]
      : [];
  switch (opts.target) {
    case "flywheel": {
      // `crewhaus flywheel run [spec.yaml] [--dataset d] [--graders g]`
      // resolves its own conventional defaults, so emit ONLY what the user
      // actually passed: the default output stays the bare command, and a
      // user who named a spec/dataset/graders gets the job they asked for
      // instead of a silently different one.
      const parts = ["crewhaus flywheel run"];
      if (opts.spec !== undefined) parts.push(shellQuote(opts.spec));
      if (opts.dataset !== undefined) parts.push(`--dataset ${shellQuote(opts.dataset)}`);
      if (opts.graders !== undefined) parts.push(`--graders ${shellQuote(opts.graders)}`);
      return {
        target: "flywheel",
        label: "crewhaus-flywheel",
        command: parts.join(" "),
        hour: 7,
        minute: 13,
        cadence: "nightly at 07:13 local time (off the hour — schedulers bunch at :00)",
        failureMeaning:
          "the loop failed (compile gate, eval, or optimize). An ACCEPTED patch is written back to the spec locally — review it with `git diff` before committing.",
        warnings: baselineWarning,
      };
    }
    case "eval-gate":
      return {
        target: "eval-gate",
        label: "crewhaus-eval-gate",
        command: `crewhaus eval ${shellQuote(spec)} --dataset ${shellQuote(dataset)} --graders ${shellQuote(graders)} --gate`,
        hour: 5,
        minute: 23,
        cadence: "nightly at 05:23 local time (off the hour — schedulers bunch at :00)",
        failureMeaning:
          "the run REGRESSED against the pinned baseline (any pass-rate drop or per-sample pass→fail flip). The baseline is kept, never promoted, on a failing gate.",
        warnings: baselineWarning,
      };
    case "sentinel":
      return {
        target: "sentinel",
        label: "crewhaus-sentinel",
        command:
          `crewhaus eval ${shellQuote(spec)} --dataset ${shellQuote(dataset)} --graders ${shellQuote(graders)} ` +
          `--seed 1 --sentinel --baseline ${shellQuote(opts.baseline ?? DEFAULT_SENTINEL_BASELINE)}`,
        hour: 3,
        minute: 17,
        cadence: "nightly at 03:17 local time (off the hour — schedulers bunch at :00)",
        failureMeaning:
          "provider DRIFT (or a not-comparable probe: the spec/dataset hash moved since the baseline was frozen). Re-freeze the baseline whenever you change either on purpose.",
        warnings: [],
      };
    default: {
      const never: never = opts.target;
      throw new ScheduleGenerateError(`unhandled schedule target ${String(never)}`);
    }
  }
}

export type GeneratedSchedule = {
  readonly job: ScheduleJob;
  readonly runner: ScheduleRunner;
  /** Suggested filename for the unit/plist ("" for a crontab line). */
  readonly filename: string;
  /** The ready-to-install text. */
  readonly text: string;
  /** How to install it, one step per line. */
  readonly install: ReadonlyArray<string>;
};

function logPath(dir: string): string {
  return join(dir, ".crewhaus", "logs");
}

function cronText(job: ScheduleJob, dir: string, home: string): string {
  const log = join(logPath(dir), `${job.label}.log`);
  return [
    `# ${job.label} — generated by \`crewhaus schedule generate --for ${job.target} --runner cron\`.`,
    `# ${job.cadence}.`,
    "# cron runs with a MINIMAL environment: no shell profile, no ~/.bashrc, and",
    "# usually no PATH to your bun/crewhaus install and no provider credentials.",
    "# Set both explicitly below (a secrets file sourced by the command is fine —",
    "# never inline a key into a crontab, it is world-readable to your user's tools).",
    "# The PATH below is written out in FULL on purpose: cron does not expand",
    "# variables in environment assignments (man 5 crontab), so `$HOME/.bun/bin`",
    "# would stay a literal and a bun-installed crewhaus would never be found.",
    "# Adjust it if your install lives elsewhere (`command -v crewhaus`).",
    `# Exit non-zero means: ${job.failureMeaning}`,
    "",
    `PATH=/usr/local/bin:/usr/bin:/bin:${join(home, ".bun", "bin")}`,
    `# ANTHROPIC_API_KEY=…   # prefer: . ${join(home, ".crewhaus", "env")} in the command below`,
    "",
    `${job.minute} ${job.hour} * * * cd ${shellQuote(dir)} && ${job.command} >> ${shellQuote(log)} 2>&1`,
    "",
  ].join("\n");
}

/** Escape the five XML predefined entities for plist string content. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function launchdLabel(job: ScheduleJob): string {
  return `com.crewhaus.${job.target}`;
}

function plistText(job: ScheduleJob, dir: string): string {
  const label = launchdLabel(job);
  const log = join(logPath(dir), `${job.label}.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  ${label} — generated by \`crewhaus schedule generate --for ${job.target} --runner launchd\`.
  ${job.cadence}.
  launchd agents do NOT inherit your shell environment: PATH and provider
  credentials must be set here (or sourced by the command). Exit non-zero
  means: ${xmlEscape(job.failureMeaning)}
-->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${xmlEscape(job.command)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(dir)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${job.hour}</integer>
    <key>Minute</key>
    <integer>${job.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
}

function systemdText(job: ScheduleJob, dir: string): string {
  const hh = String(job.hour).padStart(2, "0");
  const mm = String(job.minute).padStart(2, "0");
  return `# ${job.label} — generated by \`crewhaus schedule generate --for ${job.target} --runner systemd\`.
# ${job.cadence}. Two units: the service does the work, the timer schedules it.
# Exit non-zero means: ${job.failureMeaning}
# Credentials: put them in an EnvironmentFile (mode 0600), never inline here.

# ---- ${job.label}.service ----
[Unit]
Description=crewhaus ${job.target} — scheduled eval automation

[Service]
Type=oneshot
WorkingDirectory=${dir}
# EnvironmentFile=%h/.crewhaus/env
ExecStart=/bin/sh -lc ${JSON.stringify(job.command)}

# ---- ${job.label}.timer ----
[Unit]
Description=Schedule crewhaus ${job.target}

[Timer]
OnCalendar=*-*-* ${hh}:${mm}:00
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** Build the runner-specific text + install steps for a target. */
export function buildSchedule(opts: ScheduleGenerateOptions): GeneratedSchedule {
  const job = resolveScheduleJob(opts);
  const dir = opts.dir;
  const home = opts.home ?? homedir();
  switch (opts.runner) {
    case "cron":
      return {
        job,
        runner: "cron",
        filename: "",
        text: cronText(job, dir, home),
        install: [
          "Review the lines above, then append them to your crontab:",
          "  crontab -e        # paste, save, quit",
          "Verify with `crontab -l`; first output lands in the log path above.",
          `Create the log directory first: mkdir -p ${shellQuote(logPath(dir))}`,
        ],
      };
    case "launchd":
      return {
        job,
        runner: "launchd",
        filename: `${launchdLabel(job)}.plist`,
        text: plistText(job, dir),
        install: [
          `Save as ~/Library/LaunchAgents/${launchdLabel(job)}.plist, then:`,
          `  mkdir -p ${shellQuote(logPath(dir))}`,
          `  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${launchdLabel(job)}.plist`,
          `  launchctl kickstart -p gui/$(id -u)/${launchdLabel(job)}   # run once now`,
          `Remove with: launchctl bootout gui/$(id -u)/${launchdLabel(job)}`,
        ],
      };
    case "systemd":
      return {
        job,
        runner: "systemd",
        filename: `${job.label}.service + ${job.label}.timer`,
        text: systemdText(job, dir),
        install: [
          "Split the two sections into ~/.config/systemd/user/:",
          `  ${job.label}.service   and   ${job.label}.timer`,
          "Then:",
          "  systemctl --user daemon-reload",
          `  systemctl --user enable --now ${job.label}.timer`,
          `Check with: systemctl --user list-timers | grep ${job.label}`,
          `Run once now: systemctl --user start ${job.label}.service`,
        ],
      };
    default: {
      const never: never = opts.runner;
      throw new ScheduleGenerateError(`unhandled runner ${String(never)}`);
    }
  }
}

/** The full stdout block: the text, then how to install it. */
export function renderSchedule(generated: GeneratedSchedule): string {
  const lines: string[] = [];
  lines.push(
    `# ${generated.job.label} · runner=${generated.runner}${generated.filename !== "" ? ` · file: ${generated.filename}` : ""}`,
  );
  lines.push("");
  lines.push(generated.text.trimEnd());
  lines.push("");
  lines.push("# --- install ---");
  for (const step of generated.install) lines.push(`# ${step}`);
  lines.push("# This command only PRINTS — nothing was installed, scheduled, or written.");
  return `${lines.join("\n")}\n`;
}
