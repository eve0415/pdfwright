import { ParseError } from '../error/parseError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

/** The predictor entries of ISO 32000-1:2008, 7.4.4.3, Table 8, with their defaults applied. */
export interface PredictorParameters {
  readonly predictor: number;
  readonly colors: number;
  readonly bitsPerComponent: number;
  readonly columns: number;
}

const validate = (parameters: PredictorParameters): void => {
  const { colors, bitsPerComponent, columns } = parameters;
  // Table 8: Colors "1 or greater (PDF 1.3)"; BitsPerComponent "Valid values are 1, 2, 4, 8, and (PDF 1.5) 16"; Columns "The number of samples in each row".
  if (!Number.isSafeInteger(colors) || colors < 1 || !Number.isSafeInteger(columns) || columns < 1 || ![1, 2, 4, 8, 16].includes(bitsPerComponent)) {
    throw new ParseError('predictor parameters outside ISO 32000-1 Table 8', 0);
  }
};

// RFC 2083, 6.6: the Paeth predictor picks whichever of left, above and upper left is closest to left + above - upper left, preferring them in that order.
const paeth = (left: number, above: number, upperLeft: number): number => {
  const estimate = left + above - upperLeft;
  const toLeft = Math.abs(estimate - left);
  const toAbove = Math.abs(estimate - above);
  const toUpperLeft = Math.abs(estimate - upperLeft);
  if (toLeft <= toAbove && toLeft <= toUpperLeft) return left;
  return toAbove <= toUpperLeft ? above : upperLeft;
};

// ISO 32000-1:2008, 7.4.4.4: "The postprediction data for each PNG-predicted row shall begin with an explicit algorithm tag", and the PNG group predicts each byte from the corresponding byte of earlier samples.
const undoPng = (data: Uint8Array, parameters: PredictorParameters): Uint8Array => {
  const rowBytes = Math.ceil((parameters.colors * parameters.bitsPerComponent * parameters.columns) / 8);
  const bytesPerPixel = Math.max(1, Math.ceil((parameters.colors * parameters.bitsPerComponent) / 8));
  const rowCount = Math.ceil(data.length / (rowBytes + 1));
  const output = new Uint8Array(data.length - rowCount);
  let previous = -1;
  for (let row = 0; row < rowCount; row++) {
    const input = row * (rowBytes + 1);
    const tag = data[input] ?? 0;
    if (tag > 4) throw new ParseError(`unknown PNG predictor tag ${String(tag)}`, input);
    const start = row * rowBytes;
    const width = Math.min(rowBytes, data.length - input - 1);
    for (let index = 0; index < width; index++) {
      // "All colour components of samples outside the image (which are necessary for predictions near the boundaries) shall be 0."
      const left = index >= bytesPerPixel ? (output[start + index - bytesPerPixel] ?? 0) : 0;
      const above = previous >= 0 ? (output[previous + index] ?? 0) : 0;
      const upperLeft = previous >= 0 && index >= bytesPerPixel ? (output[previous + index - bytesPerPixel] ?? 0) : 0;
      let prediction = 0;
      if (tag === 1) prediction = left;
      else if (tag === 2) prediction = above;
      else if (tag === 3) prediction = Math.floor((left + above) / 2);
      else if (tag === 4) prediction = paeth(left, above, upperLeft);
      output[start + index] = ((data[input + 1 + index] ?? 0) + prediction) % 256;
    }
    previous = start;
  }
  return output;
};

interface Component {
  readonly index: number;
  readonly bits: number;
}

const readComponent = (row: Uint8Array, { index, bits }: Component): number => {
  if (bits === 8) return row[index] ?? 0;
  if (bits === 16) return (row[index * 2] ?? 0) * 256 + (row[index * 2 + 1] ?? 0);
  // "Samples and their components shall be packed into bytes from high-order to low-order bits."
  const bit = index * bits;
  const shift = 8 - bits - (bit % 8);
  return Math.floor((row[Math.floor(bit / 8)] ?? 0) / 2 ** shift) % 2 ** bits;
};

const writeComponent = (row: Uint8Array, { index, bits }: Component, value: number): void => {
  if (bits === 8) row[index] = value;
  else if (bits === 16) {
    row[index * 2] = Math.floor(value / 256);
    row[index * 2 + 1] = value % 256;
  } else {
    const bit = index * bits;
    const shift = 8 - bits - (bit % 8);
    const byte = Math.floor(bit / 8);
    const current = row[byte] ?? 0;
    const cleared = current - (Math.floor(current / 2 ** shift) % 2 ** bits) * 2 ** shift;
    row[byte] = cleared + value * 2 ** shift;
  }
};

// ISO 32000-1:2008, 7.4.4.4, NOTE 1: "TIFF Predictor 2 predicts that each colour component of a sample is the same as the corresponding colour component of the sample immediately to its left."
const undoTiff = (data: Uint8Array, parameters: PredictorParameters): Uint8Array => {
  const { colors, bitsPerComponent: bits, columns } = parameters;
  const rowBytes = Math.ceil((colors * bits * columns) / 8);
  const output = Uint8Array.from(data);
  const modulus = 2 ** bits;
  for (let start = 0; start + rowBytes <= output.length; start += rowBytes) {
    const row = output.subarray(start, start + rowBytes);
    for (let index = colors; index < colors * columns; index++) {
      const component = { index, bits };
      writeComponent(row, component, (readComponent(row, component) + readComponent(row, { index: index - colors, bits })) % modulus);
    }
  }
  return output;
};

/** Reverses the predictor an LZWDecode or FlateDecode stream was encoded with (ISO 32000-1:2008, 7.4.4.4, Table 10). */
export const undoPredictor = (data: Uint8Array, parameters: PredictorParameters): Uint8Array => {
  if (parameters.predictor === 1) return data;
  validate(parameters);
  // Table 10: 2 is TIFF Predictor 2, and "a Predictor value greater than or equal to 10 shall indicate that a PNG predictor is in use".
  if (parameters.predictor === 2) return undoTiff(data, parameters);
  if (parameters.predictor >= 10 && parameters.predictor <= 15) return undoPng(data, parameters);
  throw new UnsupportedFeatureError(`predictor ${String(parameters.predictor)} is not defined by ISO 32000-1 Table 10`);
};
