# @pdfwright/illustrator

`@pdfwright/illustrator` writes a PDF 1.7 page showing composed print artwork and embeds an Illustrator-native copy of its layers, spot swatches, clipping groups, rasters and live strokes in the page-piece data. It depends on `@pdfwright/core` and has no other runtime dependencies. Install both packages with `pnpm add @pdfwright/illustrator @pdfwright/core`.

This package is an independent implementation for interoperability, written from the structure of files saved by Adobe Illustrator. It does not use Adobe code, SDKs or documentation.

Adobe and Illustrator are either registered trademarks or trademarks of Adobe in the United States and/or other countries. This project is not affiliated with, endorsed by or sponsored by Adobe.

## Example

This page has a CMYK image, white ink and primer plates sharing one soft mask, and a hairline die stroke. The complete example is executed by the package tests.

```ts
import { mm, pdfDate } from '@pdfwright/core';
import { writeIllustratorPdf, type IllustratorDocument, type PathGeometry, type SpotColor } from '@pdfwright/illustrator';

const die: PathGeometry = {
  start: [mm(5), mm(5)],
  segments: [
    { kind: 'line', to: [mm(45), mm(5)] },
    { kind: 'line', to: [mm(45), mm(35)] },
    { kind: 'line', to: [mm(5), mm(35)] },
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

## Checked structure

The reference structure was recorded from PDFs saved by Illustrator 30.8.2 with “Preserve Illustrator Editing Capabilities” at Acrobat 4 and Acrobat 8 compatibility. Local structural comparisons cover private-data key sets and versions, 65,536-byte chunking, equal page and application dates, the Zstandard frame header and window, cropmarks, layer and raster counts, path and group operator counts, and layer and object lock fields. The local reader also reconstructs supported layer artwork from three 30.8.2 saves; writing and reading that artwork again preserves its normalized structure and raster color and alpha bytes. Package-generated PDFs are checked for those container fields, artboard declarations, native layer/path/clip/raster round trips, fixed-point numbers without exponent form, and visible separations rendered at 72 dpi. A 10 MB mixed raster payload was decoded byte-for-byte by two independent Zstandard decoders.

In Illustrator 30.8.2, package output opened as editable layers with the artboard in view, and View → Fit Artboard in Window fitted the artboard. The Design, White and Primer rasters kept their soft alpha edges. Files using Zstandard frames with a content size or raw blocks, and files written with either `nativeOrigin`, opened with the same editable artwork. When the page and application `/LastModified` dates differed, Illustrator offered to keep editing or accept changes; accepting changes imported the visible page with the White and Primer spot plates intact as Separation images with soft masks. Illustrator 30.8.2 rejected `%AI12_CompressedData` and imported only the visible page.

## Supported features and limits

- CMYK documents, bleed, visible and hidden layers, layer and group opacity, layer and object locks, closed filled or stroked paths, spot colors and tints, overprint, clipping groups, and CMYK or spot rasters with alpha are supported.
- The native copy's coordinate origin is selectable with `nativeOrigin`: the artboard's lower-left corner by default, or its upper-left corner. Package tests check each value's cropmarks, page origin, artboard position points, ruler origin and artwork offset, that the visible page is unchanged, and that output is deterministic.
- Layer and object locks are written in native data and round-trip through the test reader. In Illustrator 30.8.2, a package-generated file with a locked layer, a locked object on an unlocked layer, and a locked hidden layer opened with those locks set, and they remained set after the file was reopened.
- RGB documents, text, gradients, open or compound paths, and custom stroke caps, joins and dashes are outside `IllustratorDocument`. TypeScript rejects these fields in document literals; `UnsupportedFeatureError` rejects extra fields if they reach runtime.
- Page colorant names default to UTF-8. Illustrator on a Japanese system writes Shift_JIS bytes for some names; pass `SpotColor.nameBytes` to choose the bytes on the visible page. Native names remain UTF-8.
- Group and clipping-group nesting is limited to 128 levels; deeper artwork raises `ValidationError`.
- The default Zstandard encoder uses raw literals and predefined FSE sequence tables. On two inspected 30.8.2 native payloads, its frames measured about 1.1 and 1.3 times the size of Illustrator's frames. A caller-supplied compressor's frame header is normalized; compressed payload corruption is not detected by this package.

Licensed under MIT OR Apache-2.0.
