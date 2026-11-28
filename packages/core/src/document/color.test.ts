import type { DeviceColor } from './color.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { pt } from '../length/length.ts';
import { formatNumber } from '../number/formatNumber.ts';
import { pdfName } from '../object/pdfObject.ts';

import { cmyk, gray, rgb } from './color.ts';
import { createContentBuilder } from './contentBuilder.ts';
import { keys, objectText, pageContent, pageResource, reload, resolved } from './inspectSaved.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

// Each constructor sets the component under test beside components at the opposite edge, so a check of only the first component cannot pass.
const constructors = [
  ['cmyk', (value: number) => cmyk(1, 0, 1, value)],
  ['rgb', (value: number) => rgb(0, value, 1)],
  ['gray', (value: number) => gray(value)],
] as const;

describe('device colours and graphics state', () => {
  it('validates components and writes colour operators', () => {
    expect(() => cmyk(0, 0, 0, 1.01)).toThrow(ValidationError);
    expect(() => rgb(-0.1, 0, 0)).toThrow(ValidationError);
    expect(() => gray(Number.NaN)).toThrow(ValidationError);
    const { content: builder, finish } = createContentBuilder(5);
    builder.fillColor(cmyk(0, 0.1, 0.2, 0.3));
    builder.strokeColor(rgb(1, 0.5, 0));
    builder.fillColor(gray(0.25));
    builder.strokeColor(cmyk(0, 0, 0, 1));
    expect(ascii(finish().data)).toBe('0 0.1 0.2 0.3 k\n1 0.5 0 RG\n0.25 g\n0 0 0 1 K\n');
  });

  // ISO 32000-1:2008, 8.6.8, Table 74 bounds each device colour component to 0.0 through 1.0.
  it.each([
    ['cmyk', [1, 0, 1, 0], [1, 0, 1, 1]],
    ['rgb', [0, 0, 1], [0, 1, 1]],
    ['gray', [0], [1]],
  ] as const)('accepts %s components at 0 and 1', (name, low, high) => {
    const make = constructors.find(([constructor]) => constructor === name)?.[1];
    expect([make?.(0).components, make?.(1).components]).toStrictEqual([low, high]);
  });

  it.each(constructors.flatMap(([name, make]) => [1 + Number.EPSILON, -Number.MIN_VALUE, Infinity, -Infinity].map(value => [name, value, make] as const)))(
    'rejects a %s component of %d with a ValidationError that has no reason',
    (_, value, make) => {
      expect(() => make(value)).toThrow(ValidationError);
      expect(() => make(value)).toThrow(expect.objectContaining({ reason: undefined }));
    },
  );

  it('deduplicates ExtGState by value per page and names states in the order each page first uses them', () => {
    const document = createDocument();
    const box = rect(pt(0), pt(0), pt(100), pt(100));
    const overprint = { fillAlpha: 0.3, overprintFill: true, overprintMode: 1, softMask: 'None' } as const;
    const multiply = { strokeAlpha: 0.5, blendMode: 'Multiply' } as const;
    document.addPage({ mediaBox: box }).draw(content => {
      content.graphicsState(overprint);
      content.graphicsState({ overprintMode: 1, softMask: 'None', fillAlpha: 0.3, overprintFill: true });
      content.graphicsState(multiply);
    });
    document.addPage({ mediaBox: box }).draw(content => {
      content.graphicsState(multiply);
      content.graphicsState(overprint);
    });
    const saved = reload(document.save());
    const states = (page: number): Array<string> => ['GS1', 'GS2'].map(name => objectText(pageResource(saved, page, 'ExtGState', name)));
    // ISO 32000-1:2008, 8.4.5, Table 58: an OP entry alone would also set op, so the fill state carries both flags.
    const fill = '<</ca 0.3/OP false/op true/OPM 1/SMask/None>>';
    const stroke = '<</CA 0.5/BM/Multiply>>';
    expect([0, 1].map(page => keys(resolved(saved, saved.page(page).resources().get(pdfName('ExtGState').bytes))))).toStrictEqual([
      ['GS1', 'GS2'],
      ['GS1', 'GS2'],
    ]);
    expect([states(0), states(1)]).toStrictEqual([
      [fill, stroke],
      [stroke, fill],
    ]);
    expect([pageContent(saved, 0), pageContent(saved, 1)]).toStrictEqual(['q\n/GS1 gs\n/GS1 gs\n/GS2 gs\nQ\n', 'q\n/GS1 gs\n/GS2 gs\nQ\n']);
  });
});

const valid = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

// The content a colour writes as a fill, or the class of the error its constructor throws.
const written = (make: () => DeviceColor): string => {
  const { content, finish } = createContentBuilder(5);
  try {
    content.fillColor(make());
  } catch (error: unknown) {
    return error instanceof ValidationError ? 'ValidationError' : String(error);
  }
  return ascii(finish().data);
};

const expected = (components: Array<number>, operator: string): string =>
  components.every(value => valid(value)) ? `${components.map(value => formatNumber(value, 5)).join(' ')} ${operator}\n` : 'ValidationError';

describe('properties', () => {
  // A component drawn from every double, with the interval's edges and the values just past them made likely.
  const component = fc.oneof(fc.double(), fc.double({ min: 0, max: 1 }), fc.constantFrom(0, 1, 1 + Number.EPSILON, -Number.MIN_VALUE));

  it('accepts a gray level exactly when it is a finite number in [0, 1] and writes it with the g operator', () => {
    fc.assert(
      fc.property(component, value => {
        expect(written(() => gray(value))).toBe(expected([value], 'g'));
      }),
    );
  });

  it('accepts RGB and CMYK colours exactly when every component is valid and writes them in order', () => {
    fc.assert(
      fc.property(component, component, component, component, (c, m, y, k) => {
        expect([written(() => rgb(c, m, y)), written(() => cmyk(c, m, y, k))]).toStrictEqual([expected([c, m, y], 'rg'), expected([c, m, y, k], 'k')]);
      }),
    );
  });
});
