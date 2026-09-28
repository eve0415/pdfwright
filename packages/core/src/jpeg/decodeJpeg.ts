import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

export interface DecodedJpeg {
  readonly width: number;
  readonly height: number;
  readonly components: 1 | 3;
  readonly adobeColorTransform: number | undefined;
  readonly rows: () => Generator<Uint8Array>;
}

export interface DecodeJpegOptions {
  /** Maximum total decoded sample bytes, 16 MiB by default. */
  readonly maxDecodedBytes?: number;
  /** Maximum storage for one MCU row, 4 MiB by default. */
  readonly maxRowBytes?: number;
  /** PDF DCTDecode ColorTransform when APP14 does not provide one; defaults to 1 for three components and 0 for one. Invalid caller values throw InvalidArgumentError; invalid PDF /ColorTransform values throw ParseError during transcoding. */
  readonly colorTransform?: 0 | 1;
}

interface Component {
  readonly id: number;
  readonly horizontal: number;
  readonly vertical: number;
  readonly quantization: number;
}

interface Frame {
  readonly width: number;
  readonly height: number;
  readonly components: readonly Component[];
  readonly maxHorizontal: number;
  readonly maxVertical: number;
}

interface HuffmanTable {
  readonly minimum: Int32Array;
  readonly maximum: Int32Array;
  readonly offsets: Int32Array;
  readonly symbols: Uint8Array;
}

interface ScanComponent {
  readonly component: Component;
  readonly dc: HuffmanTable;
  readonly ac: HuffmanTable;
  readonly quantization: Uint16Array;
}

interface Scan {
  readonly data: Uint8Array;
  readonly start: number;
  readonly end: number;
  readonly frame: Frame;
  readonly components: readonly ScanComponent[];
  readonly restartInterval: number;
  readonly colorTransform: number;
}

interface MarkerLocation {
  readonly marker: number;
  readonly next: number;
}

interface SegmentBounds {
  readonly start: number;
  readonly end: number;
}

interface DecodedBlock {
  readonly samples: Uint8Array;
  readonly dc: number;
}

