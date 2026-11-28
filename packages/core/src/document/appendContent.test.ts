import type { PdfObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { ContentBuilder } from './contentBuilder.ts';
import type { ImageOptions } from './image.ts';
import type { LoadedDocument } from './loadDocument.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { ParseError } from '../error/parseError.ts';
import { ValidationError } from '../error/validationError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { pt } from '../length/length.ts';
import { pdfDictionary, pdfName, pdfReference } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { cmyk } from './color.ts';
import { entry, keys, objectText, resolved, streamBytes } from './inspectSaved.ts';
import { loadDocument } from './loadDocument.ts';
import { rect } from './rect.ts';

const load = (objects: ReadonlyArray<TestObject>): LoadedDocument =>
  loadDocument(buildPdf([{ xref: 'classic', objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }, ...objects], trailer: '/Root 1 0 R' }]).bytes);

const page = (extra: string): Array<TestObject> => [
  { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]>>' },
  { number: 3, body: `<</Type/Page/Parent 2 0 R${extra}>>` },
  { number: 4, body: streamBody('', '0 0 m 10 10 l S') },
];

const text = (value: PdfObject): string => latin1Text(serializeObject(value, { fractionDigits: 5 }));

const object = (document: LoadedDocument, number: number): string => text(document.get(pdfReference(number, 0)));

// The content of a stream object, inflated when it is compressed.
const content = (document: LoadedDocument, number: number): string => {
  const value = document.get(pdfReference(number, 0));
  if (value.kind !== 'stream') {
    return '';
  }
  return latin1Text(value.dictionary.has(pdfName('Filter').bytes) ? inflateZlib(value.data).data : value.data);
};

