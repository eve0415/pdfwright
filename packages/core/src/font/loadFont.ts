import type { Matrix } from '../content/matrix.ts';
import type { PdfDirectObject, PdfReference } from '../object/pdfObject.ts';
import type { CMap } from './cmap/cmap.ts';
import type { CMapProvider } from './cmap/cmapProvider.ts';
import type { CMapResult } from './cmap/cmapResolver.ts';
import type { CMapCode } from './cmap/mappingTable.ts';
import type { EncodingTable } from './encoding/simpleEncodings.ts';
import type { DescendantFont, FontGlyph, FontModel, FontString, FontSubtype, FontWarning, Rectangle, Type3Parts, VerticalExtent } from './fontModel.ts';
import type { FontSource } from './fontValues.ts';
import type { SimpleWidths } from './simpleFont.ts';
import type { Standard14Metrics } from './standard14.ts';
import type { ProcedureSummary } from './type3Procedures.ts';

import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfName } from '../object/pdfObject.ts';

import { CMapResolver } from './cmap/cmapResolver.ts';
import { cidToGid, cidWidths, collectionOf, descendantOf } from './compositeFont.ts';
import { glyphNameText } from './encoding/glyphNames.ts';
import { readDescriptor, verticalExtent } from './fontDescriptor.ts';
import { dictionaryOf, latin1, nameOf, numbersOf, withoutSubsetTag } from './fontValues.ts';
import { simpleGlyphNames, simpleWidths } from './simpleFont.ts';
import { standard14Metrics } from './standard14.ts';
import { normalised, readProcedure } from './type3Procedures.ts';

const SUBTYPE = pdfName('Subtype').bytes;
const BASE_FONT = pdfName('BaseFont').bytes;
const ENCODING = pdfName('Encoding').bytes;
const TO_UNICODE = pdfName('ToUnicode').bytes;
const FONT_MATRIX = pdfName('FontMatrix').bytes;
const FONT_BBOX = pdfName('FontBBox').bytes;
const CHAR_PROCS = pdfName('CharProcs').bytes;
const RESOURCES = pdfName('Resources').bytes;

// ISO 32000-1:2008, 9.2.4: glyph space units are 1/1000 of text space for every font type but Type 3, whose FontMatrix maps glyph space to text space.
const THOUSANDTH = [0.001, 0, 0, 0.001, 0, 0] as const satisfies Matrix;

// 9.10.2 names the character collections whose registry–ordering–UCS2 maps give text: "Adobe-GB1, Adobe-CNS1, Adobe-Japan1, or Adobe-Korea1".
const STANDARD_ORDERINGS = new Set(['GB1', 'CNS1', 'Japan1', 'Korea1']);

const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const codeBytes = (code: CMapCode): Uint8Array => {
  const bytes = new Uint8Array(code.length);
  let { value } = code;
  for (let index = code.length - 1; index >= 0; index--) {
    bytes[index] = value % 256;
    value = Math.floor(value / 256);
  }
  return bytes;
};

const subtypeOf = (name: string | undefined): FontSubtype =>
  name === 'Type0' || name === 'Type1' || name === 'MMType1' || name === 'TrueType' || name === 'Type3' ? name : 'other';

/**
 * The key a font is cached and reported under (the design's font key rule): `objectNumber.generation` for an indirect font; for a font dictionary written directly in a resource dictionary, `direct:` followed by the caller's name for the resource dictionary's owner and the resource name in hexadecimal.
 */
export const fontKey = (value: PdfDirectObject, owner: string, name: Uint8Array): string =>
  value.kind === 'reference' ? `${String(value.objectNumber)}.${String(value.generation)}` : `direct:${owner}:${hex(name)}`;

interface LoadContext {
  readonly source: FontSource;
  readonly cmaps: CMapResolver;
  readonly warnings: FontWarning[];
}

interface Loaded {
  readonly key: string;
  readonly reference: PdfReference | undefined;
  readonly dictionary: PdfDictionaryEntries;
  readonly subtype: FontSubtype;
  readonly baseFont: Uint8Array | undefined;
  readonly toUnicode: CMap | undefined;
  readonly toUnicodeState: FontModel['toUnicode'];
}

