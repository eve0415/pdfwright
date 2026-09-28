import type { Bounds } from '../geometry/bounds.ts';
import type { DocumentColors } from '../native/writeHeader.ts';
import type { IllustratorDocument } from './illustratorDocument.ts';

import { artBounds } from '../geometry/bounds.ts';
import { documentColors } from '../native/writeHeader.ts';

import { validateDocument } from './validateDocument.ts';

export interface PreparedDocument {
  readonly bounds: Bounds;
  readonly colors: DocumentColors;
}

export const prepareDocument = (document: IllustratorDocument): PreparedDocument => {
  validateDocument(document);
  return { bounds: artBounds(document), colors: documentColors(document) };
};
