import type { InfoValue } from './documentInfo.ts';
import type { MetadataMapping } from './mapping.ts';
import type { XmpPacket } from './xmp/readXmp.ts';

import { describe, expect, it } from 'vitest';

import { mapMetadata } from './mapping.ts';
import { readXmp } from './xmp/readXmp.ts';

const NAMESPACES =
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"';

const packet = (body: string): XmpPacket | undefined => {
  const result = readXmp(new TextEncoder().encode(`<rdf:RDF ${NAMESPACES}><rdf:Description rdf:about="">${body}</rdf:Description></rdf:RDF>`));
  return result.ok ? result.packet : undefined;
};

const text = (value: string): InfoValue => ({ kind: 'text', text: value, encoding: 'pdfdoc', languages: [], replaced: 0 });

const info = (entries: Record<string, InfoValue>): ReadonlyMap<string, InfoValue> => new Map(Object.entries(entries));

const agreements = (mapping: MetadataMapping): Record<string, string> =>
  Object.fromEntries(mapping.properties.map(property => [property.key, property.agreement]));

const codes = (mapping: MetadataMapping): readonly string[] => mapping.findings.map(finding => finding.code);

const alt = (value: string): string => `<rdf:Alt><rdf:li xml:lang="x-default">${value}</rdf:li></rdf:Alt>`;