describe('appending page content', () => {
  it('refuses raw content whose overprint state cannot be checked', () => {
    const document = load(page('/Resources<<>>'));
    expect(() => {
      document.page(0).appendContent(latin1Bytes('/GS1 gs 0 0 0 0 k 0 0 10 10 re f'));
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'raw-content-unchecked' }));
    expect(() => {
      document.page(0).appendContent(latin1Bytes('0 0 0 0 k 0 0 10 10 re f'), { isolate: false });
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'raw-content-unchecked' }));
  });

  it('checks raw content passed through a proxy over its bytes', () => {
    const document = load(page('/Resources<<>>'));
    const bytes = latin1Bytes('0 0 0 0 k 0 0 10 10 re f');
    const proxied = new Proxy(bytes, {
      get: (target, key) => {
        if (key === 'length') {
          return target.length;
        }
        if (key === 'subarray') {
          return target.subarray.bind(target);
        }
        return typeof key === 'string' && /^\d+$/u.test(key) ? target[Number(key)] : undefined;
      },
    });
    expect(() => {
      document.page(0).appendContent(proxied, { isolate: false });
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'raw-content-unchecked' }));
  });

  it('writes the raw bytes it checked when a proxy changes them after the check', () => {
    const document = load(page('/Contents 4 0 R/Resources<<>>'));
    const benign = latin1Bytes('n                     ');
    const harmful = latin1Bytes('0 0 0 0 k 0 0 9 9 re f');
    // Reading every byte once takes as many indexed reads as there are bytes; every indexed read after those sees the harmful bytes.
    let reads = 0;
    const proxied = new Proxy(benign, {
      get: (target, key) => {
        if (typeof key === 'string' && /^\d+$/u.test(key)) {
          const value = (reads >= target.length ? harmful : target)[Number(key)];
          reads++;
          return value;
        }
        if (key === 'length') {
          return target.length;
        }
        return key === 'subarray' ? target.subarray.bind(target) : undefined;
      },
    });
    document.page(0).appendContent(proxied, { isolate: false });
    const contents = entry(document, document.get(pdfReference(3, 0)), 'Contents');
    const last = contents.kind === 'array' ? contents.items.at(-1) : contents;
    expect(latin1Text(streamBytes(resolved(document, last)))).toBe('\nn                     ');
  });

  it('separates appended operators from a stream without trailing whitespace', () => {
    const isolated = load(page('/Contents 4 0 R/Resources<<>>'));
    isolated.page(0).appendContent(latin1Bytes('n'));
    const plain = load(page('/Contents 4 0 R/Resources<<>>'));
    plain.page(0).appendContent(latin1Bytes('n'), { isolate: false });
    expect([content(isolated, 7).startsWith('\nQ'), content(plain, 5).startsWith('\n')]).toStrictEqual([true, true]);
  });

  it('wraps existing content in q and Q and adds a stream after it', () => {
    const document = load(page('/Contents 4 0 R/Resources<<>>'));
    document.page(0).appendContent(latin1Bytes('1 0 0 rg 0 0 5 5 re f'));
    expect(object(document, 3)).toBe('<</Type/Page/Parent 2 0 R/Contents[6 0 R 4 0 R 7 0 R 5 0 R]/Resources<<>>>>');
    expect([content(document, 6), content(document, 4), content(document, 7), content(document, 5)]).toStrictEqual([
      'q\n',
      '0 0 m 10 10 l S',
      '\nQ\n',
      '1 0 0 rg 0 0 5 5 re f',
    ]);
  });

  it('appends without wrapping when asked, and to pages with no content or an indirect content array', () => {
    const plain = load(page('/Contents[4 0 R]/Resources<<>>'));
    plain.page(0).appendContent(latin1Bytes('n'), { isolate: false });
    expect(object(plain, 3)).toBe('<</Type/Page/Parent 2 0 R/Contents[4 0 R 5 0 R]/Resources<<>>>>');
    const empty = load(page('/Resources<<>>'));
    empty.page(0).appendContent(latin1Bytes('n'));
    expect(object(empty, 3)).toBe('<</Type/Page/Parent 2 0 R/Resources<<>>/Contents 5 0 R>>');
    const indirect = load([...page('/Contents 9 0 R/Resources<<>>'), { number: 9, body: '[4 0 R]' }]);
    indirect.page(0).appendContent(latin1Bytes('n'));
    expect([object(indirect, 3), object(indirect, 9)]).toStrictEqual([
      '<</Type/Page/Parent 2 0 R/Contents[11 0 R 4 0 R 12 0 R 10 0 R]/Resources<<>>>>',
      '[4 0 R]',
    ]);
  });

  it('draws with the content builder under resource names the page does not use yet', () => {
    const document = load(page('/Contents 4 0 R/Resources<</ColorSpace<</CS1/DeviceGray>>>>'));
    const spot = document.separation({ name: 'Spot', alternate: cmyk(0, 0.5, 0, 0) });
    document.page(0).appendContent(builder => {
      builder.fillColor(spot, 1);
      builder.path(path => path.rect(0, 0, 10, 10));
      builder.fill('nonzero');
    });
    expect(content(document, 5)).toBe('q\n/CS2 cs\n1 scn\n0 0 10 10 re\nf\nQ\n');
    document.page(0).appendContent(builder => {
      builder.strokeColor(spot, 0.5);
    });
    expect(content(document, 8)).toBe('q\n/CS2 CS\n0.5 SCN\nQ\n');
    expect(object(document, 3)).toContain('/Resources<</ColorSpace<</CS1/DeviceGray/CS2[/Separation /Spot /DeviceCMYK <<');
  });

  it('refuses group PieceInfo once content has drawn the group', () => {
    const document = load(page('/Resources<<>>'));
    const group = document.group({ bbox: rect(pt(0), pt(0), pt(10), pt(10)) }, builder => {
      builder.path(path => path.rect(0, 0, 5, 5));
      builder.fill('nonzero');
    });
    const data = { Example: { private: { kind: 'null' } } } as const;
    group.pieceInfo({ lastModified: pdfDate({ year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: 'Z' }), data });
    document.page(0).appendContent(builder => {
      builder.group(group, [1, 0, 0, 1, 0, 0]);
    });
    expect(() => {
      group.pieceInfo({ lastModified: pdfDate({ year: 2026, month: 1, day: 2, hour: 0, minute: 0, second: 0, offset: 'Z' }), data });
    }).toThrow(ValidationError);
  });

  it('raises the catalog version for transparent graphics states in a PDF 1.3 file', () => {
    const written = latin1Text(
      buildPdf([{ xref: 'classic', objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }, ...page('/Resources<<>>')], trailer: '/Root 1 0 R' }]).bytes,
    );
    const old = loadDocument(latin1Bytes(written.replace('%PDF-1.7', '%PDF-1.3')));
    old.page(0).appendContent(builder => {
      builder.graphicsState({ fillAlpha: 0.5 });
    });
    const saved = old.save();
    expect([saved.warnings.map(warning => warning.code), loadDocument(saved.chunks).catalog().get(pdfName('Version').bytes)]).toStrictEqual([
      ['version-raised'],
      pdfName('1.4'),
    ]);
  });

  it('writes an image once however often content draws it', () => {
    const document = load(page('/Resources<<>>'));
    const image = document.image({
      width: 1,
      height: 1,
      colorSpace: 'DeviceGray',
      bitsPerComponent: 8,
      samples: Uint8Array.of(128),
      softMask: { width: 1, height: 1, samples: Uint8Array.of(255) },
    });
    for (let round = 0; round < 2; round++) {
      document.page(0).appendContent(builder => {
        builder.image(image, [10, 0, 0, 10, 0, 0]);
      });
    }
    expect(object(document, 3)).toBe('<</Type/Page/Parent 2 0 R/Resources<</XObject<</Im1 6 0 R>>>>/Contents[9 0 R 7 0 R 10 0 R 8 0 R]>>');
    expect([document.get(pdfReference(5, 0)).kind, object(document, 6).includes('/SMask 5 0 R')]).toStrictEqual(['stream', true]);
  });
});

