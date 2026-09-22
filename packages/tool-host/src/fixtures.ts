/**
 * Recorded probe output, for the tests.
 *
 * This package reads a real machine, and the machine a test runs on is not
 * the machine it is about: CI is Linux, development here is macOS, and
 * neither is Windows. A parser checked against whatever the test host
 * happens to print is a parser checked against nothing — it passes locally,
 * and on CI it either fails or, far worse, quietly reports something
 * different. So every parser test drives one of these strings.
 *
 * PROVENANCE — this matters, so it is stated per fixture below:
 *
 *   captured  the bytes a real machine printed, copied verbatim apart from
 *             the identifiers noted under "sanitising"
 *   written   the documented output format of a tool this package has no
 *             machine to run (iproute2's `ss` and `ip -j`, and every Windows
 *             probe). These are the fixtures to re-capture first when a host
 *             of that kind is available.
 *
 * Captured on macOS 26.6.2 (Darwin 25.6.0, arm64) and, for the Linux
 * fixtures, inside a real Linux container on that machine (Alpine 3.20,
 * aarch64, busybox userland) — which is also why the Linux side has busybox
 * `ip`/`netstat` rather than iproute2: it is the tooling a slim container
 * actually has, and the case the fallbacks exist for.
 *
 * Sanitising: MAC addresses, the LAN address, the user name and the uid are
 * replaced with stand-ins of the same shape. Column widths, tabs, trailing
 * spaces and field order are untouched, because those are what is being
 * tested.
 */

// ---------------------------------------------------------------------------
// macOS — captured
// ---------------------------------------------------------------------------

/** captured: `uname -srvm`. One line; the VERSION field alone is nine
 *  tokens and contains both spaces and colons. */
export const MACOS_UNAME = `Darwin 25.6.0 Darwin Kernel Version 25.6.0: Fri Jul 31 19:17:12 PDT 2026; root:xnu-12377.161.14~5/RELEASE_ARM64_T8103 arm64
`;

/** captured: `sw_vers`. The separator is TWO TABS, not a space. */
export const MACOS_SW_VERS = `ProductName:\t\tmacOS
ProductVersion:\t\t26.6.2
BuildVersion:\t\t25G83
`;

/** captured: `sysctl hw.logicalcpu hw.physicalcpu hw.memsize
 *  machdep.cpu.brand_string kern.boottime` — named output.
 *
 *  kern.boottime is here on purpose: its value contains a time with its own
 *  colons, so a parser that splits on the LAST colon, or on every colon,
 *  mangles it. */
export const MACOS_SYSCTL = `hw.logicalcpu: 8
hw.physicalcpu: 8
hw.memsize: 17179869184
machdep.cpu.brand_string: Apple M1
kern.boottime: { sec = 1789196391, usec = 979990 } Fri Sep 11 23:59:51 2026
`;

/**
 * captured: `sysctl -n hw.logicalcpu hw.physicalcpu hw.memsize
 * machdep.cpu.brand_string hw.cpufrequency` on the same machine — FIVE keys
 * asked for, FOUR lines back, because hw.cpufrequency does not exist on
 * Apple Silicon and its error went to stderr.
 *
 * This is why `HOST_COMMANDS.sysctl` does not use `-n`: zipping these lines
 * against the key list shifts every value after the missing key by one row,
 * so the memory size would be read as the physical core count. The fixture
 * is kept as the evidence for that decision.
 */
export const MACOS_SYSCTL_N_MISALIGNED = `8
8
17179869184
Apple M1
`;

/**
 * captured: `pmset -g batt` on a Mac with NO battery. The entire output is
 * one line. Nothing here says 0%, and nothing here may be reported as 0%.
 */
export const MACOS_PMSET_NO_BATTERY = `Now drawing from 'AC Power'
`;

/** written: a MacBook discharging. The status word is "discharging", which
 *  contains "charging" — the substring trap. */
export const MACOS_PMSET_DISCHARGING = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=12582499)\t63%; discharging; 3:41 remaining present: true
`;

/** written: the same machine on mains, charging, with no time estimate yet. */
export const MACOS_PMSET_CHARGING = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=12582499)\t41%; charging; (no estimate) present: true
`;

/** written: charged and on mains — charging is false, and that is a
 *  measurement rather than an unknown. */
