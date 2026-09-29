/** Typed codes for tolerated or reconstructed PDF damage, from header and cross-reference repairs to stream and page problems under ISO 32000-1:2008, 7.5. */
export type LoadWarningCode =
  | 'junk-before-header'
  | 'startxref-corrected'
  | 'trailing-data-after-eof'
  | 'missing-eof'
  | 'xref-entry-length'
  | 'trailer-size-too-small'
  | 'prev-cycle'
  | 'xref-reconstructed'
  | 'xref-stream-trailing-data'
  | 'xref-stream-index-order'
  | 'stream-length-recovered'
  | 'stream-keyword-cr'
  | 'stream-keyword-eol'
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
  | 'recovery-ambiguous-object'
  | 'recovery-unreadable-object';

/** A nonfatal load finding with optional byte offset and object number; parsing continues when the damaged construct can be handled under ISO 32000-1:2008, 7.5. */
export interface LoadWarning {
  readonly code: LoadWarningCode;
  readonly detail: string;
  readonly offset?: number;
  readonly objectNumber?: number;
}
