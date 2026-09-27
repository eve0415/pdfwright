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

## Editing an existing file

`loadDocument` reads a file without copying it and parses objects when they are used; encrypted files are refused.
Its `maxPageTreeDepth` load option limits page tree levels from the root through a page to 256 by default and throws `ResourceLimitError` when exceeded.
Edits change only the objects they touch: this example sets a trim box and adds a Varnish plate to the first page.
`save()` appends the changes to an intact file as an incremental update, rewrites a file whose structure had to be repaired, and returns views of the input plus the new bytes, so the input is never copied.
`compareDocuments` reports what differs between two documents by page, box, content, resources, fonts and page-piece data, never by object number.
Because the input stays in memory, a 128 MB Cloudflare Workers isolate can edit files of up to about 80 MB.

```ts
import type { PdfDifference, SavedPdf } from '@pdfwright/core';

import { cmyk, compareDocuments, loadDocument, mm, rect } from '@pdfwright/core';

export interface VarnishEdit {
  readonly saved: SavedPdf;
  readonly differences: readonly PdfDifference[];
}

export const addVarnishPlate = (input: Uint8Array): VarnishEdit => {
  const document = loadDocument(input);
  const varnish = document.separation({ name: 'Varnish', alternate: cmyk(0, 0, 0.2, 0) });
  const page = document.page(0);
  page.setBox('TrimBox', rect(mm(6), mm(6), mm(94), mm(54)));
  page.appendContent(content => {
    content.fillColor(varnish, 1);
    content.path(path => path.rect(mm(10), mm(10), mm(80), mm(40)));
    content.fill('nonzero');
  });
  const saved = document.save();
  const { differences } = compareDocuments(loadDocument(input), loadDocument(saved.chunks));
  return { saved, differences };
};
```

## Development

See the contributor guide's [Setup](AGENTS.md#setup) and [The gate](AGENTS.md#the-gate) sections for development instructions.

## License

Licensed under either of the [Apache License, Version 2.0](LICENSE-APACHE) or the [MIT license](LICENSE-MIT), at your option.
