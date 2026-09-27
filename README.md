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
A full rewrite gives every object number from 0 to the highest an entry, in a compressed cross-reference stream when the source is PDF 1.5 or later or used one, and otherwise in a classic table, where its `maxTableGapEntries` save option limits the entries for unused numbers to 100,000 by default and throws `ResourceLimitError` when exceeded; its `maxGeneratedXrefEntries` save option does the same for a cross-reference stream, 10,000,000 by default, so that a small file claiming a huge object number cannot make a save generate billions of entries.
A rewrite that writes a cross-reference stream raises a header below 1.5 to 1.5, the version that introduced them, and reports it as a `version-raised` save warning.
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

## Inspecting a file

`listFonts`, `listColorants`, `extractText` and `matchText` read a loaded document without changing it.
Damaged content never makes them throw: what cannot be read becomes a warning or a problem, and the page results of `listColorants` and `extractText` say `complete: false`.
They throw `InvalidArgumentError` for a page index that is not a page, and `ResourceLimitError` past their limits; `matchText` and `orderGlyphs` also throw `InvalidArgumentError` for an option value outside its type.
Interpreting one page may execute at most 10,000,000 content operations and lex at most 256 MiB of decoded content, counting a form, tiling pattern cell, Type 3 glyph procedure, soft-mask group or annotation appearance each time it is drawn, because a form drawn a thousand times inside a form drawn a thousand times is a million form executions from a few hundred bytes; these two limits are fixed.
`extractText` also throws `ResourceLimitError` past 1,000,000 glyphs a page, which its `maxGlyphs` option changes.

### Fonts

`listFonts(document)` returns one entry per font dictionary the pages reach through their resources, with its subtype, name, descendant CIDFont, embedding, subset tag, encoding, ToUnicode state and problems, the pages whose resources reach it (`pages`, what `pdffonts` lists) and the pages whose content shows text with it (`shownOn`).
Filling `shownOn` interprets every page; `shownOn: false` gives an inventory of resources alone.
A Type 3 font's embedding is `not-applicable`, since its glyphs are content streams in the font dictionary, and its `type3.glyphs` says whether they paint `vector` shapes, `image`s, both (`mixed`), or cannot be read.
Entries that share a `descriptor` are parts of one font, as with the Type 3 fonts Chromium writes for each 256 glyphs of a font.

### Spot colorants

`listColorants(document)` lists each page's colorants by name bytes, for every page or those its `pages` option names.
A colorant is `painted` when a painting operator reaches it in content, forms, patterns, Type 3 glyphs, images, shadings or printable annotation appearances; `selected` when executed content sets its colour space without a visible mark (a bare `cs`, invisible text, a path that only clips); and `declared`, with each reason that applies, when it is named without being executed (resources, soft masks, `d1` glyphs, uncoloured patterns, annotations that do not print, extra NChannel colorants, `SeparationInfo`).
`painted` is what separations print; Ghostscript's `tiffsep` also makes a plate for a `selected` colorant, and the oracle test checks that its plates of spot colorants lie between the painted and the painted-or-selected ones, apart from recorded differences.
Tints and geometry are not considered: a colorant painted at tint 0, outside the CropBox or wholly clipped away is painted.
`All` and `None` have the kinds `all` and `none`, Separations named `Cyan`, `Magenta`, `Yellow` or `Black` are `process`, and `alternates` lists each distinct alternate definition, so that one spot defined two ways shows.

### Text

`extractText(document, pageIndex)` returns the glyphs a page shows in content order, each with its code, font key, CID and GID where known, and three layers of text: `toUnicode`, `encodingText` (from the glyph name or CID collection) and the ActualText span it lies in.
`text` is the glyph's own text, its ToUnicode text else its encoding text, never ActualText; when it is null, `reason` says why.
Positions are in the page's default user space, before `/Rotate` and `UserUnit`, and boxes are advance boxes, not ink bounds; writing mode 1 follows `W2` and `DW2`.
Each glyph is flagged `notdef`, `empty` (a Type 3 glyph that paints nothing) and `visible`, which is false for render modes 3 and 7, alpha 0, a soft mask's group, a degenerate size or an empty glyph; `covered`, `coreHidden` and `clip` say what the clip and later opaque fills of axis-aligned rectangles hide, and fills of other shapes, images and shadings are not considered.
Its `annotations` option reads the normal appearances of `'printable'` annotations or `'all'` of them after the page content, and none by default, as `pdftotext` and `mutool` do.
Its `cmapProvider` option supplies predefined CMaps: Identity-H and Identity-V are built in, and without a provider a string in another CMap of ISO 32000-1 Table 118 has `reason: 'predefined-cmap-unavailable'`. A caller loads such files, for example from Adobe's `cmap-resources` and `mapping-resources-pdf` repositories, before extracting, since extraction is synchronous.

