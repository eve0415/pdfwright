# pdfwright

pdfwright is a TypeScript PDF library for print production. This repository is the pnpm workspace that holds its packages, which use web-standard APIs only and are built as ESM with type declarations.

## Packages

| Package                                          | Role                                                         |
| ------------------------------------------------ | ------------------------------------------------------------ |
| [`@pdfwright/core`](packages/core)               | The core package                                             |
| [`@pdfwright/illustrator`](packages/illustrator) | Write Illustrator-layered PDFs from print-production artwork |

Adobe and Illustrator are either registered trademarks or trademarks of Adobe in the United States and/or other countries. pdfwright is not affiliated with, endorsed by or sponsored by Adobe.

In Illustrator 30.8.2, PDFs from `@pdfwright/illustrator` opened as editable layers with the artboard in view; Fit Artboard fitted the artboard, and soft raster alpha remained visible. When changes to a file with differing dates were accepted, page import kept spot plates drawn as Separation images with soft masks.

## Writing a print page

This example writes a 100 × 60 mm page with bleed and trim boxes, a White spot fill, and a hairline Cut path. `save()` returns ordered byte chunks; call `toBytes()` when one buffer is needed.

```ts
import type { SavedPdf } from '@pdfwright/core';

import { cmyk, createDocument, mm, pdfDate, rect } from '@pdfwright/core';

export const writePrintPage = (): SavedPdf => {
  const document = createDocument({
    info: { title: 'White ink proof', modificationDate: pdfDate({ year: 2024, month: 3, day: 1, hour: 12, minute: 0, second: 0, offset: 'Z' }) },
  });
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

## Colorant names and overprint

A colorant name can be supplied as raw PDF name bytes, so its original byte spelling survives the save. `/All` and `/None` require matching `allow` values. Painting zero DeviceCMYK under fill overprint mode 1 raises `ValidationError` with reason `invisible-overprint` unless the caller acknowledges it.

```ts
import type { PageColorants, SavedPdf } from '@pdfwright/core';

import { ValidationError, cmyk, createDocument, listColorants, loadDocument, pt, rect } from '@pdfwright/core';

export interface ColorantExample {
  readonly saved: SavedPdf;
  readonly colorants: PageColorants['colorants'];
  readonly whiteOverprintReason: string | undefined;
}

export const writeColorants = (): ColorantExample => {
  const document = createDocument();
  const rawName = Uint8Array.of(0x82, 0xa0);
  const spot = document.separation({ name: rawName, alternate: cmyk(0, 0, 0, 0.2) });
  const all = document.separation({ name: 'All', alternate: cmyk(0, 0, 0, 0.2), allow: 'All' });
  const none = document.separation({ name: 'None', alternate: cmyk(0, 0, 0, 0), allow: 'None' });
  const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
  page.draw(content => {
    for (const [plate, x] of [
      [spot, 10],
      [all, 40],
      [none, 70],
    ] as const) {
      content.fillColor(plate, 1);
      content.path(path => path.rect(x, 10, 20, 20));
      content.fill('nonzero');
    }
  });
  const probe = createDocument();
  const probePage = probe.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
  let whiteOverprintReason: string | undefined = undefined;
  try {
    probePage.draw(content => {
      content.fillColor(cmyk(0, 0, 0, 0));
      content.graphicsState({ overprintFill: true, overprintMode: 1 });
      content.path(path => path.rect(0, 0, 10, 10));
      content.fill('nonzero');
    });
  } catch (error: unknown) {
    if (!(error instanceof ValidationError)) throw error;
    whiteOverprintReason = error.reason;
  }
  const saved = document.save();
  const colorants = listColorants(loadDocument(saved.toBytes()))[0]?.colorants ?? [];
  return { saved, colorants, whiteOverprintReason };
};
```

## Page-piece data

A page-piece entry carries a caller-supplied LastModified date and opaque private data. Editing the page box leaves that application data intact.

```ts
import type { SavedPdf } from '@pdfwright/core';

import { createDocument, loadDocument, pdfDate, pdfString, pt, rect, serializeObject } from '@pdfwright/core';

export interface PieceInfoExample {
  readonly saved: SavedPdf;
  readonly retained: boolean;
}

