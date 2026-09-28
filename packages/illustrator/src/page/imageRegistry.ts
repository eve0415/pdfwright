import type { PdfDocument, PdfImage } from '@pdfwright/core';

import { md5 } from '@pdfwright/core';

export interface ImageRegistry {
  stencil: (width: number, height: number, alpha: Uint8Array) => PdfImage;
}

const keyFor = (width: number, height: number, alpha: Uint8Array): string => {
  const prefix = new TextEncoder().encode(`${String(width)}:${String(height)}:`);
  const bytes = new Uint8Array(prefix.length + alpha.length);
  bytes.set(prefix);
  bytes.set(alpha, prefix.length);
  return [...md5(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const stencilSamples = (width: number, height: number): Uint8Array => {
  const rowBytes = Math.ceil(width / 8);
  const samples = new Uint8Array(rowBytes * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < rowBytes; column++) {
      const bits = Math.min(8, width - column * 8);
      samples[row * rowBytes + column] = 256 - 2 ** (8 - bits);
    }
  }
  return samples;
};

/** Reuses a one-bit all-ink ImageMask for plates with identical dimensions and alpha. */
export const createImageRegistry = (document: PdfDocument): ImageRegistry => {
  const stencils = new Map<string, PdfImage>();
  return {
    stencil: (width, height, alpha) => {
      const key = keyFor(width, height, alpha);
      let image = stencils.get(key);
      if (image === undefined) {
        image = document.image({
          width,
          height,
          colorSpace: 'ImageMask',
          bitsPerComponent: 1,
          samples: stencilSamples(width, height),
          softMask: { width, height, samples: alpha },
        });
        stencils.set(key, image);
      }
      return image;
    },
  };
};
