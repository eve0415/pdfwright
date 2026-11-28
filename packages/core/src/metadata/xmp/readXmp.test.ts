import type { ReadXmp, XmpProperty } from './readXmp.ts';

import { describe, expect, it } from 'vitest';

import { RDF_NAMESPACE, readXmp } from './readXmp.ts';

const RDF = 'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"';
const DC = 'xmlns:dc="http://purl.org/dc/elements/1.1/"';
const XMP = 'xmlns:xmp="http://ns.adobe.com/xap/1.0/"';
const PDF = 'xmlns:pdf="http://ns.adobe.com/pdf/1.3/"';

const packet = (body: string, rdfAttributes = ''): string =>
  `<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ${RDF}${rdfAttributes}>${body}</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;

const read = (text: string): ReadXmp => readXmp(new TextEncoder().encode(text));

const properties = (text: string): ReadonlyArray<XmpProperty> => {
  const result = read(text);
  return result.ok ? result.packet.properties : [];
};

const summary = (text: string): ReadonlyArray<readonly [string, string, unknown]> =>
  properties(text).map(property => [`${property.namespace}${property.localName}`, property.form, property.value] as const);

const refusal = (text: string): string | undefined => {
  const result = read(text);
  return result.ok ? undefined : result.reason;
};

const findings = (text: string): ReadonlyArray<string> => {
  const result = read(text);
  return result.ok ? result.packet.findings.map(finding => finding.code) : [result.reason];
};

const descriptions = (...abouts: ReadonlyArray<string>): string => packet(abouts.map(about => `<rdf:Description ${about}/>`).join(''));

const subject = (text: string): string | undefined => {
  const result = read(text);
  return result.ok ? result.packet.subject : undefined;
};

const wrapperAndCount = (text: string): ReadonlyArray<unknown> | string => {
  const result = read(text);
  return result.ok ? [result.packet.wrapper, result.packet.properties.length] : result.reason;
};

const utf16Packet = (text: string): Uint8Array => {
  const bytes = [0xfe, 0xff];
  // Every character of the packets built here is in the Basic Multilingual Plane.
  for (const character of text) {
    const unit = character.codePointAt(0) ?? 0;
    bytes.push(Math.floor(unit / 256), unit % 256);
  }
  return Uint8Array.from(bytes);
};

const encodingFindings = (bytes: Uint8Array): ReadonlyArray<string> => {
  const result = readXmp(bytes);
  return result.ok ? [result.packet.encoding, ...result.packet.findings.map(finding => finding.code)] : [result.reason];
};

// Text as UTF-16BE or UTF-32BE bytes without a byte-order mark.
const utf16be = (text: string): Array<number> =>
  Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)).flatMap(unit => [unit >> 8, unit & 0xff]);
const utf32be = (text: string): Array<number> =>
  Array.from(text, character => character.codePointAt(0) ?? 0).flatMap(code => [code >>> 24, (code >> 16) & 0xff, (code >> 8) & 0xff, code & 0xff]);

describe('reading XMP packets', () => {
  it('reads simple, attribute, URI, language alternative, ordered and opaque properties', () => {
    const text = packet(
      `<rdf:Description rdf:about="" ${DC} ${XMP} xmp:CreatorTool="Tool &amp; Co">` +
        '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Title</rdf:li><rdf:li xml:lang="ja">題</rdf:li></rdf:Alt></dc:title>' +
        '<dc:creator><rdf:Seq><rdf:li>A</rdf:li><rdf:li>B</rdf:li></rdf:Seq></dc:creator>' +
        '<xmp:CreateDate>2024-01-01T00:00:00Z</xmp:CreateDate>' +
        '<xmp:Thumbnails><rdf:Alt><rdf:li rdf:parseType="Resource"><xmp:width>1</xmp:width></rdf:li></rdf:Alt></xmp:Thumbnails>' +
        '<xmp:BaseURL rdf:resource="http://example.com/"/>' +
        '<dc:empty/>' +
        '</rdf:Description>',
    );
    expect(summary(text)).toStrictEqual([
      ['http://ns.adobe.com/xap/1.0/CreatorTool', 'attribute', { kind: 'text', text: 'Tool & Co', language: undefined }],
      [
        'http://purl.org/dc/elements/1.1/title',
        'element',
        {
          kind: 'array',
          type: 'Alt',
          items: [
            { text: 'Title', language: 'x-default' },
            { text: '題', language: 'ja' },
          ],
        },
      ],
      [
        'http://purl.org/dc/elements/1.1/creator',
        'element',
        {
          kind: 'array',
          type: 'Seq',
          items: [
            { text: 'A', language: undefined },
            { text: 'B', language: undefined },
          ],
        },
      ],
      ['http://ns.adobe.com/xap/1.0/CreateDate', 'element', { kind: 'text', text: '2024-01-01T00:00:00Z', language: undefined }],
      ['http://ns.adobe.com/xap/1.0/Thumbnails', 'element', { kind: 'opaque' }],
      ['http://ns.adobe.com/xap/1.0/BaseURL', 'element', { kind: 'uri', uri: 'http://example.com/' }],
      ['http://purl.org/dc/elements/1.1/empty', 'element', { kind: 'text', text: '', language: undefined }],
    ]);
  });

  it('gives each property its span in the packet bytes', () => {
    const text = packet(`<rdf:Description rdf:about="" ${PDF} pdf:Producer="日本"><pdf:Keywords>山</pdf:Keywords></rdf:Description>`);
    const bytes = new TextEncoder().encode(text);
    const spans = properties(text).map(property => new TextDecoder().decode(bytes.subarray(property.span.start, property.span.end)));
    expect(spans).toStrictEqual(['pdf:Producer="日本"', '<pdf:Keywords>山</pdf:Keywords>']);
  });

  it('resolves namespaces by URI whatever the prefix, and inherits xml:lang', () => {
    const text = packet(
      '<rdf:Description rdf:about="" xmlns:t="http://purl.org/dc/elements/1.1/" xmlns:dc="http://example.com/other/">' +
        '<t:subject xml:lang="en">A</t:subject><dc:title>B</dc:title></rdf:Description>',
      ' xml:lang="de"',
    );
    expect(summary(text)).toStrictEqual([
      ['http://purl.org/dc/elements/1.1/subject', 'element', { kind: 'text', text: 'A', language: 'en' }],
      ['http://example.com/other/title', 'element', { kind: 'text', text: 'B', language: 'de' }],
    ]);
  });

  it('reads packets without x:xmpmeta or a wrapper, and reports the wrapper when present', () => {
    const bare = `<rdf:RDF ${RDF}><rdf:Description rdf:about="" ${PDF}><pdf:Producer>P</pdf:Producer></rdf:Description></rdf:RDF>`;
    const readOnly = packet(`<rdf:Description rdf:about="" ${PDF}/>`).replace('end="w"', "end='r'");
    expect([wrapperAndCount(bare), wrapperAndCount(readOnly)]).toStrictEqual([
      [{ begin: false, end: undefined }, 1],
      [{ begin: true, end: 'r' }, 0],
    ]);
  });

  it('reads a packet followed by padding after its trailer', () => {
    expect(wrapperAndCount(`${packet(`<rdf:Description rdf:about="" ${PDF} pdf:Producer="P"/>`)}\u{0}\u{0}\u{0}`)).toStrictEqual([
      { begin: true, end: 'w' },
      1,
    ]);
  });

  it('finds a second packet after the first packet trailer', () => {
    const first = packet('<rdf:Description rdf:about=""/>');
    expect(findings(`${first}${packet('<rdf:Description rdf:about=""/>')}`)).toStrictEqual(['extra-xmp-packet']);
  });

  it('accepts a missing, empty, unprefixed or mixed about and reports the subject', () => {
    expect([
      subject(descriptions('')),
      subject(descriptions('rdf:about=""', 'rdf:about="uuid:1"')),
      subject(descriptions('about="uuid:1"')),
      subject(descriptions('rdf:about="uuid:1"', 'rdf:about="uuid:2"')),
    ]).toStrictEqual(['', 'uuid:1', 'uuid:1', 'uuid:1']);
    expect([
      findings(descriptions('rdf:about=""', 'rdf:about="uuid:1"')),
      findings(descriptions('about="uuid:1"')),
      findings(descriptions('rdf:about="uuid:1"', 'rdf:about="uuid:2"')),
    ]).toStrictEqual([[], ['rdf-about-unprefixed'], ['rdf-about-mismatch']]);
  });

  it('reports duplicate properties and packets not in UTF-8', () => {
    const duplicated = packet(`<rdf:Description ${PDF} pdf:Producer="A"/><rdf:Description ${PDF}><pdf:Producer>B</pdf:Producer></rdf:Description>`);
    const utf16 = utf16Packet(packet(''));
    expect([findings(duplicated), encodingFindings(utf16)]).toStrictEqual([['duplicate-property'], ['utf-16be', 'xmp-not-utf8']]);
  });

  it('refuses a packet above the token cap passed to readXmp', () => {
    const text = packet(`<rdf:Description xmlns:p="urn:p">${'<p:x/>'.repeat(8193)}</rdf:Description>`);
    expect(readXmp(new TextEncoder().encode(text), 8192)).toStrictEqual({ ok: false, reason: 'too-many-tokens' });
  });

  it('reports one finding for repeated duplicates of the same property', () => {
    const text = packet(`<rdf:Description ${PDF}>${'<pdf:Producer>P</pdf:Producer>'.repeat(4)}</rdf:Description>`);
    expect(findings(text)).toStrictEqual(['duplicate-property']);
  });

  it('refuses packets that are not well-formed, not decodable, or not the RDF subset XMP uses', () => {
    expect([
      refusal(packet('<rdf:Description>')),
      refusal('<!DOCTYPE x><x/>'),
      refusal('<a/>'),
      refusal(`<a>${packet('')}${packet('')}</a>`.replaceAll(/<\?xpacket[^?]*\?>/gu, '')),
      refusal(packet('<rdf:Bag/>')),
      refusal(packet('text')),
      refusal(packet('<rdf:Description><u:a/></rdf:Description>')),
      refusal(packet(`<rdf:Description xmlns:q=""/>`)),
      refusal(packet(`<rdf:Description xmlns=""/>`)),
      readXmp(Uint8Array.of(0x3c, 0xff)),
    ]).toStrictEqual([
      'not-well-formed',
      'doctype',
      'no-rdf',
      'multiple-rdf',
      'not-xmp',
      'not-xmp',
      'unbound-prefix',
      'not-well-formed',
      undefined,
      { ok: false, reason: 'undecodable' },
    ]);
  });

  it('refuses reserved namespace rebinding and malformed qualified names', () => {
    const cases = [
      `<rdf:RDF xmlns:rdf="${RDF_NAMESPACE}" xmlns:xml="urn:evil"/>`,
      `<rdf:RDF xmlns:rdf="${RDF_NAMESPACE}" xmlns:xmlns="urn:evil"/>`,
      `<rdf:RDF xmlns:rdf="${RDF_NAMESPACE}" xmlns:p="http://www.w3.org/XML/1998/namespace"/>`,
      // Namespaces in XML 1.0, 3: "Other prefixes MUST NOT be bound to this namespace name" for the XML namespace, and no prefix may be bound to the xmlns one, nor the default namespace to either.
      `<rdf:RDF xmlns:rdf="${RDF_NAMESPACE}" xmlns:p="http://www.w3.org/2000/xmlns/"/>`,
      `<rdf:RDF xmlns:rdf="${RDF_NAMESPACE}" xmlns="http://www.w3.org/XML/1998/namespace"/>`,
      `<rdf:RDF xmlns:rdf="${RDF_NAMESPACE}" xmlns="http://www.w3.org/2000/xmlns/"/>`,
      `<rdf:RDF xmlns:rdf="${RDF_NAMESPACE}"><rdf:Description><p:x:y xmlns:p="urn:p"/></rdf:Description></rdf:RDF>`,
    ];
    expect(cases.map(value => refusal(value))).toStrictEqual(Array.from({ length: 7 }, () => 'not-well-formed'));
  });

  // Namespaces in XML 1.0, 6.3: no element may have two attributes with the same expanded name, and 6.2 puts an unprefixed attribute in no namespace.
  it('refuses two attributes with the same expanded name and accepts attributes whose expanded names differ', () => {
    const cases = [
      packet(`<rdf:Description xmlns:a="urn:x" xmlns:b="urn:x" a:p="1" b:p="2"/>`),
      packet(`<rdf:Description xmlns:a="urn:x"><a:q xmlns:b="urn:x" a:p="1" b:p="2"/></rdf:Description>`),
      packet(`<rdf:Description xmlns:a="urn:x" xmlns:b="urn:" a:p="1" b:xp="2"/>`),
      packet(`<rdf:Description xmlns:a="urn:x" xmlns:b="urn:y" a:p="1" b:p="2"/>`),
      packet(`<rdf:Description xmlns="urn:x" xmlns:a="urn:x" p="1" a:p="2"/>`),
    ];
    expect(cases.map(value => refusal(value))).toStrictEqual(['not-well-formed', 'not-well-formed', undefined, undefined, undefined]);
  });

  it.each([
    ['UTF-16BE', [0xfe, 0xff], utf16be],
    ['UTF-32BE', [0x00, 0x00, 0xfe, 0xff], utf32be],
  ])('gives spans in the bytes of a %s packet with an astral character', (_name, mark, encode) => {
    const bytes = Uint8Array.from([
      ...mark,
      ...encode(packet(`<rdf:Description rdf:about="" ${PDF} pdf:Producer="\u{20BB7}"><pdf:Keywords>\u{20BB7}山</pdf:Keywords></rdf:Description>`)),
    ]);
    const result = readXmp(bytes);
    const spans = result.ok ? result.packet.properties.map(property => [...bytes.subarray(property.span.start, property.span.end)]) : [];
    expect(spans).toStrictEqual([encode('pdf:Producer="\u{20BB7}"'), encode('<pdf:Keywords>\u{20BB7}山</pdf:Keywords>')]);
  });

  it('gives an attribute property the language of its rdf:Description and reads a bag', () => {
    const text = packet(
      `<rdf:Description rdf:about="" ${PDF} ${DC} xml:lang="fr" pdf:Producer="P"><dc:subject><rdf:Bag><rdf:li>a</rdf:li></rdf:Bag></dc:subject></rdf:Description>`,
    );
    expect(summary(text)).toStrictEqual([
      ['http://ns.adobe.com/pdf/1.3/Producer', 'attribute', { kind: 'text', text: 'P', language: 'fr' }],
      ['http://purl.org/dc/elements/1.1/subject', 'element', { kind: 'array', type: 'Bag', items: [{ text: 'a', language: 'fr' }] }],
    ]);
  });

  // XMP Part 1 7.5 and 7.7: only an array of rdf:li items with simple values, or a URI given by rdf:resource alone on an empty element, is read; anything else is kept as opaque.
  it.each([
    ['an array with an item that is not rdf:li', '<dc:subject><rdf:Bag><dc:x>a</dc:x></rdf:Bag></dc:subject>'],
    ['an array item with nested elements', '<dc:subject><rdf:Bag><rdf:li><dc:x>a</dc:x></rdf:li></rdf:Bag></dc:subject>'],
    ['an array beside text', '<dc:subject>text<rdf:Bag><rdf:li>a</rdf:li></rdf:Bag></dc:subject>'],
    ['a resource with text', '<dc:subject rdf:resource="urn:x">text</dc:subject>'],
    ['a resource with another attribute', '<dc:subject rdf:resource="urn:x" dc:other="y"/>'],
  ])('keeps %s as opaque', (_name, property) => {
    expect(summary(packet(`<rdf:Description rdf:about="" ${DC}>${property}</rdf:Description>`))).toStrictEqual([
      ['http://purl.org/dc/elements/1.1/subject', 'element', { kind: 'opaque' }],
    ]);
  });
});
