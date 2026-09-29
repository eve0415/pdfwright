import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { TextPdf } from '../../testing/textPdf.ts';
import type { PageColorants } from './listColorants.ts';

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';

import { describe, expect, it } from 'vitest';

import { renderPagePlates } from '../../../../../scripts/plateOracle.ts';
import { loadDocument } from '../../document/loadDocument.ts';
import { latin1Text, streamBody } from '../../testing/pdfBuilder.ts';
import { textPdfBytes } from '../../testing/textPdf.ts';

import { listColorants } from './listColorants.ts';

const CORPUS = path.join(import.meta.dirname, '../../../test/corpus');

const tint = (c1 = '0 1 0 0'): string => `<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[${c1}]/N 1>>`;
const separation = (name: string, c1?: string): string => `[/Separation/${name}/DeviceCMYK ${tint(c1)}]`;
const form = (resources: string, content: string, box = '[0 0 200 200]'): string =>
  streamBody(`/Type/XObject/Subtype/Form/BBox${box}/Resources<<${resources}>>`, content);
const HELVETICA = '/Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>';

/** A one-page fixture, and the differences from Ghostscript's plates recorded for it. */
interface PlateCase {
  readonly name: string;
  readonly pdf: TextPdf;
  /** Spot colorants pdfwright reports as painted for which Ghostscript makes no plate. */
  readonly unplated?: readonly string[];
  /** Plates Ghostscript makes for colorants pdfwright reports as neither painted nor selected. */
  readonly plated?: readonly string[];
}

const page = (content: string, resources: string, entries = ''): TextPdf['pages'] => [{ content, resources, entries }];

// A page with a painted spot, spots only in resources, All and None, a form, an NChannel image, a shading and an annotation appearance.
const SPOT_OBJECTS: readonly TestObject[] = [
  { number: 100, body: form(`/ColorSpace<</CSf ${separation('InForm', '1 0 0 0')}>>`, '/CSf cs 0.5 scn 70 10 30 30 re f') },
  { number: 101, body: form(`/ColorSpace<</CSa ${separation('InAnnot')}>>`, '/CSa cs 1 scn 0 0 20 20 re f', '[0 0 20 20]') },
  {
    number: 102,
    body: streamBody(
      `/Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace[/DeviceN[/ImgA/ImgB]/DeviceCMYK 103 0 R<</Subtype/NChannel/Colorants<</ImgA ${separation('ImgA')}/ImgB ${separation('ImgB', '1 0 0 0')}>>>>]`,
      '\u0080@',
    ),
  },
  { number: 103, body: streamBody('/FunctionType 4/Domain[0 1 0 1]/Range[0 1 0 1 0 1 0 1]', '{ 0 0 }') },
  { number: 104, body: `<</ShadingType 2/ColorSpace ${separation('InShading')}/Coords[0 0 100 0]/Function<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N 1>>>>` },
];
const SPOT_RESOURCES = `/ColorSpace<</CSused ${separation('Used')}/CSunused ${separation('DeclaredOnly')}/CSall ${separation('All')}/CSnone ${separation('None')}/CSproc ${separation('Cyan')}>>/XObject<</Fm1 100 0 R/Im1 102 0 R>>/Shading<</Sh1 104 0 R>>`;
const annotation = (flags: string): string => `/Annots[<</Type/Annot/Subtype/Square${flags}/Rect[150 150 170 170]/AP<</N 101 0 R>>>>]`;

const type3Font = (procedure: string): readonly TestObject[] => [
  {
    number: 110,
    body: '<</Type/Font/Subtype/Type3/FontBBox[0 0 1000 1000]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</a 111 0 R>>/Encoding<</Differences[97/a]>>/FirstChar 97/LastChar 97/Widths[1000]/Resources<</ColorSpace<</CSg 112 0 R>>>>>>',
  },
  { number: 111, body: streamBody('', `${procedure} /CSg cs 1 scn 0 0 1000 1000 re f`) },
];