interface ParserState {
  readonly quantization: (Uint16Array | undefined)[];
  readonly dc: (HuffmanTable | undefined)[];
  readonly ac: (HuffmanTable | undefined)[];
  frame: Frame | undefined;
  restartInterval: number;
  adobeColorTransform: number | undefined;
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22,
  15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// Fixed constants and evaluation order make IDCT rounding repeatable across runtimes.
const COSINE = [
  [1, 0.98078528040323043, 0.92387953251128674, 0.83146961230254524, Math.SQRT1_2, 0.55557023301960229, 0.38268343236508984, 0.19509032201612833],
  [1, 0.83146961230254524, 0.38268343236508984, -0.19509032201612819, -Math.SQRT1_2, -0.98078528040323043, -0.92387953251128685, -0.55557023301960218],
  [1, 0.55557023301960229, -0.38268343236508973, -0.98078528040323043, -Math.SQRT1_2, 0.1950903220161283, 0.92387953251128652, 0.83146961230254546],
  [1, 0.19509032201612833, -0.92387953251128674, -0.55557023301960218, Math.SQRT1_2, 0.83146961230254546, -0.38268343236508989, -0.98078528040323065],
];

const invalid = (offset: number, detail: string): never => {
  throw new ParseError(`invalid JPEG: ${detail}`, offset);
};

const unsupported = (
  reason:
    | 'jpeg-progressive'
    | 'jpeg-arithmetic'
    | 'jpeg-lossless'
    | 'jpeg-12-bit'
    | 'jpeg-cmyk'
    | 'jpeg-multi-scan'
    | 'jpeg-sampling'
    | 'jpeg-color-transform'
    | 'jpeg-process',
): never => {
  throw new UnsupportedFeatureError(`JPEG feature is unsupported: ${reason}`, reason);
};

const byte = (data: Uint8Array, offset: number): number => data[offset] ?? invalid(offset, 'truncated marker segment');
const word = (data: Uint8Array, offset: number): number => byte(data, offset) * 256 + byte(data, offset + 1);

const markerAt = (data: Uint8Array, position: number): MarkerLocation => {
  if (byte(data, position) !== 0xff) return invalid(position, 'expected marker');
  let next = position + 1;
  while (byte(data, next) === 0xff) next++;
  const marker = byte(data, next);
  if (marker === 0) return invalid(next, 'unexpected stuffed byte outside scan');
  return { marker, next: next + 1 };
};

const segment = (data: Uint8Array, position: number): SegmentBounds => {
  const length = word(data, position);
  if (length < 2 || position + length > data.length) return invalid(position, 'marker segment length is invalid');
  return { start: position + 2, end: position + length };
};

const frameComponent = (data: Uint8Array, position: number): Component => {
  const id = byte(data, position);
  const factors = byte(data, position + 1);
  const horizontal = Math.floor(factors / 16);
  const vertical = factors % 16;
  const quantization = byte(data, position + 2);
  if (horizontal < 1 || horizontal > 2 || vertical < 1 || vertical > 2 || quantization > 3) return unsupported('jpeg-sampling');
  return { id, horizontal, vertical, quantization };
};

const checkSampling = (components: readonly Component[], maxHorizontal: number, maxVertical: number): void => {
  if (components.length === 1) {
    if (maxHorizontal !== 1 || maxVertical !== 1) unsupported('jpeg-sampling');
    return;
  }
  const [luma, firstChroma, secondChroma] = components;
  if (
    luma === undefined ||
    firstChroma === undefined ||
    secondChroma === undefined ||
    luma.horizontal !== maxHorizontal ||
    luma.vertical !== maxVertical ||
    firstChroma.horizontal !== 1 ||
    firstChroma.vertical !== 1 ||
    secondChroma.horizontal !== 1 ||
    secondChroma.vertical !== 1 ||
    (maxHorizontal === 1 && maxVertical !== 1)
  ) {
    unsupported('jpeg-sampling');
  }
};

// ITU-T T.81 (1992), B.2.2 and Table B.2 define SOF component identifiers, precision and sampling factors.
const frameHeader = (data: Uint8Array, bounds: SegmentBounds): Frame => {
  const { start, end } = bounds;
  if (end - start < 6) return invalid(start, 'frame header is short');
  const precision = byte(data, start);
  if (precision !== 8) return unsupported('jpeg-12-bit');
  const height = word(data, start + 1);
  const width = word(data, start + 3);
  const count = byte(data, start + 5);
  if (count === 4) return unsupported('jpeg-cmyk');
  if (count !== 1 && count !== 3) return unsupported('jpeg-sampling');
  if (height === 0 || width === 0 || end - start !== 6 + count * 3) return invalid(start, 'frame geometry is invalid');
  const components: Component[] = [];
  for (let index = 0; index < count; index++) {
    const position = start + 6 + index * 3;
    const component = frameComponent(data, position);
    if (components.some(item => item.id === component.id)) return invalid(position, 'duplicate component identifier');
    components.push(component);
  }
  const maxHorizontal = Math.max(...components.map(component => component.horizontal));
  const maxVertical = Math.max(...components.map(component => component.vertical));
  checkSampling(components, maxHorizontal, maxVertical);
  return { width, height, components, maxHorizontal, maxVertical };
};

// ITU-T T.81 (1992), B.2.4.1 and Figure B.6 specify DQT element precision and zigzag ordering.
const quantizationTables = (data: Uint8Array, bounds: SegmentBounds, tables: (Uint16Array | undefined)[]): void => {
  const { start, end } = bounds;
  let position = start;
  while (position < end) {
    const selector = byte(data, position++);
    const precision = Math.floor(selector / 16);
    const destination = selector % 16;
    if (precision > 1 || destination > 3) return invalid(position - 1, 'quantization table selector is invalid');
    const size = precision === 0 ? 1 : 2;
    if (position + 64 * size > end) return invalid(position, 'quantization table is short');
    const table = new Uint16Array(64);
    for (let index = 0; index < 64; index++) {
      const value = precision === 0 ? byte(data, position++) : word(data, position);
      if (precision === 1) position += 2;
      if (value === 0) return invalid(position, 'zero quantization value');
      table[ZIGZAG[index] ?? 0] = value;
    }
    tables[destination] = table;
  }
};

// ITU-T T.81 (1992), B.2.4.2 and Figure B.7 define the 16 code-length counts and their values.
const huffmanTables = (
  data: Uint8Array,
  bounds: SegmentBounds,
  tables: { readonly dc: (HuffmanTable | undefined)[]; readonly ac: (HuffmanTable | undefined)[] },
): void => {
  const { start, end } = bounds;
  let position = start;
  while (position < end) {
    const selector = byte(data, position++);
    const tableClass = Math.floor(selector / 16);
    const destination = selector % 16;
    if (tableClass > 1 || destination > 3 || position + 16 > end) return invalid(position - 1, 'Huffman table selector is invalid');
    const counts = data.subarray(position, position + 16);
    position += 16;
    const symbolCount = counts.reduce((sum, count) => sum + count, 0);
    if (position + symbolCount > end || symbolCount === 0) return invalid(position, 'Huffman values are invalid');
    const symbols = data.slice(position, position + symbolCount);
    position += symbolCount;
    const minimum = new Int32Array(17);
    const maximum = new Int32Array(17);
    const offsets = new Int32Array(17);
    minimum.fill(-1);
    maximum.fill(-1);
    let code = 0;
    let offset = 0;
    for (let length = 1; length <= 16; length++) {
      const count = counts[length - 1] ?? 0;
      if (code + count > 2 ** length) return invalid(position, 'Huffman code lengths oversubscribe the tree');
      if (count > 0) {
        minimum[length] = code;
        maximum[length] = code + count - 1;
        offsets[length] = offset;
      }
      code = (code + count) * 2;
      offset += count;
    }
    const table = { minimum, maximum, offsets, symbols };
    if (tableClass === 0) tables.dc[destination] = table;
    else tables.ac[destination] = table;
  }
};

const scanHeader = (
  data: Uint8Array,
  bounds: SegmentBounds,
  setup: {
    readonly frame: Frame;
    readonly quantization: readonly (Uint16Array | undefined)[];
    readonly dc: readonly (HuffmanTable | undefined)[];
    readonly ac: readonly (HuffmanTable | undefined)[];
  },
): ScanComponent[] => {
  const { start, end } = bounds;
  const { frame, quantization, dc, ac } = setup;
  // ITU-T T.81 (1992), B.2.3: one SOS with every frame component is an interleaved sequential scan.
  const count = byte(data, start);
  if (count !== frame.components.length) return unsupported('jpeg-multi-scan');
  if (end - start !== 1 + count * 2 + 3) return invalid(start, 'scan header length is invalid');
  const components: ScanComponent[] = [];
  for (let index = 0; index < count; index++) {
    const position = start + 1 + index * 2;
    const id = byte(data, position);
    const selector = byte(data, position + 1);
    const component = frame.components.find(item => item.id === id);
    if (component === undefined || components.some(item => item.component.id === id)) return invalid(position, 'scan component is invalid');
    const dcTable = dc[Math.floor(selector / 16)];
    const acTable = ac[selector % 16];
    const quantizationTable = quantization[component.quantization];
    if (dcTable === undefined || acTable === undefined || quantizationTable === undefined) return invalid(position, 'scan table is missing');
    components.push({ component, dc: dcTable, ac: acTable, quantization: quantizationTable });
  }
  const spectralStart = byte(data, end - 3);
  const spectralEnd = byte(data, end - 2);
  const approximation = byte(data, end - 1);
  if (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0) return unsupported('jpeg-progressive');
  return components;
};

const scanEnd = (data: Uint8Array, start: number): number => {
  // ITU-T T.81 (1992), B.1.1.5 and B.2.1: FF00 is entropy data, RSTn separates intervals, and EOI closes the frame.
  for (let position = start; position < data.length;) {
    if (data[position] !== 0xff) {
      position++;
      continue;
    }
    let markerPosition = position + 1;
    while (data[markerPosition] === 0xff) markerPosition++;
    const marker = byte(data, markerPosition);
    if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) {
      position = markerPosition + 1;
      continue;
    }
    if (marker === 0xd9) return position;
    if (marker === 0xda) return unsupported('jpeg-multi-scan');
    return invalid(position, 'unexpected marker after entropy data');
  }
  return invalid(data.length, 'missing end of image');
};

