import type { ContentBuilder } from './contentBuilder.ts';

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { pt } from '../length/length.ts';

import { cmyk } from './color.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

const nested =
  (levels: number) =>
  (content: ContentBuilder): void => {
    for (let index = 0; index < levels; index++) content.save();
    content.path(path => path.rect(0, 0, 1, 1));
    content.fill('nonzero');
    for (let index = 0; index < levels; index++) content.restore();
  };

describe('transparency groups', () => {
  it('writes a form with its own resources and group attributes', () => {
    const document = createDocument();
    const spot = document.separation({ name: 'Primer', alternate: cmyk(0, 0, 0, 0.5) });
    const group = document.group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)), isolated: true, knockout: false, colorSpace: 'DeviceCMYK' }, content => {
      content.fillColor(spot, 1);
      content.graphicsState({ fillAlpha: 0.3 });
      content.path(path => path.rect(0, 0, 20, 20));
      content.fill('nonzero');
    });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.draw(content => {
      content.group(group, [1, 0, 0, 1, 0, 0]);
    });
    const pdf = ascii(document.save().toBytes());
    for (const fragment of [
      '/Subtype/Form',
      '/BBox[0 0 20 20]',
      '/Group<</S/Transparency/I true/K false/CS/DeviceCMYK>>',
      '/ColorSpace<</CS1',
      '/ExtGState<</GS1',
      '/XObject<</Fm1',
    ]) {
      expect(pdf).toContain(fragment);
    }
  });

  it('requires isolation when a form group names a colour space', () => {
    const document = createDocument();
    expect(() =>
      document.group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)), colorSpace: 'DeviceCMYK' }, content => {
        content.save();
        content.restore();
      }),
    ).toThrow(ValidationError);
  });

  it('checks inherited white overprint at placement', () => {
    const document = createDocument();
    const group = document.group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)) }, content => {
      content.fillColor(cmyk(0, 0, 0, 0));
      content.path(path => path.rect(0, 0, 20, 20));
      content.fill('nonzero');
    });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.draw(content => {
      content.graphicsState({ overprintFill: true, overprintMode: 1 });
      expect(() => {
        content.group(group, [1, 0, 0, 1, 0, 0]);
      }).toThrow(ValidationError);
      expect(() => {
        content.group(group, [1, 0, 0, 1, 0, 0], { acknowledgeInvisibleOverprint: true });
      }).not.toThrow();
    });
  });

  it('allows a group with its own ExtGState to override inherited overprint', () => {
    const document = createDocument();
    const group = document.group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)) }, content => {
      content.graphicsState({ overprintFill: false });
      content.fillColor(cmyk(0, 0, 0, 0));
      content.path(path => path.rect(0, 0, 20, 20));
      content.fill('nonzero');
    });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.draw(content => {
      content.graphicsState({ overprintFill: true, overprintMode: 1 });
      expect(() => {
        content.group(group, [1, 0, 0, 1, 0, 0]);
      }).not.toThrow();
    });
  });

  it('returns a frozen handle exposing only its kind and page-piece setter', () => {
    const document = createDocument();
    const group = document.group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)) }, content => {
      content.path(path => path.rect(0, 0, 20, 20));
    });
    expect([Object.isFrozen(group), Object.keys(group).toSorted()]).toStrictEqual([true, ['kind', 'pieceInfo']]);
    const forged = { kind: 'PdfGroup', pieceInfo: (): void => undefined } as const;
    const foreign = createDocument().group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)) }, content => {
      content.path(path => path.rect(0, 0, 20, 20));
    });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.draw(content => {
      for (const handle of [forged, foreign]) {
        expect(() => {
          content.group(handle, [1, 0, 0, 1, 0, 0]);
        }).toThrow(ValidationError);
      }
    });
  });

  it('counts the q/Q nesting a placed form adds, including the implicit save of Do', () => {
    const document = createDocument();
    const box = rect(pt(0), pt(0), pt(20), pt(20));
    const deep = document.group({ bbox: box }, nested(25));
    expect(() => document.group({ bbox: box }, nested(26))).toThrow(ValidationError);
    const inner = document.group({ bbox: box }, nested(20));
    const outer = document.group({ bbox: box }, content => {
      nested(3)(content);
      for (let index = 0; index < 3; index++) content.save();
      content.group(inner, [1, 0, 0, 1, 0, 0]);
      for (let index = 0; index < 3; index++) content.restore();
    });
    const page = document.addPage({ mediaBox: box });
    page.draw(content => {
      content.group(deep, [1, 0, 0, 1, 0, 0]);
      content.group(outer, [1, 0, 0, 1, 0, 0]);
      content.save();
      for (const group of [deep, outer]) {
        expect(() => {
          content.group(group, [1, 0, 0, 1, 0, 0]);
        }).toThrow(ValidationError);
      }
      content.restore();
    });
  });
});
