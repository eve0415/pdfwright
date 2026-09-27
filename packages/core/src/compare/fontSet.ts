import type { PageEntry } from '../document/pageTree.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { UnreadableObject } from '../resourceGraph/walkResources.ts';
import type { DocumentFonts } from './documentFonts.ts';
import type { FontIdentity } from './pdfDifference.ts';

import { walkResources } from '../resourceGraph/walkResources.ts';

/** What a font walk found: fonts by identity, and why objects on the way could not be read. */
export interface FontSet {
  readonly fonts: Map<string, FontIdentity>;
  /** Objects that could not be parsed, by the page entry the walk started from. */
  readonly unreadable: readonly UnreadableObject[];
}

/** The fonts a page uses, through its resources and its annotations' appearances. */
export const fontSet = (fonts: DocumentFonts, page: PageEntry, resources: PdfDirectObject | undefined): FontSet => {
  const found = new Map<string, FontIdentity>();
  const unreadable = walkResources(fonts.document, page, {
    resources,
    font: ({ dictionary, value }) => {
      const identity = fonts.identity(dictionary, value);
      found.set(JSON.stringify(identity), identity);
    },
  });
  return { fonts: found, unreadable };
};
