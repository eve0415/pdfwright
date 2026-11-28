import type { Fill, IllustratorDocument, Item, PathGeometry, PathItem, SpotColor, Stroke, Subpath } from '../model/illustratorDocument.ts';
import type { LoadedDocument, PdfDictionaryEntries, PdfObject } from '@pdfwright/core';

import { ValidationError, createDocument, inflateZlib, loadDocument, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { drawPage } from './drawPage.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' });
const outline: Subpath = {
  start: [10, 10],
  segments: [
    { kind: 'line', to: [40, 10] },
    { kind: 'line', to: [40, 30] },
    { kind: 'line', to: [10, 30] },
  ],
};
const fill: Fill = { paint: { kind: 'process', cmyk: [0, 0, 1, 0] } };
const stroke: Stroke = { paint: { kind: 'spot', spot: { name: 'Cut', alternate: [0, 1, 0, 0] } }, width: 0 };
const path: PathItem = { kind: 'path', geometry: { subpaths: [outline] }, fill, stroke };

const latin1 = new TextDecoder('latin1');
const key = (text: string): Uint8Array => new TextEncoder().encode(text);

const render = (model: IllustratorDocument): LoadedDocument => {
  const document = createDocument();
  drawPage(document, model);
  return loadDocument(document.save().toBytes());
};

const resolved = (loaded: LoadedDocument, value: PdfObject | undefined): PdfObject | undefined => (value?.kind === 'reference' ? loaded.get(value) : value);

const dictionaryOf = (loaded: LoadedDocument, value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  const object = resolved(loaded, value);
  return object?.kind === 'dictionary' ? object.entries : object?.kind === 'stream' ? object.dictionary : undefined;
};

const streamText = (loaded: LoadedDocument, value: PdfObject | undefined): string => {
  const object = resolved(loaded, value);
  return object?.kind === 'stream' ? latin1.decode(inflateZlib(object.data).data) : '';
};

const nameText = (value: PdfObject | undefined): string | undefined => (value?.kind === 'name' ? latin1.decode(value.bytes) : undefined);

const pageContent = (loaded: LoadedDocument): string => streamText(loaded, dictionaryOf(loaded, loaded.page(0).reference)?.get(key('Contents')));

// The ExtGState dictionary that each `gs` operator in the page content selects, in drawing order.
const selectedStates = (loaded: LoadedDocument): Array<PdfDictionaryEntries | undefined> => {
  const states = dictionaryOf(loaded, loaded.page(0).resources().get(key('ExtGState')));
  return [...pageContent(loaded).matchAll(/\/(\S+) gs\n/gu)].map(match => dictionaryOf(loaded, states?.get(key(match[1] ?? ''))));
};

// Starting at the page, the fill alphas set by the ExtGState resources of each stream in turn, following the form XObject that stream draws.
const alphasByForm = (loaded: LoadedDocument): Array<Array<number>> => {
  const levels: Array<Array<number>> = [];
  let resources: PdfDictionaryEntries | undefined = loaded.page(0).resources();
  while (resources !== undefined) {
    const states = [...(dictionaryOf(loaded, resources.get(key('ExtGState')))?.entries() ?? [])];
    levels.push(
      states.flatMap(([, state]) => {
        const alpha = dictionaryOf(loaded, state)?.get(key('ca'));
        return alpha?.kind === 'real' && typeof alpha.value === 'number' ? [alpha.value] : [];
      }),
    );
    const forms = [...(dictionaryOf(loaded, resources.get(key('XObject')))?.entries() ?? [])].map(([, form]) => dictionaryOf(loaded, form));
    const form = forms.find(entries => nameText(entries?.get(key('Subtype'))) === 'Form');
    resources = dictionaryOf(loaded, form?.get(key('Resources')));
  }
  return levels;
};

const formCount = (loaded: LoadedDocument): number =>
  [...(dictionaryOf(loaded, loaded.page(0).resources().get(key('XObject')))?.entries() ?? [])].filter(
    ([, value]) => nameText(dictionaryOf(loaded, value)?.get(key('Subtype'))) === 'Form',
  ).length;

const spotRaster = (spot: SpotColor, samples?: Uint8Array): Item => ({
  kind: 'raster',
  width: 3,
  height: 1,
  bounds: { x: 0, y: 0, width: 30, height: 10 },
  color: samples === undefined ? { space: 'spot', spot } : { space: 'spot', spot, samples },
  alpha: Uint8Array.of(255, 128, 0),
});

