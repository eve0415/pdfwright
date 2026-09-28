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