class EntropyReader {
  private readonly data: Uint8Array;
  private readonly end: number;
  private position: number;
  private bits = 0;
  private count = 0;

  constructor(data: Uint8Array, start: number, end: number) {
    this.data = data;
    this.position = start;
    this.end = end;
  }

  bit(): number {
    if (this.count === 0) {
      const { position } = this;
      if (position >= this.end) return invalid(position, 'truncated entropy data');
      this.bits = byte(this.data, this.position++);
      if (this.bits === 0xff && byte(this.data, this.position++) !== 0) return invalid(position, 'marker inside entropy code');
      this.count = 8;
    }
    this.count--;
    return Math.floor(this.bits / 2 ** this.count) % 2;
  }

  bitsOf(length: number): number {
    let result = 0;
    for (let index = 0; index < length; index++) result = result * 2 + this.bit();
    return result;
  }

  huffman(table: HuffmanTable): number {
    let code = 0;
    for (let length = 1; length <= 16; length++) {
      code = code * 2 + this.bit();
      const minimum = table.minimum[length] ?? -1;
      const maximum = table.maximum[length] ?? -1;
      if (minimum >= 0 && code <= maximum) {
        return table.symbols[(table.offsets[length] ?? 0) + code - minimum] ?? invalid(this.position, 'Huffman symbol is missing');
      }
    }
    return invalid(this.position, 'Huffman code is invalid');
  }

