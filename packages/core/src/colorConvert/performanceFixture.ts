import type { IccProfile } from '../icc/iccProfile.ts';

import { cmyk } from '../document/color.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { createDocument } from '../document/pdfDocument.ts';
import { rect } from '../document/rect.ts';
import { pt } from '../length/length.ts';

import { convertImages } from './convertImages.ts';

const WIDTH = 1024;
const HEIGHT = 512;

/** A generated RGB image with varied samples, shared by the workerd timer and Node memory measurement. */
export const imageConversionFixture = (): Uint8Array => {
  const samples = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 3;
      samples[offset] = x % 256;
      samples[offset + 1] = y % 256;
      samples[offset + 2] = (x * 17 + y * 29) % 256;
    }
  }
  const document = createDocument();
  const image = document.image({ width: WIDTH, height: HEIGHT, colorSpace: 'DeviceRGB', bitsPerComponent: 8, samples });
  const plate = document.separation({ name: 'Varnish', alternate: cmyk(0, 0, 0, 0.2) });
  const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(600), pt(300)) });
  page.draw(content => {
    content.image(image, [600, 0, 0, 300, 0, 0]);
    content.fillColor(plate, 1);
    content.path(path => path.rect(20, 20, 100, 100));
    content.fill('nonzero');
  });
  return document.save().toBytes();
};

export interface ImageConversionMeasurement {
  readonly pixels: number;
  readonly converted: number;
  readonly kind: 'buffered' | 'streamed';
  readonly elapsedMs: number;
  readonly savedBytes: number;
}

export interface ImageConversionOptions {
  readonly source: IccProfile;
  readonly output: IccProfile;
  readonly sample?: () => void;
}

/** Measures the conversion pass and the save that produces its CMYK image bytes. */
export const measureImageConversion = async (input: Uint8Array, { source, output, sample }: ImageConversionOptions): Promise<ImageConversionMeasurement> => {
  const document = loadDocument(input);
  sample?.();
  const start = performance.now();
  const report = convertImages(document, { sourceRgbProfile: source, outputProfile: output });
  sample?.();
  const saved = document.save();
  let savedBytes = 0;
  for await (const chunk of saved.toStream()) {
    savedBytes += chunk.length;
    sample?.();
  }
  sample?.();
  return { pixels: WIDTH * HEIGHT, converted: report.converted, kind: saved.kind, elapsedMs: performance.now() - start, savedBytes };
};
