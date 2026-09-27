import type { ContentBuilder } from './contentBuilder.ts';

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { pt } from '../length/length.ts';

import { createContentBuilder } from './contentBuilder.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('content builder', () => {
  it('rejects all-zero dash arrays and allows an empty solid pattern', () => {
    const { content: builder } = createContentBuilder(5);
    expect(() => {
      builder.dash([0, 0], 0);
    }).toThrow(ValidationError);
    expect(() => {
      builder.dash([], 0);
    }).not.toThrow();
  });

  it('rejects a miter limit below one', () => {
    const { content: builder } = createContentBuilder(5);
    for (const limit of [0, 0.5, 0.999994]) {
      expect(() => {
        builder.miterLimit(limit);
      }).toThrow(ValidationError);
    }
    expect(() => {
      builder.miterLimit(1);
    }).not.toThrow();
  });

  it('formats path, graphics, and clipping operators exactly', () => {
    const { content: builder, finish } = createContentBuilder(5);
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
    expect(ascii(finish().data)).toBe(
      'q\n1 0 0 1 2 3 cm\n0 w\n1 j\n2 J\n4 M\n[2 1] 0 d\n0 0 m\n10 0 l\n10 1 9 2 8 3 c\n1 2 3 4 re\nh\nW*\nn\n0 0 5 5 re\nf\n0 0 5 5 re\nB*\nQ\n',
    );
  });

  it('rejects unbalanced graphics state and nesting deeper than 28', () => {
    const { content: builder, finish } = createContentBuilder(5);
    expect(() => {
      builder.restore();
    }).toThrow(ValidationError);
    builder.save();
    expect(() => finish()).toThrow(ValidationError);
    for (let index = 1; index < 28; index++) builder.save();
    expect(() => {
      builder.save();
    }).toThrow(ValidationError);
    for (let index = 0; index < 28; index++) builder.restore();
    expect(() => finish()).not.toThrow();
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

  it('hands draw callbacks only drawing operations and refuses use after the callback', () => {
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    const retained: ContentBuilder[] = [];
    page.draw(content => {
      retained.push(content);
      expect(['finish' in content, 'inheritedWhitePaint' in content, Object.isFrozen(content)]).toStrictEqual([false, false, true]);
    });
    expect(() => {
      retained[0]?.path(path => path.rect(0, 0, 1, 1));
    }).toThrow(ValidationError);
  });

  it('does not mutate a finished builder before rejecting a command', () => {
    let registrations = 0;
    const { content, finish } = createContentBuilder(5, {
      registerGraphicsState: () => {
        registrations++;
        return 'GS1';
      },
    });
    finish();
    expect(() => {
      content.graphicsState({ fillAlpha: 0.5 });
    }).toThrow(ValidationError);
    expect(() => {
      content.save();
    }).toThrow(ValidationError);
    expect(() => {
      finish();
    }).not.toThrow();
    let pathCalled = false;
    expect(() => {
      content.path(path => {
        pathCalled = true;
        return path;
      });
    }).toThrow(ValidationError);
    expect([registrations, pathCalled]).toStrictEqual([0, false]);
  });
});