  signed(length: number): number {
    if (length === 0) return 0;
    const value = this.bitsOf(length);
    return value < 2 ** (length - 1) ? value - (2 ** length - 1) : value;
  }

  restart(number: number): void {
    this.count = 0;
    if (this.position >= this.end || byte(this.data, this.position++) !== 0xff) return invalid(this.position, 'restart marker is missing');
    while (this.position < this.end && this.data[this.position] === 0xff) this.position++;
    if (byte(this.data, this.position++) !== 0xd0 + number) return invalid(this.position, 'restart marker sequence is invalid');
  }

  finish(): void {
    // ITU-T T.81 (1992), B.1.1.5: unused Huffman bits at the end of a segment are all 1.
    if (this.position !== this.end || this.bits % 2 ** this.count !== 2 ** this.count - 1) {
      invalid(this.position, 'trailing entropy data or invalid pad bits');
    }
  }
}

const cosine = (position: number, frequency: number): number => {
  const value = COSINE[position < 4 ? position : 7 - position]?.[frequency] ?? 0;
  return position < 4 || frequency % 2 === 0 ? value : -value;
};

const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

// ITU-T T.81 (1992), A.3.3 and F.2.1.5: dequantize then inverse-DCT each 8-by-8 data unit, adding the 8-bit level shift.
export const inverseDct = (coefficients: Int32Array): Uint8Array => {
  const intermediate = new Float64Array(64);
  const output = new Uint8Array(64);
  for (let row = 0; row < 8; row++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let frequency = 0; frequency < 8; frequency++) {
        const scale = frequency === 0 ? Math.SQRT1_2 : 1;
        sum += scale * (coefficients[row * 8 + frequency] ?? 0) * cosine(x, frequency);
      }
      intermediate[row * 8 + x] = sum;
    }
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let frequency = 0; frequency < 8; frequency++) {
        const scale = frequency === 0 ? Math.SQRT1_2 : 1;
        sum += scale * (intermediate[frequency * 8 + x] ?? 0) * cosine(y, frequency);
      }
      output[y * 8 + x] = clamp(128 + sum / 4);
    }
  }
  return output;
};

