# govdocs1, thread 000

`manifest.json` lists the 200 PDFs of thread 000 of the govdocs1 corpus (https://digitalcorpora.org/corpora/file-corpora/files/) with their SHA-256, and the thread's zip file with its SHA-256.
The files are not committed.
Digital Corpora describes the corpus as "a corpus of 1 million documents that are freely available for research and may be (to the best of our knowledge) freely redistributed."

`node scripts/fetchCorpus.ts` downloads the zip, checks it against the manifest, and extracts the listed files into `.cache/files/`, where the corpus test finds them; without them that part of the test has nothing to check.
File 000146.pdf carries page-piece data (`/PieceInfo`).
