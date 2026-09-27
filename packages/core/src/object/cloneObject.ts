import type { PdfDirectObject, PdfObject } from './pdfObject.ts';

import { parsedDictionaryEntries } from './pdfDictionaryEntries.ts';

/** A copy of a direct object that shares no array or dictionary with it; name, string and invalid bytes are shared, since nothing changes them in place. */
export const cloneDirect = (value: PdfDirectObject): PdfDirectObject => {
  if (value.kind === 'array') return { kind: 'array', items: value.items.map(item => cloneDirect(item)) };
  if (value.kind === 'dictionary') {
    return { kind: 'dictionary', entries: parsedDictionaryEntries([...value.entries.entries()].map(([key, item]) => [key, cloneDirect(item)] as const)) };
  }
  return value;
};

/** Like cloneDirect; a stream's dictionary is copied and its data is shared. */
export const cloneObject = (value: PdfObject): PdfObject => {
  if (value.kind !== 'stream') return cloneDirect(value);
  return {
    kind: 'stream',
    dictionary: parsedDictionaryEntries([...value.dictionary.entries()].map(([key, item]) => [key, cloneDirect(item)] as const)),
    data: value.data,
  };
};
