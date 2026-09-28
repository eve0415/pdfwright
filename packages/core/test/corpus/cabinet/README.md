# pdfCabinetOfHorrors files

These files are from `pdfCabinetOfHorrors/` in https://github.com/openpreserve/format-corpus at commit `366f068cec399d0cdfd61fa473de3ab6dc858098`.
That directory's `readme.md` (https://github.com/openpreserve/format-corpus/blob/366f068cec399d0cdfd61fa473de3ab6dc858098/pdfCabinetOfHorrors/readme.md) states: "License: All files in this folder: Creative Commons CC0: Public Domain Dedication."
They are the smaller files of that directory and cover encryption, byte-level corruption, fonts embedded or not, attachments, links and PDF/A.

| File                              | Bytes  | SHA-256                                                            | `qpdf 12.2.0 --check` exit | Encrypted |
| --------------------------------- | ------ | ------------------------------------------------------------------ | -------------------------- | --------- |
| calistoMTNoFontsEmbedded.pdf      | 9353   | `44f7582b024defc788adb8f35c719f72409ccd8c6929b2ece75af5791e5d3119` | 3                          | no        |
| corruptionOneByteMissing.pdf      | 39512  | `7423451704ef9cb32340618416796a812c47fa2337cf1356aa63c2f414b7798e` | 3                          | no        |
| encryption_nocopy.pdf             | 70599  | `dd55fec2e48a0f43266146e1d31155480695d31a28d0e4311bbd9472f9d992b3` | 3                          | yes       |
| encryption_openpassword.pdf       | 70599  | `01973e6b86f06d6b1cbb6c76a661a7859db958b0cc245a8a3350481ae8d92158` | 2                          | yes       |
| externalLink.pdf                  | 73227  | `14ca68bc60b188279ffa9b2dae926d9fe5cefe83b52fcdfd0a64e67232407008` | 3                          | no        |
| fileAttachment.pdf                | 78950  | `c7ff5c769c257a7ab0cc3a906e63b15aea91e1605a269b7dcbcb3911ea07681c` | 0                          | no        |
| javascript.pdf                    | 953    | `23f8479a3e56c2a344b371ebc6da219231e87de17750c92314cd06f7b06d8629` | 0                          | no        |
| pdf-17-header18.pdf               | 7717   | `15c6451235a988565d8d640088642e3611e6a37c1faac945af1a8ffccf1b0b38` | 3                          | no        |
| test_fontArialNotEmbedded.pdf     | 207305 | `4806e51b3a8725bcd4c06e9ca852874a4285da1bd57ce7a7c890ea2fe9f9a01c` | 3                          | no        |
| text_only_fontsEmbeddedAll.pdf    | 70062  | `8ee33b2b2dee93bf44c5426e12e12064bff001a808ff4d2feea87c7beea4e4ba` | 3                          | no        |
| text_only_fontsEmbeddedSubset.pdf | 33411  | `fb0c62591ac545f0b56e8986a30f67c008d0434b28ac5bd550e0e7ecd3c56435` | 3                          | no        |
| text_only_fontsNotEmbedded.pdf    | 7929   | `fc11edd136ab259f3f22a13c2740edccda4d9225c80aec94fe6834aad5a87713` | 3                          | no        |
| text_only_pdfa1b.pdf              | 39513  | `81bf11af4c56488c63c6d038d4ba09c7334dc3e26c5d6a17c7df9bd398f48635` | 0                          | no        |
| veraPDFHiRes.pdf                  | 65205  | `a9be3e1100d450637da1b9f8837384934b435ace122b3962136797fa8568a611` | 0                          | no        |
| veraPDFHiResChangedHeight.pdf     | 65205  | `1876e524237a7213b15667e57666ac092c219107502ba25ac49d9197650eeb27` | 0                          | no        |
| veraPDFHiResWrongObjectID.pdf     | 65205  | `dc7ae1ae93dab50806bf881077559bb004d7f18b9de6335aefbe0cd81aa966af` | 3                          | no        |
