# @crewhaus/tool-host

What this machine is, as facts a workflow can gate on.

| Tool | Answers |
|---|---|
| `SystemInfo` | os and kernel, cpu, memory, uptime, runtime — and on request battery and free disk |
| `NetworkInfo` | interfaces and addresses, DNS resolvers, the proxy environment |
| `PortInspect` | what is listening on TCP, and which process owns it |

All three only read. Nothing here changes anything, and nothing here leaves the
host: no TCP probe, no name resolution, no request to anybody. To find out
whether something is reachable, use `@crewhaus/tool-proc`'s `WaitForPort` or
`@crewhaus/tool-fetch`, which are built to defend an outbound call.

## Unknown is an answer; zero is not

A caller asks how many cores a machine has in order to decide something — how
many workers to start, whether to run the big suite, whether to pull eight
gigabytes over a metered link. Every one of those decisions is made wrongly,
and silently, when a probe that could not answer returns a zero.

These are not hypotheticals. Each one was reproduced while this package was
being written:

- `pmset -g batt` on a desktop Mac prints one line — `Now drawing from 'AC
  Power'` — and no battery line at all. Read carelessly that is 0%, and a
  "skip the big download below 20% battery" gate fires on every desktop.
- `os.cpus()` returns an empty array in some containers. Read carelessly that
  is a machine with no CPUs.
- `os.loadavg()` returns `[0, 0, 0]` on Windows, by documented design. Read
  carelessly that is an idle machine.
- An unprivileged `lsof` lists only its own user's sockets. Read carelessly,
  the port another user is holding is free.

So the result has one rule, and it is exact:

- **`null` means unknown**, and every null is accompanied by an entry in the
  result's `unknown` list naming the field, the probe that was tried, and why
  it did not answer.
- **An absent key means not applicable.** A machine with no battery has no
  charge level; an unset `http_proxy` has no value. Neither is a mystery, so
  neither is a null.
- **An empty list is a claim, so it has to be earned.** A command that exits 0
  and prints something these parsers cannot read has told us nothing, and the
  empty list it parses to would read as a fact. `ifconfig` on a busybox host
  prints a format with no `flags=` in it at all (a captured fixture), and every
  machine has at least a loopback interface — so zero interfaces means the
  output was not understood, and the answer is `null` with the reason. Zero
  sockets is a real state, so there the evidence is the header `ss` and
  `netstat` print even on an idle host.
- **A cut-off answer is a prefix, not an answer.** `netstat -an -p tcp` and
  `netstat -ano` list every socket in every state, so a busy host overruns the
  output cap. When that happens `socketCoverage` drops to `null`: the ports
  whose rows were dropped must not come back as free.

```json
{
  "cpu": { "model": null, "logicalCores": 4, "physicalCores": null },
  "unknown": [
    { "field": "cpu.physicalCores", "probe": "/proc/cpuinfo",
      "reason": "the file carries no physical id / core id lines, which every ARM kernel omits; logical cores are NOT a substitute where SMT is on" }
  ]
}
```

A test walks each tool's output and fails on any null that has no entry, so the
rule cannot rot quietly.

## Why PortInspect runs two commands on macOS

`lsof` is the only probe on macOS that knows process names, and an ordinary
user's `lsof` can only open its own processes' file descriptors. On the machine
these fixtures came from, seconds apart: `netstat -an -p tcp` listed twenty
listening sockets, and `lsof` listed eight. The twelve it could not see were
root's — ssh, cups, screen sharing. A tool built on `lsof` alone reports those
ports as free.

So sockets come from `netstat` (every user, no owner) and `lsof` is joined on
top for the owners it can see. A socket whose owner cannot be read is returned
**with an unknown owner**, never dropped:

```json
{ "address": "127.0.0.1", "port": 631, "family": "ipv4", "owners": [], "ownerKnown": false }
```

`socketCoverage` says whether the source that answered sees every user's
sockets. It is the field that decides what `listening: false` may mean — when
coverage is not `all-users`, a port with no listener comes back `null`, because
an absence that was never visible is not evidence.

Per platform: Linux uses `ss` (every socket; the owner only where permitted),
falling back to `netstat -ltnp` and then to `/proc/net/tcp` **and** `tcp6` —
both, because a dual-stack listener appears only in the second, as one of the
captured fixtures shows. Windows uses `netstat -ano` plus `tasklist` for names.

