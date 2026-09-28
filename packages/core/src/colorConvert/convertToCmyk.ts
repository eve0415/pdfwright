import type { LoadedDocument } from '../document/loadDocument.ts';
import type { MetadataChange } from '../metadata/setMetadata.ts';
import type { PdfX4PageChange, PdfX4PageOptions } from '../pdfx/preparePages.ts';
import type { PdfX4MetadataOptions } from '../pdfx/writeMetadata.ts';
import type { OutputIntentChange, OutputIntentOptions } from '../pdfx/writeOutputIntent.ts';
import type { FormConversionReport } from './convertForms.ts';
import type { GroupConversionReport } from './convertGroups.ts';
import type { ImageConversionReport } from './convertImages.ts';
import type { IndexedConversionReport } from './convertIndexed.ts';
import type { MeshConversionReport } from './convertMeshes.ts';
import type { OtherCarrierReport } from './convertOtherCarriers.ts';
import type { ShadingConversionReport } from './convertShadings.ts';
import type { SpotConversionReport } from './convertSpots.ts';
import type { RewriteColorOptions } from './rewriteContent.ts';
import type { PageRewriteReport } from './rewritePage.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { ValidationError } from '../error/validationError.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { preparePdfX4Pages } from '../pdfx/preparePages.ts';
import { writePdfX4Metadata } from '../pdfx/writeMetadata.ts';
import { writeGtsPdfxOutputIntent } from '../pdfx/writeOutputIntent.ts';

import { convertForms } from './convertForms.ts';
import { convertTransparencyGroups } from './convertGroups.ts';
import { convertImages } from './convertImages.ts';
import { convertIndexedSpaces } from './convertIndexed.ts';
import { convertMeshShadings } from './convertMeshes.ts';
import { convertOtherCarriers } from './convertOtherCarriers.ts';
import { convertShadings } from './convertShadings.ts';
import { convertSpotSpaces } from './convertSpots.ts';
import { checkConversionRefusals } from './preflight.ts';
import { rewritePageColors } from './rewritePage.ts';

/** Requires source RGB and output CMYK ICC bytes plus an output condition; compressed RGB images default to ICC-tagged keep, `pdfx` is off unless supplied, profiles default to a 24 MiB cap, and conversion refusals use typed ValidationError or UnsupportedFeatureError reasons under ICC.1:2022 and ISO 32000-1:2008, 8.6. */
export interface ConvertToCmykOptions extends Omit<RewriteColorOptions, 'sourceRgbProfile' | 'outputProfile'> {
  /** ICC profile for untagged DeviceRGB colours. */
  readonly sourceRgbProfile: Uint8Array;
  /** Output-class CMYK profile for conversion and the output intent. */
  readonly outputProfile: Uint8Array;
  /** Printing condition and existing-intent policy. */
  readonly outputIntent: Omit<OutputIntentOptions, 'outputProfile' | 'pdfx'>;
  /** PDF/X-4 page and metadata options; false omits those steps. */
  readonly pdfx?: (PdfX4MetadataOptions & PdfX4PageOptions & { readonly version?: 'PDF/X-4' }) | false;
}

/** Counts converted page, form, image, colour-space, shading, mesh, group, and annotation carriers and reports output-intent and optional PDF/X changes under ISO 32000-1:2008, 8.6 and 14.11.5. */
export interface ConversionReport {
  readonly page: PageRewriteReport;
  readonly forms: FormConversionReport;
  readonly images: ImageConversionReport;
  readonly indexed: IndexedConversionReport;
  readonly spots: SpotConversionReport;
  readonly shadings: ShadingConversionReport;
  readonly meshes: MeshConversionReport;
  readonly groups: GroupConversionReport;
  readonly otherCarriers: OtherCarrierReport;
  readonly outputIntent: OutputIntentChange;
  readonly pageBoxes: PdfX4PageChange | undefined;
  readonly metadata: MetadataChange | undefined;
}

/** Writes the output intent for the caller's CMYK profile, converts reachable RGB and calibrated colours to that profile, and with `pdfx` set adds missing TrimBoxes, page groups and PDF/X-4 identification. */
export const convertToCmyk = (document: LoadedDocument, options: ConvertToCmykOptions): ConversionReport => {
  const sourceRgbProfile = parseIccProfile(options.sourceRgbProfile);
  const outputProfile = parseIccProfile(options.outputProfile);
  if (sourceRgbProfile.header.colorSpace !== 'RGB') throw new ValidationError('sourceRgbProfile must be an RGB ICC profile', 'color-space');
  const policy = options.outputIntent.existing === undefined ? {} : { existing: options.outputIntent.existing };
  checkConversionRefusals(document, outputProfile, { outputIntent: policy });
  const conversion: RewriteColorOptions = { ...options, sourceRgbProfile, outputProfile };
  const pdfx = options.pdfx !== undefined && options.pdfx !== false;
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const previous = internals.objects.fork();
  const version = internals.pdfX4VersionState();
  try {
    const outputIntent = writeGtsPdfxOutputIntent(document, { outputProfile: options.outputProfile, ...options.outputIntent, pdfx });
    const page = rewritePageColors(document, conversion);
    const forms = convertForms(document, conversion);
    const images = convertImages(document, conversion);
    const indexed = convertIndexedSpaces(document, conversion);
    const spots = convertSpotSpaces(document, conversion);
    const shadings = convertShadings(document, conversion);
    const meshes = convertMeshShadings(document, conversion);
    const groups = convertTransparencyGroups(document, conversion);
    const otherCarriers = convertOtherCarriers(document, conversion);
    const pageBoxes = options.pdfx === undefined || options.pdfx === false ? undefined : preparePdfX4Pages(document, options.pdfx);
    const metadata = options.pdfx === undefined || options.pdfx === false ? undefined : writePdfX4Metadata(document, options.pdfx);
    return { page, forms, images, indexed, spots, shadings, meshes, groups, otherCarriers, outputIntent, pageBoxes, metadata };
  } catch (error: unknown) {
    internals.objects.adopt(previous);
    internals.restorePdfX4VersionState(version);
    throw error;
  }
};
