# @crewhaus/tool-media

Deterministic media tools. Image headers, PNG encoding and decoding,
screenshot comparison, EXIF, QR codes and barcodes, charts, sparklines and
diagrams, subtitles, and a probe for audio and video — without a model call
and without an image library.

Every format reader and writer here is hand-written against its published
specification, and each one states the exact subset it supports. Where
something cannot be done faithfully — rasterising a chart label with no
font, decoding a 16-bit PNG into 8-bit samples, laying out a dense graph —
the tool says so rather than producing something that looks right and is
not.

```yaml
tools:
  - all-media       # every tool below
  - -MediaProbe     # ...except the one that shells out
```

| Tool | What it does |
|---|---|
| `BarcodeEncode` | Code 128 or EAN-13 to a PNG or a module pattern, check digit computed |
| `ChartRender` | Bar, line, scatter or pie data to an SVG chart with axes, ticks and a legend |
| `ColorContrast` | The WCAG contrast ratio for colour pairs, and the levels each one clears |
| `ColorConvert` | Hex, RGB and HSL in every direction, plus relative luminance |
| `DiagramRender` | A node and edge list to a box-and-arrow SVG with a layered layout |
| `ExifRead` | A JPEG's capture time, camera, lens, exposure, orientation — and GPS |
| `ExifStrip` | A copy of a JPEG without its metadata, the picture untouched |
| `ImageCrop` | A rectangle out of a PNG, written as a PNG |
| `ImageDiff` | Two PNGs compared pixel by pixel and by perceptual hash |
| `ImageInfo` | Dimensions, bit depth, colour model and alpha, from the header alone |
| `ImageKind` | What a file actually is, and whether its extension agrees |
| `ImageResize` | A PNG at a new size, with the resampling method stated |
| `MediaProbe` | `ffprobe`'s view of an audio or video file, structured |
| `PngRead` | A PNG decoded to RGBA pixels, or to per-channel statistics |
| `PngWrite` | Raw RGBA pixels encoded as a valid PNG |
| `QrEncode` | A QR code as a PNG or a text matrix, error correction chosen |
| `SparklineRender` | A series as a one-line SVG or a run of Unicode blocks |
| `SubtitleParse` | SRT or WebVTT to cues with millisecond times |
| `SubtitleWrite` | Cues back out, shifted and re-wrapped, in either format |

## Determinism

The same inputs against the same files produce the same bytes, on any
machine. Nothing reads the clock — a subtitle shift is an argument, never
"now minus something". Nothing uses unseeded randomness. Listings are
sorted. Numbers are formatted without a locale, so an axis label does not
change when `LANG` does. Chart and diagram layout is arithmetic on the data
plus fixed constants: no measurement, no iteration to convergence. A QR
code's mask is chosen by the standard's penalty rules, which are a pure
function of the payload, so the same text always produces the same symbol.

Two deliberate consequences. Label widths are **estimated** from a fixed
per-character advance rather than measured, because measuring would make
the output depend on which fonts a machine has. And PNG compression runs at
a pinned level through `node:zlib`, so two renders of the same chart
compare equal byte for byte.

The one exception is `MediaProbe`, which is only as deterministic as the
`ffprobe` on the machine. Its result says so.

## Containment

Every caller-supplied path goes through the same `resolveSafe` that
`@crewhaus/tool-fs` uses: a lexical check for `..` and absolute escapes,
then a symlink-aware check, so a link living inside the workspace and
pointing at `/etc` is refused rather than followed. The workspace root is
`process.cwd()`.

Every read is size-checked before it happens. A header reader reads the
first megabyte of a file, never the whole of a four-gigabyte video. A PNG's
dimensions are checked against the pixel cap on `IHDR`, before anything is
inflated, and the inflate itself is given `maxOutputLength`, so a lying
stream aborts mid-decompression rather than after the fact.

