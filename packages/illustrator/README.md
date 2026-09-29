# @pdfwright/illustrator

`@pdfwright/illustrator` writes a PDF 1.7 page showing composed print artwork and embeds an Illustrator-native copy of its layers, spot swatches, clipping groups, rasters and live strokes in the page-piece data, and reads that native copy back. It depends on `@pdfwright/core` and has no other runtime dependencies. Install both packages with `pnpm add @pdfwright/illustrator @pdfwright/core`.

This package is an independent implementation for interoperability, written from the structure of files saved by Adobe Illustrator. It does not use Adobe code, SDKs or documentation.

Adobe and Illustrator are either registered trademarks or trademarks of Adobe in the United States and/or other countries. This project is not affiliated with, endorsed by or sponsored by Adobe.

## Example

This page has a CMYK image, white ink and primer plates sharing one soft mask, and a hairline die stroke. The complete example is executed by the package tests.

```ts
import { mm, pdfDate } from '@pdfwright/core';
import { writeIllustratorPdf, type IllustratorDocument, type PathGeometry, type SpotColor } from '@pdfwright/illustrator';

const die: PathGeometry = {
  subpaths: [
    {
      start: [mm(5), mm(5)],
      segments: [
        { kind: 'line', to: [mm(45), mm(5)] },
        { kind: 'line', to: [mm(45), mm(35)] },
        { kind: 'line', to: [mm(5), mm(35)] },
      ],
    },
  ],
};
const bounds = { x: mm(10), y: mm(10), width: mm(30), height: mm(10) };
const alpha = Uint8Array.of(255, 128, 0);
const white: SpotColor = { name: 'White', alternate: [0, 0, 0, 0.1] };
const primer: SpotColor = { name: 'Primer', alternate: [0, 0, 0, 0.2] };
const cut: SpotColor = { name: 'Cut', alternate: [0, 1, 0, 0] };
const artwork: IllustratorDocument = {
  artboard: { width: mm(50), height: mm(40), bleed: mm(3) },
  layers: [
    {
      name: 'Design',
      items: [
        {
          kind: 'clipGroup',
          clip: die,
          items: [
            {
              kind: 'raster',
              width: 3,
              height: 1,
              bounds,
              color: { space: 'cmyk', samples: Uint8Array.of(0, 100, 20, 0, 20, 0, 100, 0, 0, 0, 0, 100) },
              alpha,
            },
          ],
        },
      ],
    },
    {
      name: 'Primer',
      items: [
        {
          kind: 'clipGroup',
          clip: die,
          items: [
            {
              kind: 'group',
              opacity: 0.3,
              isolated: true,
              items: [{ kind: 'raster', width: 3, height: 1, bounds, color: { space: 'spot', spot: primer }, alpha }],
            },
          ],
        },
      ],
    },
    {
      name: 'White',
      items: [{ kind: 'clipGroup', clip: die, items: [{ kind: 'raster', width: 3, height: 1, bounds, color: { space: 'spot', spot: white }, alpha }] }],
    },
    { name: 'Die line', items: [{ kind: 'path', geometry: die, stroke: { paint: { kind: 'spot', spot: cut }, width: 0 } }] },
  ],
  lastModified: pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' }),
};
const pdfBytes = writeIllustratorPdf(artwork);
```

Layers are supplied in paint order, bottom first; the Layers panel shows the reverse order. Coordinates are points from the artboard's lower-left corner with y increasing upward. `mm`, `inch` and `pt` retain exact rational lengths until PDF serialization.

## Native coordinate origin

The `nativeOrigin` option of `writeIllustratorPdf` chooses where the Illustrator-native copy puts its coordinate origin. It changes only the native copy in the page-piece data; the model's coordinates and the visible PDF page are the same for both values, and each value writes the same bytes on every call.

