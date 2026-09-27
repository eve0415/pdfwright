export type LoadWarningCode =
  | 'junk-before-header'
  | 'startxref-corrected'
  | 'xref-entry-length'
  | 'trailer-size-too-small'
  | 'prev-cycle'
  | 'xref-reconstructed'
  | 'xref-stream-trailing-data'
  | 'xref-stream-index-order'
  | 'stream-length-recovered'
  | 'stream-keyword-cr'
  | 'missing-endobj'
  | 'duplicate-key'
  | 'malformed-name-escape'
  | 'name-contains-null'
  | 'name-too-long'
  | 'invalid-token'
  | 'objstm-offsets-unsorted'
  | 'objstm-extends-cycle'
  | 'flate-trailing-data'
  | 'flate-truncated-trailer'
  | 'flate-checksum-mismatch'
  | 'dangling-reference'
  | 'generation-mismatch'
  | 'page-count-mismatch'
  | 'resources-missing'
  | 'unknown-xref-entry-type'
  | 'xref-entry-offset-zero'
  | 'mixed-xref-chain'
  | 'recovery-ambiguous-object';

export interface LoadWarning {
  readonly code: LoadWarningCode;
  readonly detail: string;
  readonly offset?: number;
  readonly objectNumber?: number;
}