// The reason raw content is refused, or 'accepted'.
const rawOutcome = (raw: string | Uint8Array, isolate: boolean): string => {
  const document = load(page('/Contents 4 0 R/Resources<<>>'));
  try {
    document.page(0).appendContent(typeof raw === 'string' ? latin1Bytes(raw) : raw, { isolate });
  } catch (error: unknown) {
    return error instanceof ValidationError ? `ValidationError ${String(error.reason)}` : String(error);
  }
  return 'accepted';
};

// The outcome of appending built content, as the class and reason of the error or 'accepted'.
const builtOutcome = (document: LoadedDocument, render: (builder: ContentBuilder) => void): string => {
  try {
    document.page(0).appendContent(render);
  } catch (error: unknown) {
    return error instanceof ValidationError ? `ValidationError ${String(error.reason)}` : String(error);
  }
  return 'accepted';
};

const whiteOverprintFill = (builder: ContentBuilder): void => {
  builder.graphicsState({ overprintFill: true, overprintMode: 1 });
  builder.fillColor(cmyk(0, 0, 0, 0));
  builder.path(path => path.rect(0, 0, 5, 5));
  builder.fill('nonzero');
};

const nestedSaves =
  (levels: number) =>
  (builder: ContentBuilder): void => {
    for (let index = 0; index < levels; index++) {
      builder.save();
    }
    for (let index = 0; index < levels; index++) {
      builder.restore();
    }
  };

const unchecked = 'ValidationError raw-content-unchecked';

// A PDF 1.3 file with one page and no content.
const loadPdf13 = (): LoadedDocument =>
  loadDocument(
    buildPdf([{ xref: 'classic', objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }, ...page('/Resources<<>>')], trailer: '/Root 1 0 R' }], {
      header: '%PDF-1.3',
    }).bytes,
  );

// The save warnings and the catalog Version a PDF 1.3 file gets after one append.
const versionAfter = (append: (document: LoadedDocument) => void): [Array<string>, PdfObject | undefined] => {
  const document = loadPdf13();
  append(document);
  const saved = document.save();
  return [saved.warnings.map(warning => warning.code), loadDocument(saved.chunks).catalog().get(pdfName('Version').bytes)];
};

const drawImage =
  (softMask: boolean) =>
  (document: LoadedDocument): void => {
    const options: ImageOptions = { width: 1, height: 1, colorSpace: 'DeviceGray', bitsPerComponent: 8, samples: Uint8Array.of(1) };
    if (softMask) {
      options.softMask = { width: 1, height: 1, samples: Uint8Array.of(2) };
    }
    const image = document.image(options);
    document.page(0).appendContent(builder => {
      builder.image(image, [1, 0, 0, 1, 0, 0]);
    });
  };

const placeGroup = (document: LoadedDocument): void => {
  const group = document.group({ bbox: rect(pt(0), pt(0), pt(1), pt(1)) }, builder => {
    builder.path(path => path.rect(0, 0, 1, 1));
  });
  document.page(0).appendContent(builder => {
    builder.group(group, [1, 0, 0, 1, 0, 0]);
  });
};

