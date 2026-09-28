# @pdfwright/illustrator

`@pdfwright/illustrator` writes a PDF 1.7 page showing composed print artwork and embeds an Illustrator-native copy of its layers, spot swatches, clipping groups, rasters and live strokes in the page-piece data. It depends on `@pdfwright/core` and has no other runtime dependencies. Install both packages with `pnpm add @pdfwright/illustrator @pdfwright/core`.

This package is an independent implementation for interoperability, written from the structure of files saved by Adobe Illustrator. It does not use Adobe code, SDKs or documentation.

Adobe and Illustrator are either registered trademarks or trademarks of Adobe in the United States and/or other countries. This project is not affiliated with, endorsed by or sponsored by Adobe.

## Example

This page has a CMYK image, white ink and primer plates sharing one alpha stencil, and a hairline die stroke. The complete example is executed by the package tests.

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

## Checked structure

The reference structure was recorded from PDFs saved by Illustrator 30.8.2 with “Preserve Illustrator Editing Capabilities” at Acrobat 4 and Acrobat 8 compatibility. Local structural comparisons cover private-data key sets and versions, 65,536-byte chunking, equal page and application dates, the Zstandard frame header and window, cropmarks, layer and raster counts, and path and group operator counts. Package-generated PDFs are checked for those container fields, artboard declarations, native layer/path/clip/raster round trips, fixed-point numbers without exponent form, and visible separations rendered at 72 dpi. A 10 MB mixed raster payload was decoded byte-for-byte by two independent Zstandard decoders.

## Supported features and limits

- CMYK documents, bleed, visible and hidden layers, layer and group opacity, closed filled or stroked paths, spot colors and tints, overprint, clipping groups, and CMYK or spot rasters with alpha are supported.
- `locked: true` raises `UnsupportedFeatureError` because the available 30.8.2 files do not establish the lock encoding.
- RGB documents, text, gradients, open or compound paths, and custom stroke caps, joins and dashes are outside `IllustratorDocument`. TypeScript rejects these fields in document literals.
- Page colorant names default to UTF-8. Illustrator on a Japanese system writes Shift_JIS bytes for some names; pass `SpotColor.nameBytes` to choose the bytes on the visible page. Native names remain UTF-8.
- The default Zstandard encoder uses raw literals and predefined FSE sequence tables. On two inspected 30.8.2 native payloads, its frames measured about 1.1 and 1.3 times the size of Illustrator's frames. A caller-supplied compressor's frame header is normalized; compressed payload corruption is not detected by this package.

Opening package output in Illustrator has not been checked, including the generated manual-check PDFs. Locked layers, RGB documents, text, open and compound paths, gradients, custom stroke settings, non-Japanese system locales, and which omitted Setup blocks Illustrator requires have not been open-tested. Acceptance of frame content sizes, the zlib wrapper, top-left native coordinates, indirect application data, and unequal page and application dates has not been checked in Illustrator.

Licensed under MIT OR Apache-2.0.
