# @crewhaus/tool-cron

What this machine is going to run, and removing one of those jobs.

| Tool | Answers |
|---|---|
| `CronList` | what is scheduled here, in which scheduler, on what schedule, and when it fires next |
| `CronDelete` | remove exactly one of those entries — destructive, with a dry run in front of it |

Three schedulers are read: the user's **crontab** everywhere, **launchd**
agents on macOS, **systemd** timers on Linux. Which ones are read by default
follows the platform; naming them explicitly is allowed, and a scheduler the
host does not have comes back as unavailable with the reason rather than as
an empty list.

## Three schedulers, three shapes — and the seams stay visible

Flattening them into one row per job reads well and cannot be acted on. Each
entry therefore names its `source`, carries **that scheduler's own
identifier**, and states which **grammar** its schedule is written in.

| Source | `id` is | Schedule grammar |
|---|---|---|
| `crontab` | `line:12` — the line number, plus a `fingerprint` of the line's bytes | `cron5`, `cron-macro`, `cron-reboot` |
| `launchd` | the **Label**, read from inside the plist | `launchd-calendar`, `launchd-interval`, `launchd-event` |
| `systemd` | the unit name, e.g. `backup.timer` | `systemd-oncalendar`, `systemd-monotonic` |

A crontab line has no identity of its own, so its number is the only handle —
and the number moves when anything above it is removed. That is what
`fingerprint` is for: pass it back to `CronDelete` and the delete refuses if
the line changed since it was listed.

A launchd plist's **file name is not its label**. On the machine this was
written on, `com.adobe.GC.Invoker-1.0.plist` declares
`com.adobe.GC.Scheduler-1.0`. Every label here is read out of the file, never
derived from the path.

## Cron is parsed once, in `@crewhaus/tool-datetime`

`CronNext` and `CronDescribe` already own the five-field grammar, the macros
and the DST walk that decides whether a 02:30 job runs twice or not at all.
This package asks them. It contains no cron parser.

**The grammars are not interchangeable, and nothing is translated between
them.** `crontab -l` lists a *user* crontab: fields 1–5 are the schedule and
the rest is the command. `/etc/crontab` and `/etc/cron.d/*` add a sixth field
naming the user; Quartz-style expressions put seconds first. Reading a
six-field expression as five does not fail — it succeeds, with the wrong
schedule and a one-token command — so a line whose command is itself
cron-shaped comes back flagged:

```
0 0 12 * * ?      →  schedule "0 0 12 * *", command "?", plus a note that
                     this looks like a six-field expression in a five-field file
```

For the same reason, a launchd `StartCalendarInterval` dictionary and a
systemd `OnCalendar` string are never handed to a cron parser. They are
reported as written, in their own grammar, with a plain-English description
derived from their own rules.

## Next firing: computed, reported, or honestly absent

- **cron** — computed by `@crewhaus/tool-datetime` from a reference instant
  you can supply, in a timezone you state. Cron fires on the host's local wall
  clock, so pass that zone to get the times the host will use; the default is
  UTC and the answer says so.
- **systemd** — **reported**, never recomputed. systemd already worked it out
  with the host's own rules and publishes it; a second answer computed here
  could only be a worse one.
- **launchd** — absent, and marked absent. A calendar dictionary with an
  omitted key means "every", a list of them means "all of these times", and
  launchd does not document the Day-plus-Weekday combination the way cron
  does. Guessing a firing time from that would be a confident invention.

Two launchd defaults are stated rather than smoothed over: an omitted `Minute`
means **every minute** of the stated hour, and a `StartInterval` restarts from
load, so its firing times shift whenever the agent is reloaded.

## `CronDelete` refuses more than it does

`destructive: true`, not concurrency-safe, and every refusal below happens
before anything is touched.

- **`dryRun`** reports the entries, the exact commands and the exact removed
  text — through the same selection and the same plan the real call executes.
  There is no separate preview path that could drift.
- **An ambiguous selector is refused.** `match` is a substring; if it matches
  more than one entry the call fails and lists the candidates. Deleting
  somebody's second backup job because a pattern matched twice is not
  recoverable from a tool result. `allowMultiple` is how you say you meant it.
- **Nothing matched is an error**, not a quiet success.
- **A stale `fingerprint` is refused**, naming both hashes. The hash covers
  the DEFINITION, never the runtime state: a systemd timer that simply fired
  in between still matches, because "it changed since you listed it" has to
  mean the schedule changed, not the clock.
- **The removed text comes back verbatim**, so it can be reinstalled.
- **A machine-wide definition is found and refused**, with the reason, rather
  than reported as missing. Nothing here escalates to root.
- Removing a launchd or systemd job **unloads or disables it**; the definition
  file stays unless you pass `removeDefinition`, and the result says the job
  will return at next login or boot. A file is only ever deleted from the
  user's own `LaunchAgents` or `~/.config/systemd/user` directory, after a
  containment check that refuses a symlink pointing out of it. A definition
  that is a symlink INSIDE that directory has the **link** removed, never what
  it points at — unlinking the target would delete another job's definition
  and leave this one's link behind.