export const MACOS_PMSET_CHARGED = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=12582499)\t100%; charged; 0:00 remaining present: true
`;

/**
 * written: a MacBook on mains whose charge is being HELD — Optimized
 * Battery Charging, or an 80% limit.
 *
 * This is the second half of the substring trap, and the half that bites
 * the other way: "not charging" contains "charging" as its own word,
 * preceded by a space, so a word-boundary match reports a battery that is
 * deliberately parked as one that is filling up. It is neither charging nor
 * discharging, so the flag is unknown — the same answer Linux's identical
 * "Not charging" gets from sysfs.
 */
export const MACOS_PMSET_NOT_CHARGING = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=12582499)\t80%; AC attached; not charging present: true
`;

/**
 * captured: `ifconfig -a`, trimmed to the interfaces that carry a trap and
 * with MACs and the LAN address replaced.
 *
 * Traps in here: a HEX netmask (BSD prints no prefix length anywhere), an
 * IPv6 address carrying a `%zone`, `status: inactive` on an interface whose
 * flags say UP (up-but-no-carrier), and bridge0's INDENTED `Configuration:`
 * and `member:` lines, which look like interface headers to any parser that
 * finds interfaces by "line contains a colon".
 */
export const MACOS_IFCONFIG = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\toptions=1203<RXCSUM,TXCSUM,TXSTATUS,SW_TIMESTAMP>
\tinet 127.0.0.1 netmask 0xff000000
\tinet6 ::1 prefixlen 128
\tinet6 fe80::1%lo0 prefixlen 64 scopeid 0x1
\tnd6 options=201<PERFORMNUD,DAD>
gif0: flags=8010<POINTOPOINT,MULTICAST> mtu 1280
stf0: flags=0<> mtu 1280
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\toptions=50b<RXCSUM,TXCSUM,VLAN_HWTAGGING,AV,CHANNEL_IO>
\tether 02:11:22:33:44:55
\tmedia: autoselect (none)
\tstatus: inactive
bridge0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\toptions=63<RXCSUM,TXCSUM,TSO4,TSO6>
\tether 02:11:22:33:44:60
\tConfiguration:
\t\tid 0:0:0:0:0:0 priority 0 hellotime 0 fwddelay 0
\t\tmaxage 0 holdcnt 0 proto stp maxaddr 100 timeout 1200
\tmember: en2 flags=3<LEARNING,DISCOVER>
\t        ifmaxaddr 0 port 9 priority 0 path cost 0
\tnd6 options=201<PERFORMNUD,DAD>
\tmedia: <unknown type>
\tstatus: inactive
en1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\toptions=6460<TSO4,TSO6,CHANNEL_IO,PARTIAL_CSUM,ZEROINVERT_CSUM>
\tether 02:11:22:33:44:61
\tinet 192.168.7.42 netmask 0xffffff00 broadcast 192.168.7.255
\tmedia: autoselect
\tstatus: active
utun0: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1380
\tinet6 fe80::da12:389f:2939:f760%utun0 prefixlen 64 scopeid 0x10 
\tnd6 options=201<PERFORMNUD,DAD>
`;

/**
 * captured: `netstat -an -p tcp`, with the LAN and remote addresses
 * replaced and most ESTABLISHED rows dropped.
 *
 * The listening set is the real one from that machine and is the evidence
 * for how PortInspect is built: ports 22, 88, 631, 5900, 8021 and 20241 are
 * owned by root or by other users, and the unprivileged `lsof` capture below
 * — taken seconds apart — contains NONE of them.
 *
 * Traps: `tcp46` is a third proto value, the address/port separator is a
 * DOT (`::1.631` — for IPv6 too), and the state column is padded with
 * trailing spaces.
 */
export const MACOS_NETSTAT_TCP = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address                                 Foreign Address                               (state)    
tcp4       0      0  192.168.7.42.50861     203.0.113.10.443       ESTABLISHED
tcp4       0      0  192.168.7.42.50857     203.0.113.10.443       LAST_ACK   
tcp46      0      0  *.8770                 *.*                    LISTEN     
tcp46      0      0  *.3283                 *.*                    LISTEN     
tcp6       0      0  *.55230                *.*                    LISTEN     
tcp4       0      0  *.55230                *.*                    LISTEN     
tcp4       0      0  127.0.0.1.20241        *.*                    LISTEN     
tcp4       0      0  127.0.0.1.11434        *.*                    LISTEN     
tcp4       0      0  *.49153                *.*                    LISTEN     
tcp4       0      0  *.88                   *.*                    LISTEN     
tcp6       0      0  *.88                   *.*                    LISTEN     
tcp4       0      0  127.0.0.1.631          *.*                    LISTEN     
tcp6       0      0  ::1.631                *.*                    LISTEN     
tcp4       0      0  127.0.0.1.8021         *.*                    LISTEN     
tcp6       0      0  ::1.8021               *.*                    LISTEN     
tcp4       0      0  *.5900                 *.*                    LISTEN     
tcp6       0      0  *.5900                 *.*                    LISTEN     
tcp4       0      0  *.22                   *.*                    LISTEN     
tcp6       0      0  *.22                   *.*                    LISTEN     
tcp4    3565      0  192.168.7.42.62875     203.0.113.24.443       CLOSE_WAIT 
`;

