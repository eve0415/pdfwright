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

const codes = (mapping: MetadataMapping): ReadonlyArray<string> => mapping.findings.map(finding => finding.code);

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

  // XMP Part 3 Table 20 lists the pre-Part-2 properties; one is reported only when it says something else than the current property, or than Info where the current property is missing.
  it.each([
    [
      'agrees with the current property',
      info({ Author: text('A') }),
      '<pdf:Author>A</pdf:Author><dc:creator><rdf:Seq><rdf:li>A</rdf:li></rdf:Seq></dc:creator>',
      [],
    ],
    [
      'agrees with the current property but not with Info',
      info({ Title: text('I') }),
      `<pdf:Title>X</pdf:Title><dc:title>${alt('X')}</dc:title>`,
      ['info-xmp-mismatch'],
    ],
    ['differs from Info without a current property', info({ Subject: text('S') }), '<pdf:Subject>T</pdf:Subject>', ['legacy-property-mismatch']],
    ['agrees with Info without a current property', info({ Subject: text('S') }), '<pdf:Subject>S</pdf:Subject>', []],
  ])('reports a legacy property that %s accordingly', (_name, values, body, expected) => {
    expect(codes(mapMetadata(values, packet(body)))).toStrictEqual(expected);
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

  it('takes an alternative as empty only when every item is empty', () => {
    const mapping = mapMetadata(
      info({}),
      packet('<dc:title><rdf:Alt><rdf:li xml:lang="x-default"></rdf:li><rdf:li xml:lang="de">Titel</rdf:li></rdf:Alt></dc:title>'),
    );
    expect([agreements(mapping)['Title'], codes(mapping)]).toStrictEqual(['xmp-only', []]);
  });

  it('reports Info text with undecodable bytes and still maps its text', () => {
    const mapping = mapMetadata(info({ Title: { kind: 'text', text: 'T\uFFFD', encoding: 'utf-16be', languages: [], replaced: 1 } }), undefined);
    expect([mapping.properties.find(property => property.key === 'Title')?.info, codes(mapping)]).toStrictEqual(['T\uFFFD', ['info-text-undecodable']]);
    expect(mapping.findings[0]?.detail).toContain('Title');
  });

  it.each([
    [
      'a creators list compared with a title',
      'Title',
      info({ Title: text('A; B') }),
      '<dc:title><rdf:Alt><rdf:li xml:lang="en">A</rdf:li><rdf:li xml:lang="de">B</rdf:li></rdf:Alt></dc:title>',
      'differ',
      ['info-xmp-mismatch'],
    ],
    [
      'creators that differ after the first',
      'Author',
      info({ Author: text('A; C') }),
      '<dc:creator><rdf:Seq><rdf:li>A</rdf:li><rdf:li>B</rdf:li></rdf:Seq></dc:creator>',
      'differ',
      ['info-xmp-mismatch'],
    ],
    [
      'an XMP date that does not parse',
      'CreationDate',
      info({ CreationDate: text('D:20240101') }),
      '<xmp:CreateDate>yesterday</xmp:CreateDate>',
      'indeterminate',
      ['date-unparseable', 'info-xmp-indeterminate'],
    ],
    ['a URI compared with text', 'Creator', info({ Creator: text('C') }), '<xmp:CreatorTool rdf:resource="x"/>', 'indeterminate', ['info-xmp-indeterminate']],
    // XMP Part 2 3.1: pdf:Trapped is Boolean, so Info Unknown has no XMP form.
    ['Trapped Unknown against True', 'Trapped', info({ Trapped: { kind: 'name', name: 'Unknown' } }), '<pdf:Trapped>True</pdf:Trapped>', 'xmp-only', []],
    [
      'Trapped True against False',
      'Trapped',
      info({ Trapped: { kind: 'name', name: 'True' } }),
      '<pdf:Trapped>False</pdf:Trapped>',
      'differ',
      ['info-xmp-mismatch'],
    ],
    ['Trapped of another type', 'Trapped', info({ Trapped: { kind: 'other', type: 'integer' } }), '', 'absent', ['trapped-not-name']],
  ])('maps %s', (_name, key, values, body, agreement, expected) => {
    const mapping = mapMetadata(values, packet(body));
    expect([agreements(mapping)[key], codes(mapping)]).toStrictEqual([agreement, expected]);
  });

  it('names the property that does not parse and the type of a Trapped that is not a name', () => {
    const date = mapMetadata(info({ CreationDate: text('D:20240101') }), packet('<xmp:CreateDate>yesterday</xmp:CreateDate>'));
    const trapped = mapMetadata(info({ Trapped: { kind: 'other', type: 'integer' } }), undefined);
    expect(date.findings[0]?.detail).toContain('xmp:CreateDate');
    expect(trapped.findings[0]?.detail).toContain('of type integer');
  });

  // ISO 32000-1:2008, 14.3.2 compares the metadata stream's date stamp with Info ModDate; without either readable, neither side is authoritative.
  it.each([
    ['Info has no ModDate', info({ Title: text('T') }), '<xmp:MetadataDate>2024-01-02T00:00:00Z</xmp:MetadataDate>'],
    ['Info ModDate is a name', info({ ModDate: { kind: 'name', name: 'D:20240102000000Z' } }), '<xmp:MetadataDate>2024-01-02T00:00:00Z</xmp:MetadataDate>'],
    [
      'the metadata date does not parse beside a modify date that does',
      info({ ModDate: text('D:20240101000000Z') }),
      '<xmp:MetadataDate>soon</xmp:MetadataDate><xmp:ModifyDate>2024-01-02T00:00:00Z</xmp:ModifyDate>',
    ],
  ])('leaves the authority indeterminate when %s', (_name, values, body) => {
    expect(mapMetadata(values, packet(body)).authority).toBe('indeterminate');
  });

  it.each([
    ['xmp', info({ Title: text('Info'), ModDate: text('D:20240101000000Z') }), '<xmp:MetadataDate>2024-01-02T00:00:00Z</xmp:MetadataDate>'],
    ['info', info({ Title: text('Info'), ModDate: text('D:20240103000000Z') }), '<xmp:MetadataDate>2024-01-02T00:00:00Z</xmp:MetadataDate>'],
  ])('names %s as authoritative in a mismatch', (authority, values, body) => {
    const mapping = mapMetadata(values, packet(`<dc:title>${alt('Packet')}</dc:title>${body}`));
    expect(mapping.findings.find(finding => finding.code === 'info-xmp-mismatch')?.detail).toMatch(new RegExp(`; ${authority} is authoritative$`, 'u'));
  });

  it('is Info-authoritative without a packet and XMP-authoritative without Info', () => {
    const withoutPacket = mapMetadata(info({ Title: text('T') }), packet('<not-well-formed'));
    const withoutInfo = mapMetadata(undefined, packet(''));
    expect([withoutPacket.authority, withoutInfo.authority]).toStrictEqual(['info', 'xmp']);
  });
});
