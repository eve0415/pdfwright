import type { ColorSource, ColorTransformOptions } from '../color/createColorTransform.ts';
import type { PdfObject } from '../object/pdfObject.ts';

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { gammaCurveTag, iccProfileBytes } from '../testing/iccProfileBytes.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertIndexedSpaces } from './convertIndexed.ts';
import { convertToCmyk } from './convertToCmyk.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));
const displayP3 = await fixture('DisplayP3-v4.icc');
const grayIcc = parseIccProfile(
  iccProfileBytes({
    profileClass: 'mntr',
    colorSpace: 'GRAY',
    pcs: 'XYZ ',
    tags: [['kTRC', gammaCurveTag(1.8)]],
  }),
);
const pdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      {
        number: 3,
        body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</ColorSpace<</CS1[/Indexed/DeviceRGB 1<000000ff0000>]>>>>>>',
      },
      { number: 4, body: streamBody('', '/CS1 cs 1 sc 0 0 10 10 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const imagePdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Im 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Im Do') },
      {
        number: 5,
        body: streamBody(
          '/Type/XObject/Subtype/Image/Width 2/Height 1/BitsPerComponent 8/ColorSpace[/Indexed/DeviceRGB 1<000000ff0000>]',
          String.fromCodePoint(0, 1),
        ),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const formPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Fm 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Fm Do') },
      {
        number: 5,
        body: streamBody(
          '/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</ColorSpace<</CS1[/Indexed/DeviceRGB 1<000000ff0000>]>>>>',
          '/CS1 cs 1 sc 0 0 10 10 re f',
        ),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const DEFAULT_TRANSFORM = { intent: 'relativeColorimetric', blackPointCompensation: true } as const;

const lookupOf = (from: ColorSource, entries: ReadonlyArray<number>, options: ColorTransformOptions = DEFAULT_TRANSFORM): Uint8Array => {
  const channels = from.kind === 'calGray' || (from.kind === 'icc' && from.profile.header.colorSpace === 'Gray') ? 1 : 3;
  // ISO 32000-1:2008, 8.6.6.3: one lookup entry per index, each holding one colour in the base space.
  const output = new Uint8Array((entries.length / channels) * 4);
  createColorTransform(from, destination, options).convertRow8(Uint8Array.from(entries), output, entries.length / channels);
  return output;
};

interface TestObject {
  readonly number: number;
  readonly body: string;
}

const onePage = (page: string, objects: ReadonlyArray<TestObject>, catalog = ''): ReturnType<typeof loadDocument> =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: `<</Type/Catalog/Pages 2 0 R${catalog}>>` },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R${page}>>` },
          { number: 4, body: streamBody('', '/CS1 cs 1 sc 0 0 10 10 re f') },
          ...objects,
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );

const streamText = (document: ReturnType<typeof loadDocument>, number: number): string => {
  const stream = document.get(pdfReference(number, 0));
  const internals = internalsOf(document);
  if (stream.kind !== 'stream' || internals === undefined) {
    throw new Error('stream is missing');
  }
  const data = decodedData(internals, stream);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return latin1Text(data);
};

const lookupIn = (value: PdfObject | undefined): IndexedLookup => {
  if (value?.kind !== 'array') {
    throw new Error('Indexed space is missing');
  }
  const [, base, , lookup] = value.items;
  if (base?.kind !== 'name' || lookup?.kind !== 'string') {
    throw new Error('Indexed space is invalid');
  }
  return { base: new TextDecoder('latin1').decode(base.bytes), lookup: lookup.bytes };
};

const resourceLookup = (document: ReturnType<typeof loadDocument>, owner: number, name = 'CS1'): IndexedLookup => {
  const internals = internalsOf(document);
  const object = document.get(pdfReference(owner, 0));
  if (internals === undefined) {
    throw new Error('internals are missing');
  }
  const entries = object.kind === 'stream' ? object.dictionary : object.kind === 'dictionary' ? object.entries : undefined;
  const resources = internals.objects.deref(entries?.get(pdfName('Resources').bytes));
  const spaces = resources?.kind === 'dictionary' ? internals.objects.deref(resources.entries.get(pdfName('ColorSpace').bytes)) : undefined;
  if (spaces?.kind !== 'dictionary') {
    throw new Error('ColorSpace resources are missing');
  }
  return lookupIn(internals.objects.deref(spaces.entries.get(pdfName(name).bytes)));
};

interface IndexedLookup {
  readonly base: string;
  readonly lookup: Uint8Array;
}

const indexed = (document: ReturnType<typeof loadDocument>): IndexedLookup => {
  const spaces = document.page(0).resources().get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') {
    throw new Error('missing ColorSpace resources');
  }
  const value = spaces.entries.get(pdfName('CS1').bytes);
  if (value?.kind !== 'array') {
    throw new Error('missing Indexed space');
  }
  const [, base, , lookup] = value.items;
  if (base?.kind !== 'name' || lookup?.kind !== 'string') {
    throw new Error('invalid Indexed space');
  }
  return { base: new TextDecoder('latin1').decode(base.bytes), lookup: lookup.bytes };
};

const imageIndexed = (document: ReturnType<typeof loadDocument>): IndexedLookup & { readonly data: Uint8Array } => {
  const image = document.get(pdfReference(5, 0));
  if (image.kind !== 'stream') {
    throw new Error('image is missing');
  }
  const value = image.dictionary.get(pdfName('ColorSpace').bytes);
  if (value?.kind !== 'array') {
    throw new Error('Indexed image colour space is missing');
  }
  const [, base, , lookup] = value.items;
  if (base?.kind !== 'name' || lookup?.kind !== 'string') {
    throw new Error('Indexed image colour space is invalid');
  }
  return { base: new TextDecoder('latin1').decode(base.bytes), lookup: lookup.bytes, data: image.data };
};

const formIndexed = (document: ReturnType<typeof loadDocument>): IndexedLookup => {
  const form = document.get(pdfReference(5, 0));
  if (form.kind !== 'stream') {
    throw new Error('form is missing');
  }
  const resources = form.dictionary.get(pdfName('Resources').bytes);
  if (resources?.kind !== 'dictionary') {
    throw new Error('form resources are missing');
  }
  const spaces = resources.entries.get(pdfName('ColorSpace').bytes);
  if (spaces?.kind !== 'dictionary') {
    throw new Error('form ColorSpace resources are missing');
  }
  const value = spaces.entries.get(pdfName('CS1').bytes);
  if (value?.kind !== 'array') {
    throw new Error('form Indexed space is missing');
  }
  const [, base, , lookup] = value.items;
  if (base?.kind !== 'name' || lookup?.kind !== 'string') {
    throw new Error('form Indexed space is invalid');
  }
  return { base: new TextDecoder('latin1').decode(base.bytes), lookup: lookup.bytes };
};

describe('indexed colour conversion', () => {
  it('converts the lookup once', () => {
    const document = loadDocument(pdf.bytes);
    const report = convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Uint8Array(8);
    transform.convertRow8(Uint8Array.of(0, 0, 0, 255, 0, 0), expected, 2);
    expect(report.indexed).toBe(1);
    expect(indexed(document)).toStrictEqual({ base: 'DeviceCMYK', lookup: expected });
    expect(document.save().mode).toBe('full');
  });

  it('leaves painted index operands untouched when the whole document is converted', () => {
    // ISO 32000-1:2008, 8.6.6.3: an Indexed operand is an index into the lookup, so converting the lookup alone keeps every painted colour.
    const document = loadDocument(pdf.bytes);
    const report = convertToCmyk(document, {
      sourceRgbProfile: source.bytes,
      outputProfile: destination.bytes,
      outputIntent: { outputConditionIdentifier: 'FOGRA28' },
    });
    expect(report.indexed.indexed).toBe(1);
    expect(indexed(document)).toStrictEqual({ base: 'DeviceCMYK', lookup: lookupOf({ kind: 'icc', profile: source }, [0, 0, 0, 255, 0, 0]) });
    expect(streamText(document, 4)).toBe('/CS1 cs 1 sc 0 0 10 10 re f');
  });

  it('converts an image lookup without changing its index samples', () => {
    const document = loadDocument(imagePdf.bytes);
    const report = convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Uint8Array(8);
    transform.convertRow8(Uint8Array.of(0, 0, 0, 255, 0, 0), expected, 2);
    expect(report.indexed).toBe(1);
    expect(imageIndexed(document)).toStrictEqual({ base: 'DeviceCMYK', lookup: expected, data: Uint8Array.of(0, 1) });
  });

  it('converts a form resource lookup without rewriting its tint operands', () => {
    const document = loadDocument(formPdf.bytes);
    const report = convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.indexed).toBe(1);
    expect(formIndexed(document)).toStrictEqual({ base: 'DeviceCMYK', lookup: lookupOf({ kind: 'icc', profile: source }, [0, 0, 0, 255, 0, 0]) });
    expect(streamText(document, 5)).toBe('/CS1 cs 1 sc 0 0 10 10 re f');
  });

  it.each([
    { length: 5, lookup: '<000000ff00>' },
    { length: 7, lookup: '<000000ff000000>' },
  ])('refuses a $length-byte lookup for hival 1 over DeviceRGB', ({ lookup }) => {
    // ISO 32000-1:2008, 8.6.6.3: the lookup holds (hival + 1) × m bytes for an m-component base.
    const document = onePage(`/Resources<</ColorSpace<</CS1[/Indexed/DeviceRGB 1 ${lookup}]>>>>`, []);
    expect(() => convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }),
    );
  });

  it.each([
    {
      base: 'CalGray',
      space: '[/CalGray<</WhitePoint[0.9505 1 1.089]/Gamma 2.2>>]',
      from: { kind: 'calGray', whitePoint: { x: 0.9505, y: 1, z: 1.089 }, gamma: 2.2 },
    },
    { base: 'ICCBased gray', space: '[/ICCBased 7 0 R]', from: { kind: 'icc', profile: grayIcc } },
  ] as const)('writes a four-byte entry per index over $base', ({ space, from }) => {
    const entries = [0, 128];
    const document = onePage(`/Resources<</ColorSpace<</CS1[/Indexed${space} 1 <0080>]>>>>`, [
      { number: 7, body: streamBody('/N 1', latin1Text(grayIcc.bytes)) },
    ]);
    expect(convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination }).indexed).toBe(1);
    expect(resourceLookup(document, 3)).toStrictEqual({ base: 'DeviceCMYK', lookup: lookupOf(from, entries) });
  });

  it.each(['/DeviceCMYK', '/Lab', '/DeviceGray'])('leaves an Indexed space over %s unchanged and uncounted', base => {
    const space = base === '/Lab' ? '[/Lab<</WhitePoint[0.9505 1 1.089]>>]' : base;
    const document = onePage(`/Resources<</ColorSpace<</CS1[/Indexed${space} 0 <00000000>]>>>>`, []);
    const before = document.save().toBytes();
    expect(convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination }).indexed).toBe(0);
    expect(document.save().toBytes()).toStrictEqual(before);
  });

  it('refuses a shared Indexed image under two DefaultRGB spaces and counts one shared under the same space once', () => {
    const image = {
      number: 5,
      body: streamBody('/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace[/Indexed/DeviceRGB 0 <ff8040>]', '\0'),
    };
    const twoPages = (secondResources: string): ReturnType<typeof loadDocument> =>
      loadDocument(
        buildPdf([
          {
            xref: 'classic',
            objects: [
              { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
              { number: 2, body: '<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>' },
              { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Im 5 0 R>>>>>>' },
              { number: 4, body: streamBody('', '/Im Do') },
              image,
              { number: 6, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Im 5 0 R>>${secondResources}>>>>` },
              { number: 7, body: streamBody('/N 3', latin1Text(displayP3)) },
            ],
            trailer: '/Root 1 0 R',
          },
        ]).bytes,
      );
    expect(() =>
      convertIndexedSpaces(twoPages('/ColorSpace<</DefaultRGB[/ICCBased 7 0 R]>>'), { sourceRgbProfile: source, outputProfile: destination }),
    ).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }));
    const shared = twoPages('');
    expect(convertIndexedSpaces(shared, { sourceRgbProfile: source, outputProfile: destination }).indexed).toBe(1);
    const converted = shared.get(pdfReference(5, 0));
    expect(lookupIn(converted.kind === 'stream' ? converted.dictionary.get(pdfName('ColorSpace').bytes) : undefined)).toStrictEqual({
      base: 'DeviceCMYK',
      lookup: lookupOf({ kind: 'icc', profile: source }, [255, 128, 64]),
    });
  });

  it('deletes a replaced indirect ColorSpace dictionary and Indexed array that nothing else references', () => {
    const objects = [
      { number: 8, body: '<</CS1 9 0 R>>' },
      { number: 9, body: '[/Indexed/DeviceRGB 0 <ff8040>]' },
    ];
    const document = onePage('/Resources<</ColorSpace 8 0 R>>', objects);
    convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    expect([document.get(pdfReference(8, 0)), document.get(pdfReference(9, 0))]).toStrictEqual([{ kind: 'null' }, { kind: 'null' }]);
    expect(resourceLookup(document, 3)).toStrictEqual({ base: 'DeviceCMYK', lookup: lookupOf({ kind: 'icc', profile: source }, [255, 128, 64]) });
  });

  it('keeps a replaced Indexed array that is still referenced elsewhere', () => {
    const objects = [
      { number: 8, body: '<</CS1 9 0 R>>' },
      { number: 9, body: '[/Indexed/DeviceRGB 0 <ff8040>]' },
    ];
    const document = onePage('/Resources<</ColorSpace 8 0 R>>', objects, '/Kept 9 0 R');
    convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(document.get(pdfReference(8, 0))).toStrictEqual({ kind: 'null' });
    expect(lookupIn(document.get(pdfReference(9, 0)))).toStrictEqual({ base: 'DeviceRGB', lookup: Uint8Array.of(255, 128, 64) });
  });

  it('converts a page lookup once when a form without Resources inherits it', () => {
    const objects = [{ number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]', '/CS1 cs 1 sc 0 0 10 10 re f') }];
    const document = onePage('/Resources<</ColorSpace<</CS1[/Indexed/DeviceRGB 0 <ff8040>]>>/XObject<</Fm 5 0 R>>>>', objects);
    expect(convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination }).indexed).toBe(1);
    const form = document.get(pdfReference(5, 0));
    expect(form.kind === 'stream' ? form.dictionary.has(pdfName('Resources').bytes) : undefined).toBe(false);
  });

  it('converts a lookup in a nested form and stops at a form cycle', () => {
    const objects = [
      { number: 5, body: streamBody('/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</XObject<</Inner 6 0 R>>>>', '/Inner Do') },
      {
        number: 6,
        body: streamBody(
          '/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Resources<</XObject<</Outer 5 0 R>>/ColorSpace<</CS1[/Indexed/DeviceRGB 0 <ff8040>]>>>>',
          '/CS1 cs 0 sc',
        ),
      },
    ];
    const document = onePage('/Resources<</XObject<</Fm 5 0 R>>>>', objects);
    expect(convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination }).indexed).toBe(1);
    expect(resourceLookup(document, 6)).toStrictEqual({ base: 'DeviceCMYK', lookup: lookupOf({ kind: 'icc', profile: source }, [255, 128, 64]) });
  });

  it.each([
    { options: { intent: 'perceptual' }, transform: { intent: 'perceptual', blackPointCompensation: true } },
    { options: { blackPointCompensation: false }, transform: { intent: 'relativeColorimetric', blackPointCompensation: false } },
  ] as const)('converts the lookup with $transform', ({ options, transform }) => {
    const entries = [0, 0, 0, 255, 128, 64, 20, 20, 20];
    const lookup = entries.map(value => value.toString(16).padStart(2, '0')).join('');
    const document = onePage(`/Resources<</ColorSpace<</CS1[/Indexed/DeviceRGB 2 <${lookup}>]>>>>`, []);
    convertIndexedSpaces(document, { sourceRgbProfile: source, outputProfile: destination, ...options });
    const expected = lookupOf({ kind: 'icc', profile: source }, entries, transform);
    expect(expected).not.toStrictEqual(lookupOf({ kind: 'icc', profile: source }, entries));
    expect(resourceLookup(document, 3)).toStrictEqual({ base: 'DeviceCMYK', lookup: expected });
  });
});
