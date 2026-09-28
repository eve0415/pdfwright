import { PdfwrightError } from './pdfwrightError.ts';

export type UnsupportedFeatureReason = 'icc-version-5' | 'icc-mpet' | 'compressed-rgb-image' | 'jpx-color-space';

export class UnsupportedFeatureError extends PdfwrightError {
  override readonly code = 'unsupported-feature' as const;
  readonly reason: UnsupportedFeatureReason | undefined;

  constructor(message: string, reason?: UnsupportedFeatureReason) {
    super(message, 'unsupported-feature');
    this.name = 'UnsupportedFeatureError';
    this.reason = reason;
  }
}
