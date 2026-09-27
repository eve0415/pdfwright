import type { PdfDirectObject } from './pdfObject.ts';

import { assertNameBytes } from './nameBytes.ts';

const byteKey = (bytes: Uint8Array): string => {
  let key = '';
  for (const byte of bytes) key += String.fromCodePoint(byte);
  return key;
};

// Set only while parsedDictionaryEntries runs: parsed keys are kept as read, and they are already private interned arrays.
let parsedKeys = false;

export class PdfDictionaryEntries {
  private readonly values = new Map<string, { key: Uint8Array; value: PdfDirectObject }>();

  constructor(entries: Iterable<readonly [Uint8Array, PdfDirectObject]> = []) {
    for (const [key, value] of entries) this.set(key, value);
  }

  get(nameBytes: Uint8Array): PdfDirectObject | undefined {
    const value = this.values.get(byteKey(nameBytes))?.value;
    // ISO 32000-1:2008, 7.3.7 treats a null-valued dictionary entry as absent.
    return value?.kind === 'null' ? undefined : value;
  }

  set(nameBytes: Uint8Array, value: PdfDirectObject): this {
    if (parsedKeys) {
      this.values.set(byteKey(nameBytes), { key: nameBytes, value });
      return this;
    }
    assertNameBytes(nameBytes);
    this.values.set(byteKey(nameBytes), { key: Uint8Array.from(nameBytes), value });
    return this;
  }

  delete(nameBytes: Uint8Array): boolean {
    return this.values.delete(byteKey(nameBytes));
  }

  has(nameBytes: Uint8Array): boolean {
    return this.get(nameBytes) !== undefined;
  }

  *entries(): IterableIterator<[Uint8Array, PdfDirectObject]> {
    for (const { key, value } of this.values.values()) {
      if (value.kind !== 'null') yield [Uint8Array.from(key), value];
    }
  }

  get size(): number {
    let count = 0;
    for (const value of this.values.values()) if (value.value.kind !== 'null') count++;
    return count;
  }
}

/** Builds entries from keys a parser read, without the validation and copying that keys from callers get; a later key replaces an earlier equal one. */
export const parsedDictionaryEntries = (entries: readonly (readonly [Uint8Array, PdfDirectObject])[]): PdfDictionaryEntries => {
  parsedKeys = true;
  try {
    return new PdfDictionaryEntries(entries);
  } finally {
    parsedKeys = false;
  }
};