export const preservePagePieceData = (): PieceInfoExample => {
  const date = pdfDate({ year: 2024, month: 3, day: 1, hour: 12, minute: 0, second: 0, offset: 'Z' });
  const document = createDocument();
  const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
  const applicationName = Uint8Array.of(0x82, 0xa0);
  const privateValue = pdfString(Uint8Array.of(1, 2, 3), 'hex');
  page.pieceInfo({
    lastModified: date,
    data: new Map([[applicationName, { private: privateValue }]]),
  });
  const loaded = loadDocument(document.save().toBytes());
  const original = loaded.page(0).pieceInfo();
  loaded.page(0).setBox('TrimBox', rect(pt(5), pt(5), pt(95), pt(95)));
  const saved = loaded.save();
  const preserved = loadDocument(saved.chunks).page(0).pieceInfo();
  if (original === undefined || preserved === undefined) throw new Error('page-piece data is missing');
  const before = serializeObject(original, { fractionDigits: 5 });
  const after = serializeObject(preserved, { fractionDigits: 5 });
  return { saved, retained: before.length === after.length && before.every((value, index) => value === after[index]) };
};
```

## Editing an existing file

`loadDocument` reads a file without copying it and parses objects when they are used; encrypted files throw `EncryptedDocumentError`.
Its `maxPageTreeDepth` load option limits page tree levels from the root through a page to 256 by default and throws `ResourceLimitError` when exceeded.
Edits change only the objects they touch: this example sets a trim box and adds a Varnish plate to the first page.
`save()` appends the changes to an intact file as an incremental update, and rewrites the whole file when its structure had to be repaired or an edit such as colour conversion requires it; its `mode` option (`'auto'`, `'incremental'` or `'full'`) chooses one, and `'incremental'` throws `InvalidArgumentError` for an edit that requires a rewrite. Either way it returns views of the input plus the new bytes, so the input is never copied.
A full rewrite gives every object number from 0 to the highest an entry. It writes a compressed cross-reference stream when the source is PDF 1.5 or later or used one, and a classic table otherwise. The save options `maxTableGapEntries` (default 100,000) and `maxGeneratedXrefEntries` (default 10,000,000) limit the entries a table or a stream may hold for unused object numbers, and `save()` throws `ResourceLimitError` past them.
A rewrite that writes a cross-reference stream raises a header below 1.5 to 1.5, and new content that uses transparency sets the catalog `Version` to 1.4 when the file declares less; `save()` reports either as a `version-raised` warning.
`compareDocuments` reports what differs between two documents by page count, page box, content, resources, fonts, page and document attributes and page-piece data, never by object number.
The input stays in memory for as long as the document and its saves are in use, so a runtime needs room for the input plus the working memory described below.
`scripts/printMemory.node.test.ts` builds a ten-page A4 file of 80–90 MB, each page holding a 5000 × 5000 CMYK image, two stroked rectangles and a Separation colour space, loads it, adds a plate and a TrimBox, saves it in full and reads the save through `toStream()`, and asserts that `process.memoryUsage().heapUsed + process.memoryUsage().external` stays at or below 120,000,000 bytes throughout; `external` is summed because Node counts `arrayBuffers` in it.
A generated 81.7 MB file with ten A4 300 dpi RGB pages (2480 × 3508 pixels), vector strokes and a Separation plate is converted with `convertToCmyk` and `pdfx`, then consumed through the saved PDF's `toStream()`. A fresh process samples `heapUsed + external` during conversion and streaming, with two forced collections at live-memory samples; the ten-page peak measured 110.3 MB against a 120 MB ceiling, and a smaller file runs the same conversion in workerd. The unconstrained allocation peak was 197.3 MB before collection, so the 120 MB check measures live memory rather than an enforced workerd isolate limit.

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

## Inspecting a file

`listFonts`, `listColorants`, `extractText` and `matchText` read a loaded document without changing it.
Damaged content never makes them throw: what cannot be read becomes a warning or a problem, and the page results of `listColorants` and `extractText` say `complete: false`.
They throw `InvalidArgumentError` for a page index that is not a page or a mode, limit or page list outside its type, as `orderGlyphs` does for a layout it does not know, and `ResourceLimitError` past their limits.
The inspection functions bound content interpretation as follows. A form, tiling pattern cell, Type 3 glyph procedure, soft-mask group or annotation appearance counts each time it is drawn.

| Limit                                               |      Value | Configurable by | Error                |
| --------------------------------------------------- | ---------: | --------------- | -------------------- |
| Content operations per page                         | 10,000,000 | Fixed           | `ResourceLimitError` |
| Decoded content lexed per page                      |    256 MiB | Fixed           | `ResourceLimitError` |
| Nested content streams                              |         64 | Fixed           | `ResourceLimitError` |
| Graphics-state saves (`q`) within one stream        |         64 | Fixed           | `ResourceLimitError` |
| Marked-content sequences across nested streams      |         64 | Fixed           | `ResourceLimitError` |
| Pending content operands                            |     16,384 | Fixed           | `ResourceLimitError` |
| Direct values in one operand, including the operand |     16,384 | Fixed           | `ResourceLimitError` |
| CMap definitions and array destinations             |     65,536 | Fixed           | `ResourceLimitError` |
| Definitions across a resolved `usecmap` chain       |     65,536 | Fixed           | `ResourceLimitError` |
| Codespace checks per resolved CMap                  |  1,000,000 | Fixed           | `ResourceLimitError` |
| Glyphs extracted per page                           |  1,000,000 | `maxGlyphs`     | `ResourceLimitError` |
| `matchText` comparisons and search steps            |  2,000,000 | Fixed           | `ResourceLimitError` |
| Opaque-rectangle comparisons per page               |  4,000,000 | Fixed           | `ResourceLimitError` |
| TrueType format 14 variation entries                |     16,384 | Fixed           | `ResourceLimitError` |

Identical codespace ranges and opaque fills under the same clip are indexed once. Inherited codespace ranges are shared between CMaps instead of copied into each child.

### Fonts

`listFonts(document)` returns one entry per font dictionary the pages reach through their resources, with its subtype, name, descendant CIDFont, embedding, subset tag, encoding, ToUnicode state and problems, the pages whose resources reach it (`pages`) and the pages whose content shows text with it (`shownOn`).
Filling `shownOn` interprets every page; `shownOn: false` gives an inventory of resources alone.
A Type 3 font's embedding is `not-applicable`, since its glyphs are content streams in the font dictionary, and its `type3.glyphs` says whether they paint `vector` shapes, `image`s, both (`mixed`), or cannot be read.
Entries that share a `descriptor` are parts of one font, such as Type 3 fonts that each hold up to 256 of its glyphs.

### Spot colorants

`listColorants(document)` lists each page's colorants by name bytes, for every page or those its `pages` option names.
A colorant is `painted` when a painting operator reaches it in content, forms, patterns, Type 3 glyphs, images, shadings or printable annotation appearances; `selected` when executed content sets its colour space without a visible mark; and `declared`, with each reason that applies, when it is named where its colour does not print: in resources, a soft mask's group, a `d1` glyph procedure or an uncoloured pattern cell, annotations that do not print, an extra NChannel colorant or `SeparationInfo`; a painted or selected colorant also lists every such reason except `resources`.
`painted` is what separations print.
Tints and geometry are not considered: a colorant painted at tint 0, outside the CropBox or wholly clipped away is painted.
`All` and `None` have the kinds `all` and `none`, Separations named `Cyan`, `Magenta`, `Yellow` or `Black` are `process`, and `alternates` lists each distinct alternate definition, so that one spot defined two ways shows.

### Text

`extractText(document, pageIndex)` returns the glyphs a page shows in content order, each with its code, font key, CID and GID where known, and three layers of text: `toUnicode`, `encodingText` (from the glyph name or CID collection) and the ActualText span it lies in.
`text` is the glyph's own text, its ToUnicode text else its encoding text, never ActualText; when it is null, `reason` says why.
Positions are in the page's default user space, before `/Rotate` and `UserUnit`, and boxes are advance boxes, not ink bounds; writing mode 1 follows `W2` and `DW2`.
Each glyph is flagged `notdef`, `empty` (a Type 3 glyph that paints nothing) and `visible`, which is false for render modes 3 and 7, alpha 0, a soft mask's group, a degenerate size or an empty glyph; `covered`, `coreHidden` and `clip` say what the clip and later opaque fills of axis-aligned rectangles hide, and fills of other shapes, images and shadings are not considered.
Its `annotations` option reads the normal appearances of `'printable'` annotations or `'all'` of them after the page content, and none by default.
Its `cmapProvider` option supplies predefined CMaps: Identity-H and Identity-V are built in, and without a provider a string in another CMap of ISO 32000-1 Table 118 has `reason: 'predefined-cmap-unavailable'`. A caller loads such files, for example from Adobe's `cmap-resources` and `mapping-resources-pdf` repositories, before extracting, since extraction is synchronous.

`orderGlyphs(glyphs, layout)` keeps the `content` order, the order the content stream draws them in, or orders glyphs in `rows` top to bottom and left to right, or in `columns-rtl` right to left and top to bottom.
It does not detect the layout: mixed layouts on one page, rotated pages and bidirectional text are not handled, and ruby set beside its base text becomes a row or column of its own, so a caller selects the glyphs to order (by region, font or size) first.

### Checking the text of a proof

`matchText(page, intended)` compares the text a page shows with an intended text, such as a printed name, code point for code point.
A caller checking a print proof extracts with `annotations: 'printable'` and treats any status but `match` as a rejection.
This example accepts the first page of a proof only when it matches the name and every font it shows is embedded or draws vector Type 3 glyphs.

```ts
import type { TextMatch } from '@pdfwright/core';

