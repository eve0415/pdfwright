import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { pt } from '../length/length.ts';

import { createContentBuilder } from './contentBuilder.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('content builder', () => {
  it('formats path, graphics, and clipping operators exactly', () => {
    const builder = createContentBuilder(5);
    builder.save();
    builder.transform(1, 0, 0, 1, pt(2), pt(3));
    builder.lineWidth(0);
    builder.lineJoin('round');
    builder.lineCap('square');
    builder.miterLimit(4);
    builder.dash([pt(2), 1], 0);
    builder.path(p => p.moveTo(0, 0).lineTo(pt(10), 0).curveTo(10, 1, 9, 2, 8, 3).rect(1, 2, 3, 4).close());
    builder.clip('evenodd');
    builder.path(p => p.rect(0, 0, 5, 5));
    builder.fill('nonzero');
    builder.path(p => p.rect(0, 0, 5, 5));
    builder.fillAndStroke('evenodd');
    builder.restore();
    expect(ascii(builder.finish())).toBe(
      'q\n1 0 0 1 2 3 cm\n0 w\n1 j\n2 J\n4 M\n[2 1] 0 d\n0 0 m\n10 0 l\n10 1 9 2 8 3 c\n1 2 3 4 re\nh\nW*\nn\n0 0 5 5 re\nf\n0 0 5 5 re\nB*\nQ\n',
    );
  });

  it('rejects unbalanced graphics state and nesting deeper than 28', () => {
    const builder = createContentBuilder(5);
    expect(() => {
      builder.restore();
    }).toThrow(ValidationError);
    builder.save();
    expect(() => {
      builder.finish();
    }).toThrow(ValidationError);
    for (let index = 1; index < 28; index++) builder.save();
    expect(() => {
      builder.save();
    }).toThrow(ValidationError);
    for (let index = 0; index < 28; index++) builder.restore();
    expect(() => {
      builder.finish();
    }).not.toThrow();
  });

  it('writes a Flate-compressed page content stream', () => {
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
    page.draw(c => {
      c.path(p => p.rect(0, 0, 10, 10));
      c.fill('nonzero');
    });
    const bytes = document.save().toBytes();
    const text = ascii(bytes);
    expect(text).toContain('/Filter/FlateDecode');
    const start = text.indexOf('stream\n') + 7;
    const end = text.indexOf('\nendstream', start);
    const compressed = bytes.subarray(start, end);
    const decoded = inflateZlib(compressed).data;
    expect(ascii(decoded)).toBe('q\n0 0 10 10 re\nf\nQ\n');
  });
});