## Every argv is a literal

Every command this package can run is a frozen constant in `HOST_COMMANDS`. No
caller value, and no value read out of another command's output, is ever
appended to an argv: a port filter is matched in JavaScript after parsing, an
interface name filters a parsed list, and the battery is read from sysfs rather
than from `upower -i <path>` precisely because that path would be an argv
element built from a probe's own output.

This repo has shipped argument injection once — `gitBranchCreate({name:"-D"})`
ran `git branch -D victim` — and the cure used here is having nothing to inject
into. A test replays hostile input (`-rf`, `$(whoami)`, `--`, a NUL) through
all three tools and asserts that every argv the runner saw is a member of that
frozen table.

## Where the results come from

`ip -j addr` is preferred on Linux because JSON has no columns, no locale and a
typed prefix length. The text parser is kept because the flag is not
everywhere: busybox `ip` answers `-j` with its usage text and exit 1, which is
one of the recorded fixtures.

A few other choices worth knowing:

- **`sysctl` is called without `-n`.** With `-n` the output is bare values, and
  a key the kernel does not know prints nothing at all — so every later value
  shifts up a row and is read as the wrong fact. Verified on Apple Silicon,
  where `hw.cpufrequency` does not exist.
- **`lsof -F` before the column form.** The columns truncate `COMMAND` to nine
  characters; `com.docker.backend` arrives as `com.docke`.
- **MemAvailable is not MemFree**, and macOS publishes neither, so it reports
  `availableBytes: null` rather than passing off free pages as available ones.
- **Disk reports `freeBytes` and `availableBytes` separately.** The gap is the
  reserved pool only root may use; gating a write on the first is how a job
  meets ENOSPC with five per cent still "free".
- **The Linux battery is chosen by the kernel's `type` and `scope`,** not by
  the device's name. `/sys/class/power_supply` also lists peripherals — a
  Logitech mouse appears as `hidpp_battery_0`, type `Battery`, scope `Device` —
  and picking by name reports a desktop as running on battery at the charge of
  a mouse.
- **`pmset`'s "not charging" is unknown, not false and not true.** macOS prints
  `AC attached; not charging` for a battery a charge limiter holds below full:
  on mains, filling nothing. The word "charging" is in there twice over, which
  is why both the positive and the negative are matched explicitly.
- **The child environment is pinned** to `LC_ALL=C`, `LANG=C`, `TZ=UTC`, with
  only `PATH` and `HOME` forwarded. Every parser here reads English keywords,
  and the harness's API keys have no business in `netstat`.

## What this does not answer

- Reachability of anything. Read the header.
- UDP. A UDP socket has no listening state, and reporting one as a "listener"
  next to TCP would be a different claim in the same field.
- The default route, and per-process CPU or memory.
- The Windows edition name, which needs PowerShell; the build number from the
  runtime is reported instead.
- A process name for a socket found through `/proc/net/tcp`: those files carry
  the owning uid and nothing else, and naming the process would mean walking
  `/proc/*/fd`.

## Testing

CI is Linux, development is macOS, and neither is Windows — so a parser checked
against whatever the test host prints is a parser checked against nothing.
Every probe goes through a seam:

| Seam | Replaces |
|---|---|
| `_setRunner` | running a command |
| `_setFs` | reading `/proc`, `/sys`, `/etc`, and `statfs` |
| `_setHostFacts` | what `node:os`, `node:dns` and `process` report |

The last two take a whole object rather than a partial, deliberately: a partial
merged over the real readings would leave a "Windows host" test inheriting CI's
Linux interface table and passing for the wrong reason.

The fixtures in `src/fixtures.ts` say where each one came from. Most are real
captures from a macOS host and from a real Linux container; the `ss`, `ip -j`
and Windows fixtures are written from the documented formats, because no
machine of either kind was available — those are the ones to re-capture first
when one is.

One test in this package touches the real machine. It runs all three tools on
whatever host it is on and asserts shape only — a count is a number or null,
never "this machine has eight cores", which would fail on the next machine.

```
bun test packages/tool-host/src
```

The `/src` is load-bearing: `bun test` matches by path PREFIX, so dropping it
also collects the sibling `packages/tool-hostfs`. That is this package's own
`test` script, and what CI's per-package run uses.
