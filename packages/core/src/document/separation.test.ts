import type { DeviceColor } from './color.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compareDocuments } from '../compare/compareDocuments.ts';
import { ValidationError } from '../error/validationError.ts';
import { listColorants } from '../inspect/colorants/listColorants.ts';
import { pt } from '../length/length.ts';
import { serializeObject } from '../serialize/serializeObject.ts';
import { buildPdf, latin1Text } from '../testing/pdfBuilder.ts';

import { cmyk, gray, rgb } from './color.ts';
import { loadDocument } from './loadDocument.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';
import { createSeparationRecord, separationObject } from './separation.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

const written = (alternate: DeviceColor): string =>
  latin1Text(serializeObject(separationObject(createSeparationRecord({ name: 'Spot', alternate }, false)), { fractionDigits: 5 }));

// The reason a separation is refused for, or 'accepted'.
const separationOutcome = (create: () => object): string => {
  try {
    create();
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return error.reason ?? 'no reason';
    }
    throw error;
  }
  return 'accepted';
};

describe('separation colour spaces', () => {
  it('keeps a Shift_JIS colorant name through write, read, edit and save', () => {
    const legacyName = new Uint8Array([0x82, 0x62, 0x82, 0x74, 0x82, 0x73]);
    const document = createDocument();
    const spot = document.separation({ name: legacyName, alternate: cmyk(0, 0, 0, 0.5) });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(40), pt(40)) });
    page.draw(content => {
      content.fillColor(spot, 1);
      content.path(draw => draw.rect(5, 5, 20, 20));
      content.fill('nonzero');
    });
    const written = document.save().toBytes();
    for (const mode of ['incremental', 'full'] as const) {
      const loaded = loadDocument(written);
      expect(listColorants(loaded)[0]?.colorants[0]?.name).toStrictEqual(legacyName);
      loaded.page(0).setBox('TrimBox', rect(pt(1), pt(1), pt(39), pt(39)));
      const saved = loadDocument(loaded.save({ mode }).toBytes());
      expect(listColorants(saved)[0]?.colorants[0]?.name).toStrictEqual(legacyName);
      expect(compareDocuments(loadDocument(written), saved).differences.map(difference => difference.kind)).toStrictEqual(['page-box']);
    }
  });

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
    for (const fragment of ['/#E7#99#BD', '/#82b#82t#82s', '/ColorSpace<</CS1', '/CS2', '/C0[0 0 0 0]', '/C0[1]']) {
      expect(pdf).toContain(fragment);
    }
  });

  it('guards special names, ASCII policy, and conflicting alternates', () => {
    const document = createDocument({ colorantPolicy: { asciiOnly: true } });
    expect(() => document.separation({ name: 'All', alternate: rgb(1, 0, 0) })).toThrow(ValidationError);
    expect(() => document.separation({ name: 'é', alternate: rgb(1, 0, 0) })).toThrow(ValidationError);
    expect(() => document.separation({ name: new Uint8Array([0x82]), alternate: gray(0) })).toThrow(ValidationError);
    const none = document.separation({ name: 'None', alternate: gray(1), allow: 'None' });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    page.draw(content => {
      content.fillColor(none, 1);
    });
    expect(ascii(document.save().toBytes())).toContain('/Separation /None /DeviceGray');
    document.separation({ name: 'Spot', alternate: cmyk(0, 0, 0, 0.2) });
    expect(() => document.separation({ name: 'Spot', alternate: cmyk(0, 0, 0, 0.3) })).toThrow(ValidationError);
  });

  it('enforces the ASCII policy when a loaded document adds a plate, with typed errors', () => {
    const { bytes } = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
        ],
        trailer: '/Root 1 0 R',
      },
    ]);
    const document = loadDocument(bytes, { colorantPolicy: { asciiOnly: true } });
    expect(() => document.separation({ name: 'é', alternate: gray(1) })).toThrow(expect.objectContaining({ reason: 'colorant-ascii-only' }));
    expect(() => document.separation({ name: 'All', alternate: gray(1) })).toThrow(expect.objectContaining({ reason: 'reserved-colorant' }));
    expect(() => document.separation({ name: 'None', alternate: gray(1) })).toThrow(expect.objectContaining({ reason: 'reserved-colorant' }));
  });

  it('accepts only separations the same document created, as opaque frozen handles', () => {
    const document = createDocument();
    const other = createDocument();
    const foreign = other.separation({ name: 'Spot', alternate: cmyk(0, 0, 0, 0.5) });
    const alternate = cmyk(0, 0, 0, 0.5);
    const forged = { kind: 'Separation', name: new TextEncoder().encode('Spot'), alternate } as const;
    const own = document.separation({ name: 'Spot', alternate });
    expect([Object.isFrozen(own), Object.keys(own)]).toStrictEqual([true, ['kind']]);
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    page.draw(content => {
      for (const separation of [foreign, forged]) {
        expect(() => {
          content.fillColor(separation, 1);
        }).toThrow(ValidationError);
      }
    });
    for (const separation of [foreign, forged]) {
      expect(() => document.image({ width: 1, height: 1, colorSpace: separation, bitsPerComponent: 8, samples: new Uint8Array(1) })).toThrow(ValidationError);
    }
  });

  // ISO 32000-1:2008, 8.6.6.4: [/Separation name alternateSpace tintTransform]; 7.10.3, Table 40: a type 2 function maps tint 0 to C0 and tint 1 to C1, so C0 is no ink and C1 the alternate.
  it.each([
    {
      space: 'DeviceCMYK',
      alternate: cmyk(0.1, 0.2, 0.3, 0.4),
      array: '[/Separation /Spot /DeviceCMYK <</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0.1 0.2 0.3 0.4]/N 1>>]',
    },
    {
      space: 'DeviceRGB',
      alternate: rgb(0.1, 0.2, 0.3),
      array: '[/Separation /Spot /DeviceRGB <</FunctionType 2/Domain[0 1]/C0[1 1 1]/C1[0.1 0.2 0.3]/N 1>>]',
    },
    { space: 'DeviceGray', alternate: gray(0.25), array: '[/Separation /Spot /DeviceGray <</FunctionType 2/Domain[0 1]/C0[1]/C1[0.25]/N 1>>]' },
  ])('writes the whole Separation array for a $space alternate', ({ alternate, array }) => {
    expect(written(alternate)).toBe(array);
  });

  it('copies the alternate, so a later change to the caller’s components does not reach the file', () => {
    const components: [number, number, number, number] = [0, 0, 0, 0.5];
    const alternate: DeviceColor = { kind: 'DeviceCMYK', components };
    const record = createSeparationRecord({ name: 'Spot', alternate }, false);
    components[3] = 0.9;
    expect(latin1Text(serializeObject(separationObject(record), { fractionDigits: 5 }))).toContain('/C1[0 0 0 0.5]');
  });

  it.each([
    { name: 'Spot', allow: 'All', outcome: 'reserved-colorant' },
    { name: 'None', allow: 'All', outcome: 'reserved-colorant' },
    { name: 'All', allow: 'All', outcome: 'accepted' },
    { name: 'None', allow: 'None', outcome: 'accepted' },
  ] as const)('checks that allow $allow matches the name $name', ({ name, allow, outcome }) => {
    const document = createDocument();
    // ISO 32000-1:2008, 8.6.6.4 gives All and None defined meanings, so allow names the one special colorant being written.
    expect(separationOutcome(() => document.separation({ name, alternate: gray(1), allow }))).toBe(outcome);
  });

  it('writes an allowed All colorant under its name', () => {
    const document = createDocument();
    const all = document.separation({ name: 'All', alternate: gray(1), allow: 'All' });
    document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) }).draw(content => {
      content.fillColor(all, 1);
    });
    expect(ascii(document.save().toBytes())).toContain('/Separation /All /DeviceGray');
  });

  it.each([
    { hex: '20', byte: 0x20, outcome: 'colorant-ascii-only' },
    { hex: '21', byte: 0x21, outcome: 'accepted' },
    { hex: '7E', byte: 0x7e, outcome: 'accepted' },
    { hex: '7F', byte: 0x7f, outcome: 'colorant-ascii-only' },
  ])('applies the ASCII policy to byte 0x$hex', ({ byte, outcome }) => {
    const document = createDocument({ colorantPolicy: { asciiOnly: true } });
    expect(separationOutcome(() => document.separation({ name: new Uint8Array([0x53, byte]), alternate: gray(1) }))).toBe(outcome);
  });
});

