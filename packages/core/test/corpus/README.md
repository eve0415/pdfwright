# PDF corpus

These files feed the corpus round trip in `packages/core/src/document/corpus.oracle.test.ts`: each file is loaded, saved incrementally and in full, reloaded from the saved chunks and compared with the source, and `qpdf --check` must report nothing worse for the saves than for the source.

| Directory   | Source                                               | Licence                  |
| ----------- | ---------------------------------------------------- | ------------------------ |
| `qpdf/`     | qpdf test files                                      | Apache License 2.0       |
| `cabinet/`  | openpreserve format-corpus pdfCabinetOfHorrors       | CC0 1.0                  |
| `safedocs/` | PDF Association SafeDocs targeted test files         | Apache License 2.0       |
| `govdocs1/` | Digital Corpora govdocs1, thread 000 (not committed) | See `govdocs1/README.md` |

Each directory's `README.md` records the source repository and commit, the licence and the SHA-256 of every file; the committed PDFs total about 1 MB.

`metadata-summary.json` lists the files that load and have metadata findings, with what `packages/core/src/metadata/metadata.oracle.test.ts` expects for each: orphaned metadata objects, packet headers that only earlier revisions hold, and the keys on which Info and XMP disagree.

`expected-failures.json` lists the files that must fail and why: encrypted files, which pdfwright refuses with a named error, and files whose structure readers disagree about, where pdfwright throws rather than chooses, or where comparisons must report the listed places as undecodable.
