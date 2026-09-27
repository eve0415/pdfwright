export type SaveWarningCode = 'duplicate-key-resolved' | 'linearization-invalidated' | 'linearization-removed' | 'version-raised' | 'junk-dropped';

export interface SaveWarning {
  readonly code: SaveWarningCode;
  readonly detail: string;
  readonly objectNumber?: number;
}
