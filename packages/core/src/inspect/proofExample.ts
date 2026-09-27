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