const CASES: readonly PlateCase[] = [
  { name: 'spots', pdf: { pages: page('/CSused cs 1 scn 10 10 50 50 re f /Fm1 Do /Im1 Do /Sh1 sh', SPOT_RESOURCES, annotation('')), objects: SPOT_OBJECTS } },
  {
    name: 'spots-print',
    pdf: { pages: page('/CSused cs 1 scn 10 10 50 50 re f /Fm1 Do /Im1 Do /Sh1 sh', SPOT_RESOURCES, annotation('/F 4')), objects: SPOT_OBJECTS },
  },
  {
    name: 'all-none',
    pdf: {
      pages: page(
        '/CSall cs 1 scn 10 10 50 50 re f /CSnone cs 1 scn 100 100 50 50 re f /CSproc cs 1 scn 60 120 20 20 re f',
        SPOT_RESOURCES,
        annotation('/F 4'),
      ),
      objects: SPOT_OBJECTS,
    },
  },
  {
    name: 'form-unused',
    pdf: {
      pages: page('0.4 g 10 10 50 50 re f /Fm1 Do', '/XObject<</Fm1 100 0 R>>'),
      objects: [{ number: 100, body: form(`/ColorSpace<</CS0 ${separation('FormUnused')}>>`, '0.6 g 70 10 30 30 re f') }],
    },
  },
  { name: 'cs-no-paint', pdf: { pages: page('/CS1 cs 1 scn 0 g 10 10 50 50 re f', `/ColorSpace<</CS1 ${separation('CsNoPaint')}>>`) } },
  { name: 'clip-only', pdf: { pages: page('/CS1 cs 1 scn 0 0 10 10 re W n', `/ColorSpace<</CS1 ${separation('CsThenClipOnly')}>>`) } },
  {
    name: 'separation-info',
    pdf: { pages: page('0.2 g 10 10 30 30 re f', '', `/SeparationInfo<</Pages[3 0 R]/DeviceColorant/SepInfoOnly/ColorSpace ${separation('SepInfoOnly')}>>`) },
  },
  {
    name: 'soft-mask',
    pdf: {
      pages: page(
        'q /GS1 gs 1 g 0 0 200 200 re f Q',
        '/ExtGState<</GS1<</Type/ExtGState/SMask<</S/Luminosity/G 100 0 R>>>>>>',
        '/Group<</S/Transparency/CS/DeviceGray>>',
      ),
      objects: [
        {
          number: 100,
          body: streamBody(
            `/Type/XObject/Subtype/Form/BBox[0 0 200 200]/Group<</S/Transparency/CS/DeviceGray/I true>>/Resources<</ColorSpace<</CSs ${separation('SMaskOnly')}>>>>`,
            '/CSs cs 1 scn 0 0 200 200 re f',
          ),
        },
      ],
    },
  },
  {
    name: 'd1-glyph',
    pdf: {
      pages: page('0.3 g BT /T1 24 Tf 50 50 Td (a) Tj ET', '/Font<</T1 110 0 R>>'),
      objects: [...type3Font('1000 0 0 0 1000 1000 d1'), { number: 112, body: separation('D1Glyph') }],
    },
  },
  {
    name: 'd0-glyph',
    pdf: {
      pages: page('0.3 g BT /T1 24 Tf 50 50 Td (a) Tj ET', '/Font<</T1 110 0 R>>'),
      objects: [...type3Font('1000 0 d0'), { number: 112, body: separation('D0Glyph') }],
    },
  },
  {
    name: 'uncoloured-pattern',
    pdf: {
      pages: page('/CS1 cs 0.5 /P0 scn 10 10 100 100 re f', '/ColorSpace<</CS1[/Pattern/DeviceGray]>>/Pattern<</P0 100 0 R>>'),
      objects: [
        {
          number: 100,
          body: streamBody(
            `/Type/Pattern/PatternType 1/PaintType 2/TilingType 1/BBox[0 0 10 10]/XStep 10/YStep 10/Resources<</ColorSpace<</CSp ${separation('UncolPattern')}>>>>`,
            '/CSp cs 1 scn 0 0 10 10 re f',
          ),
        },
      ],
    },
    // 8.6.8 makes colour operators in an uncoloured tiling pattern an error, and pdfwright declares the colorant; Ghostscript executes the selection and makes the plate.
    plated: ['UncolPattern'],
  },
  {
    name: 'uncoloured-pattern-base',
    pdf: {
      pages: page('/CS2 cs 0.7 /P0b scn 10 10 100 100 re f', `/ColorSpace<</CS2[/Pattern ${separation('UncolBase')}]>>/Pattern<</P0b 100 0 R>>`),
      objects: [
        {
          number: 100,
          body: streamBody('/Type/Pattern/PatternType 1/PaintType 2/TilingType 1/BBox[0 0 10 10]/XStep 10/YStep 10/Resources<<>>', '0 0 10 10 re f'),
        },
      ],
    },
  },
  {
    name: 'nchannel',
    pdf: {
      pages: page(
        '/CScn cs 1 1 scn 20 20 40 40 re f',
        `/ColorSpace<</CScn[/DeviceN[/Cyan/NChanComp]/DeviceCMYK 100 0 R<</Subtype/NChannel/Colorants<</NChanComp ${separation('NChanComp')}/NChanExtra ${separation('NChanExtra')}>>>>]>>`,
      ),
      objects: [{ number: 100, body: streamBody('/FunctionType 4/Domain[0 1 0 1]/Range[0 1 0 1 0 1 0 1]', '{ pop pop 0 0 0 0 }') }],
    },
  },
  { name: 'zero-tint', pdf: { pages: page('/CSz cs 0 scn 10 10 50 50 re f', `/ColorSpace<</CSz ${separation('ZeroTint')}>>`) } },
  { name: 'outside-crop', pdf: { pages: page('/CSo cs 1 scn 10000 10000 50 50 re f', `/ColorSpace<</CSo ${separation('OutsideCrop')}>>`) } },
  { name: 'fully-clipped', pdf: { pages: page('0 0 1 1 re W n /CSc cs 1 scn 50 50 40 40 re f', `/ColorSpace<</CSc ${separation('FullyClipped')}>>`) } },
  {
    name: 'invisible-text',
    pdf: { pages: page('/CSt cs 1 scn BT /F1 24 Tf 3 Tr 50 50 Td (A) Tj ET', `/ColorSpace<</CSt ${separation('TextInvisible')}>>${HELVETICA}`) },
  },
  {
    name: 'hidden-annotation',
    pdf: {
      pages: page('0.9 g 0 0 200 200 re f', '', '/Annots[<</Type/Annot/Subtype/Square/Rect[50 50 70 70]/F 6/AP<</N 100 0 R>>>>]'),
      objects: [{ number: 100, body: form(`/ColorSpace<</CSh ${separation('HiddenAnnot')}>>`, '/CSh cs 1 scn 0 0 20 20 re f', '[0 0 20 20]') }],
    },
  },
  {
    name: 'appearance-states',
    pdf: {
      pages: page('0.9 g 0 0 200 200 re f', '', '/Annots[<</Type/Annot/Subtype/Square/Rect[50 50 70 70]/F 4/AP<</N<</On 100 0 R/Off 101 0 R>>>>/AS/Off>>]'),
      objects: [
        { number: 100, body: form(`/ColorSpace<</CSon ${separation('OnOnly')}>>`, '/CSon cs 1 scn 0 0 20 20 re f', '[0 0 20 20]') },
        { number: 101, body: form(`/ColorSpace<</CSoff ${separation('OffOnly')}>>`, '/CSoff cs 1 scn 0 0 20 20 re f', '[0 0 20 20]') },
      ],
    },
    // Ghostscript prints the selected state of an appearance subdictionary without making its spot plate, reporting that it skips colour separations.
    unplated: ['OffOnly'],
  },
  {
    name: 'hidden-optional-content',
    pdf: {
      pages: page('/OC /MC1 BDC /CSoc cs 1 scn 10 10 50 50 re f EMC', `/ColorSpace<</CSoc ${separation('OCOff')}>>/Properties<</MC1 100 0 R>>`),
      objects: [{ number: 100, body: '<</Type/OCG/Name(oc1)>>' }],
      catalog: '/OCProperties<</OCGs[100 0 R]/D<</OFF[100 0 R]>>>>',
    },
  },
  {
    name: 'shading-pattern',
    pdf: {
      pages: page('/Pattern cs /P1 scn 10 10 100 100 re f', '/Pattern<</P1 100 0 R>>'),
      objects: [
        {
          number: 100,
          body: `<</Type/Pattern/PatternType 2/Shading<</ShadingType 2/ColorSpace ${separation('ShadeSpot')}/Coords[0 0 100 0]/Function<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N 1>>>>>>`,
        },
      ],
    },
  },
  {
    name: 'image-mask',
    pdf: {
      pages: page('/CSim cs 1 scn q 100 0 0 100 10 10 cm /Im1 Do Q', `/ColorSpace<</CSim ${separation('ImageMaskSpot')}>>/XObject<</Im1 100 0 R>>`),
      objects: [
        {
          number: 100,
          body: streamBody('/Type/XObject/Subtype/Image/Width 4/Height 4/ImageMask true/BitsPerComponent 1/Decode[0 1]', '\u0000\u0000\u0000\u0000'),
        },
      ],
    },
  },
  {
    name: 'declared-beside-painted',
    pdf: {
      pages: page('/Fm1 Do', `/ColorSpace<</CSunused ${separation('DeclaredOnly2')}>>/XObject<</Fm1 100 0 R>>`),
      objects: [{ number: 100, body: form(`/ColorSpace<</CSf ${separation('PaintedElsewhere')}>>`, '/CSf cs 1 scn 20 20 40 40 re f') }],
    },
  },
  {
    name: 'inline-image-mask',
    pdf: {
      pages: page(
        '/CSii cs 1 scn q 100 0 0 100 10 10 cm BI /IM true /W 4 /H 4 /BPC 1 /D [0 1] ID \u0000\u0000\u0000\u0000 EI Q',
        `/ColorSpace<</CSii ${separation('InlineImgSpot')}>>`,
      ),
    },
  },
  { name: 'cs-only', pdf: { pages: page('/CS1 cs', `/ColorSpace<</CS1 ${separation('CsOnlyNoScn')}>>`) } },
  { name: 'cs-scn-only', pdf: { pages: page('/CS1 cs 1 scn', `/ColorSpace<</CS1 ${separation('CsScnNothing')}>>`) } },
  { name: 'cs-scn-in-q', pdf: { pages: page('q /CS1 cs 1 scn Q', `/ColorSpace<</CS1 ${separation('CsScnQQ')}>>`) } },
];