`orderGlyphs(glyphs, layout)` keeps the `content` order, which is the logical order of Chromium's print output, or orders glyphs in `rows` top to bottom and left to right, or in `columns-rtl` right to left and top to bottom.
It does not detect the layout: mixed layouts on one page, rotated pages and bidirectional text are not handled, and ruby set beside its base text becomes a row or column of its own, so a caller selects the glyphs to order (by region, font or size) first.

### Checking the text of a proof

`matchText(page, intended)` compares the glyphs a page shows with the text it is meant to show, such as a customer's name on a keyring proof, code point for code point.
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

By default the glyphs compared are those that paint (or are empty Type 3 glyphs, which count as missing where they stand for text) and are not covered, not entirely hidden, not clipped out and not under a clip whose shape is unknown, and whose box is centred inside the CropBox; `select` replaces that choice and `order` reads them in another layout.
Neither text is normalised: NFC rewrites compatibility ideographs such as 神 (U+FA19) to another registered form, and NFKC erases the difference between full-width and half-width forms that a print must keep.
Instead, a few folds read the page's side as the characters fonts and Chromium put in place of the intended ones: `radicals` reads CJK radicals as their equivalent unified ideographs (except U+2F2A, U+2F2C and U+2F3E, which Noto draws with a different ideograph's glyph), `vertical-forms` reads vertical presentation forms as the characters they stand for, `ligatures` reads Latin ligatures as their letters, and `shared-glyphs` reads U+2027 as U+30FB.
The `folds` option chooses them and `equivalents` adds pairs a caller has verified; the result lists each fold used, and `embedded-cmap` among them when a glyph was accepted for an intended character because its font's embedded cmap maps that character to exactly the glyph drawn, as Noto Sans JP draws 戸 with the glyph Chromium's ToUnicode calls U+2F3E.
When the selected glyphs are two or more consecutive copies of one run, as Chromium draws text with `text-shadow`, `-webkit-text-stroke` or `mask-image`, only the last copy drawn is compared; white space and variation selectors follow the `whitespace` and `variationSelectors` options.

The status is `mismatch` when a glyph is `.notdef` or empty (`missing-glyph`), a glyph has no text (`unmapped`), or the texts differ (`substituted`, `missing`, `extra`).
It is `unverified`, which a person must check, when the texts agree only on weaker evidence:

- `actual-text-disagrees`: an ActualText span says something its glyphs' own text does not; the glyphs' text was compared, since Chromium writes the source character over a glyph that an OpenType feature such as `jis78` changed.
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
It does not prove that the shapes are right where the file has no font program (Type 3) or where a substitution is invisible to the cmap, nor that no fallback font was used (`fonts` lists them so a caller can require one), and it does not check sizes, positions, colours or covering by anything but opaque rectangles.
`matchText`'s documentation lists what it cannot see, among them optional content, alpha near zero, and a glyph whose ToUnicode claims another character than the one it shows, as CSS `font-feature-settings` values can make Chromium draw, when the font's embedded cmap does not list that character; of these, only half-width forms of full-width characters are caught, by their width. A proof's own CSS decides whether such features apply.

### Chromium proofs

Chromium's `page.pdf()` embeds a font according to its outline technology, which decides what a check of its proofs can require.

- A static font with TrueType outlines, such as IPAGothic, becomes a `Type0` font with a `CIDFontType2` subset in `FontFile2` (tag `AAAAAA+`), the `Identity-H` CMap and a ToUnicode CMap, so `matchText` checks each glyph against the subset's own cmap and reports `glyph-checked`.
- A font with CFF outlines, such as Noto Sans CJK JP, becomes several Type 3 fonts, one for each 256 glyphs, sharing one descriptor and subset tag, whose glyph procedures draw `vector` paths and whose ToUnicode gives the text; nothing in the file confirms those glyphs, so `matchText` reports `glyph-text-only`. Chromium 153 prints variable fonts as Type 3 fonts too.
- A character the face lacks is set in another installed font that has it, as a font resource of its own: in an IPAGothic proof, 𠮷 (U+20BB7) comes out in a `BAAAAA+` Type 3 font of Noto Sans CJK JP.
- `writing-mode: vertical-rl` does not use writing mode 1: glyphs are stacked down the column one by one in horizontal-writing fonts, so `extractText` reports writing mode 0 for every glyph.

So proof HTML set in static TrueType-outline fonts prints as embedded subset fonts whose glyphs `matchText` can check, and any other font technology yields Type 3 fonts: a preflight that rejects Type 3 fonts outright rejects every proof set in a CFF or variable font, and one that accepts vector Type 3 glyphs tests `font.type3?.glyphs === 'vector'`.
`packages/core/src/inspect/chromiumProof.oracle.test.ts` is the evidence: it prints fixed HTML with the Chromium that Playwright 1.63.0 pins (headless shell 153.0.8010.12) in IPAGothic, which `playwright install --with-deps` installs, and in Noto Sans CJK JP from the `fonts-noto-cjk` package, and asserts the font type, embedding, subset tag, encoding, ToUnicode and Type 3 glyph kind of each face, the fallback font and writing mode 0, with `match` for the name 山田 太郎 in both faces and `missing-glyph` for a character no installed font draws; the shared descriptor, the split into 256 glyphs and the variable-font case are not asserted.
When a Playwright update changes how Chromium embeds fonts, that test fails.

