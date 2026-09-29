import type { MarkedContent } from '../../content/interpreter.ts';
import type { DocumentInternals } from '../../document/documentInternals.ts';

import { unreadable } from '../../content/unreadable.ts';
import { pdfDocEncodingUnicode } from '../../font/encoding/simpleEncodings.ts';
import { latin1 } from '../../font/fontValues.ts';
import { pdfName } from '../../object/pdfObject.ts';

const ACTUAL_TEXT = pdfName('ActualText').bytes;
const LANG = pdfName('Lang').bytes;

/** A marked-content sequence whose ActualText replaces the text of the glyphs shown inside it (ISO 32000-1:2008, 14.9.4). */
export interface ActualTextSpan {
  /** The replacement text, with language escapes removed (ISO 32000-1:2008, 7.9.2.2). */
  readonly text: string;
  /** The language of the first language escape in the text, as `ja` or `ja-JP`, else the property list's Lang entry; undefined when neither gives one. */
  readonly language: string | undefined;
  /** The indexes of the glyphs shown inside the span, in content order. A span inside which no glyph is shown is not listed. */
  readonly glyphs: readonly number[];
}

/** A decoded text string and the language its first language escape names. */
export interface DecodedText {
  readonly text: string;
  readonly language: string | undefined;
}

const REPLACEMENT = '�';
const ESCAPE = 0x1b;

// The ASCII bytes of a language escape's codes: a 2-byte ISO 639 language code and an optional 2-byte ISO 3166 country code.
const languageOf = (codes: Uint8Array): string | undefined => {
  const text = latin1(codes);
  if (!/^[A-Za-z]{2}(?:[A-Za-z]{2})?$/u.test(text)) return undefined;
  return text.length === 4 ? `${text.slice(0, 2)}-${text.slice(2)}` : text;
};

// 7.9.2.2: in a Unicode text string, "An escape sequence may appear anywhere … to indicate the language in which subsequent text shall be written": U+001B, "A 2- byte ISO 639 language code", "(Optional) A 2-byte ISO 3166 country code" and U+001B, the codes "encoded as ASCII characters".
const decodeUtf16 = (bytes: Uint8Array): DecodedText => {
  const decoder = new TextDecoder('utf-16be');
  const parts: string[] = [];
  let language: string | undefined = undefined;
  let start = 2;
  for (let offset = 2; offset + 1 < bytes.length; offset += 2) {
    if (bytes[offset] !== 0 || bytes[offset + 1] !== ESCAPE) continue;
    const end = [6, 8].map(length => offset + length).find(close => bytes[close - 2] === 0 && bytes[close - 1] === ESCAPE);
    if (end === undefined) continue;
    parts.push(decoder.decode(bytes.subarray(start, offset)));
    language ??= languageOf(bytes.subarray(offset + 2, end - 2));
    start = end;
    offset = end - 2;
  }
  parts.push(decoder.decode(bytes.subarray(start, bytes.length - ((bytes.length - start) % 2))));
  return { text: parts.join(''), language };
};

/**
 * Decodes a text string (ISO 32000-1:2008, 7.9.2.2): "For text strings encoded in Unicode, the first two bytes shall be 254 followed by 255", and the rest is UTF-16BE; any other string is PDFDocEncoding (Annex D), whose undefined codes become U+FFFD.
 */
export const decodeTextString = (bytes: Uint8Array): DecodedText => {
  if (bytes[0] === 254 && bytes[1] === 255) return decodeUtf16(bytes);
  const text = [...bytes].map(code => {
    const unicode = pdfDocEncodingUnicode(code);
    return unicode === undefined ? REPLACEMENT : String.fromCodePoint(unicode);
  });
  return { text: text.join(''), language: undefined };
};

/**
 * Collects the ActualText spans glyphs are shown in. 14.9.4: replacement text may be given for "A marked-content sequence …, through an ActualText entry in a property list attached to the marked-content sequence with a Span tag", and "The ActualText value shall be used as a replacement, not a description, for the content".
 * A glyph inside nested spans belongs to each of them; the outermost is the one whose text replaces it.
 */
export class ActualTextSpans {
  readonly spans: { text: string; language: string | undefined; glyphs: number[] }[] = [];
  private readonly document: DocumentInternals;
  // The span index of each marked-content sequence by its id, or null for a sequence that is not an ActualText span.
  private readonly sequences = new Map<number, number | null>();

  constructor(document: DocumentInternals) {
    this.document = document;
  }

  private text(value: MarkedContent['properties'], key: Uint8Array): DecodedText | undefined {
    try {
      const resolved = this.document.objects.deref(value?.get(key));
      return resolved?.kind === 'string' ? decodeTextString(resolved.bytes) : undefined;
    } catch (error: unknown) {
      if (!unreadable(error)) throw error;
      return undefined;
    }
  }

  private spanOf(sequence: MarkedContent): number | null {
    const known = this.sequences.get(sequence.id);
    if (known !== undefined) return known;
    const actual = latin1(sequence.tag) === 'Span' ? this.text(sequence.properties, ACTUAL_TEXT) : undefined;
    let index: number | null = null;
    if (actual !== undefined) {
      index = this.spans.length;
      this.spans.push({ text: actual.text, language: actual.language ?? this.text(sequence.properties, LANG)?.text, glyphs: [] });
    }
    this.sequences.set(sequence.id, index);
    return index;
  }

  /** Records a glyph shown inside the open sequences, outermost first, and returns the outermost ActualText span it lies in. */
  add(glyph: number, markedContent: readonly MarkedContent[]): number | undefined {
    let outermost: number | undefined = undefined;
    for (const sequence of markedContent) {
      const index = this.spanOf(sequence);
      if (index === null) continue;
      this.spans[index]?.glyphs.push(glyph);
      outermost ??= index;
    }
    return outermost;
  }
}
