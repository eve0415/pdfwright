# SafeDocs targeted test files

These files are from https://github.com/pdf-association/safedocs at commit `68f730ab8c39204844112c499c5707b79878533b`: `Dual-startxref.pdf` from `Miscellaneous Targeted Test PDFs/`, and the two `Dialect-` files from `Dialects/`.
The repository is licensed under the Apache License 2.0 (https://github.com/pdf-association/safedocs/blob/68f730ab8c39204844112c499c5707b79878533b/LICENSE), and `NOTICE.txt` is its `NOTICE.txt` from the same commit.

| File                     | Bytes | SHA-256                                                            | `qpdf --check` exit | Encrypted |
| ------------------------ | ----- | ------------------------------------------------------------------ | ------------------- | --------- |
| Dialect-DictIsStream.pdf | 788   | `a9eb0a3fa943629f29b42471643436d5bca4c55b27ae9aabc8e17e1fc6889008` | 3                   | no        |
| Dialect-StreamIsDict.pdf | 755   | `0cd3361df97988626b219c9b691e51be5a290c79de5bcb3f7660c517a6e59ffc` | 3                   | no        |
| Dual-startxref.pdf       | 1637  | `378e1e7967af58f6847a2e6ac56d9384e4ba08071b7ecee1fba5785073409135` | 0                   | no        |
