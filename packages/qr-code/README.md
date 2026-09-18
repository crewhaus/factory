# @crewhaus/qr-code

A QR Code encoder and terminal renderer, with no dependencies.

It exists for one line of `crewhaus hangar --lan`: the console prints a symbol, you point your
phone at it, and Hangar opens. The CLI carries exactly one non-workspace dependency by policy, so
the encoder is written here rather than installed — about 400 lines, all of it pure TypeScript
with no data files, which also keeps it safe to embed in the `bun build --compile` binary.

```ts
import { encodeQr, renderQrLines } from "@crewhaus/qr-code";

const qr = encodeQr("http://192.168.1.42:4200/#t=…");
for (const line of renderQrLines(qr)) console.log(line);
```

## What it implements

ISO/IEC 18004 in **byte mode only**, versions 1–40, all four error-correction levels, with
automatic version selection, the spec's mask evaluation, and Reed–Solomon over GF(256).

Byte mode is the whole encoder on purpose. Numeric and alphanumeric modes only pay for themselves
alongside a segmentation optimiser, and the payloads this was built for — `http://host:port/#t=…`
— contain lowercase letters, which the alphanumeric character set cannot hold. Byte mode over
UTF-8 encodes every input correctly; the cost is at most one extra version for an all-digit
payload.

## Two things worth knowing

**The renderer solves aspect ratio and polarity, not just drawing.** A terminal cell is about
twice as tall as it is wide, so the half-block characters `▀` and `▄` carry two module rows per
text row and the modules come out square — a version 6 symbol is 49 columns and 25 rows rather
than 98 columns. And because a terminal has no fixed background, each line is wrapped in an
explicit black-on-white SGR pair: without it the same characters read as a QR code on a dark theme
and as its photographic negative on a light one. Pass `color: false` for a pipe or a log, and
`ascii: true` for terminals whose font renders the half blocks with seams.

**The error-correction level is a floor, not a target.** Once a version is chosen, `encodeQr`
raises the level as far as that version allows for free, because a stronger level in the same
number of modules is pure damage tolerance — which is what a symbol being photographed off a
screen at an angle actually needs. Pass `boostEcLevel: false` to pin it.

## Verification

The capacity tables, alignment-pattern coordinates and format/version information were checked
against an independent encoder and decoder (macOS `CIQRCodeGenerator` and Vision's
`VNDetectBarcodesRequest`): all 160 version × EC-level capacity boundaries, every alignment
pattern from version 2 to 40, 27 symbols' format information across all four levels, and 18
symbols' version information. That oracle needs macOS, so its conclusions are frozen as literals
in `encode.test.ts`; the round-trip reader in the same file re-derives the payload from the
finished matrix on every run.