const block = (reader: EntropyReader, component: ScanComponent, previous: number): DecodedBlock => {
  // ITU-T T.81 (1992), F.2.2.1 and F.2.2.2: DC differences and AC run/size symbols use separate Huffman tables.
  const coefficients = new Int32Array(64);
  const dcLength = reader.huffman(component.dc);
  if (dcLength > 16) return invalid(0, 'DC category is invalid');
  const dc = previous + reader.signed(dcLength);
  coefficients[0] = dc * (component.quantization[0] ?? 0);
  for (let index = 1; index < 64;) {
    const symbol = reader.huffman(component.ac);
    if (symbol === 0) break;
    const run = Math.floor(symbol / 16);
    const size = symbol % 16;
    if (size === 0 && run !== 15) return invalid(0, 'AC run is invalid');
    index += size === 0 ? 16 : run;
    // ITU-T T.81 (1992), F.2.2.2: a final ZRL may cover coefficients through position 63.
    if (index > 64 || (index === 64 && size !== 0)) return invalid(0, 'AC run exceeds block');
    if (size === 0) continue;
    const natural = ZIGZAG[index] ?? 0;
    coefficients[natural] = reader.signed(size) * (component.quantization[natural] ?? 0);
    index++;
  }
  return { samples: inverseDct(coefficients), dc };
};

interface Plane {
  readonly width: number;
  readonly samples: Uint8Array;
}

const rowPlanes = (frame: Frame, mcuColumns: number): Map<number, Plane> => {
  const planes = new Map<number, Plane>();
  for (const component of frame.components) {
    const width = mcuColumns * component.horizontal * 8;
    planes.set(component.id, { width, samples: new Uint8Array(width * component.vertical * 8) });
  }
  return planes;
};

const decodeMcu = (input: {
  readonly scan: Scan;
  readonly reader: EntropyReader;
  readonly predictors: Map<number, number>;
  readonly planes: ReadonlyMap<number, Plane>;
  readonly mcuColumn: number;
}): void => {
  const { scan, reader, predictors, planes, mcuColumn } = input;
  for (const scanned of scan.components) {
    const { component } = scanned;
    const plane = planes.get(component.id) ?? invalid(0, 'component plane is missing');
    for (let vertical = 0; vertical < component.vertical; vertical++) {
      for (let horizontal = 0; horizontal < component.horizontal; horizontal++) {
        const decoded = block(reader, scanned, predictors.get(component.id) ?? 0);
        predictors.set(component.id, decoded.dc);
        const x = (mcuColumn * component.horizontal + horizontal) * 8;
        const y = vertical * 8;
        for (let row = 0; row < 8; row++) plane.samples.set(decoded.samples.subarray(row * 8, row * 8 + 8), (y + row) * plane.width + x);
      }
    }
  }
};

const componentSamples = (frame: Frame, planes: ReadonlyMap<number, Plane>, point: { readonly x: number; readonly localY: number }): number[] =>
  frame.components.map(component => {
    const plane = planes.get(component.id);
    if (plane === undefined) return invalid(0, 'component plane is missing');
    const sourceX = Math.floor((point.x * component.horizontal) / frame.maxHorizontal);
    const sourceY = Math.floor((point.localY * component.vertical) / frame.maxVertical);
    return plane.samples[sourceY * plane.width + sourceX] ?? 0;
  });

