/**
 * D41 — `crewhaus schedule generate`: the off-GitHub scheduling shim. The
 * generated text is deterministic (no timestamps), so these are effectively
 * snapshots of what a user is asked to install — and the point of the verb
 * is that it prints and installs NOTHING, which the tests pin too.
 */
import { describe, expect, test } from "bun:test";
import {
  SCHEDULE_RUNNERS,
  SCHEDULE_TARGETS,
  ScheduleGenerateError,
  buildSchedule,
  parseScheduleRunner,
  parseScheduleTarget,
  renderSchedule,
  resolveScheduleJob,
  shellQuote,
  xmlEscape,
} from "./schedule-generate";

const DIR = "/srv/harness";

describe("flag parsing", () => {
  test("--for is required and closed over the known targets", () => {
    expect(() => parseScheduleTarget(undefined)).toThrow(/--for is required/);
    expect(() => parseScheduleTarget("nightly")).toThrow(/unknown --for "nightly"/);
    for (const t of SCHEDULE_TARGETS) expect(parseScheduleTarget(t)).toBe(t);
  });

  test("--runner defaults to cron and rejects anything else", () => {
    expect(parseScheduleRunner(undefined)).toBe("cron");
    expect(() => parseScheduleRunner("upstart")).toThrow(/unknown --runner "upstart"/);
    for (const r of SCHEDULE_RUNNERS) expect(parseScheduleRunner(r)).toBe(r);
  });

  test("errors are the module's own type so the CLI can die() cleanly", () => {
    expect(() => parseScheduleTarget("x")).toThrow(ScheduleGenerateError);
  });
});

describe("resolveScheduleJob — each target wraps its real command", () => {
  test("flywheel", () => {
    const job = resolveScheduleJob({ target: "flywheel", runner: "cron", dir: DIR });
    expect(job.command).toBe("crewhaus flywheel run");
    expect([job.hour, job.minute]).toEqual([7, 13]);
  });

  test("eval-gate exits non-zero on regression — the gate flag must be there", () => {
    const job = resolveScheduleJob({ target: "eval-gate", runner: "cron", dir: DIR });
    expect(job.command).toBe(
      "crewhaus eval crewhaus.yaml --dataset eval/dataset.jsonl --graders eval/graders.yaml --gate",
    );
    expect(job.failureMeaning).toMatch(/REGRESSED/);
  });

  test("sentinel pins the seed and points at the frozen baseline", () => {
    const job = resolveScheduleJob({ target: "sentinel", runner: "cron", dir: DIR });
    expect(job.command).toContain("--seed 1 --sentinel --baseline eval/sentinel-baseline");
    expect(job.failureMeaning).toMatch(/DRIFT/);
  });

  test("the three targets never share a firing minute", () => {
    const times = SCHEDULE_TARGETS.map((target) => {
      const j = resolveScheduleJob({ target, runner: "cron", dir: DIR });
      return `${j.hour}:${j.minute}`;
    });
    expect(new Set(times).size).toBe(SCHEDULE_TARGETS.length);
  });

  test("path overrides are threaded and shell-quoted", () => {
    const job = resolveScheduleJob({
      target: "eval-gate",
      runner: "cron",
      dir: DIR,
      spec: "specs/my agent.yaml",
      dataset: "data/dev.jsonl",
      graders: "eval/g.yaml",
    });
    expect(job.command).toContain("'specs/my agent.yaml'");
    expect(job.command).toContain("--dataset data/dev.jsonl");
  });

  test("flywheel threads the SAME path flags (a schedule must run the job you asked for)", () => {
    const job = resolveScheduleJob({
      target: "flywheel",
      runner: "cron",
      dir: DIR,
      spec: "prod.yaml",
      dataset: "registry:prod-ratings",
      graders: "eval/strict.yaml",
    });
    // `crewhaus flywheel run [spec.yaml] --dataset --graders` accepts all
    // three; dropping them silently installed a crontab running a DIFFERENT
    // job (the conventional paths) than the one the user typed.
    expect(job.command).toBe(
      "crewhaus flywheel run prod.yaml --dataset registry:prod-ratings --graders eval/strict.yaml",
    );
  });

  test("a flag the target cannot consume is WARNED about, not silently dropped", () => {
    const flywheel = resolveScheduleJob({
      target: "flywheel",
      runner: "cron",
      dir: DIR,
      baseline: "eval/frozen",
    });
    expect(flywheel.command).not.toContain("frozen");
    expect(flywheel.warnings.join(" ")).toMatch(/--baseline only applies to --for sentinel/);
    const gate = resolveScheduleJob({
      target: "eval-gate",
      runner: "cron",
      dir: DIR,
      baseline: "eval/frozen",
    });
    expect(gate.warnings).toHaveLength(1);
    // Sentinel consumes it, so it says nothing.
    const sentinel = resolveScheduleJob({
      target: "sentinel",
      runner: "cron",
      dir: DIR,
      baseline: "eval/frozen",
    });
    expect(sentinel.warnings).toEqual([]);
    expect(sentinel.command).toContain("--baseline eval/frozen");
  });

  test("no warnings, and the bare command, when nothing extra was passed", () => {
    for (const target of SCHEDULE_TARGETS) {
      expect(resolveScheduleJob({ target, runner: "cron", dir: DIR }).warnings).toEqual([]);
    }
  });
});

