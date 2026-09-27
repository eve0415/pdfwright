import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { pt } from '../length/length.ts';

import { cmyk, gray, rgb } from './color.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('separation colour spaces', () => {
  it('encodes UTF-8 names and preserves caller-supplied bytes', () => {
    const document = createDocument();
    const japanese = document.separation({ name: '白', alternate: cmyk(0, 0, 0, 0.2) });
    const legacy = document.separation({ name: new Uint8Array([0x82, 0x62, 0x82, 0x74, 0x82, 0x73]), alternate: gray(0.5) });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
    page.draw(content => {
      content.fillColor(japanese, 0.75);
      content.path(path => path.rect(0, 0, 20, 20));
      content.fill('nonzero');
      content.strokeColor(legacy, 0.25);
      content.path(path => path.moveTo(0, 0).lineTo(20, 20));
      content.stroke();
    });
    const pdf = ascii(document.save().toBytes());
    for (const fragment of ['/#E7#99#BD', '/#82b#82t#82s', '/ColorSpace<</CS1', '/CS2', '/C0[0 0 0 0]', '/C0[1]']) expect(pdf).toContain(fragment);
  });

  it('guards special names, ASCII policy, and conflicting alternates', () => {
    const document = createDocument({ colorantPolicy: { asciiOnly: true } });
    expect(() => document.separation({ name: 'All', alternate: rgb(1, 0, 0) })).toThrow(ValidationError);
    expect(() => document.separation({ name: 'é', alternate: rgb(1, 0, 0) })).toThrow(ValidationError);
    expect(() => document.separation({ name: new Uint8Array([0x82]), alternate: gray(0) })).toThrow(ValidationError);
    expect(document.separation({ name: 'None', alternate: gray(1), allow: 'None' }).name).toStrictEqual(new TextEncoder().encode('None'));
    document.separation({ name: 'Spot', alternate: cmyk(0, 0, 0, 0.2) });
    expect(() => document.separation({ name: 'Spot', alternate: cmyk(0, 0, 0, 0.3) })).toThrow(ValidationError);
  });
});