const renderRow = (scan: Scan, planes: ReadonlyMap<number, Plane>, localY: number): Uint8Array => {
  const { frame } = scan;
  const output = new Uint8Array(frame.width * frame.components.length);
  for (let x = 0; x < frame.width; x++) {
    const samples = componentSamples(frame, planes, { x, localY });
    if (frame.components.length === 1) {
      output[x] = samples[0] ?? 0;
    } else if (scan.colorTransform === 0) {
      output[x * 3] = samples[0] ?? 0;
      output[x * 3 + 1] = samples[1] ?? 0;
      output[x * 3 + 2] = samples[2] ?? 0;
    } else {
      const y = samples[0] ?? 0;
      const cb = (samples[1] ?? 128) - 128;
      const cr = (samples[2] ?? 128) - 128;
      output[x * 3] = clamp(y + 1.402 * cr);
      output[x * 3 + 1] = clamp(y - 0.344136 * cb - 0.714136 * cr);
      output[x * 3 + 2] = clamp(y + 1.772 * cb);
    }
  }
  return output;
};

const rows = function* (scan: Scan, maxRowBytes: number): Generator<Uint8Array> {
  const { frame } = scan;
  const mcuColumns = Math.ceil(frame.width / (8 * frame.maxHorizontal));
  const mcuRows = Math.ceil(frame.height / (8 * frame.maxVertical));
  const storage = mcuColumns * 64 * frame.components.reduce((sum, component) => sum + component.horizontal * component.vertical, 0);
  if (storage + frame.width * frame.components.length > maxRowBytes) throw new ResourceLimitError('JPEG MCU row exceeds maxRowBytes');
  const reader = new EntropyReader(scan.data, scan.start, scan.end);
  const predictors = new Map<number, number>();
  let decodedMcus = 0;
  for (let mcuRow = 0; mcuRow < mcuRows; mcuRow++) {
    const planes = rowPlanes(frame, mcuColumns);
    for (let mcuColumn = 0; mcuColumn < mcuColumns; mcuColumn++) {
      if (scan.restartInterval > 0 && decodedMcus > 0 && decodedMcus % scan.restartInterval === 0) {
        reader.restart((decodedMcus / scan.restartInterval - 1) % 8);
        predictors.clear();
      }
      decodeMcu({ scan, reader, predictors, planes, mcuColumn });
      decodedMcus++;
    }
    if (mcuRow === mcuRows - 1) reader.finish();
    for (let localY = 0; localY < frame.maxVertical * 8 && mcuRow * frame.maxVertical * 8 + localY < frame.height; localY++) {
      yield renderRow(scan, planes, localY);
    }
  }
};

const parseHeaderSegment = (input: {
  readonly state: ParserState;
  readonly data: Uint8Array;
  readonly marker: number;
  readonly bounds: SegmentBounds;
}): void => {
  const { state, data, marker, bounds } = input;
  if (marker === 0xc0 || marker === 0xc1) {
    if (state.frame !== undefined) invalid(bounds.start, 'multiple frames');
    state.frame = frameHeader(data, bounds);
  } else if (marker === 0xdb) {
    quantizationTables(data, bounds, state.quantization);
  } else if (marker === 0xc4) {
    huffmanTables(data, bounds, state);
  } else if (marker === 0xdd) {
    if (bounds.end - bounds.start !== 2) invalid(bounds.start, 'restart interval length is invalid');
    state.restartInterval = word(data, bounds.start);
  } else if (marker === 0xee) {
    const adobe = [65, 100, 111, 98, 101];
    if (bounds.end - bounds.start >= 12 && adobe.every((value, index) => data[bounds.start + index] === value)) {
      state.adobeColorTransform = byte(data, bounds.start + 11);
      if (state.adobeColorTransform > 1) unsupported('jpeg-color-transform');
    }
  } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) {
    invalid(bounds.start, 'unsupported marker');
  }
};

