import type { PdfDirectObject, PdfObject } from './pdfObject.ts';

import { parsedDictionaryEntries } from './pdfDictionaryEntries.ts';

/** A copy of a direct object that shares nothing with it. */
export const cloneDirect = (value: PdfDirectObject): PdfDirectObject => {
  if (value.kind === 'array') return { kind: 'array', items: value.items.map(item => cloneDirect(item)) };
  if (value.kind === 'dictionary') {
    return { kind: 'dictionary', entries: parsedDictionaryEntries([...value.entries.entries()].map(([key, item]) => [key, cloneDirect(item)] as const)) };
  }
  if (value.kind === 'name' || value.kind === 'string' || value.kind === 'invalid') return { ...value, bytes: Uint8Array.from(value.bytes) };
  return { ...value };
};

/** Like cloneDirect; a stream's dictionary is copied and its data, often a view of the input file, is shared. */
export const cloneObject = (value: PdfObject): PdfObject => {
  if (value.kind !== 'stream') return cloneDirect(value);
  return {
    kind: 'stream',
    dictionary: parsedDictionaryEntries([...value.dictionary.entries()].map(([key, item]) => [key, cloneDirect(item)] as const)),
    data: value.data,
  };
};
