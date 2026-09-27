export type MetadataFindingCode =
  | 'info-xmp-mismatch'
  | 'info-xmp-indeterminate'
  | 'xmp-missing'
  | 'info-missing'
  | 'info-not-indirect'
  | 'legacy-property-mismatch'
  | 'duplicate-property'
  | 'orphan-metadata'
  | 'superseded-packets'
  | 'metadata-not-stream'
  | 'metadata-dictionary'
  | 'metadata-filtered'
  | 'xmp-unreadable'
  | 'xmp-doctype'
  | 'xmp-not-utf8'
  | 'rdf-about-unprefixed'
  | 'rdf-about-mismatch'
  | 'trapped-not-name'
  | 'info-not-text-string'
  | 'info-empty-string'
  | 'xmp-empty-value'
  | 'info-text-undecodable'
  | 'date-unparseable'
  | 'date-zone-unknown'
  | 'modification-after-metadata'
  | 'xmp-transcoded'
  | 'opaque-property-kept'
  | 'info-value-kept';

/** Something about the document's metadata that a reader or a preflight may need to know. */
export interface MetadataFinding {
  readonly code: MetadataFindingCode;
  readonly detail: string;
}
