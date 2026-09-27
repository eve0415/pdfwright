export { EncryptedDocumentError } from './error/encryptedDocumentError.ts';
export { InvalidArgumentError } from './error/invalidArgumentError.ts';
export { ParseError } from './error/parseError.ts';
export { ResourceLimitError } from './error/resourceLimitError.ts';
export { PdfwrightError } from './error/pdfwrightError.ts';
export { UnsupportedFeatureError } from './error/unsupportedFeatureError.ts';
export { ValidationError } from './error/validationError.ts';
export type { PdfwrightErrorCode } from './error/pdfwrightError.ts';
export type { InvalidArgumentReason } from './error/invalidArgumentError.ts';
export type { ValidationReason } from './error/validationError.ts';
export { add, compare, equals, formatLength, inch, mm, multiply, negate, pt, subtract } from './length/length.ts';
export type { Length } from './length/length.ts';
export { DEFAULT_FRACTION_DIGITS, formatInteger, formatNumber } from './number/formatNumber.ts';
export { md5 } from './hash/md5.ts';
export { adler32 } from './flate/adler32.ts';
export { deflateRaw, deflateZlib } from './flate/deflate.ts';
export type { DeflateOptions } from './flate/deflate.ts';
export { inflateRaw, inflateZlib } from './flate/inflate.ts';
export type { FlateWarning, InflateOptions } from './flate/inflate.ts';
export {
  PdfDictionaryEntries,
  pdfArray,
  pdfDictionary,
  pdfInteger,
  pdfLiteralString,
  pdfName,
  pdfNameFromBytes,
  pdfReal,
  pdfReference,
  pdfString,
} from './object/pdfObject.ts';
export type { InvalidObjectReason, PdfDirectObject, PdfObject, PdfReference } from './object/pdfObject.ts';
export { serializeObject } from './serialize/serializeObject.ts';
export { createDocument } from './document/pdfDocument.ts';
export { loadDocument } from './document/loadDocument.ts';
export type { LoadOptions, LoadedDocument, SaveOptions } from './document/loadDocument.ts';
export type { DocumentStructure, StructureStatus } from './document/readStructure.ts';
export type { BoxName, EffectiveBox, EffectiveBoxes, LoadedPage } from './document/loadedPage.ts';
export type { ResourceCategory } from './document/pageResources.ts';
export type { SaveWarning, SaveWarningCode } from './save/saveWarning.ts';
export { compareDocuments } from './compare/compareDocuments.ts';
export type {
  BoxValue,
  CompareOptions,
  DifferenceArea,
  DocumentComparison,
  FontIdentity,
  PdfDifference,
  PieceOwner,
  ValuePath,
  ValueSummary,
} from './compare/pdfDifference.ts';
export type { LoadWarning, LoadWarningCode } from './parse/loadWarning.ts';
export type { CMapProvider } from './font/cmap/cmapProvider.ts';
export type { CidFontSubtype, FontEncodingSummary, FontSubtype } from './font/fontModel.ts';
export { listFonts } from './inspect/fonts/listFonts.ts';
export type {
  FontDescendant,
  FontEmbedding,
  FontEntry,
  FontInventory,
  FontProblem,
  FontProblemCode,
  FontSubset,
  ListFontsOptions,
} from './inspect/fonts/listFonts.ts';
export type { Type3Glyphs, Type3Summary } from './inspect/fonts/type3Glyphs.ts';
export { listColorants } from './inspect/colorants/listColorants.ts';
export type { ColorantUse, DeclaredOnlyReason, ListColorantsOptions, PageColorants, PaintedBy, SelectedBy } from './inspect/colorants/listColorants.ts';
export type { AlternateSummary, ColorantKind } from './inspect/colorants/colorSpaceColorants.ts';
export { extractText } from './inspect/text/extractText.ts';
export type {
  ExtractTextOptions,
  GlyphMarkedContent,
  GlyphSource,
  GlyphTextReason,
  InvisibleBecause,
  PageGlyph,
  PageText,
} from './inspect/text/extractText.ts';
export type { ActualTextSpan } from './inspect/text/textUnits.ts';
export { orderGlyphs } from './inspect/text/orderGlyphs.ts';
export type { GlyphLayout } from './inspect/text/orderGlyphs.ts';
export { matchText } from './inspect/text/matchText.ts';
export type { DuplicateRuns, FoldApplied, MatchTextOptions, TextDifference, TextMatch } from './inspect/text/matchText.ts';
export type { TextFold } from './inspect/text/folds.ts';
export type { EmbeddedCmap } from './inspect/text/glyphEvidence.ts';
export type { InspectWarning, InspectWarningCode } from './content/inspectWarning.ts';
export type { FontWarningCode } from './font/fontModel.ts';
export type { DocumentOptions, PageOptions, PdfDocument, PdfPage } from './document/pdfDocument.ts';
export type { DocumentInfo, InfoValue, TextString } from './metadata/documentInfo.ts';
export { readMetadata } from './metadata/readMetadata.ts';
export type { ComponentPacket, DocumentMetadata } from './metadata/readMetadata.ts';
export { setMetadata } from './metadata/setMetadata.ts';
export type { MetadataChange, MetadataInput, ReconciledValue, SetMetadataOptions } from './metadata/setMetadata.ts';
export type { Agreement, LegacyValue, MappedKey, MappedProperty } from './metadata/mapping.ts';
export type { MetadataFinding, MetadataFindingCode } from './metadata/metadataFinding.ts';
export type { ScannedPackets } from './metadata/packetScan.ts';
export type { XmpArrayItem, XmpFinding, XmpFindingCode, XmpPacket, XmpProperty, XmpValue } from './metadata/xmp/readXmp.ts';
export type { XmlEncoding, XmlSpan } from './metadata/xmp/xmlTokenizer.ts';
export type { ContentBuilder, ContentNumber, PathBuilder } from './document/contentBuilder.ts';
export { cmyk, gray, rgb } from './document/color.ts';
export type { DeviceColor } from './document/color.ts';
export type { GraphicsStateOptions, PaintOptions } from './document/contentBuilder.ts';
export type { Separation, SeparationOptions } from './document/separation.ts';
export type { ImageColorSpace, ImageOptions, PdfImage } from './document/image.ts';
export type { GroupOptions, PdfGroup } from './document/group.ts';
export type { DocumentPieceInfoInput, PieceData, PieceDataEntries, PieceInfoInput } from './document/pieceInfo.ts';
export type { SavedPdf } from './write/savedPdf.ts';
export { rect } from './document/rect.ts';
export type { PdfRect } from './document/rect.ts';
export { parsePdfDate, pdfDate, pdfDateFromDate, pdfDateString } from './date/pdfDate.ts';
export type { ParsedPdfDate, PdfDate, PdfDateComponents, PdfDatePrecision } from './date/pdfDate.ts';
