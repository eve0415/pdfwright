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