// ISO 32000-1:2008, 9.10.3: a ToUnicode CMap is a stream; any other value is not defined there and reads as unreadable.
const readToUnicode = (context: LoadContext, dictionary: PdfDictionaryEntries): Pick<Loaded, 'toUnicode' | 'toUnicodeState'> => {
  const value = dictionary.get(TO_UNICODE);
  if (value === undefined) return { toUnicode: undefined, toUnicodeState: 'absent' };
  const result = context.cmaps.stream(value);
  if (result.kind !== 'cmap') {
    context.warnings.push({ code: 'to-unicode-unreadable', detail: result.kind === 'unreadable' ? result.reason : `the CMap ${result.name} is not available` });
    return { toUnicode: undefined, toUnicodeState: 'unreadable' };
  }
  for (const problem of result.problems) {
    context.warnings.push({ code: problem.kind === 'range-overflow' ? 'to-unicode-range-overflow' : 'to-unicode-unreadable', detail: problem.detail });
  }
  return { toUnicode: result.cmap, toUnicodeState: 'present' };
};

const fontMatrixOf = (context: LoadContext, dictionary: PdfDictionaryEntries): Matrix => {
  const numbers = numbersOf(context.source, dictionary.get(FONT_MATRIX));
  const [a, b, c, d, e, f] = numbers ?? [];
  const complete = numbers?.length === 6 && a !== undefined && b !== undefined && c !== undefined && d !== undefined && e !== undefined && f !== undefined;
  if (complete) return [a, b, c, d, e, f];
  context.warnings.push({ code: 'font-unreadable', detail: 'the Type 3 FontMatrix is not an array of six numbers' });
  return THOUSANDTH;
};

// Table 112, FontBBox: "If all four elements of the rectangle are zero, a conforming reader shall make no assumptions about glyph sizes based on the font bounding box."
const fontBBoxOf = (context: LoadContext, dictionary: PdfDictionaryEntries): Rectangle | undefined => {
  const [x1, y1, x2, y2, ...rest] = numbersOf(context.source, dictionary.get(FONT_BBOX)) ?? [];
  const complete = x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined && rest.length === 0;
  return complete && [x1, y1, x2, y2].some(value => value !== 0) ? normalised([x1, y1, x2, y2]) : undefined;
};

// The Chromium shape (the design's house rule for Type 3 notdef glyphs): a FontDescriptor, and every Differences name `g` followed by uppercase hexadecimal digits, the source font's glyph index.
const chromiumType3 = (differences: readonly string[], hasDescriptor: boolean): boolean =>
  hasDescriptor && differences.length > 0 && differences.every(name => /^g[0-9A-F]+$/u.test(name));

const standardWidths = (metrics: Standard14Metrics | undefined, names: EncodingTable): SimpleWidths => {
  if (metrics === undefined) return undefined;
  return code => {
    const name = names[code];
    return name === undefined ? undefined : metrics.width(name);
  };
};

// A standard 14 font without a descriptor takes its vertical extent from the FontBBox of its bundled metrics.
const extentWithMetrics = (extent: VerticalExtent, metrics: Standard14Metrics | undefined): VerticalExtent =>
  extent.estimated && metrics !== undefined ? { descent: metrics.bbox[1], ascent: metrics.bbox[3], estimated: false } : extent;

