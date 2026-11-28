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
  readonly defaults: ReadonlyArray<number>;
  readonly glyphs: ReadonlyArray<readonly [number, number]>;
}

export interface SyntheticFontOptions {
  /** The PostScript name, written to the name table. */
  readonly name: string;
  /** The glyphs by index; glyph 0 is .notdef. */
  readonly glyphs: ReadonlyArray<SyntheticGlyph>;
  /** Unicode code points and the glyph index each maps to. */
  readonly characters: ReadonlyArray<readonly [number, number]>;
  readonly variations?: ReadonlyArray<SyntheticVariations>;
  readonly unitsPerEm?: number;
  readonly ascender?: number;
  readonly descender?: number;
}

// A field of `width` bytes holds an integer that fits it as either a signed or an unsigned value; anything else would wrap silently.
const bytesOf = (value: number, width: number): Array<number> => {
  if (!Number.isInteger(value) || value < -(256 ** width / 2) || value >= 256 ** width) {
    throw new RangeError(`${String(value)} does not fit a ${String(width)}-byte field`);
  }
  const unsigned = value < 0 ? value + 256 ** width : value;
  return Array.from({ length: width }, (_, index) => Math.floor(unsigned / 256 ** (width - 1 - index)) % 256);
};

const u16 = (...values: ReadonlyArray<number>): Array<number> => values.flatMap(value => bytesOf(value, 2));
const i16 = (...values: ReadonlyArray<number>): Array<number> =>
  values.flatMap(value => {
    if (value > 32_767) {
      throw new RangeError(`${String(value)} does not fit an int16 field`);
    }
    return bytesOf(value, 2);
  });
const u24 = (value: number): Array<number> => bytesOf(value, 3);
const u32 = (...values: ReadonlyArray<number>): Array<number> => values.flatMap(value => bytesOf(value, 4));
// Table tags and Macintosh-platform names are written one byte per character, so only printable ASCII is accepted.
const tag = (text: string): Array<number> =>
  Array.from(text, character => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint > 0x7e) {
      throw new RangeError(`${JSON.stringify(text)} is not printable ASCII`);
    }
    return codePoint;
  });

const padded = (data: ReadonlyArray<number>): Array<number> => [...data, ...Array.from({ length: (4 - (data.length % 4)) % 4 }, () => 0)];

// A table checksum is the sum of the table as big-endian uint32 values, padded with zeros to a multiple of four bytes, modulo 2^32.
const checksum = (data: ReadonlyArray<number>): number => {
  const words = padded(data);
  let sum = 0;
  for (let index = 0; index < words.length; index += 4) {
    sum = (sum + (words[index] ?? 0) * 16_777_216 + (words[index + 1] ?? 0) * 65_536 + (words[index + 2] ?? 0) * 256 + (words[index + 3] ?? 0)) % 4_294_967_296;
  }
  return sum;
};

// A rectangle as one clockwise contour of four on-curve points, coordinates as int16 deltas (flag 0x01, no short vectors).
const glyphData = (box: SyntheticGlyph['box']): Array<number> => {
  if (box === undefined) {
    return [];
  }
  const [xMin, yMin, xMax, yMax] = box;
  const xs = [xMin, 0, xMax - xMin, 0];
  const ys = [yMin, yMax - yMin, 0, yMin - yMax];
  return padded([...u16(1), ...i16(xMin, yMin, xMax, yMax), ...u16(3, 0), 1, 1, 1, 1, ...i16(...xs), ...i16(...ys)]);
};

const extent = (glyphs: ReadonlyArray<SyntheticGlyph>, index: 0 | 1 | 2 | 3, pick: (...values: Array<number>) => number): number => {
  const values = glyphs.flatMap(glyph => (glyph.box === undefined ? [] : [glyph.box[index]]));
  return values.length === 0 ? 0 : pick(...values);
};