| `nativeOrigin`                     | Native y | `%AI3_Cropmarks` | `%%PageOrigin` | `PositionPoint1`, `PositionPoint2` | `RulerOrigin`                    |
| ---------------------------------- | -------- | ---------------- | -------------- | ---------------------------------- | -------------------------------- |
| `'artboard-bottom-left'` (default) | 0 to H   | `0 0 W H`        | `0 H`          | (0, H), (W, 0)                     | (⌊8191.5 − W/2⌋, ⌊8191.5 − H/2⌋) |
| `'artboard-top-left'`              | −H to 0  | `0 −H W 0`       | `0 0`          | (0, 0), (W, −H)                    | (8191.5 − W/2, 8191.5 + H/2)     |

W and H are the artboard width and height in points. The structure comparison against Illustrator 30.8.2 saves described below records `%AI3_Cropmarks: 0 0 W H` in every one of those saves, which is the `'artboard-bottom-left'` form, the default. Those saves were made in an Illustrator whose rulers showed y increasing upward; whether Illustrator writes the `'artboard-top-left'` form under other ruler settings has not been checked. Package output in either form opened in Illustrator 30.8.2 with the same editable artwork; no other Illustrator version has been checked.

## Reading the native data

`readIllustratorPdf` reads the Illustrator-native layer copy of a PDF's first page back into an `IllustratorDocument`, for tests that check what a writer of Illustrator-layered production PDFs put in the native data.

```ts
readIllustratorPdf(pdf: Uint8Array, options: ReadIllustratorPdfOptions): IllustratorPdfContents

interface ReadIllustratorPdfOptions {
  readonly zstandard: ZstandardDecompressor;
}

type ZstandardDecompressor = (frame: Uint8Array) => Uint8Array;

interface IllustratorPdfContents {
  readonly document: IllustratorDocument;
  readonly nativeOrigin: NativeOrigin;
  readonly header: ReadonlyMap<string, string>;
  readonly native: Uint8Array;
  readonly lastModified: { readonly page: Uint8Array; readonly application: Uint8Array };
  readonly privateDataKeys: readonly string[];
  readonly blockLengths: readonly number[];
  readonly compression: NativePayloadCompression;
}

type NativePayloadCompression =
  | { readonly kind: 'zstandard'; readonly frameHeaderDescriptor: number; readonly windowDescriptor: number | undefined }
  | { readonly kind: 'zlib' };
```

The caller supplies the Zstandard decoder, as the caller may supply the encoder through the `compression` option of `writeIllustratorPdf`. The package's own encoder writes only raw literals and predefined FSE sequence tables, so it contains none of the Huffman literal decoding and compressed FSE table decoding that a general decoder needs for frames written by Illustrator or by any other encoder, and writing one would add a second, much larger codec to a package whose runtime dependency is `@pdfwright/core` alone. Any function that decodes one complete frame (RFC 8878, 3.1.1) will do; the `decompress` function of the `fzstd` package is one:

```ts
import { decompress } from 'fzstd';
import { readIllustratorPdf } from '@pdfwright/illustrator';

const contents = readIllustratorPdf(pdfBytes, { zstandard: decompress });
contents.document.layers.map(layer => layer.name);
contents.header.get('%AI3_Cropmarks');
```

The decoder receives the frame that follows the 20-byte `%AI24_ZStandard_Data` wrapper. A `%AI12_CompressedData` payload is zlib data, which `@pdfwright/core` inflates without calling the decoder; this package does not write that wrapper.