const simpleModel = (context: LoadContext, loaded: Loaded): Omit<FontModel, keyof Loaded | 'toUnicode' | 'warnings'> => {
  const { source } = context;
  const { dictionary, subtype } = loaded;
  const descriptor = readDescriptor(source, dictionary);
  const input = { source, font: dictionary, subtype, descriptor };
  const { names, differences, problems } = simpleGlyphNames(input);
  for (const detail of problems) context.warnings.push({ code: 'font-unreadable', detail });
  // Table 111 exempts the standard 14 fonts from Widths, and their widths then come from the bundled AFM metrics by glyph name; a Widths array, when present, is used as it is.
  const standard = subtype === 'Type1' && loaded.baseFont !== undefined ? standard14Metrics(latin1(loaded.baseFont)) : undefined;
  const widths = simpleWidths(input) ?? standardWidths(standard, names);
  if (widths === undefined) context.warnings.push({ code: 'widths-unknown', detail: 'the font has no Widths array with a FirstChar' });
  const glyphMatrix = subtype === 'Type3' ? fontMatrixOf(context, dictionary) : THOUSANDTH;
  const charProcs = dictionaryOf(source.objects.deref(dictionary.get(CHAR_PROCS)));
  const type3: Type3Parts | undefined =
    subtype === 'Type3'
      ? {
          charProcs,
          resources: dictionary.get(RESOURCES),
          chromium: chromiumType3(differences, descriptor.dictionary !== undefined),
          fontBBox: fontBBoxOf(context, dictionary),
        }
      : undefined;
  const fontName = loaded.baseFont === undefined ? undefined : withoutSubsetTag(latin1(loaded.baseFont));
  const procedures = new Map<string, ProcedureSummary | undefined>();
  // A Type 3 glyph's procedure, read once per name; undefined when the name has none. 9.6.5: "If the name is not present as a key in CharProcs, no glyph shall be painted".
  const procedureOf = (name: string): ProcedureSummary | undefined => {
    if (!procedures.has(name)) {
      const procedure = source.objects.deref(charProcs?.get(latin1Bytes(name)));
      procedures.set(name, procedure?.kind === 'stream' ? readProcedure(source, procedure) : undefined);
    }
    return procedures.get(name);
  };
  const glyphOf = (code: number): FontGlyph => {
    const name = names[code];
    const summary = type3 === undefined || name === undefined ? undefined : procedureOf(name);
    const missing = type3 !== undefined && (summary === undefined || (type3.chromium && name === 'g0'));
    const width = widths?.(code);
    return {
      bytes: Uint8Array.of(code),
      code,
      valid: true,
      cid: undefined,
      gid: undefined,
      glyphName: name,
      notdef: name === '.notdef' || missing,
      empty: summary?.paints === false,
      type3Box: summary?.box,
      toUnicode: loaded.toUnicode?.unicode({ value: code, length: 1 }),
      encodingText: name === undefined ? undefined : glyphNameText(name, fontName),
      // Table 112: Type 3 widths "shall be interpreted in glyph space as specified by FontMatrix"; "If FontMatrix specifies a rotation, only the horizontal component of the transformed width shall be used."
      width: width === undefined ? undefined : width * glyphMatrix[0],
      wordSpace: code === 32,
      cmapUnavailable: undefined,
    };
  };
  const glyphs: (FontGlyph | undefined)[] = [];
  return {
    descendant: undefined,
    writingMode: 0,
    glyphMatrix,
    verticalExtent: extentWithMetrics(verticalExtent(source, descriptor.dictionary, subtype === 'Type3' ? dictionary.get(FONT_BBOX) : undefined), standard),
    collectionMap: undefined,
    type3,
    glyphs: (string): FontString => ({
      kind: 'glyphs',
      glyphs: [...string].map(code => {
        glyphs[code] ??= glyphOf(code);
        return glyphs[code];
      }),
    }),
  };
};

const cmapProblems = (context: LoadContext, result: CMapResult): void => {
  if (result.kind === 'cmap') {
    for (const problem of result.problems) context.warnings.push({ code: 'font-unreadable', detail: `the Encoding CMap: ${problem.detail}` });
  } else if (result.kind === 'unavailable') context.warnings.push({ code: 'cmap-unavailable', detail: `the predefined CMap ${result.name} is not available` });
  else context.warnings.push({ code: 'font-unreadable', detail: `the Encoding CMap cannot be read: ${result.reason}` });
};

// 9.7.5.2, NOTE 1: "CMaps whose names end in H specify horizontal writing mode; those ending in V specify vertical writing mode."
const writingModeOf = (result: CMapResult, name: string | undefined): 0 | 1 => {
  if (result.kind === 'cmap') return result.cmap.writingMode;
  return name?.endsWith('V') === true ? 1 : 0;
};

interface CollectionSources {
  readonly result: CMapResult;
  readonly encodingName: string | undefined;
  readonly descendant: DescendantFont | undefined;
}

