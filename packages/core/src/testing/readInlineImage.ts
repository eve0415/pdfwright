// Reads the first inline image of a content stream the way a viewer would, so that tests check what conversion writes rather than how it builds it.

import { readContent } from '../content/contentOperations.ts';
import { decodeStream } from '../filter/decodeStream.ts';
import { PdfDictionaryEntries, pdfName } from '../object/pdfObject.ts';

import { latin1Text } from './pdfBuilder.ts';

export interface ReadInlineImage {
  /** The operators of the whole content stream, in order. */
  readonly operators: ReadonlyArray<string>;
  /** The codes of the warnings the image's own filters raise. */
  readonly warnings: ReadonlyArray<string>;
  /** The samples the image's own filters decode its data to. */
  readonly samples: Uint8Array;
}

/** Reads the content stream and decodes its first inline image through the F and DP entries it declares. */
export const readInlineImage = (content: Uint8Array): ReadInlineImage => {
  const operations = [...readContent(content, 32)];
  const image = operations[0]?.inlineImage;
  if (image === undefined) {
    throw new Error('inline image is missing');
  }
  const dictionary = new PdfDictionaryEntries();
  for (let index = 0; index + 1 < image.parameters.length; index += 2) {
    const key = image.parameters[index];
    const value = image.parameters[index + 1];
    if (key?.kind === 'name' && value !== undefined && value.kind !== 'stray-delimiter') {
      const name = latin1Text(key.bytes);
      if (name === 'F' || name === 'DP') {
        dictionary.set(pdfName(name === 'F' ? 'Filter' : 'DecodeParms').bytes, value);
      }
    }
  }
  const warnings: Array<string> = [];
  const samples = decodeStream({ kind: 'stream', dictionary, data: image.data }, { maxDecodedBytes: 1_048_576, warn: warning => warnings.push(warning.code) });
  return { operators: operations.map(operation => operation.operator), warnings, samples };
};