describe('raw content checks', () => {
  it.each([
    ['an operator missing an operand', '1 m', true, unchecked],
    ['an unknown operator', '1 xyz', true, unchecked],
    ['an XObject paint', '/Im0 Do', true, unchecked],
    ['a shading paint', '/Sh0 sh', true, unchecked],
    ['an XObject paint without isolation', '/Im0 Do', false, unchecked],
    ['a shading paint without isolation', '/Sh0 sh', false, unchecked],
    ['a restore with no save', 'Q', true, unchecked],
    ['one restore too many', 'q Q Q', true, unchecked],
    ['a balanced save and restore', 'q Q', true, 'accepted'],
    ['a save left open', 'q 2 w', true, unchecked],
    ['a save left open without isolation', 'q 2 w', false, unchecked],
    ['one restore too few', 'q q Q', true, unchecked],
    ['two balanced saves', 'q q Q Q', true, 'accepted'],
    ['an unterminated string', '(unterminated', true, unchecked],
    ['arrays nested past the parse limit', '['.repeat(300), true, unchecked],
    ['a line width without isolation', '1 w', false, 'accepted'],
    ['a clip without isolation', '0 0 1 1 re W n', false, 'accepted'],
  ])('checks %s (%s, isolate %s)', (_, raw, isolate, expected) => {
    expect(rawOutcome(raw, isolate)).toBe(expected);
  });

  // Without isolation, content inherits the page's graphics state, so every painting operator is refused and a path ended with n is not.
  it.each([
    ['0 0 1 1 re f', 'f'],
    ['0 0 1 1 re F', 'F'],
    ['0 0 1 1 re f*', 'f*'],
    ['0 0 1 1 re S', 'S'],
    ['0 0 1 1 re s', 's'],
    ['0 0 1 1 re B', 'B'],
    ['0 0 1 1 re B*', 'B*'],
    ['0 0 1 1 re b', 'b'],
    ['0 0 1 1 re b*', 'b*'],
    ['BI /W 1 /H 1 /CS /G /BPC 8 ID \u0000 EI', 'BI'],
    ['BT (a) Tj ET', 'Tj'],
    ['BT [(a)] TJ ET', 'TJ'],
    ["BT (a) ' ET", "'"],
    ['BT 1 2 (a) " ET', '"'],
  ])('refuses %s without isolation, which paints with %s, and accepts it isolated', raw => {
    expect([rawOutcome(raw, false), rawOutcome(raw, true)]).toStrictEqual([unchecked, 'accepted']);
  });

  it('accepts a path ended without painting when content is not isolated', () => {
    expect(rawOutcome('0 0 1 1 re n', false)).toBe('accepted');
  });
});