- `document` holds the artwork in model coordinates, points from the artboard's lower-left corner, whichever origin the native copy declares. Every optional field is materialized: layers carry `visible`, `locked`, `opacity` and `color`, every item carries `locked`, groups carry `opacity` and `isolated`, fills and strokes carry `overprint`, spot paints carry `tint`, path geometries carry `fillRule`, segments carry `anchor`, bleed is given per side, and a subpath the writer closed with a final line keeps that line. Numbers are those of the native copy, which keeps at most ten fractional digits, and quadratic segments come back as the cubic curves they were written as, so a test comparing against its own input compares against the input with the same defaults and rounding applied. `lastModified` is the page's `/LastModified` date, because the native header keeps only the minute.
- `nativeOrigin` is read from `%AI3_Cropmarks`: `0 0 W H` is `'artboard-bottom-left'` and `0 −H W 0` is `'artboard-top-left'`, and any other cropmarks raise `UnsupportedFeatureError`. Under `'artboard-top-left'` every y is restored by adding H, and because the native copy keeps both y − H and H rounded to ten decimals, a restored coordinate can differ from the bottom-left reading by one unit in the tenth decimal place. In the package tests, writing a document read that way again with `'artboard-top-left'` gave the same native bytes.
- `header` maps each native header comment through `%%EndComments` to the text after its first colon, and `%AI5_FileFormat` to its version. Values are as written, so `%%BoundingBox` and `%%HiResBoundingBox` stay in native coordinates.
- `native` is the decompressed native data; `lastModified` holds the bytes of the page's and the Illustrator page-piece dictionary's `/LastModified` strings, which Illustrator compares; `privateDataKeys` lists the keys of the Illustrator `/Private` dictionary in file order; `blockLengths` gives the length of each `AIPDFPrivateData` block in block order; and `compression` names the wrapper and, for Zstandard, the frame's Frame_Header_Descriptor and Window_Descriptor bytes (RFC 8878, 3.1.1.1), the latter `undefined` for a single-segment frame.

The reader accepts the native grammar this package writes and the layer artwork of the three Illustrator 30.8.2 saves described below. It raises `@pdfwright/core` errors:

| Error                     | When                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ValidationError`         | The PDF has no page, or its first page has no Illustrator page-piece data or no `AIPDFPrivateData` block.                                                                                                                                                                                                                                       |
| `ParseError`              | A container object is missing or has the wrong type, the page date is not a PDF date, or the native data has a line without its closing CR, truncated raster data or a malformed number or string; for native data, `offset` is the byte offset in the decompressed native data.                                                                |
| `UnsupportedFeatureError` | The payload wrapper is neither `%AI24_ZStandard_Data` nor `%AI12_CompressedData`, a block has a filter other than FlateDecode, or the native data uses grammar the reader does not support, such as the sublayers or the RGB paint of the 30.8.2 saves that have them; for a native line the reader rejects, the message gives its byte offset. |
| `InvalidArgumentError`    | `options.zstandard` is not a function, or it returns something other than a `Uint8Array`.                                                                                                                                                                                                                                                       |

An error the decoder itself throws reaches the caller unchanged.

## Checked structure

The reference structure was recorded from PDFs saved by Illustrator 30.8.2 with “Preserve Illustrator Editing Capabilities” at Acrobat 4 and Acrobat 8 compatibility. Local structural comparisons cover private-data key sets and versions, 65,536-byte chunking, equal page and application dates, the Zstandard frame header and window, cropmarks, layer and raster counts, path and group operator counts, and layer and object lock fields. `readIllustratorPdf` also reconstructs supported layer artwork from three 30.8.2 saves; writing and reading that artwork again preserves its normalized structure and raster color and alpha bytes. Package-generated PDFs are checked for those container fields, artboard declarations under both native origins, native layer/path/clip/raster round trips, fixed-point numbers without exponent form, and visible separations rendered at 72 dpi. A 10 MB mixed raster payload was decoded byte-for-byte by two independent Zstandard decoders.

Compound paths occur in those saves only in symbol and brush-pattern definitions, not in layer artwork, and a save that has them has eighteen. Each opens with `0 Ae` and `*u` and closes with `*U`; between them every subpath is its own path object with its own anchor count and paint operator, and the paint state is written on the first object only. One of them, which also nests groups and carries a compound-shape art dictionary, has `1 XR` in that paint state; every other `XR` in the saves is `0 XR`. The package writes compound paths in that grammar. Package-generated compound paths and compound clips round-trip through `readIllustratorPdf` under both fill rules, and Ghostscript renders the even-odd hole of a compound fill and a compound clip, and the filled middle of a nonzero compound clip, at 72 dpi.

In Illustrator 30.8.2, package output opened as editable layers with the artboard in view, and View → Fit Artboard in Window fitted the artboard. The Design, White and Primer rasters kept their soft alpha edges. Files using Zstandard frames with a content size or raw blocks, and files written with either `nativeOrigin`, opened with the same editable artwork. When the page and application `/LastModified` dates differed, Illustrator offered to keep editing or accept changes; accepting changes imported the visible page with the White and Primer spot plates intact as Separation images with soft masks. Illustrator 30.8.2 rejected `%AI12_CompressedData` and imported only the visible page.

## Supported features and limits

- CMYK documents, bleed, visible and hidden layers, layer and group opacity, layer and object locks, closed filled or stroked paths, spot colors and tints, overprint, clipping groups, and CMYK or spot rasters with alpha are supported.
- `info` writes a document information dictionary with an agreeing XMP packet; its `modificationDate` defaults to the model's `lastModified`, and without `info` the PDF has neither. `fractionDigits` (0 to 10, 5 by default) sets the fractional digits of the reals on the visible page, so `fractionDigits: 6` keeps a spot alternate component such as 0.960571 that the default would round to 0.96057. The native copy keeps its own fixed precision.
- The native copy's coordinate origin is selectable with `nativeOrigin`: the artboard's lower-left corner by default, or its upper-left corner. Package tests check each value's cropmarks, page origin, artboard position points, ruler origin and artwork offset, that the visible page is unchanged, and that output is deterministic.
- Layer and object locks are written in native data and round-trip through `readIllustratorPdf`. In Illustrator 30.8.2, a package-generated file with a locked layer, a locked object on an unlocked layer, and a locked hidden layer opened with those locks set, and they remained set after the file was reopened.
- A path's geometry is one or more closed subpaths with a fill rule, `'nonzero'` by default or `'evenodd'`, which decides which areas the fill and a clipping group's clip enclose; the stroke follows every subpath under either rule. On the visible page the subpaths form one path painted with `f`, `f*`, `S`, `B` or `B*` or clipped with `W` or `W*`. In the native copy, one subpath is written as an ordinary path and two or more as a compound path, so a one-member compound path cannot be expressed. Segments are lines, cubic curves, or quadratic curves, which are written as the cubic curve that traces the same points and stay exact for exact lengths.
- Compound paths and the even-odd rule in the native copy follow the grammar of compound paths in Illustrator 30.8.2 saves, but no package-generated file using them has been opened in Illustrator yet. The fill rule is written as `0 XR` or `1 XR`; those saves write `0 XR` on ordinary paths and `1 XR` only on a compound path, and reading `1` as the even-odd rule is an inference. A clipping path made of several subpaths is written as a compound path whose members each end with `h W n`, a form those saves do not contain. The path-direction operator `D` that Illustrator writes on some compound-path members is not written, so each subpath keeps the direction its points give it.
- RGB documents, text, gradients, open paths, and custom stroke caps, joins and dashes are outside `IllustratorDocument`. TypeScript rejects these fields in document literals; `UnsupportedFeatureError` rejects extra fields if they reach runtime.
- Page colorant names default to UTF-8. Illustrator on a Japanese system writes Shift_JIS bytes for some names; pass `SpotColor.nameBytes` to choose the bytes on the visible page. Native names remain UTF-8.
- Group and clipping-group nesting is limited to 128 levels; deeper artwork raises `ValidationError`.
- The default Zstandard encoder uses raw literals and predefined FSE sequence tables. On two inspected 30.8.2 native payloads, its frames measured about 1.1 and 1.3 times the size of Illustrator's frames. A caller-supplied compressor's frame header is normalized; compressed payload corruption is not detected by this package.

Licensed under MIT OR Apache-2.0.