describe('mapping Info to XMP', () => {
  it('agrees on every row of XMP Part 3 Table 20 when both sides say the same', () => {
    const mapping = mapMetadata(
      info({
        Title: text('T'),
        Author: text('A'),
        Subject: text('S'),
        Keywords: text('K'),
        Creator: text('C'),
        Producer: text('P'),
        CreationDate: text("D:20240101090000+09'00'"),
        ModDate: text('D:20240102000000Z'),
        Trapped: { kind: 'name', name: 'True' },
      }),
      packet(
        `<dc:title>${alt('T')}</dc:title><dc:creator><rdf:Seq><rdf:li>A</rdf:li></rdf:Seq></dc:creator><dc:description>${alt('S')}</dc:description>` +
          '<pdf:Keywords>K</pdf:Keywords><xmp:CreatorTool>C</xmp:CreatorTool><pdf:Producer>P</pdf:Producer>' +
          '<xmp:CreateDate>2024-01-01T00:00:00Z</xmp:CreateDate><xmp:ModifyDate>2024-01-02T00:00:00Z</xmp:ModifyDate>' +
          '<xmp:MetadataDate>2024-01-02T00:00:00Z</xmp:MetadataDate><pdf:Trapped>True</pdf:Trapped>',
      ),
    );
    expect([agreements(mapping), mapping.authority, codes(mapping)]).toStrictEqual([
      {
        Title: 'agree',
        Author: 'agree',
        Subject: 'agree',
        Keywords: 'agree',
        Creator: 'agree',
        Producer: 'agree',
        CreationDate: 'agree',
        ModDate: 'agree',
        Trapped: 'agree',
      },
      'xmp',
      [],
    ]);
  });

  it('matches the first or x-default alternative, and the first creator or all creators joined', () => {
    const mapping = mapMetadata(
      info({ Title: text('Default'), Subject: text('First'), Author: text('A; B') }),
      packet(
        '<dc:title><rdf:Alt><rdf:li xml:lang="en">English</rdf:li><rdf:li xml:lang="x-default">Default</rdf:li></rdf:Alt></dc:title>' +
          '<dc:description><rdf:Alt><rdf:li xml:lang="en">First</rdf:li><rdf:li xml:lang="de">Zweite</rdf:li></rdf:Alt></dc:description>' +
          '<dc:creator><rdf:Seq><rdf:li>A</rdf:li><rdf:li>B</rdf:li></rdf:Seq></dc:creator>',
      ),
    );
    const first = mapMetadata(info({ Author: text('A') }), packet('<dc:creator><rdf:Seq><rdf:li>A</rdf:li><rdf:li>B</rdf:li></rdf:Seq></dc:creator>'));
    expect([agreements(mapping), agreements(first)['Author']]).toStrictEqual([
      {
        Title: 'agree',
        Author: 'agree',
        Subject: 'agree',
        Keywords: 'absent',
        Creator: 'absent',
        Producer: 'absent',
        CreationDate: 'absent',
        ModDate: 'absent',
        Trapped: 'absent',
      },
      'agree',
    ]);
  });

  it('reports disagreements with the authority, one-sided values and Trapped Unknown as no property', () => {
    const mapping = mapMetadata(
      info({ Title: text('Info'), Producer: text('P'), Trapped: { kind: 'name', name: 'Unknown' }, ModDate: text("D:20030826163921-06'00'") }),
      packet(`<dc:title>${alt('Packet')}</dc:title><xmp:CreatorTool>C</xmp:CreatorTool><xmp:ModifyDate>2003-08-26T23:39:02Z</xmp:ModifyDate>`),
    );
    expect([agreements(mapping), mapping.authority, codes(mapping)]).toStrictEqual([
      {
        Title: 'differ',
        Author: 'absent',
        Subject: 'absent',
        Keywords: 'absent',
        Creator: 'xmp-only',
        Producer: 'info-only',
        CreationDate: 'absent',
        ModDate: 'differ',
        Trapped: 'agree',
      },
      'xmp',
      ['info-xmp-mismatch', 'info-xmp-mismatch'],
    ]);
  });

  it('takes Info as authoritative when its ModDate is later than the metadata date', () => {
    const mapping = mapMetadata(
      info({ ModDate: text('D:20240103000000Z') }),
      packet('<xmp:ModifyDate>2024-01-03T00:00:00Z</xmp:ModifyDate><xmp:MetadataDate>2024-01-02T00:00:00Z</xmp:MetadataDate>'),
    );
    const noStamp = mapMetadata(info({ ModDate: text('D:20240103000000Z') }), packet('<xmp:CreatorTool>C</xmp:CreatorTool>'));
    const noZone = mapMetadata(info({ ModDate: text('D:20240103000000Z') }), packet('<xmp:ModifyDate>2024-01-03T00:00:00</xmp:ModifyDate>'));
    expect([mapping.authority, codes(mapping), noStamp.authority, noZone.authority, codes(noZone)]).toStrictEqual([
      'info',
      ['modification-after-metadata'],
      'indeterminate',
      'indeterminate',
      ['date-zone-unknown', 'info-xmp-indeterminate'],
    ]);
  });

  it('reports Info values of the wrong kind, empty strings, unparseable dates and legacy duplicates', () => {
    const mapping = mapMetadata(
      info({ Title: text(''), Author: { kind: 'other', type: 'integer' }, Trapped: text('True'), CreationDate: text('yesterday') }),
      packet('<pdf:Title>Old</pdf:Title><dc:title><rdf:Alt><rdf:li xml:lang="x-default">New</rdf:li></rdf:Alt></dc:title>'),
    );
    expect([codes(mapping), mapping.properties.find(property => property.key === 'Title')?.legacy]).toStrictEqual([
      ['info-empty-string', 'legacy-property-mismatch', 'info-not-text-string', 'date-unparseable', 'trapped-not-name'],
      [{ property: 'pdf:Title', value: { kind: 'text', text: 'Old', language: undefined } }],
    ]);
  });

  it('takes an empty XMP value as unknown, like an empty Info string', () => {
    const mapping = mapMetadata(
      info({ Title: text('T'), Subject: text('') }),
      packet(`<dc:title>${alt('')}</dc:title><dc:description>${alt('S')}</dc:description><pdf:Producer></pdf:Producer><dc:creator><rdf:Seq/></dc:creator>`),
    );
    expect([agreements(mapping), codes(mapping)]).toStrictEqual([
      {
        Title: 'info-only',
        Author: 'absent',
        Subject: 'xmp-only',
        Keywords: 'absent',
        Creator: 'absent',
        Producer: 'absent',
        CreationDate: 'absent',
        ModDate: 'absent',
        Trapped: 'absent',
      },
      ['xmp-empty-value', 'xmp-empty-value', 'info-empty-string', 'xmp-empty-value'],
    ]);
  });

  it('is Info-authoritative without a packet and XMP-authoritative without Info', () => {
    const withoutPacket = mapMetadata(info({ Title: text('T') }), packet('<not-well-formed'));
    const withoutInfo = mapMetadata(undefined, packet(''));
    expect([withoutPacket.authority, withoutInfo.authority]).toStrictEqual(['info', 'xmp']);
  });
});