import { extractText, listFonts, loadDocument, matchText } from '@pdfwright/core';

export interface ProofCheck {
  readonly accepted: boolean;
  readonly match: TextMatch;
  readonly unembedded: readonly string[];
}

export const checkProof = (input: Uint8Array, name: string): ProofCheck => {
  const document = loadDocument(input);
  const match = matchText(extractText(document, 0, { annotations: 'printable' }), name);
  const unembedded = listFonts(document)
    .fonts.filter(font => font.shownOn.includes(0))
    .filter(font => font.embedding.state !== 'embedded' && font.type3?.glyphs !== 'vector')
    .map(font => font.key);
  return { accepted: match.status === 'match' && unembedded.length === 0, match, unembedded };
};
```

By default the glyphs compared are those that paint (or are empty Type 3 glyphs, which count as missing where they stand for text) and are not covered, not entirely hidden, not clipped out and not under a clip whose shape is unknown, and whose box's centre lies inside the CropBox clipped to the MediaBox (ISO 32000-1:2008, 14.11.2); `select` replaces that choice and `order` reads them in another layout.
Neither text is normalised: NFC rewrites compatibility ideographs such as 神 (U+FA19) to another registered form, and NFKC erases the difference between full-width and half-width forms that a print must keep.
Instead, a few folds read characters on the page's side as the characters they commonly stand in for: `radicals` reads CJK radicals as their Unicode Equivalent_Unified_Ideograph, except U+2F2A, U+2F2C and U+2F3E, `vertical-forms` reads vertical presentation forms as the characters they stand for, `ligatures` reads Latin ligatures as their letters, and `shared-glyphs` reads U+2027 as U+30FB.
The `folds` option chooses them and `equivalents` adds pairs a caller has verified; the result lists each fold used, and `embedded-cmap` among them when a glyph was accepted for an intended character because its font's embedded cmap maps that character to exactly the glyph drawn.
When the selected glyphs are two or more consecutive copies of one run, each shifted from the first by less than a quarter of the font size and half the run's advance, only the last copy drawn is compared unless `duplicates` is `'keep'`; white space and variation selectors follow the `whitespace` and `variationSelectors` options.

The status is `mismatch` when a glyph is `.notdef` or empty (`missing-glyph`), a glyph has no text (`unmapped`), or the texts differ (`substituted`, `missing`, `extra`).
It is `unverified`, which a person must check, when the texts agree only on weaker evidence:

- `actual-text-disagrees`: an ActualText span says something its glyphs' own text does not; the glyphs' own text is compared, since a span can name the source character of a glyph that an OpenType feature such as `jis78` replaced.
- `variant-unverified`: only an ActualText span carries an intended variation selector.
- `glyph-disagrees`: the font's embedded TrueType cmap maps the glyph's text to another glyph than the one drawn; or it does not list the glyph's folded text but maps the glyph's own text to the glyph drawn; or it does not list the character and the glyph is half an em wide where its ToUnicode character is full-width or wide, the width of a half-width form such as CSS `"hwid"` draws without a span, in a font that does not show such characters at proportional widths.
- `glyph-unchecked`: a Type 0 font with a `CIDFontType2` descendant embeds a TrueType program without a usable Unicode cmap, so nothing confirms which glyph a code shows.
- `no-glyph-evidence`: an ActualText span none of whose glyphs is compared lies between compared glyphs.
- `partly-hidden`: the clip or later opaque rectangles cut more than 0.1 em into compared glyphs.
- `page-incomplete`: some of the page's content could not be read, so what it would have drawn is unknown.

A character whose Unicode `Vertical_Orientation` is `Tu` or `Tr` is often drawn in vertical text with a vertical alternate that the cmap does not give.
Such a character set upright in a column does not disagree for being drawn with another glyph than the cmap's, and wherever the cmap does not list it, it is not checked by its width or its own text.
`evidence` is `glyph-checked` when the embedded cmap of every compared glyph's font maps the glyph's text to the glyph drawn, and `glyph-text-only` when some glyph was checked by its text alone, as a Type 3 glyph or a simple font's always is.

`match` means every compared glyph is a real, painting glyph of its font, and the glyphs' own text, and any ActualText, which must agree with it, equals the intended text in the chosen order after the listed folds.
It does not prove that the shapes are right where no embedded TrueType cmap confirms the glyph (Type 3 and simple fonts, `evidence: 'glyph-text-only'`) or where a substitution is invisible to the cmap, nor that no fallback font was used (`fonts` lists them so a caller can require one), and it does not check sizes, positions, colours or covering by anything but opaque rectangles.
`matchText`'s documentation lists what it cannot see, among them optional content, alpha near zero, and a glyph whose ToUnicode claims another character than the one it shows, without an ActualText span, when the font's embedded cmap does not list that character; of these, only half-width forms of full-width characters are caught, by their width.

### Chromium proofs

Chromium's print-to-PDF writes different font structures according to the font's outlines, which affects what `matchText` can check.

- Chromium's print-to-PDF writes a static TrueType-outline face such as IPAGothic as a `Type0` font with a `CIDFontType2` subset in `FontFile2`, an `Identity-H` CMap and a ToUnicode CMap; `matchText` checks each glyph against the subset's own cmap and reports `glyph-checked`.
- Chromium's print-to-PDF writes a CFF-outline face such as Noto Sans CJK JP as Type 3 fonts whose glyph procedures draw vector paths; `matchText` compares their ToUnicode text and reports `glyph-text-only`.
- Chromium's print-to-PDF writes a character missing from the chosen face in another installed font as a separate font resource, which `listFonts` lists independently and `matchText` includes in `fonts`.
- Chromium's print-to-PDF writes vertical text one glyph at a time with an `Identity-H` CMap, so `extractText` reports writing mode 0 for those glyphs (ISO 32000-1:2008, 9.7.5.2, Table 118).

A preflight that rejects Type 3 fonts outright rejects proofs using those fonts; one that accepts vector Type 3 glyphs tests `font.type3?.glyphs === 'vector'`.

### Bundled data

`@pdfwright/core` bundles the Adobe Glyph List, so that glyph names of simple fonts, Symbol and ZapfDingbats included, map to Unicode; the widths and FontBBox of Adobe's Core 14 font metrics, so that standard 14 fonts without a Widths array are positioned; Unicode 18.0.0's Equivalent_Unified_Ideograph, Vertical_Orientation and East_Asian_Width data, for the `radicals` fold and the cmap and width checks; and the International Color Consortium's `sRGB2014.icc`, for `srgbColorSource()` and `srgbProfileBytes()`.
Their sources and licence notices are in [`packages/core/THIRD-PARTY-NOTICES.md`](packages/core/THIRD-PARTY-NOTICES.md), which the package ships.
Adobe's predefined CJK CMaps are not bundled; a `CMapProvider` supplies them.

## Setting metadata

`readMetadata(document)` reports the document information dictionary, the catalog's XMP packet, one row per key mapped by XMP Specification Part 3, Table 20 (Title, Author, Subject, Keywords, Creator, Producer, CreationDate, ModDate, Trapped) with both values and their `agreement` (`agree`, `differ`, `indeterminate`, `info-only`, `xmp-only` or `absent`), the side ISO 32000-1:2008, 14.3.2 makes authoritative (`xmp`, `info` or `indeterminate`), the metadata streams other objects carry, the orphaned metadata streams nothing reachable references, and how many `<?xpacket begin=` headers a byte scan of the file finds in each place, including earlier revisions.
XMP reading accepts `readMetadata(document, { maxXmpTokens })`, and metadata edits accept the same option in `setMetadata(document, input, { maxXmpTokens })`. The default is 160,000 XML tokens per packet, in addition to fixed limits of 64 nested elements and 256 attributes per element. Packets past the cap are reported as unreadable with reason `too-many-tokens`; `setMetadata` refuses to discard one unless `unreadableXmp: 'replace'` is supplied.
`readMetadata` never throws for damaged metadata; what cannot be read is a finding.

`setMetadata(document, input)` writes Info and the document's XMP packet from one input, so that they agree.

- A key left out keeps the document's value, taken from the authoritative side where the two disagree and from Info where neither is; `null`, or an empty string for a text key, removes it. `modificationDate` is required and sets ModDate, `xmp:ModifyDate` and `xmp:MetadataDate`, which are never read from a clock. Trapped `Unknown` has no XMP form, since `pdf:Trapped` is Boolean.
- When the catalog's metadata stream can be read and no other object shares it, the packet replaces it in place: every managed and legacy property is removed wherever it occurs, one `rdf:Description` holding the managed values is inserted before the `rdf:RDF` end tag, and the rest of the packet is kept apart from the white space before each removed property. Dates are written to each side at its own precision. For a key the input leaves out, a property that occurs once and agrees with the resolved value is left as it is, and so are a property in a form the mapping does not read, such as a qualified value, and a date or Trapped value in the packet that cannot be parsed; an Info value of the wrong type or a date that does not parse is kept unless the packet or the input gives the key a value.
- Legacy duplicates such as `pdf:Author` are removed (`removedLegacy`), and orphaned metadata streams are deleted (`deletedOrphans`).
- `xmpMM:DocumentID` is kept, or derived from the first file identifier when the packet has none; `documentId: { value }` writes the given value in place of either, and a document with neither throws `ValidationError` `document-id-required`. Pass `instanceId` to set `xmpMM:InstanceID`; otherwise it is derived when the document is saved from the DocumentID, the metadata date, the previous InstanceID and the objects the save writes as changed, added or deleted.
- With the default `revisions: 'remove'`, the next save must rewrite the file, so that it holds exactly one document packet, and `save({ mode: 'incremental' })` throws `InvalidArgumentError` `metadata-history`. A rewrite moves the bytes signatures cover, so a document with a populated signature field, AcroForm `SigFlags` that sets SignaturesExist (bit 1) or AppendOnly (bit 2) or cannot be read, or a catalog `Perms` dictionary, is refused with `ValidationError` `signed-document`. `revisions: 'keep'` allows an incremental update and reports `saveMode: 'incremental-required'` for a signed document; a later full save throws `InvalidArgumentError` `signed-document` unless `save({ invalidateSignatures: true })` explicitly permits invalidation. With `revisions: 'keep'`, `supersededPackets` counts the packets an incremental update leaves in earlier revisions.
- A packet that cannot be read throws `ValidationError` `xmp-unreadable` unless `unreadableXmp: 'replace'`, and a value XML 1.0 cannot carry throws `ValidationError` `xmp-unrepresentable`. Everything is validated before anything changes.

The returned `MetadataChange` lists the values the edit discarded (`reconciled`), and its `findings` say what else a caller may need to know: a direct Info dictionary made indirect (`info-not-indirect`), a packet re-encoded as UTF-8 (`xmp-transcoded`), and values left as they were stored (`info-value-kept`, `xmp-value-kept`, `opaque-property-kept`).
The edit walks every object reachable from the trailer and reads every other object in use to find orphaned metadata; parsed objects are cached up to `parsedObjectCacheBytes`, so objects that do not fit are parsed again on each pass. A rewrite unpacks any object stream that holds a changed object.
`createDocument({ info })` writes an agreeing XMP packet by default; it requires `info.modificationDate` (`ValidationError` `metadata-date-required`) and derives the DocumentID from the first file identifier unless `metadata.documentId` gives one. Pass `metadata.instanceId` to set the InstanceID, or `metadata: { xmp: false }` to write Info without XMP.

The next example reads Info and XMP, updates both from one input, and checks that two saves of the same edited document produce identical bytes.

```ts
import type { DocumentMetadata, MetadataChange } from '@pdfwright/core';

