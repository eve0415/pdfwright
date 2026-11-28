import type { ContentBuilder, GraphicsStateOptions, PathBuilder } from './contentBuilder.ts';
import type { PdfImage } from './image.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { pt } from '../length/length.ts';
import { pdfName } from '../object/pdfObject.ts';

import { cmyk, gray, rgb } from './color.ts';
import { createContentBuilder } from './contentBuilder.ts';
import { entry, objectText, pageResource, reload } from './inspectSaved.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

const DRAWING_OPERATIONS = [
  'clip',
  'dash',
  'fill',
  'fillAndStroke',
  'fillColor',
  'graphicsState',
  'group',
  'image',
  'lineCap',
  'lineJoin',
  'lineWidth',
  'miterLimit',
  'path',
  'restore',
  'save',
  'stroke',
  'strokeColor',
  'transform',
];

// The content one call writes into a fresh builder, or the class of the error it throws.
const outcome = (draw: (content: ContentBuilder) => void, fractionDigits = 5): string => {
  const { content, finish } = createContentBuilder(fractionDigits);
  try {
    draw(content);
  } catch (error: unknown) {
    return error instanceof ValidationError ? 'ValidationError' : String(error);
  }
  return ascii(finish().data);
};

const spot = createDocument().separation({ name: 'Spot', alternate: cmyk(0, 0.5, 0, 0) });
const image: PdfImage = Object.freeze({ kind: 'PdfImage' });

const saves = (content: ContentBuilder, count: number): void => {
  for (let index = 0; index < count; index++) {
    content.save();
  }
};

