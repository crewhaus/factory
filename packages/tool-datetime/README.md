# @crewhaus/tool-datetime

Deterministic date and time tools. Every one is pure: no filesystem, no
network, no randomness, and — the rule that shapes the whole package — **no
clock**.

There is no `Date.now()` here and no implicit "today". Every tool that needs a
reference time takes it as an input field. `CronNext` makes you pass the
instant to search forward from; `BusinessDays` makes you pass the start date
and the holiday list. That is a constraint with teeth, and it is the point: a
tool that quietly consults the system clock cannot be cached, cannot be
replayed, and turns every eval into a flake.

```yaml
tools:
  - all-datetime        # every tool below
  - -recurrenceExpand   # ...except this one
```

| Tool | What it does |
|---|---|
| `BusinessDays` | Count business days between two dates, or move a number of them, against your weekend and holiday list |
| `CronDescribe` | Render a 5-field cron expression as English, with the expanded value set per field |
| `CronNext` | The next N firing times of a cron expression, from a reference time you supply |
| `DateAdd` | Add or subtract years, months, weeks, days, hours, minutes and seconds, clamping at month ends |
| `DateConvertTimezone` | Move an instant between IANA zones, with the offset and abbreviation that applied then |
| `DateDiff` | Distance between two instants in a chosen unit, plus a years/months/days/hours breakdown |
| `DateFormat` | Render an instant through a token pattern in a chosen zone |
| `DateParse` | Parse a date string into a normalized UTC instant, reporting ambiguity instead of guessing |
| `DateRange` | Expand a start and end into a capped list of instants at a fixed step |
| `DayOfYear` | Convert between a date and its ordinal day, in either direction |
| `DurationFormat` | Render a length of time as human text, ISO 8601, or a clock |
| `DurationParse` | Read `P3DT4H`, `2h30m` or `01:30:00` into milliseconds and components |
| `IsLeapYear` | The Gregorian leap rule, with the year's length and the nearest leap years |
| `QuarterOf` | The quarter a date falls in, calendar or fiscal, with its bounds |
| `RecurrenceExpand` | Expand a supported subset of an iCalendar RRULE from an explicit start |
| `TimestampConvert` | Unix seconds, millis, micros and nanos to ISO 8601 and back |
| `WeekOfYear` | ISO-8601 week number and week-year, with the week's bounds |

## The rules these tools implement, stated once

Date libraries differ on a handful of questions and rarely say which answer
they picked. These are ours.

**Calendar units move the wall clock; time units move the instant.** In
`DateAdd`, `days: 1` in `America/New_York` across a spring-forward keeps 09:00
at 09:00 and advances the instant by 23 hours. `hours: 24` advances the instant
by 24 hours and lands at 10:00. Both are correct; they answer different
questions. Mixing units applies the calendar part first.

**Month arithmetic clamps.** 31 January plus one month is 28 February, not 3
March. It follows that the operation is not reversible — subtracting a month
from 28 February gives 28 January — and not associative. `DateDiff` is defined
as the inverse of the same clamp, so 31 January to 28 February counts as one
whole month and to 27 February as none.

**`DateRange` anchors on the start**, computing `start + n × step` rather than
stepping from the previous item. A monthly range from 31 January runs 31 Jan,
28 Feb, 31 Mar — iterating would clamp once and then stay on the 28th forever.

**`RecurrenceExpand` skips instead of clamping**, because RFC 5545 says so. A
monthly rule starting on the 31st fires seven times a year. This is the
opposite of `DateAdd`, deliberately, and each says so in its output.

**DST is reported, never papered over.** A wall clock in a spring-forward gap
does not exist and one in a fall-back repeat happens twice. Every tool that
resolves a wall clock says which case it hit: `DateParse` returns
`wallClockResolution`, `CronNext` returns `skippedForDst` and marks a repeated
firing, `DateAdd` puts it in `notes`.

**Ambiguity is reported, not guessed.** `DateParse` refuses `03/04/2026` and
returns both readings until you pass `dateOrder`. There is no fallback to
`new Date(string)`, whose behaviour outside ISO 8601 is implementation-defined.

## Supported subsets, precisely

Each parser here implements a closed grammar and rejects everything else by
name. A parser that quietly ignores what it does not understand produces a
calendar that is wrong in a way nobody notices.

**`DateParse`** accepts: ISO 8601 extended (`2026-09-17T14:30:00+02:00`, with
`Z`, `+HH:MM`, `+HHMM` or `+HH`), ISO basic (`20260917T143000Z`), ordinal
(`2026-260`), week dates (`2026-W38-4`), year-first slashes (`2026/09/17`),
bare numeric dates with a `dateOrder`, month names in either order
(`17 Sep 2026`, `September 17, 2026`), and RFC 2822 with its weekday prefix.
`24:00` rolls to the next day; second 60 clamps to 59 and says so.