/**
 * captured: `lsof -nP -iTCP -sTCP:LISTEN -F cfnuLPT` as an ordinary user
 * (uid stand-in 501, login stand-in "agent").
 *
 * Eight sockets against netstat's twenty, and the difference is exactly the
 * sockets owned by other users. The format is stateful: `p` opens a process,
 * `c`/`u`/`L` describe it, and every `f` block under it is one descriptor.
 * Note the second process, which holds the SAME socket on two descriptors,
 * and `ccom.docker.backend`, whose full name the column format cannot show.
 */
export const MACOS_LSOF_FIELDS = `p751
csharingd
u501
Lagent
f18
PTCP
n*:8770
TST=LISTEN
TQR=0
TQS=0
p760
crapportd
u501
Lagent
f24
PTCP
n*:55230
TST=LISTEN
TQR=0
TQS=0
f25
PTCP
n*:55230
TST=LISTEN
TQR=0
TQS=0
p805
collama
u501
Lagent
f3
PTCP
n127.0.0.1:11434
TST=LISTEN
TQR=0
TQS=0
p877
ccom.docker.backend
u501
Lagent
f28
PTCP
n*:49153
TST=LISTEN
TQR=0
TQS=0
p21918
cARDAgent
u501
Lagent
f9
PTCP
n*:3283
TST=LISTEN
TQR=0
TQS=0
`;

/**
 * captured: the column form of the same command.
 *
 * `com.docke` is `com.docker.backend` truncated to nine characters by lsof,
 * and `Photo\\x20App` is a name whose space lsof escaped — which is what
 * keeps whitespace splitting usable, and what has to be decoded afterwards.
 * Two processes share 127.0.0.1:49153 on the same DEVICE (an inherited
 * descriptor), so one socket legitimately has two owners.
 */
export const MACOS_LSOF_COLUMNS = `COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
sharingd    751 agent   18u  IPv6 0xbba6b53c943a2607      0t0  TCP *:8770 (LISTEN)
rapportd    760 agent   24u  IPv4  0xd55b26994204fcb      0t0  TCP *:55230 (LISTEN)
ollama      805 agent    3u  IPv4 0x669119a1c529cb60      0t0  TCP 127.0.0.1:11434 (LISTEN)
com.docke   877 agent   28u  IPv4 0xb1ae500fdd0f3b11      0t0  TCP 127.0.0.1:49153 (LISTEN)
vpnkit-br   916 agent    8u  IPv4 0xb1ae500fdd0f3b11      0t0  TCP 127.0.0.1:49153 (LISTEN)
Photo\\x20A 1248 agent   29u  IPv4 0x5f8cde88d5a8e1ae      0t0  TCP [::1]:15292 (LISTEN)
`;

// ---------------------------------------------------------------------------
// Linux — captured in a real container
// ---------------------------------------------------------------------------

/**
 * captured: /proc/cpuinfo on aarch64, in full for two of the four cores.
 *
 * There is no `model name` line, no `physical id` and no `core id` — ARM
 * kernels print none of them. So the model is genuinely unknown here, and
 * the physical core count is genuinely unknown; assuming logical == physical
 * would be a fabricated number. The separator is `\t: ` on most lines and a
 * plain `: ` on "CPU architecture", in the same file.
 */