### A probe that did not answer is never an answer

Every field a caller acts on distinguishes "no" from "could not tell":

- `crontab -l` that was killed at its deadline, or whose output hit the
  output cap and came back as a PREFIX, makes the source `available: false`
  with the reason — and `CronDelete` refuses, because a rewrite built from
  half a listing deletes the half it never saw.
- `launchctl list` failing makes every agent's `state` **`unknown`**, not
  `not-loaded`: no rows because nothing is loaded and no rows because the
  command failed are opposite facts.
- A `LaunchAgents` directory that exists and cannot be listed is reported as
  unreadable, not as empty. A permission error must not read as "you have no
  agents".
- systemd's `UnitFileState` becomes `enabled` only when it is a yes or a no.
  `static` (no `[Install]` section — it is pulled in by another unit) and an
  empty value leave `enabled` off and report the raw word instead.
- A multi-step delete that fails partway reports `partial: true` and what had
  already taken effect, rather than a bare `deleted: false` the machine
  contradicts.

### Rewriting a crontab is a race, and it is treated as one

A crontab is a file somebody else may be editing in `crontab -e` right now.
There is no portable lock. What this package does instead:

1. Read `crontab -l`, plan the removal from those exact bytes.
2. **Re-read immediately before writing** and compare. Different bytes means
   somebody edited it in between: the call refuses and writes nothing.
3. Write the new text to a private temp directory as `crontab.partial`, mode
   `0600`, then **rename** it to `crontab` and hand `crontab(1)` that name.
   A rename inside one directory is atomic, so the path crontab opens is
   either absent or complete — never half-written.
4. Always end the text in exactly one newline. Debian's crontab *refuses* a
   file without one ("new crontab file is missing newline before EOF, can't
   install."), and a second newline would grow the file on every edit.
5. Read it back and confirm the jobs are the ones intended. `verification`
   is one of `matched`, `mismatch` or `unreadable` — a read-back that could
   not be *done* is reported as its own outcome, not as a comparison that
   disagreed.
6. Remove the temp directory, whether the install worked or not.

The window between step 2 and step 3 is small but real, and the result says so
rather than implying a lock exists. Everything outside the removed line —
`MAILTO`, `PATH`, comments, blank lines, jobs this call was not about, lines
this parser could not read — survives byte for byte, **including its line
terminator**: a file that mixes `\n` and `\r\n` comes back mixed exactly as it
was, because re-terminating a line with `\r\n` appends a carriage return to a
command that never had one and cron then runs `/usr/local/bin/backup.sh\r`. A comment sitting above a
removed job is **kept** and reported; it may describe more than one job.

## No shell, ever

Every command is an argv array. Nothing is interpolated into a command line,
and no caller-supplied value reaches a command at all: labels and unit names
come from the host's own listing, are checked before they become arguments
(an identifier starting with `-` is a flag, not a name), and `--` is used
where the program accepts it — verified on macOS and Debian rather than
assumed. No schema in this package takes a path, a directory or a command;
every directory is derived from the home directory.

## Tested against recorded output, not against the machine

Every parser takes its input through an injected command runner, and the
suite drives recorded fixtures — real captures from macOS 15 and from Debian
13 with systemd 257, listed with their provenance in
`src/__fixtures__/host-output.ts`. Exactly one test touches the real host: it
runs `CronList` over this machine's crontab and asserts shape only.

That is not ceremony. Running the real commands is what caught three defects
a hand-written fixture would have hidden: systemd 257 prints
`NextElapseUSecRealtime` as `Sat 2026-09-19 07:44:13 UTC`, not as the
microseconds its name implies; a timer with two `OnCalendar=` lines prints two
separate `TimersCalendar=` lines, so last-one-wins parsing loses half the
schedule; and the real user-bus error is "Failed to connect to **user scope**
bus", which a pattern matching "Failed to connect to bus" never sees.

The seams are `_setRunner`, `_setFs` and `_setClock`.

## What this package does not do

- **Windows Task Scheduler.** `schtasks` is a fourth model with localised CSV
  column headers; a half-built reader for it would be worse than its absence.
  On Windows, `CronList` reads nothing and says so.
- **`/etc/crontab` and `/etc/cron.d`.** Different grammar (the extra user
  field), and changing them needs root.
- **Creating or editing a job.** This package inspects and removes.
- **Translating between schedulers.** No cron expression is synthesised from a
  launchd calendar or a systemd `OnCalendar`, in either direction.
- **Escalating privileges.** A system-scope entry is reported and refused.

Dependencies: `@crewhaus/tool-datetime` for cron interpretation, and the usual
tool-builder/catalog/errors trio. Nothing else — no cron parser, no plist
parser, no CSV reader.
