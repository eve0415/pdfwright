import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { ParseError } from '../error/parseError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { decodeStream } from '../filter/decodeStream.ts';

export type PdfStream = Extract<PdfObject, { kind: 'stream' }>;

/** What font reading needs from a document: its objects and its limits. */
export type FontSource = Pick<DocumentInternals, 'objects' | 'maxDecodedBytes' | 'maxNesting'>;

export const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

export const dictionaryOf = (value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') return value.entries;
  return value?.kind === 'stream' ? value.dictionary : undefined;
};

export const nameOf = (value: PdfObject | undefined): string | undefined => (value?.kind === 'name' ? latin1(value.bytes) : undefined);

/** An integer or real value as a number; a real a created document holds as an exact rational is divided out. */
export const numberOf = (value: PdfObject | undefined): number | undefined => {
  if (value?.kind === 'integer') return value.value;
  if (value?.kind !== 'real') return undefined;
  return typeof value.value === 'number' ? value.value : Number(value.value.numerator) / Number(value.value.denominator);
};

/** The numbers of an array, resolving references to its items, or undefined when it is not an array of numbers. */
export const numbersOf = (source: FontSource, value: PdfDirectObject | undefined): number[] | undefined => {
  const array = source.objects.deref(value);
  if (array?.kind !== 'array') return undefined;
  const numbers: number[] = [];
  for (const item of array.items) {
    const number = numberOf(source.objects.deref(item));
    if (number === undefined) return undefined;
    numbers.push(number);
  }
  return numbers;
};

// ISO 32000-1:2008, 9.6.4: the name of a font subset "shall begin with a tag followed by a plus sign (+). The tag shall consist of exactly six uppercase letters".
export const withoutSubsetTag = (name: string): string => (/^[A-Z]{6}\+/u.test(name) ? name.slice(7) : name);

/** A stream's decoded data, or the reason it cannot be decoded; decoded data past `maxDecodedBytes` throws ResourceLimitError. */
export const decodedData = (source: FontSource, stream: PdfStream): Uint8Array | string => {
  try {
    return decodeStream(stream, {
      maxDecodedBytes: source.maxDecodedBytes,
      warn: (): void => {
        // Flate trailer warnings leave the decoded data usable; the reader of the data reports what it lacks.
      },
      deref: value => source.objects.deref(value),
    });
  } catch (error) {
    if (error instanceof ParseError || error instanceof UnsupportedFeatureError) return error.message;
    throw error;
  }
};