// 9.10.2: a predefined CMap other than Identity-H and Identity-V, or a descendant in one of the four Adobe collections, gives text through "registry–ordering–UCS2", with the registry and ordering "used by the font’s CMap".
const collectionMapName = (source: FontSource, { result, encodingName, descendant }: CollectionSources): string | undefined => {
  const predefined = encodingName !== undefined && encodingName !== 'Identity-H' && encodingName !== 'Identity-V';
  const info = result.kind === 'cmap' && predefined ? result.cmap.cidSystemInfo : undefined;
  if (info?.registry !== undefined && info.ordering !== undefined) return `${latin1(info.registry)}-${latin1(info.ordering)}-UCS2`;
  const described = collectionOf(source, descendant?.dictionary);
  if (described === undefined || !(predefined || (described.registry === 'Adobe' && STANDARD_ORDERINGS.has(described.ordering)))) return undefined;
  return `${described.registry}-${described.ordering}-UCS2`;
};

interface CompositeParts {
  readonly cmap: CMap;
  readonly toUnicode: CMap | undefined;
  readonly widths: ((cid: number) => number) | undefined;
  readonly gids: ((cid: number) => number) | undefined;
  readonly ucs2: CMap | undefined;
}

// A code whose CID depends on a usecmap CMap no provider supplied has no known CID. 9.7.6.3: an invalid code takes "a substitute glyph …as just described", its notdef mapping or CID 0.
const cidOf = (cmap: CMap, code: CMapCode, valid: boolean): number | undefined => {
  if (!valid) return cmap.notdef(code) ?? 0;
  const mapped = cmap.mapped(code) ?? cmap.notdef(code);
  if (mapped === undefined && cmap.unavailableParent !== undefined) return undefined;
  return mapped ?? 0;
};

const compositeGlyph = (parts: CompositeParts, code: CMapCode, valid: boolean): FontGlyph => {
  const cid = cidOf(parts.cmap, code, valid);
  const gid = cid === undefined ? undefined : parts.gids?.(cid);
  const width = cid === undefined ? undefined : parts.widths?.(cid);
  return {
    bytes: codeBytes(code),
    code: code.value,
    valid,
    cid,
    gid,
    glyphName: undefined,
    type3Box: undefined,
    // 9.7.6.3: "the glyph for CID 0 (which shall be present)" is the substitute; in a CIDFontType2 font glyph index 0 is the TrueType .notdef glyph.
    notdef: cid === 0 || gid === 0,
    empty: false,
    toUnicode: parts.toUnicode?.unicode(code),
    encodingText: cid === undefined ? undefined : parts.ucs2?.unicode({ value: cid, length: 2 }),
    width: width === undefined ? undefined : width / 1000,
    // 9.3.3: word spacing applies to code 32 in "a composite font that defines code 32 as a single-byte code".
    wordSpace: code.length === 1 && code.value === 32,
    cmapUnavailable: cid === undefined ? parts.cmap.unavailableParent : undefined,
  };
};

const splitComposite = (parts: CompositeParts, cache: Map<string, FontGlyph>, string: Uint8Array): FontGlyph[] => {
  const shown: FontGlyph[] = [];
  for (let offset = 0; offset < string.length;) {
    const { code, valid } = parts.cmap.read(string, offset);
    const key = `${valid ? '' : '!'}${String(code.length)}:${String(code.value)}`;
    let glyph = cache.get(key);
    if (glyph === undefined) {
      glyph = compositeGlyph(parts, code, valid);
      cache.set(key, glyph);
    }
    shown.push(glyph);
    offset += code.length;
  }
  return shown;
};