export const LINUX_PROC_CPUINFO_ARM64 = `processor\t: 0
BogoMIPS\t: 48.00
Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp
CPU implementer\t: 0x61
CPU architecture: 8
CPU variant\t: 0x0
CPU part\t: 0x000
CPU revision\t: 0

processor\t: 1
BogoMIPS\t: 48.00
Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp
CPU implementer\t: 0x61
CPU architecture: 8
CPU variant\t: 0x0
CPU part\t: 0x000
CPU revision\t: 0

processor\t: 2
BogoMIPS\t: 48.00
CPU implementer\t: 0x61
CPU architecture: 8

processor\t: 3
BogoMIPS\t: 48.00
CPU implementer\t: 0x61
CPU architecture: 8

`;

/**
 * written: /proc/cpuinfo on x86_64 — four logical cores on two physical
 * ones, which is the case the (physical id, core id) pair count exists for.
 * Reporting physicalCores as 4 here would be wrong by a factor of two.
 */
export const LINUX_PROC_CPUINFO_X86 = `processor\t: 0
vendor_id\t: GenuineIntel
cpu family\t: 6
model\t\t: 142
model name\t: Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz
physical id\t: 0
siblings\t: 4
core id\t\t: 0
cpu cores\t: 2
flags\t\t: fpu vme de pse tsc msr

processor\t: 1
vendor_id\t: GenuineIntel
model name\t: Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz
physical id\t: 0
siblings\t: 4
core id\t\t: 1
cpu cores\t: 2

processor\t: 2
vendor_id\t: GenuineIntel
model name\t: Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz
physical id\t: 0
siblings\t: 4
core id\t\t: 0
cpu cores\t: 2

processor\t: 3
vendor_id\t: GenuineIntel
model name\t: Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz
physical id\t: 0
siblings\t: 4
core id\t\t: 1
cpu cores\t: 2

`;

/** captured: the head of /proc/meminfo. MemAvailable is ten times MemFree
 *  plus change on a warm machine, which is why one is not the other. */
export const LINUX_PROC_MEMINFO = `MemTotal:       13280532 kB
MemFree:        11001140 kB
MemAvailable:   12351268 kB
Buffers:           97304 kB
Cached:          1616908 kB
SwapCached:            0 kB
Active:           582424 kB
Inactive:        1379004 kB
`;

/** written: a pre-3.14 kernel, which has no MemAvailable at all. MemFree is
 *  not a substitute and must not be reported as one. */
export const LINUX_PROC_MEMINFO_NO_AVAILABLE = `MemTotal:        2048000 kB
MemFree:          131072 kB
Buffers:           16384 kB
Cached:           524288 kB
`;

/** captured: /etc/os-release. */
export const LINUX_OS_RELEASE_ALPINE = `NAME="Alpine Linux"
ID=alpine
VERSION_ID=3.20.7
PRETTY_NAME="Alpine Linux v3.20"
HOME_URL="https://alpinelinux.org/"
BUG_REPORT_URL="https://gitlab.alpinelinux.org/alpine/aports/-/issues"
`;

/** captured: /etc/os-release from a Debian trixie image — the quoted value
 *  with spaces and parentheses. */
export const LINUX_OS_RELEASE_DEBIAN = `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
VERSION="13 (trixie)"
VERSION_CODENAME=trixie
ID=debian
`;

/**
 * captured: what busybox `ip` prints when asked for `-j`. Exit status 1, a
 * usage message, and not a byte of JSON.
 *
 * This is the whole reason the text parser is kept alongside the JSON one:
 * `ip -j` is preferred where it exists, and it does not exist here.
 */
export const LINUX_IP_J_UNSUPPORTED = `BusyBox v1.36.1 (2024-06-10 07:11:47 UTC) multi-call binary.

Usage: ip [OPTIONS] address|route|link|tunnel|neigh|rule [ARGS]

OPTIONS := -f[amily] inet|inet6|link | -o[neline]
`;

/**
 * captured: `ip addr` from busybox.
 *
 * Traps: `eth0@if39` — the name stops at the `@`, which names a veth peer;
 * `state UNKNOWN` on loopback, which is why the carrier is read from the
 * LOWER_UP flag rather than from the state word; a trailing space after
 * `state UP`; and `link/ipip 0.0.0.0`, which is an address in the MAC
 * position and is not a MAC.
 */
