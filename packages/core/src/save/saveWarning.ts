/** Typed codes for duplicate keys, linearization removal, version changes, and discarded recovered data while saving under ISO 32000-1:2008, 7.5. */
export type SaveWarningCode =
  | 'duplicate-key-resolved'
  | 'linearization-invalidated'
  | 'linearization-removed'
  | 'version-raised'
  | 'version-lowered'
  | 'recovery-object-dropped'
  | 'junk-dropped';

/** A nonfatal save finding with an optional object number; it explains a structural change in the written PDF under ISO 32000-1:2008, 7.5. */
export interface SaveWarning {
  readonly code: SaveWarningCode;
  readonly detail: string;
  readonly objectNumber?: number;
}