const compositeModel = (context: LoadContext, loaded: Loaded): Omit<FontModel, keyof Loaded | 'toUnicode' | 'warnings'> => {
  const { source } = context;
  const encodingValue = loaded.dictionary.get(ENCODING);
  const encodingName = nameOf(source.objects.deref(encodingValue));
  const result: CMapResult =
    encodingValue === undefined ? { kind: 'unreadable', reason: 'the Type 0 font has no Encoding' } : context.cmaps.encoding(encodingValue);
  cmapProblems(context, result);
  const descendant = descendantOf(source, loaded.dictionary);
  if (descendant === undefined) context.warnings.push({ code: 'font-unreadable', detail: 'the Type 0 font has no descendant CIDFont dictionary' });
  const gids = descendant?.subtype === 'CIDFontType2' ? cidToGid(source, descendant.dictionary) : undefined;
  if (typeof gids === 'string') context.warnings.push({ code: 'font-unreadable', detail: gids });
  const mapName = collectionMapName(source, { result, encodingName, descendant });
  const unicodeMap = mapName === undefined ? undefined : context.cmaps.named(mapName);
  if (unicodeMap !== undefined && unicodeMap.kind !== 'cmap' && loaded.toUnicodeState !== 'present') {
    context.warnings.push({ code: 'cmap-unavailable', detail: `the CID-to-Unicode map ${mapName ?? ''} is not available` });
  }
  const ucs2 = unicodeMap?.kind === 'cmap' ? unicodeMap.cmap : undefined;
  const parts: CompositeParts | undefined =
    result.kind === 'cmap'
      ? {
          cmap: result.cmap,
          toUnicode: loaded.toUnicode,
          widths: descendant === undefined ? undefined : cidWidths(source, descendant.dictionary),
          gids: typeof gids === 'string' ? undefined : gids,
          ucs2,
        }
      : undefined;
  const cache = new Map<string, FontGlyph>();
  return {
    descendant,
    writingMode: writingModeOf(result, encodingName),
    glyphMatrix: THOUSANDTH,
    verticalExtent: verticalExtent(source, descendant === undefined ? undefined : readDescriptor(source, descendant.dictionary).dictionary),
    collectionMap: mapName === undefined ? undefined : { name: mapName, available: ucs2 !== undefined },
    type3: undefined,
    glyphs: (string): FontString => {
      if (result.kind === 'unavailable') return { kind: 'cmap-unavailable', cmap: result.name };
      if (result.kind === 'unreadable') return { kind: 'undecodable', reason: result.reason };
      if (parts === undefined) return { kind: 'undecodable', reason: 'the CMap cannot be read' };
      return { kind: 'glyphs', glyphs: splitComposite(parts, cache, string) };
    },
  };
};

const loadFont = (context: LoadContext, value: PdfDirectObject, key: string): FontModel => {
  const { source } = context;
  const reference = value.kind === 'reference' ? value : undefined;
  const dictionary = dictionaryOf(source.objects.deref(value));
  if (dictionary === undefined) {
    const reason = 'the font is not a dictionary';
    return {
      key,
      reference,
      dictionary: new PdfDictionaryEntries(),
      subtype: 'other',
      descendant: undefined,
      baseFont: undefined,
      writingMode: 0,
      glyphMatrix: THOUSANDTH,
      verticalExtent: { descent: -200, ascent: 800, estimated: true },
      toUnicode: 'absent',
      collectionMap: undefined,
      type3: undefined,
      warnings: [{ code: 'font-unreadable', detail: reason }],
      glyphs: () => ({ kind: 'undecodable', reason }),
    };
  }
  const baseFont = source.objects.deref(dictionary.get(BASE_FONT));
  const subtypeName = nameOf(source.objects.deref(dictionary.get(SUBTYPE)));
  const subtype = subtypeOf(subtypeName);
  const loaded: Loaded = {
    key,
    reference,
    dictionary,
    subtype,
    baseFont: baseFont?.kind === 'name' ? baseFont.bytes : undefined,
    ...readToUnicode(context, dictionary),
  };
  const model = subtype === 'Type0' ? compositeModel(context, loaded) : simpleModel(context, loaded);
  return {
    key,
    reference,
    dictionary,
    subtype,
    baseFont: loaded.baseFont,
    toUnicode: loaded.toUnicodeState,
    warnings: context.warnings,
    ...model,
  };
};

/**
 * The fonts of one document, each read once per key (see `fontKey`), with the CMaps they use resolved through one CMapResolver and the caller's provider.
 * Damage in a font becomes a warning on its model, never an exception; decoded streams past the document's `maxDecodedBytes` and CMaps past their entry limit throw ResourceLimitError.
 */
export class FontCache {
  private readonly source: FontSource;
  private readonly cmaps: CMapResolver;
  private readonly fonts = new Map<string, FontModel>();

  constructor(source: FontSource, provider: CMapProvider | undefined) {
    this.source = source;
    this.cmaps = new CMapResolver(source, provider);
  }

  font(value: PdfDirectObject, key: string): FontModel {
    let font = this.fonts.get(key);
    if (font === undefined) {
      font = loadFont({ source: this.source, cmaps: this.cmaps, warnings: [] }, value, key);
      this.fonts.set(key, font);
    }
    return font;
  }
}