const isReserved = (bytes: Uint8Array): boolean => ['All', 'None'].includes(latin1Text(bytes));

// Names of every length from 1 to `longest`, without the reserved All and None.
const colorantNames = (longest: number): fc.Arbitrary<Uint8Array> =>
  fc
    .integer({ min: 1, max: longest })
    .chain(length => fc.uint8Array({ min: 1, minLength: length, maxLength: length }))
    .filter(bytes => !isReserved(bytes));

describe('properties', () => {
  it('keeps any colorant name of 1 to 127 non-null bytes through a save and reload', () => {
    fc.assert(
      fc.property(colorantNames(127), name => {
        const document = createDocument();
        const spot = document.separation({ name, alternate: cmyk(0, 0, 0, 1) });
        document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) }).draw(content => {
          content.fillColor(spot, 1);
          content.path(path => path.rect(0, 0, 5, 5));
          content.fill('nonzero');
        });
        expect(listColorants(loadDocument(document.save().toBytes()))[0]?.colorants.map(colorant => colorant.name)).toStrictEqual([name]);
      }),
    );
  });

  it('accepts a name under the ASCII policy exactly when every byte is printable ASCII', () => {
    fc.assert(
      fc.property(colorantNames(16), name => {
        const document = createDocument({ colorantPolicy: { asciiOnly: true } });
        // ISO 32000-1:2008, 7.3.5 allows any byte but null in a name; the policy narrows that to 0x21 to 0x7E.
        const printable = name.every(byte => byte >= 0x21 && byte <= 0x7e);
        expect(separationOutcome(() => document.separation({ name, alternate: gray(1) }))).toBe(printable ? 'accepted' : 'colorant-ascii-only');
      }),
    );
  });
});
