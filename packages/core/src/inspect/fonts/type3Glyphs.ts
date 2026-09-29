import type { ContentOperand, ContentOperation } from '../../content/contentOperations.ts';
import type { DocumentInternals } from '../../document/documentInternals.ts';
import type { Type3Parts } from '../../font/fontModel.ts';
import type { PdfDictionaryEntries } from '../../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../../object/pdfObject.ts';

import { readContent } from '../../content/contentOperations.ts';
import { unreadable } from '../../content/unreadable.ts';
import { decodedData, dictionaryOf, latin1 } from '../../font/fontValues.ts';
import { pdfName } from '../../object/pdfObject.ts';

const XOBJECT = pdfName('XObject').bytes;
const SUBTYPE = pdfName('Subtype').bytes;

/** What a Type 3 font's glyph procedures paint: only vector shapes, only images, both, or `unreadable` when a procedure cannot be read. */
export type Type3Glyphs = 'vector' | 'image' | 'mixed' | 'unreadable';

/** Classifies Type 3 glyph procedures by vector or image painting, counts procedures and d0 coloured glyphs under ISO 32000-1:2008, 9.6.5. */
export interface Type3Summary {
  readonly glyphs: Type3Glyphs;
  /** The entries of CharProcs. */
  readonly procedures: number;
  /** The procedures that begin with d0 and so set their own colours (ISO 32000-1:2008, 9.6.5). */
  readonly coloured: number;
}

/** A Type 3 font's glyph classification, and whether its procedures name resources at all. */
export interface Type3Reading extends Type3Summary {
  readonly namesResources: boolean;
  /** Whether the font has no resource dictionary, so that its names are looked up in the page's. */
  readonly inheritsPageResources: boolean;
}

// 8.6.5.1, 8.6.6.1 and 8.9.7, Table 94: colour space operands that are not resource names.
const SPACE_FAMILIES = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern', 'G', 'RGB', 'CMYK', 'I', 'Indexed']);

// 7.8.3: the operators whose name operands are looked up in a resource dictionary: Tf (Font), Do (XObject), gs (ExtGState), sh (Shading), CS and cs (ColorSpace), SCN and scn (Pattern), BDC and DP (Properties), and an inline image's ColorSpace.
const isName = (operand: ContentOperand | undefined): boolean => operand?.kind === 'name';

const namesResource = ({ operator, operands, inlineImage }: ContentOperation): boolean => {
  const [first, second] = operands;
  if (operator === 'Tf' || operator === 'Do' || operator === 'gs' || operator === 'sh') return true;
  if (operator === 'CS' || operator === 'cs') return first?.kind === 'name' && !SPACE_FAMILIES.has(latin1(first.bytes));
  if (operator === 'SCN' || operator === 'scn') return isName(operands.at(-1));
  if (operator === 'BDC' || operator === 'DP') return isName(second);
  const parameters = inlineImage?.parameters ?? [];
  return parameters.some((key, index) => {
    const value = parameters[index + 1];
    return key.kind === 'name' && ['CS', 'ColorSpace'].includes(latin1(key.bytes)) && value?.kind === 'name' && !SPACE_FAMILIES.has(latin1(value.bytes));
  });
};

interface Procedure {
  readonly kind: 'vector' | 'image' | 'unreadable';
  readonly coloured: boolean;
  readonly namesResources: boolean;
}

const UNREADABLE: Procedure = { kind: 'unreadable', coloured: false, namesResources: false };

// 8.9.5 and 8.9.7: an image XObject drawn by Do, or an inline image, paints an image.
const paintsImage = (document: DocumentInternals, operation: ContentOperation, resources: PdfDictionaryEntries | undefined): boolean => {
  if (operation.operator === 'BI') return true;
  const [name] = operation.operands;
  if (operation.operator !== 'Do' || name?.kind !== 'name') return false;
  const xObjects = dictionaryOf(document.objects.deref(resources?.get(XOBJECT)));
  const xObject = document.objects.deref(xObjects?.get(name.bytes));
  const subtype = xObject?.kind === 'stream' ? document.objects.deref(xObject.dictionary.get(SUBTYPE)) : undefined;
  return subtype?.kind === 'name' && latin1(subtype.bytes) === 'Image';
};

const readProcedure = (document: DocumentInternals, value: PdfDirectObject, resources: PdfDictionaryEntries | undefined): Procedure => {
  const stream = document.objects.deref(value);
  if (stream?.kind !== 'stream') return UNREADABLE;
  const data = decodedData(document, stream);
  if (typeof data === 'string') return UNREADABLE;
  let image = false;
  let coloured = false;
  let names = false;
  let first = true;
  for (const operation of readContent(data, document.maxNesting)) {
    // 9.6.5: a glyph description begins with d0, which sets its own colours, or d1.
    if (first) coloured = operation.operator === 'd0';
    first = false;
    image ||= paintsImage(document, operation, resources);
    names ||= namesResource(operation);
  }
  return { kind: image ? 'image' : 'vector', coloured, namesResources: names };
};

/**
 * Reads each glyph procedure of a Type 3 font (ISO 32000-1:2008, 9.6.5): a procedure that draws an image XObject or an inline image paints an image, any other paints vector shapes.
 * Names are looked up in the font's Resources, or in `pageResources` when the font has none, as Table 112 says: "the names shall be looked up in the resource dictionary of the page on which the font is used".
 */
export const readType3Glyphs = (document: DocumentInternals, type3: Type3Parts, pageResources: PdfDictionaryEntries | undefined): Type3Reading => {
  let own: PdfObject | undefined = undefined;
  try {
    own = document.objects.deref(type3.resources);
  } catch (error: unknown) {
    // A Resources entry that cannot be read is no resource dictionary; content interpretation then takes the page's, and so does this reading.
    if (!unreadable(error)) throw error;
  }
  // 7.3.7: a null value is an absent entry; a value that is not a dictionary gives no resources either, and content interpretation takes the page's.
  const inheritsPageResources = dictionaryOf(own) === undefined;
  const resources = inheritsPageResources ? pageResources : dictionaryOf(own);
  const kinds = new Set<Procedure['kind']>();
  let procedures = 0;
  let coloured = 0;
  let namesResources = false;
  for (const [, value] of type3.charProcs?.entries() ?? []) {
    procedures++;
    let procedure = UNREADABLE;
    try {
      procedure = readProcedure(document, value, resources);
    } catch (error: unknown) {
      if (!unreadable(error)) throw error;
    }
    kinds.add(procedure.kind);
    if (procedure.coloured) coloured++;
    namesResources ||= procedure.namesResources;
  }
  let glyphs: Type3Glyphs = 'vector';
  if (kinds.has('unreadable')) glyphs = 'unreadable';
  else if (kinds.has('image')) glyphs = kinds.has('vector') ? 'mixed' : 'image';
  return { glyphs, procedures, coloured, namesResources, inheritsPageResources };
};