describe('appending built content', () => {
  // The appended content is wrapped in q and Q, which takes one of the 28 levels of ISO 32000-1:2008, Annex C, Table C.1.
  it.each([
    [27, 'accepted'],
    [28, 'ValidationError undefined'],
  ])('accepts %i nested saves only while the wrapper fits within 28 levels', (levels, expected) => {
    expect(builtOutcome(load(page('/Resources<<>>')), nestedSaves(levels))).toBe(expected);
  });

  // ISO 32000-1:2008, 11.4.7: the page group's colour space is the blending space, and 11.7.4.3 makes white with overprint mode 1 invisible only in DeviceCMYK.
  it.each([
    ['a DeviceRGB page group', '/Group<</S/Transparency/CS/DeviceRGB>>', [], 'accepted'],
    ['a DeviceGray page group', '/Group<</S/Transparency/CS/DeviceGray>>', [], 'accepted'],
    ['a DeviceCMYK page group', '/Group<</S/Transparency/CS/DeviceCMYK>>', [], 'ValidationError invisible-overprint'],
    ['no page group', '', [], 'ValidationError invisible-overprint'],
    ['a page group naming DeviceRGB indirectly', '/Group<</S/Transparency/CS 9 0 R>>', [{ number: 9, body: '/DeviceRGB' }], 'accepted'],
    ['an indirect page group of DeviceRGB', '/Group 9 0 R', [{ number: 9, body: '<</S/Transparency/CS/DeviceRGB>>' }], 'accepted'],
    [
      'a page group naming DeviceCMYK indirectly',
      '/Group<</S/Transparency/CS 9 0 R>>',
      [{ number: 9, body: '/DeviceCMYK' }],
      'ValidationError invisible-overprint',
    ],
  ])('reads the blending space from %s', (_, group, extra, expected) => {
    expect(builtOutcome(load([...page(`/Resources<<>>${group}`), ...extra]), whiteOverprintFill)).toBe(expected);
  });

  // ISO 32000-1:2008, 8.4.5, Table 58: CA, ca, BM and SMask are PDF 1.4 features, while op, OP and OPM are not; 11.1 makes groups and soft masks PDF 1.4 too.
  it.each([
    ['an overprint state', { overprintFill: true }, [[], undefined]],
    ['a stroke alpha', { strokeAlpha: 0.5 }, [['version-raised'], pdfName('1.4')]],
    ['a blend mode', { blendMode: 'Multiply' }, [['version-raised'], pdfName('1.4')]],
    ['a soft mask of None', { softMask: 'None' }, [['version-raised'], pdfName('1.4')]],
  ] as const)('sets the catalog version of a PDF 1.3 file for %s as needed', (_, options, expected) => {
    expect(
      versionAfter(document => {
        document.page(0).appendContent(builder => {
          builder.graphicsState(options);
        });
      }),
    ).toStrictEqual(expected);
  });

  it('raises a PDF 1.3 file to 1.4 for a placed group or a soft-masked image, and not for an image without a mask', () => {
    expect([versionAfter(placeGroup), versionAfter(drawImage(true)), versionAfter(drawImage(false))]).toStrictEqual([
      [['version-raised'], pdfName('1.4')],
      [['version-raised'], pdfName('1.4')],
      [[], undefined],
    ]);
  });

  // ISO 32000-1:2008, 7.3.3, NOTE 2: "Wherever a real number is expected, an integer may be used instead", so a component written as 0 or 1 is the same number as 0.0 or 1.0.
  it.each([
    ['every component written as a real', '/C0[0.0 0.0 0.0 0.0]/C1[0.0 0.5 0.0 0.0]', 'CS7', ['CS7']],
    ['the components a save writes, whole ones as integers', '/C0[0 0 0 0]/C1[0 0.5 0 0]', 'CS7', ['CS7']],
    ['a different tint', '/C0[0 0 0 0]/C1[0 0.4 0 0]', 'CS1', ['CS1', 'CS7']],
  ])('reuses a name the page resources already give the same separation, with %s', (_, components, name, names) => {
    const spot = `[/Separation /Spot /DeviceCMYK <</FunctionType 2/Domain[0 1]${components}/N 1>>]`;
    const document = load(page(`/Contents 4 0 R/Resources<</ColorSpace<</CS7 ${spot}>>>>`));
    document.page(0).appendContent(builder => {
      builder.fillColor(document.separation({ name: 'Spot', alternate: cmyk(0, 0.5, 0, 0) }), 1);
    });
    expect([content(document, 5), keys(entry(document, pdfDictionary(document.page(0).resources()), 'ColorSpace')).toSorted()]).toStrictEqual([
      `q\n/${name} cs\n1 scn\nQ\n`,
      names,
    ]);
  });

  it('reuses the name of a separation an earlier save wrote, after the file is loaded again', () => {
    const first = load(page('/Contents 4 0 R/Resources<<>>'));
    first.page(0).appendContent(builder => {
      builder.fillColor(first.separation({ name: 'Spot', alternate: cmyk(0, 0.5, 0, 0) }), 1);
    });
    const reloaded = loadDocument(first.save().chunks);
    reloaded.page(0).appendContent(builder => {
      builder.fillColor(reloaded.separation({ name: 'Spot', alternate: cmyk(0, 0.5, 0, 0) }), 1);
    });
    expect(keys(resolved(reloaded, reloaded.page(0).resources().get(pdfName('ColorSpace').bytes)))).toStrictEqual(['CS1']);
  });

  it('writes a group drawn by two appends once and reuses its name', () => {
    const document = load(page('/Resources<<>>'));
    const group = document.group({ bbox: rect(pt(0), pt(0), pt(1), pt(1)) }, builder => {
      builder.path(path => path.rect(0, 0, 1, 1));
    });
    for (let round = 0; round < 2; round++) {
      document.page(0).appendContent(builder => {
        builder.group(group, [1, 0, 0, 1, 0, 0]);
      });
    }
    expect(object(document, 3)).toBe('<</Type/Page/Parent 2 0 R/Resources<</XObject<</Fm1 5 0 R>>>>/Contents[8 0 R 6 0 R 9 0 R 7 0 R]>>');
    expect([content(document, 6), content(document, 7)]).toStrictEqual(['q\nq\n1 0 0 1 0 0 cm\n/Fm1 Do\nQ\nQ\n', 'q\nq\n1 0 0 1 0 0 cm\n/Fm1 Do\nQ\nQ\n']);
  });

  it('writes a nested group before the group that draws it, each once', () => {
    const document = load(page('/Resources<<>>'));
    const box = rect(pt(0), pt(0), pt(1), pt(1));
    const inner = document.group({ bbox: box }, builder => {
      builder.path(path => path.rect(0, 0, 1, 1));
    });
    const outer = document.group({ bbox: box }, builder => {
      builder.group(inner, [1, 0, 0, 1, 0, 0]);
    });
    document.page(0).appendContent(builder => {
      builder.group(outer, [1, 0, 0, 1, 0, 0]);
      builder.group(inner, [1, 0, 0, 1, 0, 0]);
    });
    expect([object(document, 3), objectText(entry(document, entry(document, document.get(pdfReference(6, 0)), 'Resources'), 'XObject'))]).toStrictEqual([
      '<</Type/Page/Parent 2 0 R/Resources<</XObject<</Fm1 6 0 R/Fm2 5 0 R>>>>/Contents 7 0 R>>',
      '<</Fm1 5 0 R>>',
    ]);
  });
});