const format4 = (characters: ReadonlyArray<readonly [number, number]>): Array<number> => {
  const bmp = characters.filter(([codePoint]) => codePoint <= 0xff_fe).toSorted(([left], [right]) => left - right);
  // One segment per character, with the delta that maps it to its glyph, and the terminal 0xFFFF segment.
  const segments = [...bmp.map(([codePoint, glyph]) => [codePoint, (glyph - codePoint + 65_536) % 65_536] as const), [0xff_ff, 1] as const];
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

const format12 = (characters: ReadonlyArray<readonly [number, number]>): Array<number> => {
  const sorted = characters.toSorted(([left], [right]) => left - right);
  return [...u16(12, 0), ...u32(16 + 12 * sorted.length, 0, sorted.length), ...sorted.flatMap(([codePoint, glyph]) => u32(codePoint, codePoint, glyph))];
};

const format14 = (variations: ReadonlyArray<SyntheticVariations>): Array<number> => {
  const header = 10 + 11 * variations.length;
  const records: Array<number> = [];
  const tables: Array<number> = [];
  // OpenType cmap format 14 requires the VariationSelector records sorted by increasing varSelector.
  for (const { selector, defaults, glyphs } of variations.toSorted((left, right) => left.selector - right.selector)) {
    const defaultOffset = header + tables.length;
    tables.push(...u32(defaults.length));
    for (const codePoint of defaults.toSorted((left, right) => left - right)) {
      tables.push(...u24(codePoint), 0);
    }
    const glyphOffset = header + tables.length;
    tables.push(...u32(glyphs.length));
    for (const [codePoint, glyph] of glyphs.toSorted(([left], [right]) => left - right)) {
      tables.push(...u24(codePoint), ...u16(glyph));
    }
    records.push(...u24(selector), ...u32(defaultOffset, glyphOffset));
  }
  return [...u16(14), ...u32(header + tables.length, variations.length), ...records, ...tables];
};

const cmapTable = (options: SyntheticFontOptions): Array<number> => {
  const subtables: Array<readonly [number, number, Array<number>]> = [[3, 1, format4(options.characters)]];
  if (options.characters.some(([codePoint]) => codePoint > 0xff_ff)) {
    subtables.push([3, 10, format12(options.characters)]);
  }
  if (options.variations !== undefined) {
    subtables.push([0, 5, format14(options.variations)]);
  }
  subtables.sort(([leftPlatform, leftEncoding], [rightPlatform, rightEncoding]) => leftPlatform - rightPlatform || leftEncoding - rightEncoding);
  let offset = 4 + 8 * subtables.length;
  const records: Array<number> = [];
  const bodies: Array<number> = [];
  for (const [platform, encoding, body] of subtables) {
    records.push(...u16(platform, encoding), ...u32(offset));
    bodies.push(...body);
    offset += body.length;
  }
  return [...u16(0, subtables.length), ...records, ...bodies];
};

// Name records for the Macintosh (1, 0, English) and Windows (3, 1, en-US) platforms: family, subfamily, unique identifier, full name and PostScript name.
const nameTable = (name: string): Array<number> => {
  const values: ReadonlyArray<readonly [number, string]> = [
    [1, name],
    [2, 'Regular'],
    [3, name],
    [4, name],
    [6, name],
  ];
  const records: Array<number> = [];
  const strings: Array<number> = [];
  for (const [platform, encoding, language] of [
    [1, 0, 0],
    [3, 1, 0x4_09],
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

const once = (seen: Set<number>, value: number, what: string): void => {
  if (!Number.isInteger(value) || value < 0 || value > 0x10_ff_ff || seen.has(value)) {
    throw new RangeError(`${what} ${value.toString(16)} is not a code point or is listed twice`);
  }
  seen.add(value);
};

// A metric outside its field, a mapping to a glyph the font lacks, or a character mapped twice would be written as asked and read back as something else.
const checkOptions = (options: SyntheticFontOptions): void => {
  const { unitsPerEm = 1000, ascender = 0, descender = 0 } = options;
  // OpenType head: unitsPerEm is 16 to 16384; usWinDescent in OS/2 is the descender's magnitude as a uint16.
  if (!Number.isInteger(unitsPerEm) || unitsPerEm < 16 || unitsPerEm > 16_384 || unitsPerEm % 2 !== 0) {
    throw new RangeError(`unitsPerEm ${String(unitsPerEm)} is not an even integer from 16 to 16384`);
  }
  if (!Number.isInteger(ascender) || !Number.isInteger(descender) || ascender < 0 || ascender > 32_767 || descender > 0 || descender < -32_767) {
    throw new RangeError('the ascender must be 0 to 32767 and the descender -32767 to 0');
  }
  const glyph = (index: number): void => {
    if (!Number.isInteger(index) || index < 0 || index >= options.glyphs.length) {
      throw new RangeError(`glyph ${String(index)} is not one of the ${String(options.glyphs.length)} glyphs`);
    }
  };
  for (const [index, { advance, box, vertical }] of options.glyphs.entries()) {
    const verticalAdvance = vertical?.advance ?? 0;
    const topSideBearing = vertical?.topSideBearing ?? 0;
    if (
      ![advance, verticalAdvance, topSideBearing].every(Number.isInteger) ||
      [advance, verticalAdvance].some(value => value < 0 || value > 0xff_ff) ||
      Math.abs(topSideBearing) > 32_767
    ) {
      throw new RangeError(`glyph ${String(index)} has an advance outside uint16 or a side bearing outside int16`);
    }
    if (box !== undefined && (box[0] > box[2] || box[1] > box[3])) {
      throw new RangeError(`glyph ${String(index)} has a box whose minimum exceeds its maximum`);
    }
  }
  const characters = new Set<number>();
  for (const [codePoint, index] of options.characters) {
    once(characters, codePoint, 'character');
    glyph(index);
  }
  const selectors = new Set<number>();
  for (const { selector, defaults, glyphs } of options.variations ?? []) {
    once(selectors, selector, 'variation selector');
    const bases = new Set<number>();
    for (const codePoint of defaults) {
      once(bases, codePoint, 'base character');
    }
    for (const [codePoint, index] of glyphs) {
      once(bases, codePoint, 'base character');
      glyph(index);
    }
  }
};

/** A TrueType program with the tables head, hhea, maxp, loca, glyf, hmtx, cmap, post (version 3.0), name, OS/2, vhea and vmtx. */
export const syntheticTrueType = (options: SyntheticFontOptions): Uint8Array => {
  checkOptions(options);
  const { glyphs } = options;
  const unitsPerEm = options.unitsPerEm ?? 1000;
  const ascender = options.ascender ?? 800;
  const descender = options.descender ?? -200;
  const [xMin, yMin, xMax, yMax] = [extent(glyphs, 0, Math.min), extent(glyphs, 1, Math.min), extent(glyphs, 2, Math.max), extent(glyphs, 3, Math.max)];
  const maxAdvance = Math.max(...glyphs.map(glyph => glyph.advance));
  const outlines = glyphs.map(glyph => glyphData(glyph.box));
  const offsets = [0];
  for (const outline of outlines) {
    offsets.push((offsets.at(-1) ?? 0) + outline.length);
  }
  const codePoints = options.characters.map(([codePoint]) => codePoint);
  const firstChar = Math.min(0xff_ff, ...codePoints);
  const lastChar = Math.min(0xff_ff, Math.max(0, ...codePoints));
  const verticalAdvance = (glyph: SyntheticGlyph): number => glyph.vertical?.advance ?? unitsPerEm;
  const tables: ReadonlyArray<readonly [string, Array<number>]> = [
    // head: version, fontRevision, checkSumAdjustment (set below), magicNumber, flags, unitsPerEm, created, modified, bounding box, macStyle, lowestRecPPEM, fontDirectionHint, indexToLocFormat 1 (long offsets), glyphDataFormat.
    [
      'head',
      [...u32(0x00_01_00_00, 0x00_01_00_00, 0, 0x5f_0f_3c_f5), ...u16(3, unitsPerEm), ...u32(0, 0, 0, 0), ...u16(xMin, yMin, xMax, yMax, 0, 8, 2, 1, 0)],
    ],
    // hhea: version, ascender, descender, lineGap, advanceWidthMax, minLeftSideBearing, minRightSideBearing, xMaxExtent, caret slope and offset, four reserved fields, metricDataFormat, numberOfHMetrics.
    ['hhea', [...u32(0x00_01_00_00), ...u16(ascender, descender, 0, maxAdvance, xMin, 0, xMax, 1, 0, 0, 0, 0, 0, 0, 0, glyphs.length)]],
    // maxp version 1.0: numGlyphs, then the limits of a font whose glyphs are four-point contours without instructions.
    ['maxp', [...u32(0x00_01_00_00), ...u16(glyphs.length, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)]],
    ['loca', u32(...offsets)],
    ['glyf', outlines.flat()],
    ['hmtx', glyphs.flatMap(glyph => u16(glyph.advance, glyph.box?.[0] ?? 0))],
    ['cmap', cmapTable(options)],
    // post version 3.0: no glyph names.
    ['post', [...u32(0x00_03_00_00, 0), ...u16(-100, 50), ...u32(0, 0, 0, 0, 0)]],
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
        ...u32(0x00_01_10_00),
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
  const header = [...u32(0x00_01_00_00), ...u16(sorted.length, 16 * power, Math.log2(power), 16 * sorted.length - 16 * power)];
  let offset = header.length + 16 * sorted.length;
  const directory: Array<number> = [];
  const bodies: Array<number> = [];
  let headOffset = 0;
  for (const [name, data] of sorted) {
    if (name === 'head') {
      headOffset = offset;
    }
    directory.push(...tag(name), ...u32(checksum(data), offset, data.length));
    const body = padded(data);
    bodies.push(...body);
    offset += body.length;
  }
  const font = [...header, ...directory, ...bodies];
  // head.checkSumAdjustment is 0xB1B0AFBA minus the checksum of the whole font computed with the field at 0.
  const adjustment = (0xb1_b0_af_ba - checksum(font) + 4_294_967_296) % 4_294_967_296;
  font.splice(headOffset + 8, 4, ...u32(adjustment));
  return Uint8Array.from(font);
};
