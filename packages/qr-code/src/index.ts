/**
 * `@crewhaus/qr-code` — a dependency-free QR Code encoder and terminal
 * renderer.
 *
 * Exists because `crewhaus hangar --lan` prints a symbol an operator scans
 * with their phone, and the CLI carries exactly one non-workspace dependency
 * by policy. Byte mode only; see `encode.ts` for why that is enough.
 */
export { encodeQr, formatInfoBits, maskPenalty, maskPredicate, versionInfoBits } from "./encode";
export type { EcLevel, EncodeOptions, QrCode } from "./encode";
export { renderQrLines, renderedWidth } from "./render";
export type { RenderOptions } from "./render";
export {
  MAX_VERSION,
  MIN_VERSION,
  alignmentCentres,
  dataCodewords,
  totalCodewords,
  versionSize,
} from "./tables";
