# Illustrator-shaped fixtures

These PDFs are generated entirely by `node scripts/generateIllustratorFixtures.ts` from repository code and synthetic artwork. They contain no bytes from Adobe exports and are licensed under the repository's MIT OR Apache-2.0 terms.

`classic.pdf` has a classic cross-reference table, a direct page `/PieceInfo`, an indirect `/Illustrator` data dictionary and unfiltered `AIPDFPrivateData` streams. The streams split a `%AI24_ZStandard_Data` payload into 65,536-byte blocks. Its Zstandard frame has neither a content-size field nor a checksum.

`object-stream.pdf` has a cross-reference stream and a page inside an object stream. Its metadata stream and selected private-data blocks use Flate encoding, matching the storage variation seen after an Acrobat rewrite.

`incremental.pdf` starts with the classic structure and adds a second cross-reference section that updates the Info dictionary through `/Prev`.

The page and Illustrator data dictionary carry the same `D:…+09'00'` date spelling. The drawing occupies the lower-left corner and the page has a DeviceCMYK transparency group, leaving space for the added plate used by acceptance tests.
