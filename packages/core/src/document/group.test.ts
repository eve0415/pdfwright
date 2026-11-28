import type { ContentBuilder } from './contentBuilder.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { formatLength, pt } from '../length/length.ts';
import { pdfDictionary, pdfName } from '../object/pdfObject.ts';
import { latin1Text } from '../testing/pdfBuilder.ts';

import { cmyk } from './color.ts';
import { groupAttributes } from './group.ts';
import { entry, keys, objectText, pageResource, reload, streamBytes } from './inspectSaved.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

// 'accepted', or the class of the error the call throws.
const attempt = (call: () => void): string => {
  try {
    call();
  } catch (error: unknown) {
    return error instanceof ValidationError ? 'ValidationError' : String(error);
  }
  return 'accepted';
};

const nested =
  (levels: number) =>
  (content: ContentBuilder): void => {
    for (let index = 0; index < levels; index++) {
      content.save();
    }
    content.path(path => path.rect(0, 0, 1, 1));
    content.fill('nonzero');
    for (let index = 0; index < levels; index++) {
      content.restore();
    }
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
    const saved = reload(document.save());
    const form = pageResource(saved, 0, 'XObject', 'Fm1');
    const resources = entry(saved, form, 'Resources');
    expect([
      keys(pdfDictionary(saved.page(0).resources())),
      [entry(saved, form, 'Subtype'), objectText(entry(saved, form, 'BBox')), objectText(entry(saved, form, 'Group'))],
      keys(resources),
      objectText(entry(saved, entry(saved, resources, 'ExtGState'), 'GS1')),
      keys(entry(saved, resources, 'ColorSpace')),
    ]).toStrictEqual([
      ['XObject'],
      [pdfName('Form'), '[0 0 20 20]', '<</S/Transparency/I true/K false/CS/DeviceCMYK>>'],
      ['ColorSpace', 'ExtGState'],
      '<</ca 0.3>>',
      ['CS1'],
    ]);
    expect(objectText(entry(saved, entry(saved, resources, 'ColorSpace'), 'CS1'))).toMatch(/^\[\/Separation \/Primer \/DeviceCMYK /u);
    expect(latin1Text(streamBytes(form))).toBe('/CS1 cs\n1 scn\n/GS1 gs\n0 0 20 20 re\nf\n');
  });

  // ISO 32000-1:2008, 11.6.6, Table 147: K defaults to false and CS is absent unless the group names a colour space.
  it('writes knockout as given and no CS without a colour space', () => {
    const document = createDocument();
    const group = document.group({ bbox: rect(pt(20), pt(20), pt(0), pt(0)), knockout: true }, content => {
      content.path(path => path.rect(0, 0, 20, 20));
    });
    document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) }).draw(content => {
      content.group(group, [1, 0, 0, 1, 0, 0]);
    });
    const saved = reload(document.save());
    const form = pageResource(saved, 0, 'XObject', 'Fm1');
    expect([objectText(entry(saved, form, 'Group')), objectText(entry(saved, form, 'BBox'))]).toStrictEqual([
      '<</S/Transparency/I false/K true>>',
      '[0 0 20 20]',
    ]);
  });

  // The bounding box is checked as written at 5 fraction digits, where 0.000004 rounds to 0 and 0.00001 does not.
  it.each([
    ['a width that rounds to zero', rect(pt(0), pt(0), pt(0.000004), pt(1)), 'ValidationError'],
    ['a height that rounds to zero', rect(pt(0), pt(0), pt(1), pt(0.000004)), 'ValidationError'],
    ['a width of one unit at the last digit', rect(pt(0), pt(0), pt(0.00001), pt(1)), 'accepted'],
    ['corners given in either order', rect(pt(1), pt(1), pt(0), pt(0)), 'accepted'],
  ])('checks %s', (_, bbox, expected) => {
    expect(attempt(() => createDocument().group({ bbox }, () => undefined))).toBe(expected);
  });

  it('requires isolation for a colour space even when isolated is given as false', () => {
    expect([
      attempt(() => createDocument().group({ bbox: rect(pt(0), pt(0), pt(1), pt(1)), isolated: false, colorSpace: 'DeviceRGB' }, () => undefined)),
      attempt(() => createDocument().group({ bbox: rect(pt(0), pt(0), pt(1), pt(1)), isolated: true, colorSpace: 'DeviceRGB' }, () => undefined)),
    ]).toStrictEqual(['ValidationError', 'accepted']);
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
      for (let index = 0; index < 3; index++) {
        content.save();
      }
      content.group(inner, [1, 0, 0, 1, 0, 0]);
      for (let index = 0; index < 3; index++) {
        content.restore();
      }
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

  it('writes only the overprint keys a group sets, since it cannot know the flags it inherits', () => {
    const document = createDocument();
    const box = rect(pt(0), pt(0), pt(20), pt(20));
    document.group({ bbox: box }, content => {
      content.graphicsState({ overprintFill: true });
    });
    document.group({ bbox: box }, content => {
      content.graphicsState({ overprintFill: false, overprintStroke: true });
    });
    expect(() =>
      document.group({ bbox: box }, content => {
        content.graphicsState({ overprintStroke: true });
      }),
    ).toThrow(/overprintFill/u);
    const pdf = ascii(document.save().toBytes());
    expect(pdf).toContain('/ExtGState<</GS1<</op true>>>>');
    expect(pdf).toContain('/ExtGState<</GS1<</OP true/op false>>>>');
  });
});

describe('properties', () => {
  // Coordinates on a grid finer than the last written digit, so that many boxes collapse to zero area only once rounded.
  const coordinate = fc.integer({ min: -20, max: 20 }).map(step => step * 0.000003);

  it('accepts a bounding box exactly when it keeps non-zero width and height once written at the fraction digits', () => {
    fc.assert(
      fc.property(coordinate, coordinate, coordinate, coordinate, fc.constantFrom(4, 5, 6), (x1, y1, x2, y2, digits) => {
        const written = [x1, y1, x2, y2].map(value => Number(formatLength(pt(value), digits)));
        const [left = 0, bottom = 0, right = 0, top = 0] = written;
        const expected = Math.min(left, right) < Math.max(left, right) && Math.min(bottom, top) < Math.max(bottom, top) ? 'accepted' : 'ValidationError';
        expect(attempt(() => groupAttributes({ bbox: [pt(x1), pt(y1), pt(x2), pt(y2)] }, digits))).toBe(expected);
      }),
    );
  });
});