export const LINUX_IP_ADDR_TEXT = `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
2: tunl0@NONE: <NOARP> mtu 1480 qdisc noop state DOWN qlen 1000
    link/ipip 0.0.0.0 brd 0.0.0.0
3: ip6tnl0@NONE: <NOARP> mtu 1452 qdisc noop state DOWN qlen 1000
    link/tunnel6 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00 brd 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
38: eth0@if39: <BROADCAST,MULTICAST,UP,LOWER_UP,M-DOWN> mtu 1500 qdisc noqueue state UP 
    link/ether 02:42:ac:11:00:02 brd ff:ff:ff:ff:ff:ff
    inet 172.17.0.2/16 brd 172.17.255.255 scope global eth0
       valid_lft forever preferred_lft forever
`;

/** written: iproute2's `ip -j addr`, the JSON this package prefers where it
 *  is available. Typed prefix lengths, named scopes, real flag arrays. */
export const LINUX_IP_J_ADDR = `[{"ifindex":1,"ifname":"lo","flags":["LOOPBACK","UP","LOWER_UP"],"mtu":65536,"qdisc":"noqueue","operstate":"UNKNOWN","group":"default","txqlen":1000,"link_type":"loopback","address":"00:00:00:00:00:00","broadcast":"00:00:00:00:00:00","addr_info":[{"family":"inet","local":"127.0.0.1","prefixlen":8,"scope":"host","label":"lo","valid_life_time":4294967295,"preferred_life_time":4294967295},{"family":"inet6","local":"::1","prefixlen":128,"scope":"host","valid_life_time":4294967295,"preferred_life_time":4294967295}]},{"ifindex":2,"ifname":"enp0s31f6","flags":["BROADCAST","MULTICAST","UP","LOWER_UP"],"mtu":1500,"qdisc":"fq_codel","operstate":"UP","group":"default","txqlen":1000,"link_type":"ether","address":"02:42:ac:11:00:03","broadcast":"ff:ff:ff:ff:ff:ff","addr_info":[{"family":"inet","local":"10.0.5.17","prefixlen":24,"broadcast":"10.0.5.255","scope":"global","dynamic":true,"label":"enp0s31f6","valid_life_time":83900,"preferred_life_time":83900},{"family":"inet6","local":"fe80::42:acff:fe11:3","prefixlen":64,"scope":"link","valid_life_time":4294967295,"preferred_life_time":4294967295}]},{"ifindex":3,"ifname":"wlp2s0","flags":["BROADCAST","MULTICAST"],"mtu":1500,"qdisc":"noop","operstate":"DOWN","group":"default","txqlen":1000,"link_type":"ether","address":"02:42:ac:11:00:04","broadcast":"ff:ff:ff:ff:ff:ff","addr_info":[]}]
`;

/** captured: `netstat -ltnp` in a container with two busybox `nc` listeners.
 *  `:::9090` is a dual-stack bind written with three colons. */
export const LINUX_NETSTAT_LTNP = `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name    
tcp        0      0 :::9090                 :::*                    LISTEN      11/nc
tcp        0      0 :::8080                 :::*                    LISTEN      9/nc
`;

/** written: the same command as an ordinary user on a machine with root's
 *  services running. `-` in the PID column is a socket whose owner this user
 *  may not inspect — an unknown owner, not an absent process. */
export const LINUX_NETSTAT_LTNP_UNPRIVILEGED = `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name    
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      -                   
tcp        0      0 127.0.0.1:631           0.0.0.0:*               LISTEN      -                   
tcp        0      0 127.0.0.1:8080          0.0.0.0:*               LISTEN      4821/node
tcp6       0      0 :::22                   :::*                    LISTEN      -                   
`;

/** captured: /proc/net/tcp with no IPv4 listeners at all — header only. The
 *  two listeners on that host were in tcp6, which is why both files are
 *  read: one file alone answers "nothing is listening". */
export const LINUX_PROC_NET_TCP_EMPTY = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode                                                     
`;

/** captured: /proc/net/tcp6 on the same host, with the two `nc` listeners.
 *  st 0A is LISTEN; the ports are hex (2382 = 9090, 1F90 = 8080). */
export const LINUX_PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:2382 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 10001        0 561238 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 10001        0 558991 1 0000000000000000 100 0 0 10 0
`;