import { createDocument, loadDocument, pdfDate, pt, readMetadata, rect, setMetadata } from '@pdfwright/core';

export interface MetadataExample {
  readonly before: DocumentMetadata;
  readonly after: DocumentMetadata;
  readonly change: MetadataChange;
  readonly identicalBytes: boolean;
}

export const updateMetadata = (): MetadataExample => {
  const date = pdfDate({ year: 2024, month: 3, day: 1, hour: 12, minute: 0, second: 0, offset: 'Z' });
  const created = createDocument({ info: { title: 'Original title', modificationDate: date } });
  created.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
  const document = loadDocument(created.save().toBytes());
  const before = readMetadata(document);
  const change = setMetadata(document, { title: 'Revised title', modificationDate: date });
  const first = document.save().toBytes();
  const second = document.save().toBytes();
  const after = readMetadata(loadDocument(first));
  const identicalBytes = first.length === second.length && first.every((value, index) => value === second[index]);
  return { before, after, change, identicalBytes };
};
```

## Colour conversion and PDF/X-4 checks

`convertToCmyk` takes a caller-supplied RGB source ICC profile and a caller-supplied output-class CMYK ICC profile; no profile is assumed for DeviceRGB, and `srgbProfileBytes()` supplies the bundled sRGB profile when DeviceRGB colours are sRGB. It converts reachable RGB and calibrated paints in page content, forms, images, patterns, shadings, transparency groups and annotation appearances, and its report separates those changes. Exact black (every component 0) in RGB and calibrated-gray fill, stroke and annotation colours becomes K-only by default, and `pureBlack: 'convert'` converts it instead. RGB `DCTDecode` and `JPXDecode` image XObjects are kept encoded by default and listed in `images.keptRgbImages`, tagged with the source profile unless they already carry a colour space or, for JPX, name RGB in their `colr` box; compressed RGB inline images move to ICC-tagged image XObjects. Their final conversion depends on the receiving renderer. Converted Flate images are generated as the save stream is read, so `toBytes()` materializes output that `toStream()` can deliver in bounded memory.
`compressedRgbImages` accepts `'keep-icc-tagged'` by default, `'refuse'`, or `'transcode'`. The transcode setting decodes single-scan 8-bit SOF0 and SOF1 Huffman RGB JPEGs by MCU row and writes Flate CMYK image data as the saved stream is read, including JPEGs moved from inline images to image XObjects. It honours Adobe APP14 and PDF `DCTDecode` `ColorTransform` values, limits an MCU row to 4 MiB and limits total decoded JPEG samples to `loadDocument`'s `maxDecodedBytes` (16 MiB by default), and refuses multi-scan JPEGs and JPEG 2000 under this setting. Unsupported JPEG processes throw `UnsupportedFeatureError` with a `jpeg-*` reason. A transcoded file can be larger because Flate preserves decoded samples rather than JPEG's compressed representation; the JPEG syntax follows [ITU-T T.81:1992, Annex B and F](https://www.w3.org/Graphics/JPEG/itu-t81.pdf), and the PDF colour-transform precedence follows [ISO 32000-1:2008, 7.4.8, Table 13](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf).
RGB transparency groups are blended in CMYK after conversion, so transparent and blended regions can differ from the RGB rendering.
`convertToCmyk` refuses a document with reachable `/PieceInfo` because conversion would invalidate its application data; it throws `ValidationError` with reason `application-data`.

`srgbColorSource()` returns a built-in sRGB source for `createColorTransform`, so converting sRGB artwork to CMYK needs no caller-supplied profile, and `srgbProfileBytes()` returns a new copy of the same profile's bytes for `convertToCmyk`'s `sourceRgbProfile` or anything else that takes profile bytes. The profile is the International Color Consortium's `sRGB2014.icc`, an ICC version 2 matrix/TRC display profile of 3,024 bytes, embedded unmodified. It is a real profile rather than an analytic definition because `convertToCmyk` tags kept DCT and JPX images with the bytes of `sourceRgbProfile`, so one profile serves both functions. All four rendering intents share its device-to-PCS transform and differ only in the destination profile's tables, black-point compensation and, for absolute colorimetric, the D50 media white of an ICC version 2 display profile. Over the 6,189-colour sample set of the repository's oracle tests, conversions to three CMYK profiles agree with LittleCMS 2.16 through the same profile within 0.019 ΔE2000 for every intent with and without black-point compensation, and with LittleCMS through two other sRGB profiles within 0.035 ΔE2000; the profile's tone curves stay within 1/65535 of the IEC 61966-2-1 decoding function.

`parseIccProfile` limits input to 24 MiB by default before making its own copy and throws `ResourceLimitError` past it; its `maxIccProfileBytes` option sets another limit of at least 132 bytes. `convertToCmyk`, `writeGtsPdfxOutputIntent` and `checkPdfX4` apply the 24 MiB default to every profile they parse.
Images that `convertToCmyk` converts from FlateDecode or unfiltered data are decoded one row at a time and written as the saved stream is read; `save()` then returns `kind: 'streamed'` with `toStream()` and `measureByteLength()`, while `toBytes()`, `chunks` and each read of `byteLength` generate the output again.
Image conversion holds bounded input rows, one CMYK output row and, for a colour-key mask, one mask row, and throws `ResourceLimitError` when those rows exceed `loadDocument`'s `maxDecodedBytes` option (16 MiB by default); a lone `FlateDecode` is decoded by image row, and a JPEG selected for transcoding is decoded by MCU row. Images under other filter chains are decoded whole within that limit. The deflater holds a 1 MiB input block, up to 4 MiB of LZ77 tokens and the encoded bytes of one block; a shared RGB-to-CMYK row cache holds 512 KiB per distinct transform.
A converted JPEG image XObject or inline JPEG selected for transcoding must fit its decoded samples within `maxDecodedBytes`; `measureByteLength()` regenerates the encoded stream to count it without retaining it. Other inline RGB images are decoded whole and limited to `maxDecodedBytes` or 4 MiB, whichever is smaller. An image's embedded ICC profile is limited to 4 MiB.
Colour conversion refuses RGB DCTDecode or JPXDecode images inside luminosity masks with reason `luminosity-compressed-rgb-image`.
`convertToCmyk` turns RGB shading meshes of Types 4–7 into DeviceCMYK Type 4 triangles, splitting a triangle into four while its colour error exceeds 0.5 ΔE2000, at most six levels deep; shadings with triangles still above that error are listed in `meshes.approximations`, and the converted stream is limited to `maxDecodedBytes` or 4 MiB, whichever is smaller.
Axial and radial RGB shadings use sampled CMYK functions with 2–4096 samples per segment; Type 3 stitching functions retain their boundaries, and each segment is sampled until its midpoint error is at most 0.5 ΔE2000 or the sample cap is reached.

The `outputIntent` identifier names the intended printing condition, independently of the profile bytes. For an identifier in the [ICC CMYK Characterization Data registry](https://registry.color.org/cmyk-registry/), `Info` defaults to the identifier, `OutputCondition` to the registry's designation and medium, and `RegistryName` to `http://www.color.org`; any other identifier needs `info`, or the pass throws `ValidationError` `output-intent-conflict`. An existing output intent whose embedded profile differs or is absent is refused with the same reason unless `existing: 'replace'` is selected, an identical indirect profile object is reused, and a catalog with `Extensions` is refused with `pdf-extensions`. This follows the output-intent entry types in [ISO 32000-1:2008, 14.11.5, Table 365](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf).

