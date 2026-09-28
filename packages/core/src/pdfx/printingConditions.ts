/** A reference name and its process, medium, and designation as listed by the ICC. No profile bytes are included. */
export interface PrintingCondition {
  readonly identifier: string;
  readonly process: string;
  readonly media: string;
  readonly designation: string;
  readonly source: string;
  readonly snapshotDate: string;
}

// International Color Consortium, CMYK Characterization Data, https://registry.color.org/cmyk-registry/, read 2026-09-28.
const registryRows: readonly (readonly [string, string, string, string])[] = [
  ['FOGRA53', 'Universal', 'Universal', 'Large gamut exchange space'],
  ['CGATS21-2-CRPC7', 'Universal', 'Universal', 'CGATS21-2'],
  ['APTEC_CTV_8', 'Offset', 'Premium coated', 'APTEC_CMYKOGV_Coated'],
  ['APTEC_CTV_7', 'Flexo', 'Premium coated', 'APTEC_Flexo_Coated_LinearCTV_2025'],
  ['APTEC_CTV_6', 'Offset', 'Premium coated PS1', 'APTEC_Offset_Coated_LinearCTV_2025'],
  ['FOGRA51', 'Offset', 'Premium coated, 115 g/m2', 'OFCOM'],
  ['JCS2011', 'Offset', 'Premium coated, 127.9 g/m2', 'Japan Color 2011'],
  ['FOGRA50', 'Offset', 'Gloss or matt coated, 115 g/m2, gloss laminated', 'OFCOM'],
  ['FOGRA49', 'Offset', 'Gloss or matt coated, 115 g/m2, matt laminated', 'OFCOM'],
  ['FOGRA43', 'Offset', 'Gloss or matt coated, 115 g/m2', 'OFCOM'],
  ['CGATS TR 006', 'Offset + gravure', 'US Grade 1 coated sheetfed', 'GRACoL Grade 1 Paper'],
  ['FOGRA39', 'Offset', 'Gloss or matt coated, 115 g/m2', 'OFCOM'],
  ['JC200103', 'Offset', 'Gloss or matt coated, 105 g/m2', 'Japan Color 2001 Coated'],
  ['FOGRA27', 'Offset', 'Gloss or matt coated, 115 g/m2', 'OFCOM 1.2 Altona'],
  ['EUROSB104', 'Offset', 'Gloss or matt coated, 115 g/m2', "'Eurostandard' 15% Coated"],
  ['APTEC Coated CardBoard', 'Offset', 'One-side coated, 250 g/m2', 'APTEC_PC10_CardBoard_2023_v1'],
  ['APTEC CCNB', 'Offset', 'Clay coated news back, 250 g/m2', 'APTEC PC11_CCNB 2023 v1'],
  ['CGATS21-2-CRPC6', 'Universal', 'Universal Premium Coated', 'CGATS21-2'],
  ['CGATS21-2-CRPC5', 'Universal', 'Universal Publication Coated', 'CGATS21-2'],
  ['FOGRA45', 'Offset', 'Improved LWC', 'OFCOM'],
  ['FOGRA46', 'Offset', 'Standard LWC', 'OFCOM'],
  ['FOGRA41', 'Offset', 'Machine finished coated', 'OFCOM'],
  ['CGATS TR 001', 'Offset', 'Gloss coated web, (LWC)', 'SWOP'],
  ['CGATS TR 003', 'Offset + gravure', 'US grade 3 coated web', 'SWOP Grade 3 Paper'],
  ['CGATS TR 005', 'Offset + gravure', 'US grade 5 coated web', 'SWOP Grade 5 Paper'],
  ['FOGRA28', 'Offset', 'Gloss coated web, (LWC) 60 g/m2', 'OFCOM 3 Altona'],
  ['JCW2003', 'Offset', 'Gloss coated web, 70 g/m2', 'Japan Color 2003'],
  ['EUROSB204', 'Offset', 'Gloss coated web, (LWC) 80 g/m2', "'Eurostandard' 15% Webcoated"],
  ['APTEC_CTV_3', 'Offset', 'Wood free uncoated PS5', 'APTEC_Uncoated'],
  ['FOGRA52', 'Offset', 'Uncoated white, 120 g/m2', 'OFCOM'],
  ['CGATS21-2-CRPC3', 'Universal', 'Universal Premium Uncoated', 'CGATS21-2'],
  ['FOGRA47', 'Offset', 'Uncoated white, 115 g/m2', 'OFCOM'],
  ['FOGRA44', 'Offset', 'Uncoated white, 115 g/m2', 'OFCOM'],
  ['FOGRA29', 'Offset', 'Uncoated white, 120 g/m2', 'OFCOM 4 Altona'],
  ['JC200104', 'Offset', 'Uncoated white, 105 g/m2', 'Japan Color 2001'],
  ['FOGRA54', 'Offset', 'Super calendered (SC) uncoated', 'OFCOM'],
  ['CGATS21-2-CRPC4', 'Universal', 'Universal Supercalendared', 'CGATS21-2'],
  ['FOGRA40', 'Offset', 'Super calendered (SC) 60 g/m2', 'OFCOM'],
  ['FOGRA30', 'Offset', 'Uncoated slightly yellowish offset, 120 g/m2', 'OFCOM 5 Altona'],
  ['FOGRA48', 'Offset', 'Improved Newsprint', 'OFCOM'],
  ['CGATS21-2-CRPC2', 'Universal', 'Improved Newsprint', 'CGATS21-2'],
  ['CGATS21-2-CRPC1', 'Universal', 'Newsprint', 'CGATS21-2'],
  ['FOGRA42', 'Offset', 'Standard Newsprint', 'OFCOM'],
  ['IFRA26', 'Offset', 'Newsshade newsprint', 'NW'],
  ['JCN2002', 'Offset', 'Newsprint', 'Japan Color 2002'],
  ['CGATS TR 002', 'Offset', 'Uncoated groundwood', 'US-SNAP'],
  ['APTEC_CTV_5', 'Flexo', 'One-side coated Label', 'APTEC_Flexo_Label'],
  ['APTEC_CTV_4', 'Flexo', 'Polyvinyl Chloride (PVC)', 'APTEC_Flexo_PVC'],
  ['FOGRA33', 'Continuous stationery', 'Matt coated art, 115 g/m2', 'OFCOF 1.2 Altona'],
  ['FOGRA37', 'Continuous stationery', 'Matt coated art, 115 g/m2', 'OFCOF 1.2 Altona'],
  ['FOGRA31', 'Continuous stationery', 'Matt coated art, 115 g/m2', 'OFCOF 2 Altona'],
  ['FOGRA35', 'Continuous stationery', 'Matt coated art, 115 g/m2', 'OFCOF 1.2 Altona'],
  ['FOGRA32', 'Continuous stationery', 'Uncoated white offset, 80 g/m2', 'OFCOF 4 Altona'],
  ['FOGRA34', 'Continuous stationery', 'Uncoated white offset, 115 g/m2', 'OFCOF 4 Altona'],
  ['FOGRA36', 'Continuous stationery', 'Uncoated white offset, 115 g/m2', 'OFCOF 4 Altona'],
  ['FOGRA38', 'Continuous stationery', 'Uncoated white offset, 115 g/m2', 'OFCOF 4 Altona'],
];

export const registeredPrintingConditions: readonly PrintingCondition[] = registryRows.map(([identifier, process, media, designation]) => ({
  identifier,
  process,
  media,
  designation,
  source: 'https://registry.color.org/cmyk-registry/',
  snapshotDate: '2026-09-28',
}));