const finishScan = (input: {
  readonly state: ParserState;
  readonly data: Uint8Array;
  readonly bounds: SegmentBounds;
  readonly start: number;
  readonly maxRowBytes: number;
  readonly maxDecodedBytes: number;
  readonly colorTransform: 0 | 1 | undefined;
}): DecodedJpeg => {
  const { state, data, bounds, start, maxRowBytes, maxDecodedBytes, colorTransform } = input;
  const { frame, quantization, dc, ac, restartInterval, adobeColorTransform } = state;
  if (frame === undefined) return invalid(bounds.start, 'scan has no frame');
  const components = scanHeader(data, bounds, { frame, quantization, dc, ac });
  const end = scanEnd(data, start);
  const mcuColumns = Math.ceil(frame.width / (8 * frame.maxHorizontal));
  const rowBytes =
    mcuColumns * 64 * frame.components.reduce((sum, component) => sum + component.horizontal * component.vertical, 0) + frame.width * frame.components.length;
  if (rowBytes > maxRowBytes) throw new ResourceLimitError('JPEG MCU row exceeds maxRowBytes');
  if (frame.width * frame.height * frame.components.length > maxDecodedBytes) {
    throw new ResourceLimitError('JPEG decoded samples exceed maxDecodedBytes');
  }
  // ISO 32000-1:2008, 7.4.8, Table 13: an Adobe marker overrides DecodeParms ColorTransform, whose absent three-component default is 1.
  const scan: Scan = {
    data,
    start,
    end,
    frame,
    components,
    restartInterval,
    colorTransform: adobeColorTransform ?? colorTransform ?? (frame.components.length === 3 ? 1 : 0),
  };
  return {
    width: frame.width,
    height: frame.height,
    components: frame.components.length === 3 ? 3 : 1,
    adobeColorTransform,
    rows: () => rows(scan, maxRowBytes),
  };
};

const checkFrameMarker = (marker: number): void => {
  if (marker === 0xcc || (marker >= 0xc9 && marker <= 0xcf)) unsupported('jpeg-arithmetic');
  if (marker === 0xc2 || marker === 0xc6) unsupported('jpeg-progressive');
  if (marker === 0xc3 || marker === 0xc7) unsupported('jpeg-lossless');
  if (marker === 0xc5 || marker === 0xc8 || marker === 0xf7) unsupported('jpeg-process');
};

/** Decodes a single-scan 8-bit sequential Huffman JPEG by MCU row; ITU-T T.81 (1992), B.2 and Annex F. */
export const decodeJpeg = (data: Uint8Array, options: DecodeJpegOptions = {}): DecodedJpeg => {
  if (byte(data, 0) !== 0xff || byte(data, 1) !== 0xd8) return invalid(0, 'missing start of image');
  const maxRowBytes = options.maxRowBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRowBytes) || maxRowBytes < 1) throw new ResourceLimitError('maxRowBytes must be a positive integer');
  const maxDecodedBytes = options.maxDecodedBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1) throw new ResourceLimitError('maxDecodedBytes must be a positive integer');
  const requestedTransform: unknown = options.colorTransform;
  if (requestedTransform !== undefined && requestedTransform !== 0 && requestedTransform !== 1) {
    throw new InvalidArgumentError('JPEG colorTransform must be 0 or 1');
  }
  const state: ParserState = { quantization: [], dc: [], ac: [], frame: undefined, restartInterval: 0, adobeColorTransform: undefined };
  let position = 2;
  while (position < data.length) {
    const current = markerAt(data, position);
    position = current.next;
    if (current.marker === 0xd9) return invalid(position, 'end of image precedes scan');
    if (current.marker >= 0xd0 && current.marker <= 0xd7) return invalid(position, 'restart marker outside scan');
    checkFrameMarker(current.marker);
    const bounds = segment(data, position);
    position = bounds.end;
    if (current.marker === 0xda) {
      return finishScan({ state, data, bounds, start: position, maxRowBytes, maxDecodedBytes, colorTransform: options.colorTransform });
    }
    parseHeaderSegment({ state, data, marker: current.marker, bounds });
  }
  return invalid(position, 'missing scan');
};
