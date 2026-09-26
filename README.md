# pdfwright

pdfwright is a TypeScript PDF library for print production. This repository is the pnpm workspace that holds its packages, which use web-standard APIs only and are built as ESM with type declarations.

## Packages

| Package                                          | Role                                           |
| ------------------------------------------------ | ---------------------------------------------- |
| [`@pdfwright/core`](packages/core)               | The core package                               |
| [`@pdfwright/illustrator`](packages/illustrator) | The Adobe Illustrator interoperability package |

`@pdfwright/illustrator` is an independent implementation for interoperability with Adobe Illustrator. Adobe and Illustrator are either registered trademarks or trademarks of Adobe in the United States and/or other countries. pdfwright is not affiliated with, endorsed by or sponsored by Adobe.

## Development

See the contributor guide's [Setup](AGENTS.md#setup) and [The gate](AGENTS.md#the-gate) sections for development instructions.

## License

Licensed under either of the [Apache License, Version 2.0](LICENSE-APACHE) or the [MIT license](LICENSE-MIT), at your option.
