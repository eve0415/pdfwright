import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { ValidationError } from '../error/validationError.ts';

import { createDocument } from './pdfDocument.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('document information', () => {
  it('writes ASCII text, UTF-16BE text, and explicit dates', () => {
    const date = pdfDate({ year: 2024, month: 2, day: 29, hour: 12, minute: 34, second: 56, offset: 'Z' });
    const document = createDocument({
      info: {
        title: 'Print (page)',
        author: '日本',
        subject: 'Proof',
        keywords: 'ink',
        creator: 'Artwork',
        producer: 'Press',
        creationDate: date,
        modificationDate: date,
      },
    });
    const pdf = ascii(document.save().toBytes());
    for (const fragment of [
      String.raw`/Title(Print \(page\))`,
      '/Author<FEFF65E5672C>',
      '/Subject(Proof)',
      '/Keywords(ink)',
      '/Creator(Artwork)',
      '/Producer(Press)',
      '/CreationDate(D:20240229123456Z)',
      '/ModDate(D:20240229123456Z)',
      '/Info',
    ]) {
      expect(pdf).toContain(fragment);
    }
  });

  it('writes no implicit metadata or clock values', () => {
    const pdf = ascii(createDocument().save().toBytes());
    expect(pdf).not.toContain('/Info');
    expect(pdf).not.toContain('/Producer');
    expect(pdf).not.toContain('/CreationDate');
    expect(pdf).not.toContain('/ModDate');
  });

  it('encodes supplementary Unicode with its surrogate pair and rejects malformed text', () => {
    const pdf = ascii(
      createDocument({ info: { title: '😀' } })
        .save()
        .toBytes(),
    );
    expect(pdf).toContain('/Title<FEFFD83DDE00>');
    expect(() => createDocument({ info: { title: '\uD800' } }).save()).toThrow(ValidationError);
  });
});