/** written: /proc/net/tcp with an IPv4 listener and an established
 *  connection. `0100007F` is 127.0.0.1 in host byte order — read the other
 *  way round it is 1.0.0.127, which looks like an address and is not one. */
export const LINUX_PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode                                                     
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 26421 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 18244 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 26890 1 0000000000000000 20 4 30 10 -1
`;

/**
 * captured: `ifconfig -a` inside a real Linux container on this machine
 * (Alpine 3.19, busybox 1.36.1, arm64) — exit code 0, nothing downloaded.
 *
 * It is here because AN EMPTY PARSE IS NOT AN ANSWER. `parseIfconfig`
 * reads the BSD header `en0: flags=8863<...> mtu 1500`; busybox and
 * net-tools print what is below instead, with no `flags=` anywhere, so
 * that parser finds nothing in it. Every host has at least a loopback
 * interface, so finding nothing can only mean the output was not
 * understood — reported as an empty list it reads as a machine with no
 * network, which is the shape of answer this package exists to refuse.
 * The MAC and the address are the container's own.
 */
export const LINUX_IFCONFIG_BUSYBOX = `eth0      Link encap:Ethernet  HWaddr 02:42:AC:11:00:02  
          inet addr:172.17.0.2  Bcast:172.17.255.255  Mask:255.255.0.0
          UP BROADCAST RUNNING MULTICAST  MTU:1500  Metric:1
          RX packets:2 errors:0 dropped:0 overruns:0 frame:0
          TX packets:0 errors:0 dropped:0 overruns:0 carrier:0
          collisions:0 txqueuelen:0 
          RX bytes:200 (200.0 B)  TX bytes:0 (0.0 B)

ip6tnl0   Link encap:UNSPEC  HWaddr 00-00-00-00-00-00-00-00-00-00-00-00-00-00-00-00  
          NOARP  MTU:1452  Metric:1
          RX packets:0 errors:0 dropped:0 overruns:0 frame:0
          TX packets:0 errors:0 dropped:0 overruns:0 carrier:0
          collisions:0 txqueuelen:1000 
          RX bytes:0 (0.0 B)  TX bytes:0 (0.0 B)

lo        Link encap:Local Loopback  
          inet addr:127.0.0.1  Mask:255.0.0.0
          UP LOOPBACK RUNNING  MTU:65536  Metric:1
          RX packets:0 errors:0 dropped:0 overruns:0 frame:0
          TX packets:0 errors:0 dropped:0 overruns:0 carrier:0
          collisions:0 txqueuelen:1000 
          RX bytes:0 (0.0 B)  TX bytes:0 (0.0 B)

tunl0     Link encap:UNSPEC  HWaddr 00-00-00-00-00-00-00-00-00-00-00-00-00-00-00-00  
          NOARP  MTU:1480  Metric:1
          RX packets:0 errors:0 dropped:0 overruns:0 frame:0
          TX packets:0 errors:0 dropped:0 overruns:0 carrier:0
          collisions:0 txqueuelen:1000 
          RX bytes:0 (0.0 B)  TX bytes:0 (0.0 B)