const model = (layers: IllustratorDocument['layers'], artboard: IllustratorDocument['artboard'] = { width: 100, height: 70 }): IllustratorDocument => ({
  artboard,
  layers,
  lastModified: date,
});

describe('visible Illustrator page', () => {
  it('places paths and clips in a bleed-offset CMYK page and leaves hidden layers out', () => {
    const loaded = render(
      model(
        [
          { name: 'Hidden', visible: false, items: [{ ...path, geometry: { subpaths: [{ start: [99, 99], segments: [{ kind: 'line', to: [100, 99] }] }] } }] },
          { name: 'Visible', items: [{ kind: 'clipGroup', clip: path.geometry, items: [path] }] },
        ],
        { width: 100, height: 70, bleed: 3 },
      ),
    );
    const content = pageContent(loaded);
    const boxes = loaded.page(0).boxes();
    const group = dictionaryOf(loaded, dictionaryOf(loaded, loaded.page(0).reference)?.get(key('Group')));
    expect({
      media: boxes.MediaBox.rect,
      trim: boxes.TrimBox.rect,
      // The visible art is the outline from (10, 10) to (40, 30), moved by the 3-point bleed.
      art: boxes.ArtBox.rect,
      group: [nameText(group?.get(key('S'))), nameText(group?.get(key('CS')))],
    }).toStrictEqual({ media: [0, 0, 106, 76], trim: [3, 3, 103, 73], art: [13, 13, 43, 33], group: ['Transparency', 'DeviceCMYK'] });
    expect(content.startsWith('q\n1 0 0 1 3 3 cm\n')).toBe(true);
    expect(content).not.toContain('99 99 m');
    expect(content).toContain('0 w\n');
    expect(content).toContain('B\n');
    expect(content).toContain('W\nn\n');
  });

  it('offsets every box and the content by a different bleed on each side', () => {
    const loaded = render(model([{ name: 'Art', items: [path] }], { width: 50, height: 40, bleed: { top: 1, right: 2, bottom: 3, left: 4 } }));
    const boxes = loaded.page(0).boxes();
    expect([boxes.MediaBox.rect, boxes.TrimBox.rect, boxes.ArtBox.rect]).toStrictEqual([
      [0, 0, 56, 44],
      [4, 3, 54, 43],
      [14, 13, 44, 33],
    ]);
    expect(pageContent(loaded).startsWith('q\n1 0 0 1 4 3 cm\n')).toBe(true);
  });

  // ISO 32000-1:2008, 14.11.2.1: an art box beyond the media box is reduced to its intersection with it, and a page without one falls back to the crop box.
  // The artboard is 100 × 70 with a 3-point bleed, so the media box runs from (0, 0) to (106, 76) and art at (x, y) lands at (x + 3, y + 3).
  it.each([
    // A raster from (−500, 10) to (−490, 30) lies wholly left of the media box.
    {
      case: 'leaves out the ArtBox of art outside the media box',
      bounds: { x: -500, y: 10, width: 10, height: 20 },
      art: { rect: [0, 0, 106, 76], explicit: false },
    },
    // A raster from (−10, 10) to (20, 30) crosses the left bleed edge at −3.
    {
      case: 'clamps the ArtBox of art that crosses the left bleed edge',
      bounds: { x: -10, y: 10, width: 30, height: 20 },
      art: { rect: [0, 13, 23, 33], explicit: true },
    },
    // A raster from (10, −10) to (30, 20) crosses the bottom bleed edge at −3.
    {
      case: 'clamps the ArtBox of art that crosses the bottom bleed edge',
      bounds: { x: 10, y: -10, width: 20, height: 30 },
      art: { rect: [13, 0, 33, 23], explicit: true },
    },
    // A raster from (90, 60) to (120, 90) crosses the right bleed edge at 103 and the top one at 73.
    {
      case: 'clamps the ArtBox of art that crosses the right and top bleed edges',
      bounds: { x: 90, y: 60, width: 30, height: 30 },
      art: { rect: [93, 63, 106, 76], explicit: true },
    },
    // A raster from (−10, −10) to (120, 90) crosses all four bleed edges.
    {
      case: 'clamps the ArtBox of art that crosses every bleed edge',
      bounds: { x: -10, y: -10, width: 130, height: 100 },
      art: { rect: [0, 0, 106, 76], explicit: true },
    },
  ])('$case', ({ bounds, art }) => {
    const raster: Item = {
      kind: 'raster',
      width: 1,
      height: 1,
      bounds,
      color: { space: 'cmyk', samples: new Uint8Array(4) },
      alpha: Uint8Array.of(255),
    };
    const { rect, explicit } = render(model([{ name: 'Art', items: [raster] }], { width: 100, height: 70, bleed: 3 }))
      .page(0)
      .boxes().ArtBox;
    expect({ rect, explicit }).toStrictEqual(art);
  });

  it('draws every subpath of a compound path and clip into one path painted by its fill rule', () => {
    const hole: Subpath = { start: [20, 15], segments: [{ kind: 'quadratic', control: [26, 27], to: [32, 15] }] };
    const pieces: PathGeometry = { subpaths: [outline, hole] };
    const evenOdd: PathGeometry = { ...pieces, fillRule: 'evenodd' };
    const content = pageContent(
      render(
        model([
          {
            name: 'Compound',
            items: [
              { kind: 'path', geometry: pieces, stroke },
              { kind: 'path', geometry: evenOdd, fill },
              { kind: 'path', geometry: evenOdd, fill, stroke },
              { kind: 'path', geometry: pieces, fill },
              { kind: 'clipGroup', clip: pieces, items: [path] },
              { kind: 'clipGroup', clip: evenOdd, items: [path] },
            ],
          },
        ]),
      ),
    );
    // The quadratic from (20, 15) through (26, 27) to (32, 15) is the cubic with controls (24, 23) and (28, 23).
    const geometry = '10 10 m\n40 10 l\n40 30 l\n10 30 l\nh\n20 15 m\n24 23 28 23 32 15 c\nh\n';
    const paths = [...content.matchAll(/10 10 m\n[^]*?\n(?:S|f\*?|B\*?|W\*?\nn)\n/gu)].map(match => match[0]);
    const painted = paths.filter(drawn => drawn.includes('20 15 m\n'));
    expect(painted).toStrictEqual(['S', 'f*', 'B*', 'f', 'W\nn', 'W*\nn'].map(operator => `${geometry}${operator}\n`));
  });

  it('draws spot rasters as Separation images sharing a soft mask', () => {
    const alpha = new Uint8Array([255, 128, 0]);
    const bounds = { x: 0, y: 0, width: 30, height: 10 };
    const white = { name: 'White', alternate: [0, 0, 0, 0.1] } as const;
    const primer = { name: 'Primer', alternate: [0, 0, 0, 0.2] } as const;
    const document = createDocument();
    drawPage(
      document,
      model(
        [
          { name: 'White', items: [{ kind: 'raster', width: 3, height: 1, bounds, color: { space: 'spot', spot: white }, alpha }] },
          { name: 'Primer', items: [{ kind: 'raster', width: 3, height: 1, bounds, color: { space: 'spot', spot: primer }, alpha }] },
          {
            name: 'Design',
            items: [
              { kind: 'raster', width: 1, height: 1, bounds, color: { space: 'cmyk', samples: new Uint8Array([0, 10, 20, 30]) }, alpha: new Uint8Array([255]) },
            ],
          },
        ],
        { width: 50, height: 40 },
      ),
    );
    const pdf = latin1.decode(document.save().toBytes());
    expect([
      pdf.includes('/ImageMask true'),
      pdf.match(/\/SMask \d+ 0 R/gu)?.length,
      new Set([...pdf.matchAll(/\/SMask (\d+) 0 R/gu)].map(match => match[1])).size,
    ]).toStrictEqual([false, 3, 2]);
    expect(pdf).toContain('/SMask');
    expect(pdf).toContain('/ColorSpace/DeviceCMYK');
    expect(pdf).toContain('/Separation /White');
    expect(pdf).toContain('/Separation /Primer');
  });

  it('gives a spot raster without samples full tint in every pixel', () => {
    const varnish: SpotColor = { name: 'Varnish', alternate: [0, 0, 0, 0.2] };
    const primer: SpotColor = { name: 'Primer', alternate: [0, 0, 0, 0.3] };
    const loaded = render(model([{ name: 'Art', items: [spotRaster(varnish), spotRaster(primer, Uint8Array.of(10, 20, 30))] }]));
    const images = [...(dictionaryOf(loaded, loaded.page(0).resources().get(key('XObject')))?.entries() ?? [])].flatMap(([, value]) => {
      const image = resolved(loaded, value);
      if (image?.kind !== 'stream') {
        return [];
      }
      const space = resolved(loaded, image.dictionary.get(key('ColorSpace')));
      const colorant = space?.kind === 'array' ? nameText(space.items[1]) : undefined;
      return [{ colorant, samples: [...inflateZlib(image.data).data] }];
    });
    expect(images.toSorted((left, right) => String(left.colorant).localeCompare(String(right.colorant)))).toStrictEqual([
      { colorant: 'Primer', samples: [10, 20, 30] },
      { colorant: 'Varnish', samples: [255, 255, 255] },
    ]);
  });

  it('names a Separation by the spot colour name bytes when the spot has them', () => {
    // ISO 32000-1:2008, 8.6.6.4: the colorant name of a Separation colour space is a name object, which holds bytes rather than text.
    const spot: SpotColor = { name: 'Weiß', nameBytes: Uint8Array.of(0x57, 0x65, 0x69, 0xdf), alternate: [0, 0, 0, 0] };
    const loaded = render(model([{ name: 'Art', items: [{ kind: 'path', geometry: path.geometry, fill: { paint: { kind: 'spot', spot } } }] }]));
    const spaces = [...(dictionaryOf(loaded, loaded.page(0).resources().get(key('ColorSpace')))?.entries() ?? [])].map(([, value]) => {
      const space = resolved(loaded, value);
      const colorant = space?.kind === 'array' ? space.items[1] : undefined;
      return colorant?.kind === 'name' ? [...colorant.bytes] : [];
    });
    expect(spaces).toStrictEqual([[0x57, 0x65, 0x69, 0xdf]]);
  });

  it('sets fill and stroke overprint on their own channels', () => {
    const fillOnly: PathItem = { kind: 'path', geometry: path.geometry, fill: { ...fill, overprint: true } };
    const strokeOnly: PathItem = { kind: 'path', geometry: path.geometry, stroke: { ...stroke, overprint: true } };
    const flags = selectedStates(render(model([{ name: 'Art', items: [fillOnly, strokeOnly] }]))).map(state => {
      const flag = (name: string): boolean | number | undefined => {
        const value = state?.get(key(name));
        return value?.kind === 'boolean' || value?.kind === 'integer' ? value.value : undefined;
      };
      // ISO 32000-1:2008, 8.6.7 and Table 58: op is fill overprint, OP stroke overprint, and OPM 1 the nonzero overprint mode.
      return { op: flag('op'), OP: flag('OP'), OPM: flag('OPM') };
    });
    expect(flags).toStrictEqual([
      { op: true, OP: false, OPM: 1 },
      { op: false, OP: true, OPM: 1 },
    ]);
  });

  it('draws layer and isolated group opacity outside their forms', () => {
    const document = createDocument();
    drawPage(
      document,
      model([{ name: 'Primer', opacity: 0.3, items: [{ kind: 'group', opacity: 0.5, isolated: true, items: [path] }] }], { width: 50, height: 40 }),
    );
    const bytes = document.save().toBytes();
    const pdf = latin1.decode(bytes);
    const loaded = loadDocument(bytes);
    expect(pdf.match(/\/Subtype\/Form/gu)).toHaveLength(2);
    expect(pdf).toContain('/I true');
    expect(pdf).toContain('/I false');
    // The page sets the layer opacity before drawing the layer form, the layer form sets the group opacity before drawing the group form, and the group form sets none.
    expect(alphasByForm(loaded)).toStrictEqual([[0.3], [0.5], []]);
  });

  it.each([
    { opacity: 1, forms: 0 },
    { opacity: 0.999, forms: 1 },
  ])('draws a layer of opacity $opacity through $forms forms', ({ opacity, forms }) => {
    expect(formCount(render(model([{ name: 'Art', opacity, items: [path] }])))).toBe(forms);
  });

  it('validates the model when no prepared document is given', () => {
    const duplicated = model([
      { name: 'Art', items: [path] },
      { name: 'Art', items: [path] },
    ]);
    expect(() => drawPage(createDocument(), duplicated)).toThrow(ValidationError);
    expect(() => drawPage(createDocument(), duplicated)).toThrow(expect.objectContaining({ reason: 'illustrator-model' }));
  });
});
