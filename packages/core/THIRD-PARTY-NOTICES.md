# Third-party notices

`@pdfwright/core` includes the following third-party data, each under the licence shown with it.

## Adobe Glyph List

- Source: <https://github.com/adobe-type-tools/agl-aglfn> at commit `4036a9ca80a62f64f9de4f7321a9a045ad0ecfd6`, the files `glyphlist.txt` (sha256 `a3b2f61ced9f3644cc0d4ecde5c59df34ca286c689d9484a43a710a81c466789`) and `zapfdingbats.txt` (sha256 `f6394e3cb8a447e84a1dad75d4baaf2aa7f45dc104faf369f4720e1a774ef2dc`).
- Use: the glyph-name to Unicode mapping of simple fonts, generated into `src/font/encoding/adobeGlyphList.ts` by `scripts/generateGlyphList.ts`, which keeps every data line and drops the comment lines.
- Copyright: "Copyright 2002-2019 Adobe (http://www.adobe.com/).", as the header of both files states.
- Licence: BSD 3-Clause License, the text of `LICENSE.md` at the same commit (sha256 `58147d341e7a34aa2196862395a34d2fd95716c41d5ed26efb59ab0e12f92089`):

```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

Redistributions of source code must retain the above copyright notice,
this list of conditions and the following disclaimer.

Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

Neither the name of Adobe nor the names of its contributors may be
used to endorse or promote products derived from this software without
specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Adobe Core 14 font metrics

- Source: `Core14_AFMs.zip` from <https://web.archive.org/web/2005id_/http://partners.adobe.com/public/developer/en/pdf/Core14_AFMs.zip> (sha256 `8c892c3c49553cfd2d2a27c4495b4bb12e2875115be7fd127ed3876df19d8654`), holding the 14 AFM files of the standard 14 fonts and `MustRead.html`.
- Use: the widths of standard 14 fonts that a PDF file gives without a Widths array, and their FontBBox, generated into `src/font/core14Metrics.ts` by `scripts/generateCore14Metrics.ts`.
- Modification: the generated file is a modification of the AFM files; each font's character widths (the WX and N values of its character metrics) and its FontBBox were extracted and reformatted, and nothing else of the AFM files is kept. The generated file states this at its top.
- Copyright notices: the Comment Copyright and Notice lines of each AFM file, as they stand in the files:

```text
Courier.afm: Comment Copyright (c) 1989, 1990, 1991, 1992, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Courier.afm: Notice Copyright (c) 1989, 1990, 1991, 1992, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Courier-Bold.afm: Comment Copyright (c) 1989, 1990, 1991, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Courier-Bold.afm: Notice Copyright (c) 1989, 1990, 1991, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Courier-BoldOblique.afm: Comment Copyright (c) 1989, 1990, 1991, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Courier-BoldOblique.afm: Notice Copyright (c) 1989, 1990, 1991, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Courier-Oblique.afm: Comment Copyright (c) 1989, 1990, 1991, 1992, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Courier-Oblique.afm: Notice Copyright (c) 1989, 1990, 1991, 1992, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Helvetica.afm: Comment Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Helvetica.afm: Notice Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated.  All Rights Reserved.Helvetica is a trademark of Linotype-Hell AG and/or its subsidiaries.
Helvetica-Bold.afm: Comment Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Helvetica-Bold.afm: Notice Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated.  All Rights Reserved.Helvetica is a trademark of Linotype-Hell AG and/or its subsidiaries.
Helvetica-BoldOblique.afm: Comment Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Helvetica-BoldOblique.afm: Notice Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated.  All Rights Reserved.Helvetica is a trademark of Linotype-Hell AG and/or its subsidiaries.
Helvetica-Oblique.afm: Comment Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Helvetica-Oblique.afm: Notice Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated.  All Rights Reserved.Helvetica is a trademark of Linotype-Hell AG and/or its subsidiaries.
Symbol.afm: Comment Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated. All rights reserved.
Symbol.afm: Notice Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated. All rights reserved.
Times-Bold.afm: Comment Copyright (c) 1985, 1987, 1989, 1990, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Times-Bold.afm: Notice Copyright (c) 1985, 1987, 1989, 1990, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.Times is a trademark of Linotype-Hell AG and/or its subsidiaries.
Times-BoldItalic.afm: Comment Copyright (c) 1985, 1987, 1989, 1990, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Times-BoldItalic.afm: Notice Copyright (c) 1985, 1987, 1989, 1990, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.Times is a trademark of Linotype-Hell AG and/or its subsidiaries.
Times-Italic.afm: Comment Copyright (c) 1985, 1987, 1989, 1990, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Times-Italic.afm: Notice Copyright (c) 1985, 1987, 1989, 1990, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.Times is a trademark of Linotype-Hell AG and/or its subsidiaries.
Times-Roman.afm: Comment Copyright (c) 1985, 1987, 1989, 1990, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
Times-Roman.afm: Notice Copyright (c) 1985, 1987, 1989, 1990, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.Times is a trademark of Linotype-Hell AG and/or its subsidiaries.
ZapfDingbats.afm: Comment Copyright (c) 1985, 1987, 1988, 1989, 1997 Adobe Systems Incorporated. All Rights Reserved.
ZapfDingbats.afm: Notice Copyright (c) 1985, 1987, 1988, 1989, 1997 Adobe Systems Incorporated. All Rights Reserved.ITC Zapf Dingbats is a registered trademark of International Typeface Corporation.
```

- Licence: the paragraph of `MustRead.html`, which accompanies the AFM files, unmodified:

```text
This file and the 14 PostScript(R) AFM files it accompanies may be used, copied, and distributed for any purpose and without charge, with or without modification, provided that all copyright notices are retained; that the AFM files are not distributed without this file; that all modifications to this file or any of the AFM files are prominently noted in the modified file(s); and that this paragraph is not modified. Adobe Systems has no responsibility or obligation to support the use of the AFM files.
```

## Unicode Equivalent_Unified_Ideograph and Vertical_Orientation data

- Source: <https://www.unicode.org/Public/18.0.0/ucd/EquivalentUnifiedIdeograph.txt>, Unicode 18.0.0 (sha256 `c86c80f6a0d1d47c9a5aadfbf1c26f1a732d662d9ccb0ed2d397919ecc47bf72`).
- Use: the CJK radicals and strokes that text comparison reads as their equivalent unified ideographs, generated into `src/inspect/text/equivalentIdeographs.ts` by `scripts/generateEquivalentIdeographs.ts`, which keeps every mapping and drops the comment lines.
- Source: <https://www.unicode.org/Public/18.0.0/ucd/VerticalOrientation.txt>, Unicode 18.0.0 (sha256 `0803e09669d7aa7137de678e55b848bd418c6632694fa1b05f0b40941103c748`).
- Use: the characters whose Vertical_Orientation is Tu or Tr, which text comparison expects to find drawn with vertical alternates, generated into `src/inspect/text/verticalOrientation.ts` by `scripts/generateVerticalOrientation.ts`, which keeps the Tu and Tr lines and drops their comments.
- Copyright: "© 2026 Unicode®, Inc.", as the header of each file states.
- Licence: Unicode License v3, which each file points to through <https://www.unicode.org/terms_of_use.html>, the text of <https://www.unicode.org/license.txt> (sha256 `e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96`):

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```