interface Relation {
  /** Spot colorants painted on the page without a plate. */
  readonly unplated: readonly string[];
  /** Plates of colorants neither painted nor selected on the page. */
  readonly plated: readonly string[];
}

// Ghostscript's tiffsep makes a plate when executed content selects a colorant's space, painting or not (the cs-only cases), so for spot colorants painted ⊆ plates ⊆ painted ∪ selected; the four process plates, All and None have no plates of their own.
const relation = (colorants: PageColorants, plates: readonly Uint8Array[]): Relation => {
  const spots = colorants.colorants.filter(use => use.kind === 'spot');
  const painted = new Set(spots.filter(use => use.painted.length > 0).map(use => latin1Text(use.name)));
  const selected = new Set(spots.filter(use => use.selected.length > 0).map(use => latin1Text(use.name)));
  const made = new Set(plates.map(plate => latin1Text(plate)));
  return {
    unplated: [...painted].filter(name => !made.has(name)).toSorted(),
    plated: [...made].filter(name => !painted.has(name) && !selected.has(name)).toSorted(),
  };
};

const withDirectory = async <T>(run: (directory: string) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-plates-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const failingFiles = async (): Promise<ReadonlySet<string>> => {
  const parsed: unknown = JSON.parse(await readFile(path.join(CORPUS, 'expected-failures.json'), 'utf8'));
  const failing = new Set<string>();
  if (typeof parsed !== 'object' || parsed === null) return failing;
  for (const [file, entry] of Object.entries(parsed)) if (typeof entry === 'object' && entry !== null && 'error' in entry) failing.add(file);
  return failing;
};

// The relation on the first page of a case, rendered at 72 dpi.
const caseRelation = async (pdf: TextPdf): Promise<Relation | undefined> => {
  const bytes = textPdfBytes(pdf);
  const [colorants] = listColorants(loadDocument(bytes), { pages: [0] });
  const plates = await withDirectory(async directory => {
    const file = path.join(directory, 'case.pdf');
    await writeFile(file, bytes);
    return renderPagePlates(file, path.join(directory, 'plates'), 72);
  });
  return colorants === undefined ? undefined : relation(colorants, plates.plates.get(1) ?? []);
};

// Each page of each file of a set that has spot colorants, against the plates of the pages Ghostscript draws.
const corpusDifferences = async (set: string, directory = path.join(CORPUS, set)): Promise<string[]> => {
  const failing = await failingFiles();
  const names = await readdir(directory).catch((): string[] => []);
  const files = names.filter(name => name.endsWith('.pdf') && !failing.has(`${set}/${name}`)).toSorted();
  if (set === 'govdocs1' && env['CI'] !== undefined && files.length === 0) throw new Error('govdocs1 corpus is missing');
  const differences: string[] = [];
  const next = async (index: number): Promise<string[]> => {
    const name = files[index];
    if (name === undefined) return differences;
    const file = path.join(directory, name);
    const bytes = new Uint8Array(await readFile(file));
    const pages = listColorants(loadDocument(bytes));
    if (pages.some(colorants => colorants.colorants.some(use => use.kind === 'spot'))) {
      const { plates, failed } = await withDirectory(async output => renderPagePlates(file, output));
      for (const colorants of pages) {
        if (failed.has(colorants.page + 1)) continue;
        const found = relation(colorants, plates.get(colorants.page + 1) ?? []);
        if (found.unplated.length > 0 || found.plated.length > 0) differences.push(`${name} page ${String(colorants.page + 1)}: ${JSON.stringify(found)}`);
      }
    }
    return next(index + 1);
  };
  return next(0);
};

describe('colorants against Ghostscript separations', () => {
  it.each(CASES)(
    'agrees with the plates of the $name case, apart from recorded differences',
    { timeout: 60_000 },
    async ({ pdf, unplated = [], plated = [] }) => {
      await expect(caseRelation(pdf)).resolves.toStrictEqual({ unplated, plated });
    },
  );

  it.each(['qpdf', 'cabinet', 'safedocs'])('agrees with the plates of the %s set', { timeout: 120_000 }, async set => {
    await expect(corpusDifferences(set)).resolves.toStrictEqual([]);
  });

  it('agrees with the plates of the fetched govdocs1 files', { timeout: 600_000 }, async () => {
    await expect(corpusDifferences('govdocs1', path.join(CORPUS, 'govdocs1/.cache/files'))).resolves.toStrictEqual([]);
  });
});