`;

/** written: `ss -ltnp` on Ubuntu as an ordinary user.
 *
 *  Row 3 has NO Process column — that socket belongs to a process this user
 *  may not inspect. Row 1 carries an interface-scoped address
 *  (`127.0.0.53%lo`), row 5 has two processes on one socket, and the IPv6
 *  rows bracket the address. */
export const LINUX_SS_LTNP = `State    Recv-Q   Send-Q     Local Address:Port       Peer Address:Port  Process
LISTEN   0        4096       127.0.0.53%lo:53             0.0.0.0:*      users:(("systemd-resolve",pid=612,fd=13))
LISTEN   0        128              0.0.0.0:22             0.0.0.0:*      users:(("sshd",pid=1023,fd=3))
LISTEN   0        128            127.0.0.1:631            0.0.0.0:*      
LISTEN   0        128                 [::]:22                [::]:*      users:(("sshd",pid=1023,fd=4))
LISTEN   0        511                    *:80                   *:*      users:(("nginx",pid=1200,fd=6),("nginx",pid=1201,fd=6))
`;

/** written: `ss -ltnp` from a build that prints the Netid column first. */
export const LINUX_SS_LTNP_NETID = `Netid  State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process
tcp    LISTEN  0       4096          0.0.0.0:3000          0.0.0.0:*     users:(("node",pid=9182,fd=20))
`;

/** written: /sys/class/power_supply/BAT0/capacity and /status. */
export const LINUX_SYSFS_BATTERY_CAPACITY = "87\n";
export const LINUX_SYSFS_BATTERY_STATUS_DISCHARGING = "Discharging\n";
/** written: a laptop held at 80% by a charge limiter. "Not charging" does
 *  NOT mean discharging, so the charging flag is unknown rather than false. */
export const LINUX_SYSFS_BATTERY_STATUS_NOT_CHARGING = "Not charging\n";

/** captured: /etc/resolv.conf as a container writes it — one nameserver, a
 *  comment, and no search list at all. */
export const LINUX_RESOLV_CONF = `# DNS requests are forwarded to the host. DHCP DNS options are ignored.
nameserver 192.168.65.5
`;

/** written: a desktop resolv.conf with a search list and comments. Per
 *  resolv.conf(5) the LAST search line wins. */
export const LINUX_RESOLV_CONF_SEARCH = `# Generated by NetworkManager
nameserver 127.0.0.53
nameserver 10.0.0.1
search corp.example.com
search example.com internal.example.com
options edns0 trust-ad
`;

// ---------------------------------------------------------------------------
// Windows — written
// ---------------------------------------------------------------------------

/**
 * Windows writes CRLF, and every Windows parser here has to survive it — a
 * trailing \r otherwise becomes part of the last field of every row. The
 * fixtures are built line by line so the line endings are visible rather
 * than buried in one long escaped string.
 */
const crlf = (lines: ReadonlyArray<string>): string => `${lines.join("\r\n")}\r\n`;

/**
 * written: `netstat -ano`, CRLF line endings included.
 *
 * Traps: the UDP rows have NO State column, so they have one field fewer and
 * a positional parse reads the pid as the state; and `LISTENING` is
 * localized on a non-English Windows, which is why a listener is recognised
 * by its wildcard foreign address instead.
 */
export const WINDOWS_NETSTAT_ANO = crlf([
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       968",
  "  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4",
  "  TCP    127.0.0.1:5939         0.0.0.0:0              LISTENING       6208",
  "  TCP    192.168.1.10:139       0.0.0.0:0              LISTENING       4",
  "  TCP    192.168.1.10:51234     140.82.114.26:443      ESTABLISHED     8124",
  "  TCP    [::]:135               [::]:0                 LISTENING       968",
  "  UDP    0.0.0.0:5353           *:*                                    3256",
  "  UDP    [::]:3702              *:*                                    4404",
]);

export const WINDOWS_NETSTAT_ANO_LOCALIZED = crlf([
  "",
  "Aktive Verbindungen",
  "",
  "  Proto  Lokale Adresse         Remoteadresse          Status          PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              ABH\u00d6REN         968",
  "  TCP    0.0.0.0:3000           0.0.0.0:0              ABH\u00d6REN         7412",
  "  TCP    192.168.1.10:51234     140.82.114.26:443      HERGESTELLT     8124",
]);

/** written: `tasklist /FO CSV /NH`. The memory column contains a comma
 *  inside its quotes, which is why the split is quote-aware. */
export const WINDOWS_TASKLIST_CSV = crlf([
  '"System Idle Process","0","Services","0","8 K"',
  '"svchost.exe","968","Services","0","12,345 K"',
  '"System","4","Services","0","2,108 K"',
  '"node.exe","7412","Console","1","250,112 K"',
  '"TeamViewer_Service.exe","6208","Services","0","31,004 K"',
]);

/** written: `wmic path Win32_Battery get ... /format:list` on a laptop. */
export const WINDOWS_WMIC_BATTERY = crlf([
  "",
  "",
  "BatteryStatus=2",
  "EstimatedChargeRemaining=87",
  "",
  "",
]);

/** written: the same command on a desktop — wmic ran and matched no
 *  instance, which IS a measurement: there is no battery. */
export const WINDOWS_WMIC_BATTERY_NONE = crlf(["", ""]);
