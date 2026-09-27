import { PdfwrightError } from './pdfwrightError.ts';

export type InvalidProfileReason =
  | 'truncated'
  | 'bad-signature'
  | 'size-mismatch'
  | 'unsupported-version'
  | 'unknown-class'
  | 'unknown-color-space'
  | 'tag-table-out-of-bounds'
  | 'tag-out-of-bounds'
  | 'tag-overlap'
  | 'duplicate-tag'
  | 'tag-type-mismatch'
  | 'bad-tag-data'
  | 'channel-mismatch'
  | 'missing-required-tag'
  | 'singular-matrix';

export class InvalidProfileError extends PdfwrightError {
  override readonly code = 'invalid-profile' as const;
  readonly reason: InvalidProfileReason;
  readonly offset: number;
  readonly tag: string | undefined;

  constructor(message: string, reason: InvalidProfileReason, location: { offset: number; tag?: string }) {
    super(message, 'invalid-profile');
    this.name = 'InvalidProfileError';
    this.reason = reason;
    this.offset = location.offset;
    this.tag = location.tag;
  }
}
