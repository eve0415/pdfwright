export type RuleAuthority = 'iso32000-1' | 'iso15930-7-preview' | 'predecessor-guidance' | 'industry-explainer' | 'implementation-evidence' | 'house-policy';

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
  | 'X4-TRAPPED-XMP'
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

/** The rules checkPdfX4 applies, each with the source its check follows and that source's authority; a rule whose requirement only ISO 15930-7:2010, clause 6 sets reports `not-checked`. */
export const pdfX4Rules: readonly PdfX4Rule[] = [
  { id: 'X4-VERSION', source: 'ISO 15930-7:2010 preview, Introduction, Table 1, and clause 1; table of contents, 6.1', authority: 'iso15930-7-preview' },
  {
    id: 'X4-PDF17-KEYS',
    source: 'ISO 15930-7:2010 preview, Introduction, Table 1 (PDF 1.6); ISO 32000-1:2008, 7.5.2 and per-key version tags',
    authority: 'iso15930-7-preview',
  },
  { id: 'X4-ENCRYPT', source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles', authority: 'industry-explainer' },
  { id: 'X4-OI-PRESENT', source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles; ISO 32000-1:2008, Table 365', authority: 'industry-explainer' },
  { id: 'X4-OI-ENTRIES', source: 'ISO 32000-1:2008, 14.11.5, Table 365; CGATS Application Notes (2006), 2.16.4', authority: 'iso32000-1' },
  {
    id: 'X4-OI-PROFILE',
    source:
      'PDF/X in a Nutshell, PDF Association (2017), PDF/X-4; ISO 32000-1:2008, Table 365; CGATS Application Notes (2006), 3.3; ISO 15930-7:2010 preview, Introduction, Table 1',
    authority: 'industry-explainer',
  },
  { id: 'X4-OI-PROFILE-VERSION', source: 'ISO 15930-7:2010 preview, clauses 2 and 3.13; table of contents, 6.4', authority: 'iso15930-7-preview' },
  {
    id: 'X4-XMP-VERSION',
    source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles; CTAN pdfx.xmp and XMP_Const.h for the property and namespace',
    authority: 'industry-explainer',
  },
  {
    id: 'X4-XMP-MM',
    source: 'ISO 15930-7:2010 preview, table of contents, 6.10; CTAN pdfx.xmp shows implementation practice',
    authority: 'iso15930-7-preview',
  },
  { id: 'X4-TRAPPED', source: 'CGATS Application Notes (2006), 2.17; ISO 32000-1:2008, Table 317', authority: 'predecessor-guidance' },
  {
    id: 'X4-TRAPPED-XMP',
    source: "XMP Specification Part 3, Table 20 maps Trapped to pdf:Trapped; agreement is this package's policy",
    authority: 'house-policy',
  },
  { id: 'X4-BOXES', source: 'CGATS Application Notes (2006), 2.10; ISO 32000-1:2008, 14.11.2', authority: 'predecessor-guidance' },
  {
    id: 'X4-JS',
    source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles; ISO 15930-7:2010 preview, table of contents, 6.18',
    authority: 'industry-explainer',
  },
  {
    id: 'X4-FORMS',
    source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles; ISO 15930-7:2010 preview, table of contents, 6.26',
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
  {
    id: 'X4-EXTERNAL',
    source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles; CGATS Application Notes (2006), 3.1.2 and 3.1.3 for OPI',
    authority: 'industry-explainer',
  },
  {
    id: 'X4-FONTS',
    source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles; ISO 15930-7:2010 preview, table of contents, 6.5',
    authority: 'industry-explainer',
  },
  { id: 'X4-SPOT-ALTERNATE', source: 'PDF/X in a Nutshell, PDF Association (2017), Core principles', authority: 'industry-explainer' },
  { id: 'X4-PS', source: 'ISO 15930-7:2010 preview, table of contents, 6.14', authority: 'iso15930-7-preview' },
  { id: 'X4-BXEX', source: 'ISO 15930-7:2010 preview, table of contents, 6.19', authority: 'iso15930-7-preview' },
  { id: 'X4-INTENTS', source: 'ISO 32000-1:2008, Table 70; ISO 15930-7:2010 preview, table of contents, 6.23', authority: 'iso15930-7-preview' },
  { id: 'X4-LIMITS', source: 'ISO 32000-1:2008, Annex C; ISO 15930-7:2010 preview, table of contents, 6.25', authority: 'iso15930-7-preview' },
  { id: 'X4-TRANSPARENCY', source: 'ISO 15930-7:2010 preview, clause 1; table of contents, 6.20', authority: 'iso15930-7-preview' },
  { id: 'X4-OC', source: 'ISO 15930-7:2010 preview, clause 1; table of contents, 6.24', authority: 'iso15930-7-preview' },
];
