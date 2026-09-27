import type { BoxName } from '../document/loadedPage.ts';

/** Where in a value a difference lies: dictionary keys as latin1 names, array indices as numbers. */
export type ValuePath = readonly (string | number)[];

/** A short description of one side of a difference. */
export interface ValueSummary {
  readonly kind: string;
  readonly text: string;
}

export interface BoxValue {
  readonly value: readonly number[] | number;
  /** For boxes: whether the page or an ancestor sets it rather than a default applying. */
  readonly explicit: boolean;
}

export type PieceOwner =
  | { readonly kind: 'page'; readonly page: number }
  | { readonly kind: 'catalog' }
  | { readonly kind: 'form'; readonly page: number; readonly path: ValuePath };

/** Identity of a font: its subtype, base font, encoding and a digest of its embedded program. */
export interface FontIdentity {
  readonly subtype: string;
  readonly baseFont: string;
  readonly encoding: string;
  readonly program: string;
}

export type PdfDifference =
  | { readonly kind: 'page-count'; readonly a: number; readonly b: number }
  | { readonly kind: 'page-box'; readonly page: number; readonly box: BoxName | 'Rotate' | 'UserUnit'; readonly a: BoxValue; readonly b: BoxValue }
  | {
      readonly kind: 'page-content';
      readonly page: number;
      readonly operationsA: number;
      readonly operationsB: number;
      readonly commonPrefix: number;
      readonly commonSuffix: number;
    }
  | { readonly kind: 'page-resources'; readonly page: number; readonly path: ValuePath; readonly a: ValueSummary; readonly b: ValueSummary }
  | { readonly kind: 'font-set'; readonly page: number | 'document'; readonly added: readonly FontIdentity[]; readonly removed: readonly FontIdentity[] }
  | {
      readonly kind: 'piece-info';
      readonly owner: PieceOwner;
      readonly path: ValuePath;
      readonly aspect: 'value' | 'stream-bytes' | 'source-bytes';
      readonly a: ValueSummary;
      readonly b: ValueSummary;
    }
  | {
      readonly kind: 'last-modified';
      readonly owner: PieceOwner;
      readonly path: ValuePath;
      readonly a: Uint8Array | undefined;
      readonly b: Uint8Array | undefined;
    }
  | { readonly kind: 'page-attribute'; readonly page: number; readonly path: ValuePath; readonly a: ValueSummary; readonly b: ValueSummary }
  | { readonly kind: 'document-attribute'; readonly path: ValuePath; readonly a: ValueSummary; readonly b: ValueSummary }
  | { readonly kind: 'ambiguous-duplicate-key'; readonly where: ValuePath; readonly key: Uint8Array; readonly document: 'a' | 'b' }
  | { readonly kind: 'undecodable'; readonly where: ValuePath; readonly document: 'a' | 'b'; readonly reason: string };

export type DifferenceArea = 'pages' | 'boxes' | 'content' | 'resources' | 'fonts' | 'pieceInfo' | 'lastModified' | 'pageAttributes' | 'documentAttributes';

export interface CompareOptions {
  /** The areas to compare; all by default. */
  readonly include?: readonly DifferenceArea[];
}

export interface DocumentComparison {
  readonly equal: boolean;
  readonly differences: readonly PdfDifference[];
}