With `pdfx`, the pass writes Info `/GTS_PDFXVersion` and XMP `pdfxid:GTS_PDFXVersion`, preserves an existing XMP `DocumentID`, `VersionID` and `RenditionClass`, writes `VersionID` `1` and `RenditionClass` `default` when the packet has none, and derives `InstanceID` deterministically from the edit. `metadataDate` and `trapped` are required because neither can be inferred from page colours. It lowers a header or catalog version above 1.6 to 1.6, the version ISO 15930-7:2010, Table 1 gives for PDF/X-4, and the next `save()` reports `version-lowered` in its warnings. On a page with neither TrimBox nor ArtBox, the default adds TrimBox equal to MediaBox and reports its page index; an existing ArtBox is kept. Pages whose content invokes transparency gain an isolated DeviceCMYK page group when they have no group already. Page boxes and transparency group entries follow [ISO 32000-1:2008, Table 30 and 14.11.2 for page boxes, and 11.4.7 and 11.6.6, Table 147, for the page group](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf). These entries declare PDF/X-4 in the file; the pass does not verify the rules `checkPdfX4` reports as `not-checked`.

```ts
import type { PdfDate } from '@pdfwright/core';

import { checkPdfX4, convertToCmyk, loadDocument } from '@pdfwright/core';

export interface PrintConversionInput {
  readonly input: Uint8Array;
  readonly sourceRgbProfile: Uint8Array;
  readonly outputProfile: Uint8Array;
  readonly outputConditionIdentifier: string;
  readonly metadataDate: PdfDate;
  readonly documentId: string;
}

export const preparePrintPdf = ({ input, sourceRgbProfile, outputProfile, outputConditionIdentifier, metadataDate, documentId }: PrintConversionInput) => {
  const document = loadDocument(input);
  const conversion = convertToCmyk(document, {
    sourceRgbProfile,
    outputProfile,
    outputIntent: { outputConditionIdentifier },
    compressedRgbImages: 'transcode',
    pdfx: { trapped: 'False', metadataDate, documentId },
  });
  const structure = checkPdfX4(document);
  return { conversion, structure, saved: document.save() };
};
```

