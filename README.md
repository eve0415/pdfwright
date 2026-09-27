# pdfwright

pdfwright is a TypeScript PDF library for print production. This repository is the pnpm workspace that holds its packages, which use web-standard APIs only and are built as ESM with type declarations.

## Packages

| Package                                          | Role                                           |
| ------------------------------------------------ | ---------------------------------------------- |
| [`@pdfwright/core`](packages/core)               | The core package                               |
| [`@pdfwright/illustrator`](packages/illustrator) | The Adobe Illustrator interoperability package |

`@pdfwright/illustrator` is an independent implementation for interoperability with Adobe Illustrator. Adobe and Illustrator are either registered trademarks or trademarks of Adobe in the United States and/or other countries. pdfwright is not affiliated with, endorsed by or sponsored by Adobe.

## Writing a print page

This example writes a 100 × 60 mm page with bleed and trim boxes, a White spot fill, and a hairline Cut path. `save()` returns ordered byte chunks; call `toBytes()` when one buffer is needed.

```ts
import type { SavedPdf } from '@pdfwright/core';

import { cmyk, createDocument, mm, rect } from '@pdfwright/core';

export const writePrintPage = (): SavedPdf => {
  const document = createDocument({ info: { title: 'White ink proof' } });
  const white = document.separation({ name: 'White', alternate: cmyk(0, 0, 0, 0.1) });
  const cut = document.separation({ name: 'Cut', alternate: cmyk(0, 0, 0, 0.5) });
  const page = document.addPage({
    mediaBox: rect(mm(0), mm(0), mm(100), mm(60)),
    bleedBox: rect(mm(2), mm(2), mm(98), mm(58)),
    trimBox: rect(mm(5), mm(5), mm(95), mm(55)),
  });
  page.draw(content => {
    content.fillColor(white, 1);
    content.path(path => path.rect(mm(10), mm(10), mm(80), mm(40)));
    content.fill('nonzero');
    content.strokeColor(cut, 1);
    content.lineWidth(0);
    content.path(path => path.rect(mm(5), mm(5), mm(90), mm(50)));
    content.stroke();
  });
  return document.save();
};
```

## Development

See the contributor guide's [Setup](AGENTS.md#setup) and [The gate](AGENTS.md#the-gate) sections for development instructions.

## License

Licensed under either of the [Apache License, Version 2.0](LICENSE-APACHE) or the [MIT license](LICENSE-MIT), at your option.