describe("cron output", () => {
  const HOME = "/home/agent";
  const text = renderSchedule(
    buildSchedule({ target: "sentinel", runner: "cron", dir: DIR, home: HOME }),
  );

  test("is a valid 5-field crontab line running in the harness dir", () => {
    const line = text.split("\n").find((l) => l.startsWith("17 3 * * *"));
    expect(line).toBeDefined();
    expect(line).toContain("cd /srv/harness && crewhaus eval crewhaus.yaml");
    expect(line).toContain(">> /srv/harness/.crewhaus/logs/crewhaus-sentinel.log 2>&1");
  });

  test("warns about cron's minimal environment and never inlines a key", () => {
    expect(text).toContain("PATH=");
    expect(text).toMatch(/never inline a key into a crontab/);
    expect(text).not.toMatch(/ANTHROPIC_API_KEY=[A-Za-z0-9]/);
  });

  test("the PATH line is EXPANDED — cron does not substitute variables", () => {
    // man 5 crontab: the value string is not parsed for environmental
    // substitutions, so `$HOME/.bun/bin` would stay a literal and a
    // bun-installed crewhaus would die with `command not found` nightly —
    // in exactly the case the comment above the line warns about.
    expect(text).toContain("PATH=/usr/local/bin:/usr/bin:/bin:/home/agent/.bun/bin");
    // No unexpanded variable survives in any ASSIGNMENT (the explanatory
    // comment above the line names `$HOME` on purpose).
    const assignments = text.split("\n").filter((l) => /^[A-Z_]+=/.test(l));
    expect(assignments.length).toBeGreaterThan(0);
    for (const line of assignments) expect(line).not.toContain("$");
  });

  test("says it installed nothing", () => {
    expect(text).toContain("only PRINTS — nothing was installed");
  });
});

describe("launchd output", () => {
  const generated = buildSchedule({ target: "flywheel", runner: "launchd", dir: DIR });

  test("is a plist with the schedule, working dir and log paths", () => {
    expect(generated.filename).toBe("com.crewhaus.flywheel.plist");
    expect(generated.text).toContain("<key>Label</key>");
    expect(generated.text).toContain("<string>com.crewhaus.flywheel</string>");
    expect(generated.text).toContain("<key>Hour</key>\n    <integer>7</integer>");
    expect(generated.text).toContain("<key>Minute</key>\n    <integer>13</integer>");
    expect(generated.text).toContain("<string>/srv/harness</string>");
  });

  test("install steps use launchctl bootstrap/bootout", () => {
    const steps = generated.install.join("\n");
    expect(steps).toContain("~/Library/LaunchAgents/com.crewhaus.flywheel.plist");
    expect(steps).toContain("launchctl bootstrap gui/$(id -u)");
    expect(steps).toContain("launchctl bootout gui/$(id -u)/com.crewhaus.flywheel");
  });

  test("XML-escapes text that would otherwise break the plist", () => {
    expect(xmlEscape(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
    const quoted = buildSchedule({
      target: "eval-gate",
      runner: "launchd",
      dir: DIR,
      dataset: "data/a&b.jsonl",
    });
    expect(quoted.text).toContain("a&amp;b.jsonl");
    expect(quoted.text).not.toContain("a&b.jsonl");
  });
});

describe("systemd output", () => {
  const generated = buildSchedule({ target: "eval-gate", runner: "systemd", dir: DIR });

  test("emits a service + timer pair with an OnCalendar matching the cadence", () => {
    expect(generated.text).toContain("# ---- crewhaus-eval-gate.service ----");
    expect(generated.text).toContain("# ---- crewhaus-eval-gate.timer ----");
    expect(generated.text).toContain("Type=oneshot");
    expect(generated.text).toContain("WorkingDirectory=/srv/harness");
    expect(generated.text).toContain("OnCalendar=*-*-* 05:23:00");
    expect(generated.text).toContain("Persistent=true");
    expect(generated.text).toContain("WantedBy=timers.target");
  });

  test("ExecStart carries the crewhaus command as one quoted shell string", () => {
    const exec = generated.text.split("\n").find((l) => l.startsWith("ExecStart="));
    expect(exec).toBe(
      'ExecStart=/bin/sh -lc "crewhaus eval crewhaus.yaml --dataset eval/dataset.jsonl --graders eval/graders.yaml --gate"',
    );
  });

  test("install steps use the user systemd units", () => {
    const steps = generated.install.join("\n");
    expect(steps).toContain("~/.config/systemd/user/");
    expect(steps).toContain("systemctl --user enable --now crewhaus-eval-gate.timer");
  });
});

describe("shellQuote", () => {
  test("leaves safe words alone and quotes the rest", () => {
    expect(shellQuote("eval/dataset.jsonl")).toBe("eval/dataset.jsonl");
    expect(shellQuote("my harness/spec.yaml")).toBe("'my harness/spec.yaml'");
    expect(shellQuote("it's.yaml")).toBe(`'it'\\''s.yaml'`);
  });
});

describe("every (target, runner) pair renders", () => {
  test("no combination throws, and each names its own job", () => {
    for (const target of SCHEDULE_TARGETS) {
      for (const runner of SCHEDULE_RUNNERS) {
        const text = renderSchedule(buildSchedule({ target, runner, dir: DIR }));
        expect(text).toContain(`runner=${runner}`);
        expect(text).toContain(`crewhaus-${target === "flywheel" ? "flywheel" : target}`);
      }
    }
  });
});
