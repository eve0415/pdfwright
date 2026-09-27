import type { PdfObject } from './pdfObject.ts';

import { assertNameBytes } from './nameBytes.ts';

const byteKey = (bytes: Uint8Array): string => {
  let key = '';
  for (const byte of bytes) key += String.fromCodePoint(byte);
  return key;
};

export class PdfDictionaryEntries {
  private readonly values = new Map<string, { key: Uint8Array; value: PdfObject }>();

  constructor(entries: Iterable<readonly [Uint8Array, PdfObject]> = []) {
    for (const [key, value] of entries) this.set(key, value);
  }

  get(nameBytes: Uint8Array): PdfObject | undefined {
    const value = this.values.get(byteKey(nameBytes))?.value;
    // ISO 32000-1:2008, 7.3.7 treats a null-valued dictionary entry as absent.
    return value?.kind === 'null' ? undefined : value;
  }

  set(nameBytes: Uint8Array, value: PdfObject): this {
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

  *entries(): IterableIterator<[Uint8Array, PdfObject]> {
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