`MediaProbe` is the only tool that leaves the process. It declares
`scope: "external"` and `ioCapability: "process"`, passes its argument as
an argv array with a `--` terminator (never a shell string), bounds the run
with a deadline it cannot outlive, and reads `ffprobe`'s pipes with a byte
cap and a drain deadline — so a probe that hangs costs a second, not a
turn. Only an allowlist of `ffprobe`'s fields is carried through; the
absolute path it echoes back is not one of them.

## What these will not do

**They will not rasterise text.** Drawing a label into a bitmap needs a
font, and this package ships none — inventing glyphs would be worse than
declining. So `ChartRender`, `DiagramRender` and `SparklineRender` emit
SVG, which is text and renders wherever there are fonts, and `QrEncode` and
`BarcodeEncode` emit PNG, because a code is pure geometry.

**They will not decode JPEG, GIF, WebP or BMP.** `ImageInfo` reads those
formats' headers, which is where the dimensions and the colour model live.
Pixels are PNG only, which is what `PngRead`, `ImageDiff`, `ImageResize`
and `ImageCrop` say when handed anything else — by name, so a caller knows
what the file actually turned out to be.

**They will not lay out an arbitrary graph.** `DiagramRender` assigns each
node a layer one past its deepest predecessor and draws layers in order. A
dense graph will have crossing edges, and this will not untangle them. A
cycle is broken at one named edge, which is still drawn — dashed — and is
reported in `backEdges`.

**They will not re-encode a photograph.** `ExifStrip` rewrites the segment
list and copies the entropy-coded scan data verbatim, so the picture is
bit-for-bit what it was. It keeps the ICC colour profile by default,
because a profile is not metadata about the photographer: it is what tells
a display how to interpret the colours, and dropping it visibly shifts the
image.

**They will not guess.** A 16-bit or interlaced PNG is refused by name
rather than truncated or de-interlaced badly. A payload past a QR code's
capacity is refused with the capacity. An EAN-13 whose thirteenth digit
does not check is refused with the digit it should have been, not silently
corrected. A colour notation this package does not read is named back.

## Formats and their limits

**PNG.** Writes 8-bit colour types 0, 2, 4 and 6, with `auto` choosing the
smallest one that is lossless for the exact pixels given. Reads those plus
palette (type 3) with `tRNS`, and multiple `IDAT` chunks. Refuses bit
depths other than 8, and Adam7 interlacing.

**QR.** Byte mode, UTF-8, versions 1 to 10 (21×21 to 57×57 modules — 271
bytes at level L), all four error-correction levels, all eight masks with
the standard's penalty scoring. No Structured Append, Micro QR, Kanji mode
or FNC1/GS1 indicators; each of those changes what a scanner does with the
result, so none is approximated.

**Code 128.** One code set for the whole symbol: C when the payload is an
even number of digits at least four long, otherwise B. Code set A is never
emitted, so the range is ASCII 32 to 126, and anything outside it is
refused by character. Switching sets mid-symbol would make a mixed payload
narrower and nothing else.

**EAN-13.** Twelve digits in, the thirteenth computed; thirteen in, the
thirteenth verified. UPC-A is EAN-13 with a leading zero, so that works
too. No EAN-8, and no 2- or 5-digit add-ons. Bars only — the
human-readable digits underneath would need a font.

**EXIF.** IFD0, the Exif sub-IFD and the GPS sub-IFD of an `APP1` segment,
both byte orders. Not MakerNotes, IFD1 thumbnails, XMP, IPTC, or EXIF in a
TIFF or HEIC.

**Subtitles.** SRT and WebVTT, through a BOM and either line ending, with
cue ids and cue settings preserved. Not WebVTT chapter or metadata tracks.
Inline markup is left in the cue text verbatim — this neither parses it nor
strips it.

## A note on `ExifRead`

A photograph taken on a phone usually records where it was taken.
`ExifRead` reports that as `hasGps: true` with a `privacyWarning`, rather
than burying the coordinates in a field list, because publishing the file
publishes the location. `ExifStrip` is the tool that removes it.