const restores = (content: ContentBuilder, count: number): void => {
  for (let index = 0; index < count; index++) {
    content.restore();
  }
};

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
    for (let index = 1; index < 28; index++) {
      builder.save();
    }
    expect(() => {
      builder.save();
    }).toThrow(ValidationError);
    for (let index = 0; index < 28; index++) {
      builder.restore();
    }
    expect(() => finish()).not.toThrow();
  });

  it('writes a Flate-compressed page content stream', () => {
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
    page.draw(c => {
      c.path(p => p.rect(0, 0, 10, 10));
      c.fill('nonzero');
    });
    const saved = reload(document.save());
    const contents = entry(saved, saved.get(saved.page(0).reference), 'Contents');
    // ISO 32000-1:2008, 7.4.4: FlateDecode data inflates with zlib.
    expect([entry(saved, contents, 'Filter'), contents.kind === 'stream' ? ascii(inflateZlib(contents.data).data) : contents.kind]).toStrictEqual([
      pdfName('FlateDecode'),
      'q\n0 0 10 10 re\nf\nQ\n',
    ]);
  });

  it('hands draw callbacks only drawing operations and refuses use after the callback', () => {
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    const retained: Array<ContentBuilder> = [];
    page.draw(content => {
      retained.push(content);
      expect([Object.keys(content).toSorted(), Object.isFrozen(content)]).toStrictEqual([DRAWING_OPERATIONS, true]);
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

  it.each([
    ['without a tint', undefined, 'ValidationError'],
    ['with tint NaN', Number.NaN, 'ValidationError'],
    ['with tint -0.01', -0.01, 'ValidationError'],
    ['with tint 1.01', 1.01, 'ValidationError'],
    ['with tint 0', 0, '/CS1 cs\n0 scn\n'],
    ['with tint 1', 1, '/CS1 cs\n1 scn\n'],
  ])('fills with a separation %s', (_, tint, expected) => {
    expect(
      outcome(content => {
        content.fillColor(spot, tint);
      }),
    ).toBe(expected);
  });

  it('refuses a tint for a device colour and writes each device operator for fill and stroke', () => {
    expect([
      outcome(content => {
        content.fillColor(cmyk(0, 0, 0, 1), 0.5);
      }),
      outcome(content => {
        content.strokeColor(rgb(0, 0, 1), 1);
      }),
      outcome(content => {
        content.fillColor(rgb(0.25, 0.5, 1));
        content.strokeColor(gray(0.5));
      }),
    ]).toStrictEqual(['ValidationError', 'ValidationError', '0.25 0.5 1 rg\n0.5 G\n']);
  });

  // ISO 32000-1:2008, 8.4.3.2 allows width 0; the check runs on the value as written, so a width that rounds to zero is accepted.
  it.each([
    [-1, 'ValidationError'],
    [-0.000001, '0 w\n'],
    [0.000001, '0 w\n'],
    [pt(-0.01), 'ValidationError'],
  ])('checks line width %s as written', (width, expected) => {
    expect(
      outcome(content => {
        content.lineWidth(width);
      }),
    ).toBe(expected);
  });

  // ISO 32000-1:2008, 8.4.3.6: dash lengths and phase are non-negative, and a nonempty array is not all zero.
  it.each([
    [[-1, 2], 0, 'ValidationError'],
    [[1, 2], -1, 'ValidationError'],
    [[0.000001], 0, 'ValidationError'],
    [[0, 1], 0, '[0 1] 0 d\n'],
    [[3], pt(1.5), '[3] 1.5 d\n'],
  ])('checks dash array %j with phase %s', (array, phase, expected) => {
    expect(
      outcome(content => {
        content.dash(array, phase);
      }),
    ).toBe(expected);
  });

  it('checks a miter limit given as a length', () => {
    expect([
      outcome(content => {
        content.miterLimit(pt(0.5));
      }),
      outcome(content => {
        content.miterLimit(pt(1));
      }),
    ]).toStrictEqual(['ValidationError', '1 M\n']);
  });

  it.each([
    ['fillAlpha', -0.1, 'ValidationError'],
    ['fillAlpha', 1.01, 'ValidationError'],
    ['fillAlpha', Number.NaN, 'ValidationError'],
    ['fillAlpha', 0, '/GS1 gs\n'],
    ['fillAlpha', 1, '/GS1 gs\n'],
    ['strokeAlpha', -0.1, 'ValidationError'],
    ['strokeAlpha', 1.01, 'ValidationError'],
    ['strokeAlpha', Number.NaN, 'ValidationError'],
    ['strokeAlpha', 0, '/GS1 gs\n'],
    ['strokeAlpha', 1, '/GS1 gs\n'],
  ] as const)('checks %s %d', (key, value, expected) => {
    expect(
      outcome(content => {
        content.graphicsState({ [key]: value });
      }),
    ).toBe(expected);
  });

  // ISO 32000-1:2008, 8.4.5, Table 58: OP alone sets both overprint flags, so on a page each flag set alone is written beside the other's current value.
  it.each([
    [{ overprintStroke: true }, '<</OP true/op false>>'],
    [{ overprintFill: true }, '<</OP false/op true>>'],
  ] as const)('writes both overprint keys on a page for %j', (options, expected) => {
    const document = createDocument();
    document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) }).draw(content => {
      content.graphicsState(options);
    });
    expect(objectText(pageResource(reload(document.save()), 0, 'ExtGState', 'GS1'))).toBe(expected);
  });

  // ISO 32000-1:2008, Annex C, Table C.1 allows 28 levels, and painting an image adds the q around its Do.
  it.each([
    [27, `${'q\n'.repeat(27)}q\n1 0 0 1 0 0 cm\n/Im1 Do\nQ\n${'Q\n'.repeat(27)}`],
    [28, 'ValidationError'],
  ])('paints an image after %i saves', (depth, expected) => {
    expect(
      outcome(content => {
        saves(content, depth);
        content.image(image, [1, 0, 0, 1, 0, 0]);
        restores(content, depth);
      }),
    ).toBe(expected);
  });

  it('refuses a retained path builder after finish', () => {
    const { content, finish } = createContentBuilder(5);
    let retained: PathBuilder | undefined;
    content.path(path => {
      retained = path;
      return path.moveTo(0, 0);
    });
    expect(ascii(finish().data)).toBe('0 0 m\n');
    expect(() => retained?.moveTo(1, 1)).toThrow(ValidationError);
  });

  it('writes numbers with the fraction digits it was created with', () => {
    expect([
      outcome(content => {
        content.lineWidth(0.125);
      }, 2),
      outcome(content => {
        content.lineWidth(0.125);
      }, 5),
    ]).toStrictEqual(['0.12 w\n', '0.125 w\n']);
  });
});

// The overprint flags a page graphics state writes: ISO 32000-1:2008, 8.4.5, Table 58 sets both when either is given, taking the other from the current state.
const modelKey = (options: GraphicsStateOptions, state: { fill: boolean; stroke: boolean }): string => {
  const given = options.overprintFill !== undefined || options.overprintStroke !== undefined;
  const fill = given ? (options.overprintFill ?? state.fill) : undefined;
  const stroke = given ? (options.overprintStroke ?? state.stroke) : undefined;
  state.fill = fill ?? state.fill;
  state.stroke = stroke ?? state.stroke;
  return JSON.stringify([options.fillAlpha, options.strokeAlpha, options.blendMode, stroke, fill, options.overprintMode, options.softMask]);
};