**`DateFormat`** tokens: `YYYY YY GGGG MMMM MMM MM M DDD DD D dddd ddd dd HH H
hh h mm m ss s SSS A a ZZZ ZZ Z zz WW W Q X x`, with `[literal text]` passing
through. Named presets cover ISO, RFC 2822, filenames and log prefixes. Month
and weekday names for a non-`en-US` locale come from the runtime's CLDR data.

**`CronNext` / `CronDescribe`** implement the 5-field form: `*`, numbers,
`a-b`, lists, `*/n`, `a-b/n`, `a/n`, `JAN`–`DEC` and `SUN`–`SAT` names, `?` as
a synonym for `*` (as a whole field, never inside a list or a step), and the
`@yearly`/`@annually`/`@monthly`/`@weekly`/`@daily`/`@midnight`/`@hourly`
macros. Rejected by name, in every field: a seconds or year field, Quartz's
`L`, `W` and `#`, Jenkins's `H`, and `@reboot`.

Two dialect choices, since cron implementations differ and rarely say which
they picked. When day-of-month and day-of-week are both restricted, a day
matches if **either** matches — Vixie cron's rule, and the one that surprises
people, so `CronDescribe` warns about it explicitly. A reversed range
(`FRI-MON`, `NOV-FEB`) **wraps** around the end of the field; Vixie cron and
cronie instead match nothing at all, which is never what the author meant.

**`RecurrenceExpand`** implements `FREQ` (`DAILY`, `WEEKLY`, `MONTHLY`,
`YEARLY`), `INTERVAL`, `COUNT`, `UNTIL`, and plain `BYDAY`. Rejected by name:
positional `BYDAY` (`2MO`), `BYMONTH`, `BYMONTHDAY`, `BYYEARDAY`, `BYWEEKNO`,
`BYHOUR`, `BYSETPOS`, `WKST`, sub-daily frequencies, and `BYDAY` with
`FREQ=YEARLY`. The week starts Monday. `UNTIL` is either a plain date, which
covers the whole day, or a date-time that must carry its `Z` — RFC 5545 §3.3.10
requires UTC there, and reading a floating time as UTC would move the end of
the series by the caller's offset without saying so.

**`DurationParse`** accepts ISO 8601 designators, shorthand (`2h30m`,
`1d 4h`, `90 minutes`), and clock form (`01:30:00`). Bare `m` means minutes;
months must be written `mo` or longer. In the shorthand form, whitespace,
commas, a leading `+` and the word `and` are filler; anything else left over is
refused by name rather than dropped, so `5m!!!` is an error and not a
five-minute timeout. Years and months are parsed but kept out of
`totalMilliseconds` and the result is marked `exact: false`, because they have
no fixed length — anchor them with `DateAdd`.

## The range a date can hold

Every instant here lives inside ±8.64×10¹⁵ milliseconds of the epoch — roughly
year −271821 to 275760 — because that is where `Date` and `Intl` stop working.
Past it `Intl.DateTimeFormat` throws a bare "date value is not finite", which is
not an answer a caller can do anything with, so each tool checks first and
returns a sentence saying so. The grammar accepts six-digit years and `DateAdd`
accepts a million of anything, so this is reachable from valid input, not only
from abuse. Below that boundary the day arithmetic is exact for every integer
year, negative ones included.

## The one runtime dependency

Timezone data comes from the runtime's `Intl` implementation, which is the
platform's tzdb copy. Offsets for recent and near-future dates are stable
across any current runtime; very old ones (before standard zones, where the
offset had seconds) are rounded to the minute, and far-future ones can move
with a tzdb update. Nothing else here depends on anything outside the package.

## What is deliberately not here

Natural-language dates ("next Tuesday", "in three weeks"), which need a
reference time *and* an interpretation — the interpretation is judgement, and
this package does not do judgement. Holiday calendars, because they are a
jurisdiction's political decision, not a computation: `BusinessDays` takes the
list as an input. Relative phrasing ("3 days ago") for the same reason
`Date.now()` is absent.

## Layout

`src/lib/` holds the pure functions and is where the behaviour is tested;
`src/index.ts` wraps them as tools. A bug in `daysFromCivil` or the cron field
expander reads better as a failing unit than as a failing tool call.

- `lib/civil.ts` — day-count arithmetic, IANA offsets, ISO rendering
- `lib/parse.ts` — the date-string grammar
- `lib/format.ts` — the token formatter
- `lib/arithmetic.ts` — add, diff, business days, ranges
- `lib/duration.ts` — duration parsing and rendering
- `lib/cron.ts` — the cron parser, walker and describer
- `lib/recurrence.ts` — the RRULE subset

## Safety flags

All seventeen are `readOnly`, non-destructive, `scope: "internal"`, and declare
no io capability, because none of them crosses a process or network boundary.
`src/index.test.ts` asserts that for every tool, and then greps the source of
every module for the ways out: `Date.now()`, a bare `new Date()`,
`performance.now()`, `Math.random()`, `crypto`, `process`, `fetch`, `require`,
`Bun.*`, and any `node:`/`fs`/`path`/`child_process` import. A future addition
that reads the clock or reaches outside has to edit that list on purpose.