describe('appending to malformed pages', () => {
  it.each([
    ['a direct dictionary', '/Contents<<>>'],
    ['an integer', '/Contents 5'],
  ])('refuses a page whose Contents is %s, naming the page', (_, contents) => {
    const document = load(page(`${contents}/Resources<<>>`));
    expect(() => {
      document.page(0).appendContent(latin1Bytes('n'));
    }).toThrow(ParseError);
    expect(() => {
      document.page(0).appendContent(latin1Bytes('n'));
    }).toThrow(/page 3 0 R/u);
  });

  it('refuses a page object replaced by a non-dictionary', () => {
    const document = load(page('/Resources<<>>'));
    const view = document.page(0);
    document.set(pdfReference(3, 0), pdfName('Page'));
    expect(() => {
      view.appendContent(latin1Bytes('n'));
    }).toThrow(ParseError);
  });

  it('writes a single stream, with no q and Q wrapper, after an empty Contents array', () => {
    const document = load(page('/Contents[]/Resources<<>>'));
    document.page(0).appendContent(latin1Bytes('n'));
    expect([object(document, 3), content(document, 5)]).toStrictEqual(['<</Type/Page/Parent 2 0 R/Contents 5 0 R/Resources<<>>>>', 'n']);
  });
});

describe('properties', () => {
  // How the page holds its existing streams: object 4 alone, or object 4 followed by object 10, whose operators differ.
  const second = { number: 10, body: streamBody('', '\n2 w') };
  const shapes = {
    absent: { extra: '', objects: [] },
    stream: { extra: '/Contents 4 0 R', objects: [] },
    array: { extra: '/Contents[4 0 R 10 0 R]', objects: [second] },
    indirect: { extra: '/Contents 9 0 R', objects: [{ number: 9, body: '[4 0 R 10 0 R]' }, second] },
  } as const;
  const original = { absent: '', stream: '0 0 m 10 10 l S', array: '0 0 m 10 10 l S\n2 w', indirect: '0 0 m 10 10 l S\n2 w' } as const;

  it('adds content after the existing streams, leaving them and an indirect Contents array unchanged', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('absent', 'stream', 'array', 'indirect'),
        fc.boolean(),
        fc.constantFrom('n', '1 w', '0 0 1 1 re W n'),
        (shape, isolate, raw) => {
          const { extra, objects } = shapes[shape];
          const document = load([...page(`${extra}/Resources<<>>`), ...objects]);
          const written = (): Array<string> =>
            [4, ...objects.map(item => item.number)].flatMap(number => [object(document, number), content(document, number)]);
          const before = written();
          document.page(0).appendContent(latin1Bytes(raw), { isolate });
          const contents = entry(document, document.get(pdfReference(3, 0)), 'Contents');
          const streams = contents.kind === 'array' ? contents.items : [contents];
          const decoded = streams.map(stream => latin1Text(streamBytes(resolved(document, stream)))).join('');
          const existing = original[shape];
          const expected = existing === '' ? raw : isolate ? `q\n${existing}\nQ\n${raw}` : `${existing}\n${raw}`;
          const depth = [...decoded.matchAll(/\b[qQ]\b/gu)].reduce((level, [operator]) => level + (operator === 'q' ? 1 : -1), 0);
          expect([decoded, depth, written()]).toStrictEqual([expected, 0, before]);
        },
      ),
    );
  });
});