### Bundled data

`@pdfwright/core` bundles the Adobe Glyph List, so that glyph names of simple fonts, Symbol and ZapfDingbats included, map to Unicode; the widths and FontBBox of Adobe's Core 14 font metrics, so that standard 14 fonts without a Widths array are positioned; and Unicode 18.0.0's Equivalent_Unified_Ideograph, Vertical_Orientation and East_Asian_Width data, for the `radicals` fold and the cmap and width checks.
Their sources and licence notices are in [`packages/core/THIRD-PARTY-NOTICES.md`](packages/core/THIRD-PARTY-NOTICES.md), which the package ships.
Adobe's predefined CJK CMaps are not bundled; a `CMapProvider` supplies them.

## Setting metadata

`readMetadata(document)` reports the document information dictionary, the catalog's XMP packet, one row per key XMP Part 3 Table 20 maps (Title, Author, Subject, Keywords, Creator, Producer, CreationDate, ModDate, Trapped) with both values and whether they agree, the side ISO 32000-1 14.3.2 makes authoritative (`xmp`, `info` or `indeterminate`), the metadata streams other objects carry, the orphaned metadata streams nothing reachable references, and the `<?xpacket begin=` headers a byte scan of the file finds, including those left in earlier revisions.
It never throws for damaged metadata; what cannot be read is a finding.

`setMetadata(document, input)` writes Info and the document's XMP packet from one input, so that they agree.

- A key left out keeps the document's value, taken from the authoritative side where the two disagree and from Info where neither is; `null` or an empty string removes it. `modificationDate` is required and sets ModDate, `xmp:ModifyDate` and `xmp:MetadataDate`, which are never read from a clock. Trapped `Unknown` has no XMP form, since `pdf:Trapped` is Boolean.
- The packet replaces the catalog's metadata stream in place: the managed properties are spliced in and every other byte of the packet is kept. Dates are written to each side at its own precision. For a key the input leaves out, a property that occurs once and agrees with the resolved value is left as it is, and so are a property in a form the mapping does not read, such as a qualified value, and a date or Trapped value in the packet that cannot be parsed; an Info value of the wrong type or a date that does not parse is kept unless the packet or the input gives the key a value.
- Legacy duplicates such as `pdf:Author` are removed (`removedLegacy`), and orphaned metadata streams are deleted (`deletedOrphans`).
- `xmpMM:DocumentID` is kept, or derived from the first file identifier when the packet has none; the `documentId` option can give one, and a document with neither throws `ValidationError` `document-id-required`. `xmpMM:InstanceID` is derived when the document is saved, from the DocumentID, the metadata date, the previous InstanceID and everything else the save writes.
- With the default `revisions: 'remove'`, the next save must rewrite the file, so that it holds exactly one document packet, and `save({ mode: 'incremental' })` throws `InvalidArgumentError` `metadata-history`. A rewrite moves the bytes signatures cover, so a document whose AcroForm `SigFlags` sets SignaturesExist (bit 1) or AppendOnly (bit 2) or cannot be read, or whose catalog has a `Perms` dictionary, is then refused with `ValidationError` `signed-document`. `revisions: 'keep'` allows an incremental update instead, and `supersededPackets` counts the packets it leaves in earlier revisions.
- A packet that cannot be read throws `ValidationError` `xmp-unreadable` unless `unreadableXmp: 'replace'`, and a value XML cannot carry throws `xmp-unrepresentable`. Everything is validated before anything changes.

The returned `MetadataChange` lists the values the edit discarded (`reconciled`), and its `findings` say what else a caller may need to know: a direct Info dictionary made indirect (`info-not-indirect`), a packet re-encoded as UTF-8 (`xmp-transcoded`), and values left as they were stored (`info-value-kept`, `xmp-value-kept`, `opaque-property-kept`).
The edit parses every object reachable from the trailer once, and a rewrite unpacks any object stream that holds a changed object.
`createDocument({ info, metadata: { xmp: true } })` writes a packet that agrees with Info in a new file; it requires `info.modificationDate` (`ValidationError` `metadata-date-required`) and derives the DocumentID from the first file identifier unless `metadata.documentId` gives one.

## Development

See the contributor guide's [Setup](AGENTS.md#setup) and [The gate](AGENTS.md#the-gate) sections for development instructions.

## License

Licensed under either of the [Apache License, Version 2.0](LICENSE-APACHE) or the [MIT license](LICENSE-MIT), at your option.
