// Writes minimal TrueType programs whose glyphs are rectangles of known metrics, so that tests can embed fonts without third-party font data.
// The tables and their fields follow the OpenType specification's chapters on each table, and the checksums and the head checkSumAdjustment follow its description of table checksums.

/** One glyph: its advance width, its rectangle in font units (none for an empty glyph), and its vertical advance and top side bearing. */
export interface SyntheticGlyph {
  readonly advance: number;
  readonly box?: readonly [number, number, number, number];
  readonly vertical?: { readonly advance: number; readonly topSideBearing: number };
}

/** A variation selector and the sequences it forms: base characters that keep their default glyph, and base characters with a glyph of their own. */
export interface SyntheticVariations {
  readonly selector: number;
  readonly defaults: readonly number[];
  readonly glyphs: readonly (readonly [number, number])[];
}

export interface SyntheticFontOptions {
  /** The PostScript name, written to the name table. */
  readonly name: string;
  /** The glyphs by index; glyph 0 is .notdef. */
  readonly glyphs: readonly SyntheticGlyph[];
  /** Unicode code points and the glyph index each maps to. */
  readonly characters: readonly (readonly [number, number])[];
  readonly variations?: readonly SyntheticVariations[];
  readonly unitsPerEm?: number;
  readonly ascender?: number;
  readonly descender?: number;
}

const bytesOf = (value: number, width: number): number[] => {
  const unsigned = value < 0 ? value + 256 ** width : value;
  return Array.from({ length: width }, (_, index) => Math.floor(unsigned / 256 ** (width - 1 - index)) % 256);
};

const u16 = (...values: readonly number[]): number[] => values.flatMap(value => bytesOf(value, 2));
const u24 = (value: number): number[] => bytesOf(value, 3);
const u32 = (...values: readonly number[]): number[] => values.flatMap(value => bytesOf(value, 4));
const tag = (text: string): number[] => Array.from(text, character => character.codePointAt(0) ?? 0);

const padded = (data: readonly number[]): number[] => [...data, ...Array.from({ length: (4 - (data.length % 4)) % 4 }, () => 0)];

// A table checksum is the sum of the table as big-endian uint32 values, padded with zeros to a multiple of four bytes, modulo 2^32.
const checksum = (data: readonly number[]): number => {
  const words = padded(data);
  let sum = 0;
  for (let index = 0; index < words.length; index += 4) {
    sum = (sum + (words[index] ?? 0) * 16_777_216 + (words[index + 1] ?? 0) * 65_536 + (words[index + 2] ?? 0) * 256 + (words[index + 3] ?? 0)) % 4_294_967_296;
  }
  return sum;
};

// A rectangle as one clockwise contour of four on-curve points, coordinates as int16 deltas (flag 0x01, no short vectors).
const glyphData = (box: SyntheticGlyph['box']): number[] => {
  if (box === undefined) return [];
  const [xMin, yMin, xMax, yMax] = box;
  const xs = [xMin, 0, xMax - xMin, 0];
  const ys = [yMin, yMax - yMin, 0, yMin - yMax];
  return padded([...u16(1, xMin, yMin, xMax, yMax), ...u16(3, 0), 1, 1, 1, 1, ...u16(...xs), ...u16(...ys)]);
};

const extent = (glyphs: readonly SyntheticGlyph[], index: 0 | 1 | 2 | 3, pick: (...values: number[]) => number): number => {
  const values = glyphs.flatMap(glyph => (glyph.box === undefined ? [] : [glyph.box[index]]));
  return values.length === 0 ? 0 : pick(...values);
};

const format4 = (characters: readonly (readonly [number, number])[]): number[] => {
  const bmp = characters.filter(([codePoint]) => codePoint <= 0xfffe).toSorted(([left], [right]) => left - right);
  // One segment per character, with the delta that maps it to its glyph, and the terminal 0xFFFF segment.
  const segments = [...bmp.map(([codePoint, glyph]) => [codePoint, (glyph - codePoint + 65_536) % 65_536] as const), [0xffff, 1] as const];
  const count = segments.length;
  const power = 2 ** Math.floor(Math.log2(count));
  const body = [
    ...u16(...segments.map(([codePoint]) => codePoint)),
    ...u16(0),
    ...u16(...segments.map(([codePoint]) => codePoint)),
    ...u16(...segments.map(([, delta]) => delta)),
    ...u16(...segments.map(() => 0)),
  ];
  return [...u16(4, 14 + body.length, 0, 2 * count, 2 * power, Math.log2(power), 2 * count - 2 * power), ...body];
};

