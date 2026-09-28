export type RuleAuthority =
  | 'iso32000-1'
  | 'iso15930-7-preview'
  | 'industry-specification'
  | 'predecessor-guidance'
  | 'industry-explainer'
  | 'implementation-evidence'
  | 'unverified';

export type PdfX4RuleId =
  | 'X4-VERSION'
  | 'X4-PDF17-KEYS'
  | 'X4-ENCRYPT'
  | 'X4-OI-PRESENT'
  | 'X4-OI-ENTRIES'
  | 'X4-OI-PROFILE'
  | 'X4-OI-PROFILE-VERSION'
  | 'X4-XMP-VERSION'
  | 'X4-XMP-MM'
  | 'X4-TRAPPED'
  | 'X4-BOXES'
  | 'X4-JS'
  | 'X4-FORMS'
  | 'X4-ANNOTS'
  | 'X4-TRANSFER'
  | 'X4-LZW'
  | 'X4-EMBEDDED'
  | 'X4-EXTERNAL'
  | 'X4-FONTS'
  | 'X4-SPOT-ALTERNATE'
  | 'X4-PS'
  | 'X4-BXEX'
  | 'X4-INTENTS'
  | 'X4-LIMITS'
  | 'X4-TRANSPARENCY'
  | 'X4-OC';

export interface PdfX4Rule {
  readonly id: PdfX4RuleId;
  readonly source: string;
  readonly authority: RuleAuthority;
}

/** Sources label the authority of each structural check; the available ISO 15930-7 preview ends before its requirement clauses. */
export const pdfX4Rules: readonly PdfX4Rule[] = [
  { id: 'X4-VERSION', source: 'ISO 15930-7:2010 preview, clause 1 and Table 1; requirement 6.1 unavailable', authority: 'iso15930-7-preview' },
  { id: 'X4-PDF17-KEYS', source: 'ISO 32000-1:2008, per-key PDF 1.7 version tags and 7.5.2', authority: 'iso32000-1' },
  { id: 'X4-ENCRYPT', source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles', authority: 'industry-explainer' },
  { id: 'X4-OI-PRESENT', source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles; ISO 32000-1:2008, Table 365', authority: 'industry-explainer' },
  { id: 'X4-OI-ENTRIES', source: 'ISO 32000-1:2008, 14.11.5, Table 365; CGATS Application Notes (2006), 2.16.4', authority: 'iso32000-1' },
  {
    id: 'X4-OI-PROFILE',
    source: 'PDF/X in a Nutshell, PDF Association (2017), PDF/X-4; ISO 32000-1:2008, Table 365; CGATS Application Notes (2006), 3.3',
    authority: 'industry-explainer',
  },
  { id: 'X4-OI-PROFILE-VERSION', source: 'ISO 15930-7:2010 preview, 2 and 3.13; requirement 6.4 unavailable', authority: 'iso15930-7-preview' },
  { id: 'X4-XMP-VERSION', source: 'CTAN pdfx.xmp, PDF/X-4 identification property; XMP_Const.h, PDF/X ID namespace', authority: 'implementation-evidence' },
  { id: 'X4-XMP-MM', source: 'CTAN pdfx.xmp, PDF/X-4 xmpMM properties', authority: 'implementation-evidence' },
  { id: 'X4-TRAPPED', source: 'CGATS Application Notes (2006), 2.17; ISO 32000-1:2008, Table 317', authority: 'predecessor-guidance' },
  { id: 'X4-BOXES', source: 'CGATS Application Notes (2006), 2.10; ISO 32000-1:2008, 14.11.2', authority: 'predecessor-guidance' },
  { id: 'X4-JS', source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles', authority: 'industry-explainer' },
  {
    id: 'X4-FORMS',
    source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles; ISO 15930-7:2010 preview, 6.26 title',
    authority: 'industry-explainer',
  },
  {
    id: 'X4-ANNOTS',
    source: 'CGATS Application Notes (2006), 2.28; PDF/X in a Nutshell, PDF Association (2017), Core principles',
    authority: 'predecessor-guidance',
  },
  { id: 'X4-TRANSFER', source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles', authority: 'industry-explainer' },
  { id: 'X4-LZW', source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles', authority: 'industry-explainer' },
  { id: 'X4-EMBEDDED', source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles', authority: 'industry-explainer' },
  { id: 'X4-EXTERNAL', source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles', authority: 'industry-explainer' },
  {
    id: 'X4-FONTS',
    source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles; ISO 15930-7:2010 preview, 6.5 title',
    authority: 'industry-explainer',
  },
  { id: 'X4-SPOT-ALTERNATE', source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles', authority: 'industry-explainer' },
  { id: 'X4-PS', source: 'ISO 15930-7:2010 preview, 6.14 title only', authority: 'iso15930-7-preview' },
  { id: 'X4-BXEX', source: 'ISO 15930-7:2010 preview, 6.19 title only', authority: 'iso15930-7-preview' },
  { id: 'X4-INTENTS', source: 'ISO 32000-1:2008, Table 70; ISO 15930-7:2010 preview, 6.23 title only', authority: 'iso32000-1' },
  { id: 'X4-LIMITS', source: 'ISO 32000-1:2008, Annex C; ISO 15930-7:2010 preview, 6.25 title only', authority: 'iso32000-1' },
  { id: 'X4-TRANSPARENCY', source: 'ISO 15930-7:2010 preview, clause 1', authority: 'iso15930-7-preview' },
  { id: 'X4-OC', source: 'ISO 15930-7:2010 preview, clause 1; requirement 6.24 unavailable', authority: 'iso15930-7-preview' },
];