Nothing checks that `outputProfile` characterizes the condition `outputConditionIdentifier` names, so pass that condition's ICC profile.

`checkPdfX4` takes a document from `loadDocument` and reports `passed`, `violation` or `not-checked` for each rule, with its source and authority. On readable objects it checks for a GTS_PDFX output intent and its required entries, an embedded parsable Gray, RGB or CMYK output profile with a BToA transform, `pdfxid:GTS_PDFXVersion` `PDF/X-4`, Info Trapped `True` or `False`, matching XMP `pdf:Trapped` as a separate house-policy rule, one print-area box per page within its MediaBox, BleedBox and CropBox, and the absence of JavaScript actions, XFA and form fields, LZW filters in reachable streams and inline images, embedded files and file attachments, reference XObjects, alternate images and OPI entries. It reports the presence of `xmpMM:DocumentID`, `VersionID` and `RenditionClass` but does not check their PDF/X-4 requirement. `loadDocument` refuses encrypted input before the checker runs. Each rule reports the sources it follows; for PDF structure they are [ISO 32000-1:2008, 14.11.5, Table 365 (output intents), 14.11.2 (page boundaries) and Table 317 (Trapped)](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf).

The checker reports `not-checked` for the PDF/X-4 version limit, PDF 1.7-only keys, ICC version limit, XMP media-management identification, annotation placement, transfer functions, font embedding, spot alternates, PostScript XObjects, `BX`/`EX`, rendering intents, architectural limits, transparency details and optional-content configurations. ISO 15930-7:2010, clause 6 sets these requirements, and the checker does not implement them. `X4-OI-ENTRIES` and `X4-OI-PROFILE` also report `not-checked` when no GTS_PDFX output intent is present, `X4-OI-PROFILE` when the profile exceeds the 24 MiB parsing limit, is not output class, or lacks AToB1 for an unregistered condition, `X4-FORMS` when `Fields` is not a readable array, `X4-JS` when non-JavaScript additional actions are present, and `X4-JS`, `X4-LZW`, `X4-EMBEDDED` and `X4-EXTERNAL` when any reachable object cannot be read. A `no-violation-found-by-these-rules` summary means only that the implemented checks found no violation. Nothing here certifies PDF/X-4.