const format12 = (characters: readonly (readonly [number, number])[]): number[] => {
  const sorted = characters.toSorted(([left], [right]) => left - right);
  return [...u16(12, 0), ...u32(16 + 12 * sorted.length, 0, sorted.length), ...sorted.flatMap(([codePoint, glyph]) => u32(codePoint, codePoint, glyph))];
};

const format14 = (variations: readonly SyntheticVariations[]): number[] => {
  const header = 10 + 11 * variations.length;
  const records: number[] = [];
  const tables: number[] = [];
  for (const { selector, defaults, glyphs } of variations) {
    const defaultOffset = header + tables.length;
    tables.push(...u32(defaults.length));
    for (const codePoint of defaults.toSorted((left, right) => left - right)) tables.push(...u24(codePoint), 0);
    const glyphOffset = header + tables.length;
    tables.push(...u32(glyphs.length));
    for (const [codePoint, glyph] of glyphs.toSorted(([left], [right]) => left - right)) tables.push(...u24(codePoint), ...u16(glyph));
    records.push(...u24(selector), ...u32(defaultOffset, glyphOffset));
  }
  return [...u16(14), ...u32(header + tables.length, variations.length), ...records, ...tables];
};

const cmapTable = (options: SyntheticFontOptions): number[] => {
  const subtables: (readonly [number, number, number[]])[] = [[3, 1, format4(options.characters)]];
  if (options.characters.some(([codePoint]) => codePoint > 0xffff)) subtables.push([3, 10, format12(options.characters)]);
  if (options.variations !== undefined) subtables.push([0, 5, format14(options.variations)]);
  subtables.sort(([leftPlatform, leftEncoding], [rightPlatform, rightEncoding]) => leftPlatform - rightPlatform || leftEncoding - rightEncoding);
  let offset = 4 + 8 * subtables.length;
  const records: number[] = [];
  const bodies: number[] = [];
  for (const [platform, encoding, body] of subtables) {
    records.push(...u16(platform, encoding), ...u32(offset));
    bodies.push(...body);
    offset += body.length;
  }
  return [...u16(0, subtables.length), ...records, ...bodies];
};

// Name records for the Macintosh (1, 0, English) and Windows (3, 1, en-US) platforms: family, subfamily, unique identifier, full name and PostScript name.
const nameTable = (name: string): number[] => {
  const values: readonly (readonly [number, string])[] = [
    [1, name],
    [2, 'Regular'],
    [3, name],
    [4, name],
    [6, name],
  ];
  const records: number[] = [];
  const strings: number[] = [];
  for (const [platform, encoding, language] of [
    [1, 0, 0],
    [3, 1, 0x409],
  ] as const) {
    for (const [id, text] of values) {
      const data = platform === 1 ? tag(text) : Array.from(text, character => u16(character.codePointAt(0) ?? 0)).flat();
      records.push(...u16(platform, encoding, language, id, data.length, strings.length));
      strings.push(...data);
    }
  }
  const count = records.length / 12;
  return [...u16(0, count, 6 + 12 * count), ...records, ...strings];
};

