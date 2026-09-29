# @pdfwright/core

The core package of pdfwright, a TypeScript PDF library for print production.

Install with `pnpm add @pdfwright/core`.

See the [repository README](https://github.com/eve0415/pdfwright#readme) for usage and API details.

## Decoding images

`decodeJpeg` and `decodePng` decode image files with web-standard APIs only, so the same bytes decode to the same samples in browsers, Workers, Node, Deno and Bun. Neither converts colour: each returns the file's samples together with the colour information the file carries, for the caller to apply.

### JPEG

```ts
import { decodeJpeg } from '@pdfwright/core';

const jpeg = decodeJpeg(bytes, { maxDecodedBytes: 64 * 1024 * 1024 });
const samples = new Uint8Array(jpeg.width * jpeg.height * jpeg.components);
let offset = 0;
for (const row of jpeg.rows()) {
  samples.set(row, offset);
  offset += row.length;
}
```

`decodeJpeg(data: Uint8Array, options?: DecodeJpegOptions): DecodedJpeg` reads the headers at once and decodes samples one MCU row at a time as `rows()` is iterated; each call to `rows()` decodes from the start again. It reads baseline and extended sequential 8-bit Huffman JPEG with one interleaved scan (ITU-T T.81, Annex F), in grey or three components with 4:4:4, 4:2:2 or 4:2:0 sampling.

| Field                 | Contents                                                                                                                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `width`, `height`     | The frame size in pixels.                                                                                                                                                                                                                                                        |
| `components`          | 1 or 3, the samples per pixel in each row.                                                                                                                                                                                                                                       |
| `colorSpace`          | `'gray'` or `'rgb'`. Three-component YCbCr is converted to RGB when the colour transform is 1: an Adobe APP14 transform flag decides, then the `colorTransform` option, then the default of 1 for three components.                                                              |
| `adobeColorTransform` | The APP14 transform flag, or `undefined`.                                                                                                                                                                                                                                        |
| `iccProfile`          | The profile reassembled from APP2 `ICC_PROFILE` segments (ICC.1, Annex B.4) in sequence-number order, as bytes, or `undefined`. A missing, repeated or inconsistent chunk throws `ParseError`. Pass it to `parseIccProfile` or `createColorTransform` to use it.                 |
| `orientation`         | The Orientation value (1 to 8) from IFD0 of the first APP1 Exif segment (TIFF 6.0 structure), or `undefined`. Exif never makes a file fail: an unreadable directory, a tag of the wrong type or count, or a value outside 1 to 8 gives `undefined`. The samples are not rotated. |
| `rows()`              | A generator of rows, top first, each `width × components` interleaved 8-bit samples.                                                                                                                                                                                             |

### PNG

```ts
import { decodePng, pngToRgba8 } from '@pdfwright/core';

const png = decodePng(bytes, { maxDecodedBytes: 64 * 1024 * 1024 });
const rgba = pngToRgba8(png);
```

`decodePng(data: Uint8Array, options?: DecodePngOptions): DecodedPng` decodes every colour type and bit depth of PNG (W3C PNG Third Edition, which ISO/IEC 15948 standardises), PLTE and tRNS, and Adam7 interlacing. It verifies every chunk's CRC and the image data's Adler-32 check value, enforces the chunk-ordering rules for the chunks it reads, and inflates with this package's own inflater.

- `samples` holds one element per sample: rows top to bottom, pixels left to right, the channels of a pixel adjacent (grey; grey, alpha; red, green, blue; or red, green, blue, alpha). Bit depths 1 to 8 give a `Uint8Array` of unscaled values from 0 to 2^depth − 1, and bit depth 16 gives a `Uint16Array`. Indexed-colour images hold palette indices, every one of which is checked against `PLTE`. The layout is the same for interlaced files.
- `colorType` (`'gray' | 'rgb' | 'indexed' | 'gray-alpha' | 'rgba'`), `bitDepth`, `channels` and `interlaced` describe the header.
- `palette` (RGB byte triples), `paletteAlpha` (an indexed image's `tRNS` table, which may be shorter than the palette) and `transparentColor` (a grey or truecolour image's `tRNS` key, in stored sample values) describe transparency.
- `iccProfile` (`{ name, profile }`, the inflated `iCCP` profile as bytes), `srgbIntent` (the `sRGB` rendering intent), `gamma` (the `gAMA` value as stored, gamma × 100,000) and `chromaticities` (the eight `cHRM` values as stored, × 100,000) are passed through as data and never applied.

`pngToRgba8(png: DecodedPng): Uint8Array` converts a decoded PNG to 8-bit RGBA with straight (unassociated) alpha, four bytes per pixel. 1-, 2- and 4-bit samples are scaled exactly (× 255, × 85, × 17), 16-bit samples are reduced to their high byte (`v >> 8`, which can differ by one from the rounding PNG Third Edition, 13.12 describes), palette entries and `tRNS` supply colour and alpha, and a colour key is matched at the stored sample depth.

An unknown ancillary chunk and bytes after `IEND` are ignored.

### Errors and limits

| Condition                                                                                         | Error                     | Reason                                                                                          |
| ------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| The file ends early                                                                               | `ParseError`              | `'image-truncated'`                                                                             |
| A PNG chunk CRC does not match                                                                    | `ParseError`              | `'image-crc-mismatch'`                                                                          |
| A zlib Adler-32 check value in a PNG does not match                                               | `ParseError`              | `'image-checksum-mismatch'`                                                                     |
| Any other malformed structure, value or chunk order                                               | `ParseError`              | `'image-invalid'`                                                                               |
| Progressive, lossless, arithmetic-coded, 12-bit, four-component, multi-scan or other JPEG process | `UnsupportedFeatureError` | `'jpeg-progressive'`, `'jpeg-lossless'`, `'jpeg-arithmetic'`, `'jpeg-12-bit'`, `'jpeg-cmyk'`, … |
| A PNG critical chunk this decoder does not know                                                   | `UnsupportedFeatureError` | `'png-critical-chunk'`                                                                          |
| A size past a limit below                                                                         | `ResourceLimitError`      |                                                                                                 |
| A limit that is not a positive integer                                                            | `InvalidArgumentError`    |                                                                                                 |

| Limit                                                                            | Default | Option            |
| -------------------------------------------------------------------------------- | ------: | ----------------- |
| JPEG width × height × components                                                 |  16 MiB | `maxDecodedBytes` |
| JPEG working storage for one MCU row                                             |   4 MiB | `maxRowBytes`     |
| PNG inflated image data and returned sample bytes, each; an inflated ICC profile |  16 MiB | `maxDecodedBytes` |

Both decoders check their limits against the header before decoding any sample.

Licensed under MIT OR Apache-2.0.