The checker labels [“PDF/X in a Nutshell” (PDF Association, 2017)](https://pdfa.org/wp-content/uploads/2017/05/PDFX-in-a-Nutshell.pdf) as an industry explainer and [CGATS, “Application Notes for PDF/X Standards,” Version 4 (2006)](https://printtechnologies.org/standards/files/pdf-x-application-notes_v4-sep06.pdf) as predecessor guidance for PDF/X-1a, PDF/X-2 and PDF/X-3. Those sources are the basis of the checks that do not cite ISO 15930-7; they do not replace it.

## Other exports

- `createColorTransform` and `parseIccProfile` evaluate and inspect ICC colour profiles, and `srgbColorSource` and `srgbProfileBytes` supply the bundled sRGB profile.
- `writeGtsPdfxOutputIntent`, `writePdfX4Metadata`, `preparePdfX4Pages`, `registeredPrintingConditions` and `pdfX4Rules` expose the individual PDF/X-4 preparation and checking steps.
- `PdfDocument` also exposes image placement, transparency groups and page-piece data for new documents.
- `createPdfFunction` evaluates supported PDF function objects.
- `createDeflateStream`, `deflateRaw`, `deflateZlib`, `inflateChunks`, `inflateRaw`, `inflateZlib`, `md5` and `adler32` expose compression and digest helpers.
- `decodeJpeg`, `decodePng` and `pngToRgba8` decode JPEG and PNG files with their ICC profiles, Exif orientation and PNG colour chunks; the [`@pdfwright/core` README](packages/core/README.md#decoding-images) documents their output, errors and limits.
- The `pdfArray`, `pdfDictionary`, `pdfInteger`, `pdfLiteralString`, `pdfName`, `pdfNameFromBytes`, `pdfReal`, `pdfReference` and `pdfString` constructors work with `PdfDictionaryEntries` and `serializeObject`.
- The length helpers `add`, `compare`, `equals`, `formatLength`, `inch`, `mm`, `multiply`, `negate`, `pt` and `subtract` use the `Length` type.
- `parsePdfDate`, `pdfDate`, `pdfDateFromDate` and `pdfDateString` handle PDF date values; `CORE_BOX_TOLERANCE` is the glyph-cover tolerance in ems.

## Development

See the contributor guide's [Setup](AGENTS.md#setup) and [The gate](AGENTS.md#the-gate) sections for development instructions.

## License

Licensed under either of the [Apache License, Version 2.0](LICENSE-APACHE) or the [MIT license](LICENSE-MIT), at your option.