/** A TrueType program with the tables head, hhea, maxp, loca, glyf, hmtx, cmap, post (version 3.0), name, OS/2, vhea and vmtx. */
export const syntheticTrueType = (options: SyntheticFontOptions): Uint8Array => {
  const { glyphs } = options;
  const unitsPerEm = options.unitsPerEm ?? 1000;
  const ascender = options.ascender ?? 800;
  const descender = options.descender ?? -200;
  const [xMin, yMin, xMax, yMax] = [extent(glyphs, 0, Math.min), extent(glyphs, 1, Math.min), extent(glyphs, 2, Math.max), extent(glyphs, 3, Math.max)];
  const maxAdvance = Math.max(...glyphs.map(glyph => glyph.advance));
  const outlines = glyphs.map(glyph => glyphData(glyph.box));
  const offsets = [0];
  for (const outline of outlines) offsets.push((offsets.at(-1) ?? 0) + outline.length);
  const codePoints = options.characters.map(([codePoint]) => codePoint);
  const firstChar = Math.min(0xffff, ...codePoints);
  const lastChar = Math.min(0xffff, Math.max(0, ...codePoints));
  const verticalAdvance = (glyph: SyntheticGlyph): number => glyph.vertical?.advance ?? unitsPerEm;
  const tables: readonly (readonly [string, number[]])[] = [
    // head: version, fontRevision, checkSumAdjustment (set below), magicNumber, flags, unitsPerEm, created, modified, bounding box, macStyle, lowestRecPPEM, fontDirectionHint, indexToLocFormat 1 (long offsets), glyphDataFormat.
    ['head', [...u32(0x00010000, 0x00010000, 0, 0x5f0f3cf5), ...u16(3, unitsPerEm), ...u32(0, 0, 0, 0), ...u16(xMin, yMin, xMax, yMax, 0, 8, 2, 1, 0)]],
    // hhea: version, ascender, descender, lineGap, advanceWidthMax, minLeftSideBearing, minRightSideBearing, xMaxExtent, caret slope and offset, four reserved fields, metricDataFormat, numberOfHMetrics.
    ['hhea', [...u32(0x00010000), ...u16(ascender, descender, 0, maxAdvance, xMin, 0, xMax, 1, 0, 0, 0, 0, 0, 0, 0, glyphs.length)]],
    // maxp version 1.0: numGlyphs, then the limits of a font whose glyphs are four-point contours without instructions.
    ['maxp', [...u32(0x00010000), ...u16(glyphs.length, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)]],
    ['loca', u32(...offsets)],
    ['glyf', outlines.flat()],
    ['hmtx', glyphs.flatMap(glyph => u16(glyph.advance, glyph.box?.[0] ?? 0))],
    ['cmap', cmapTable(options)],
    // post version 3.0: no glyph names.
    ['post', [...u32(0x00030000, 0), ...u16(-100, 50), ...u32(0, 0, 0, 0, 0)]],
    ['name', nameTable(options.name)],
    // OS/2 version 4: average width, weight 400, width class 5, fsType 0 (installable embedding), sub- and superscript metrics, strikeout, family class, PANOSE, Unicode ranges, vendor, fsSelection REGULAR, character range, typographic and Windows metrics, code page ranges, x-height, cap height, default and break characters, usMaxContext.
    [
      'OS/2',
      [
        ...u16(4, Math.round(maxAdvance / 2), 400, 5, 0, 650, 700, 0, 140, 650, 700, 0, 480, 50, 250, 0),
        ...Array.from({ length: 10 }, () => 0),
        ...u32(1, 0, 0, 0),
        ...tag('NONE'),
        ...u16(0x40, firstChar, lastChar, ascender, descender, 0, ascender, -descender),
        ...u32(1, 0),
        ...u16(500, 700, 0, 32, 0),
      ],
    ],
    // vhea version 1.1: vertTypoAscender, vertTypoDescender, vertTypoLineGap, advanceHeightMax, minTopSideBearing, minBottomSideBearing, yMaxExtent, caret slope and offset, four reserved fields, metricDataFormat, numOfLongVerMetrics.
    [
      'vhea',
      [
        ...u32(0x00011000),
        ...u16(
          unitsPerEm / 2,
          -unitsPerEm / 2,
          0,
          Math.max(...glyphs.map(glyph => verticalAdvance(glyph))),
          0,
          0,
          yMax - yMin,
          0,
          1,
          0,
          0,
          0,
          0,
          0,
          0,
          glyphs.length,
        ),
      ],
    ],
    ['vmtx', glyphs.flatMap(glyph => u16(verticalAdvance(glyph), glyph.vertical?.topSideBearing ?? 0))],
  ];
  const sorted = tables.toSorted(([left], [right]) => (left < right ? -1 : 1));
  const power = 2 ** Math.floor(Math.log2(sorted.length));
  const header = [...u32(0x00010000), ...u16(sorted.length, 16 * power, Math.log2(power), 16 * sorted.length - 16 * power)];
  let offset = header.length + 16 * sorted.length;
  const directory: number[] = [];
  const bodies: number[] = [];
  let headOffset = 0;
  for (const [name, data] of sorted) {
    if (name === 'head') headOffset = offset;
    directory.push(...tag(name), ...u32(checksum(data), offset, data.length));
    const body = padded(data);
    bodies.push(...body);
    offset += body.length;
  }
  const font = [...header, ...directory, ...bodies];
  // head.checkSumAdjustment is 0xB1B0AFBA minus the checksum of the whole font computed with the field at 0.
  const adjustment = (0xb1b0afba - checksum(font) + 4_294_967_296) % 4_294_967_296;
  font.splice(headOffset + 8, 4, ...u32(adjustment));
  return Uint8Array.from(font);
};
