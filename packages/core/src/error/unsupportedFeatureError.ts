import { PdfwrightError } from './pdfwrightError.ts';

/** Typed reasons for unsupported ICC, compressed image, JPEG process, PNG chunk, and DeviceN or NChannel behaviour; `jpeg-*` reasons follow ITU-T T.81:1992, Annex B process markers, and `png-critical-chunk` is an unknown critical chunk under PNG Third Edition, 5.4. */
export type UnsupportedFeatureReason =
  | 'png-critical-chunk'
  | 'icc-version-5'
  | 'icc-mpet'
  | 'compressed-rgb-image'
  | 'luminosity-compressed-rgb-image'
  | 'jpx-color-space'
  | 'jpeg-progressive'
  | 'jpeg-arithmetic'
  | 'jpeg-lossless'
  | 'jpeg-12-bit'
  | 'jpeg-cmyk'
  | 'jpeg-multi-scan'
  | 'jpeg-sampling'
  | 'jpeg-color-transform'
  | 'jpeg-process'
  | 'device-n-components'
  | 'nchannel-process';

/** An input uses a feature the requested operation cannot process. */
export class UnsupportedFeatureError extends PdfwrightError {
  override readonly code = 'unsupported-feature' as const;
  readonly reason: UnsupportedFeatureReason | undefined;

  constructor(message: string, reason?: UnsupportedFeatureReason) {
    super(message, 'unsupported-feature');
    this.name = 'UnsupportedFeatureError';
    this.reason = reason;
  }
}
