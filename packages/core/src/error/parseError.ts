import { PdfwrightError } from './pdfwrightError.ts';

/** Why an image file could not be parsed, for the image decoders' refusals callers are expected to handle by reason. */
export type ParseReason = 'image-truncated' | 'image-invalid' | 'image-crc-mismatch' | 'image-checksum-mismatch';

/** PDF, image or compressed data could not be parsed at the reported offset. */
export class ParseError extends PdfwrightError {
  override readonly code = 'parse' as const;
  readonly offset: number;
  readonly reason: ParseReason | undefined;

  constructor(message: string, offset: number, reason?: ParseReason) {
    super(message, 'parse');
    this.name = 'ParseError';
    this.offset = offset;
    this.reason = reason;
  }
}