// The same options with their keys inserted in the opposite order.
const reordered = (options: GraphicsStateOptions): GraphicsStateOptions => {
  const copy: GraphicsStateOptions = {};
  if (options.softMask !== undefined) {
    copy.softMask = options.softMask;
  }
  if (options.overprintMode !== undefined) {
    copy.overprintMode = options.overprintMode;
  }
  if (options.overprintStroke !== undefined) {
    copy.overprintStroke = options.overprintStroke;
  }
  if (options.overprintFill !== undefined) {
    copy.overprintFill = options.overprintFill;
  }
  if (options.blendMode !== undefined) {
    copy.blendMode = options.blendMode;
  }
  if (options.strokeAlpha !== undefined) {
    copy.strokeAlpha = options.strokeAlpha;
  }
  if (options.fillAlpha !== undefined) {
    copy.fillAlpha = options.fillAlpha;
  }
  return copy;
};

// What a sequence of saves (true) and restores (false) writes and how deep it goes, or the error class when it leaves 0 to 28 levels or ends unbalanced.
type Nesting = 'ValidationError' | readonly [string, number];

const modelNesting = (operations: ReadonlyArray<boolean>): Nesting => {
  let depth = 0;
  let deepest = 0;
  for (const save of operations) {
    depth += save ? 1 : -1;
    deepest = Math.max(deepest, depth);
    if (depth < 0 || depth > 28) {
      return 'ValidationError';
    }
  }
  return depth === 0 ? [operations.map(save => (save ? 'q\n' : 'Q\n')).join(''), deepest] : 'ValidationError';
};

const nesting = (operations: ReadonlyArray<boolean>): Nesting => {
  const { content, finish } = createContentBuilder(5);
  try {
    for (const save of operations) {
      if (save) {
        content.save();
      } else {
        content.restore();
      }
    }
    const finished = finish();
    return [ascii(finished.data), finished.summary.depth];
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return 'ValidationError';
    }
    throw error;
  }
};

const OPTION_KEYS = ['fillAlpha', 'strokeAlpha', 'blendMode', 'overprintFill', 'overprintStroke', 'overprintMode', 'softMask'] as const;

// The options with one key taken from the donor, or removed when the donor lacks it.
const swapped = (first: GraphicsStateOptions, donor: GraphicsStateOptions, key: keyof GraphicsStateOptions): GraphicsStateOptions => {
  const copy = { ...first };
  const value = donor[key];
  if (value === undefined) {
    Reflect.deleteProperty(copy, key);
  } else {
    Reflect.set(copy, key, value);
  }
  return copy;
};

// Climbs or descends to each target depth in turn and then back to 0, so the sequence never restores below 0 and passes 28 only when a target does.
const balanced = fc.array(fc.oneof(fc.integer({ min: 0, max: 5 }), fc.constantFrom(27, 28, 29)), { maxLength: 8 }).map(targets => {
  const operations: Array<boolean> = [];
  let depth = 0;
  for (const target of [...targets, 0]) {
    for (; depth < target; depth++) {
      operations.push(true);
    }
    for (; depth > target; depth--) {
      operations.push(false);
    }
  }
  return operations;
});

describe('properties', () => {
  // Balanced sequences reach the valid branch and the 28-level limit; unconstrained ones mostly underflow or end unbalanced.
  const sequence = fc.oneof(balanced, fc.array(fc.boolean(), { maxLength: 40 }));

  it('accepts a save and restore sequence exactly when it stays within 0 to 28 levels and ends balanced', () => {
    fc.assert(
      fc.property(sequence, operations => {
        expect(nesting(operations)).toStrictEqual(modelNesting(operations));
      }),
    );
  });

  const options = fc.record(
    {
      fillAlpha: fc.constantFrom(0, 0.5, 1),
      strokeAlpha: fc.constantFrom(0, 1),
      blendMode: fc.constantFrom('Normal', 'Multiply'),
      overprintFill: fc.boolean(),
      overprintStroke: fc.boolean(),
      overprintMode: fc.constantFrom(0, 1),
      softMask: fc.constant('None'),
    },
    { requiredKeys: [] },
  );

  it('gives two graphics states one name exactly when they set the same parameters, whatever their key order', () => {
    fc.assert(
      fc.property(options, options, (first, donor) => {
        // The reordered copy and each one-key change are the near misses of equality, which two independent records rarely are.
        for (const second of [reordered(first), donor, ...OPTION_KEYS.map(key => swapped(first, donor, key))]) {
          const state = { fill: false, stroke: false };
          const same = modelKey(first, state) === modelKey(second, state);
          const written = outcome(content => {
            content.graphicsState(first);
            content.graphicsState(second);
          });
          expect(written).toBe(`/GS1 gs\n/GS${same ? '1' : '2'} gs\n`);
        }
      }),
    );
  });
});
