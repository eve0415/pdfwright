import type { XmlAttribute, XmlToken } from './xmlTokenizer.ts';

import { describe, expect, it } from 'vitest';

import { decodeXml, tokenizeXml } from './xmlTokenizer.ts';

const tokensOf = (text: string): readonly XmlToken[] => {
  const result = tokenizeXml(text);
  return result.ok ? result.tokens : [];
};

const characterData = (tokens: readonly XmlToken[]): string[] => tokens.flatMap(token => (token.kind === 'text' || token.kind === 'cdata' ? [token.text] : []));

const attributeValues = (tokens: readonly XmlToken[]): (readonly XmlAttribute[])[] =>
  tokens.flatMap(token => (token.kind === 'start' ? [token.attributes] : []));

const instructions = (tokens: readonly XmlToken[]): string[][] => tokens.flatMap(token => (token.kind === 'pi' ? [[token.target, token.content]] : []));

const refusal = (text: string): string | undefined => {
  const result = tokenizeXml(text);
  return result.ok ? undefined : result.reason;
};

const kinds = (text: string): readonly string[] => {
  const result = tokenizeXml(text);
  return result.ok ? result.tokens.map(token => token.kind) : [result.reason];
};

const nested = (depth: number): string => `${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`;

const attributes = (count: number): string => `<a ${Array.from({ length: count }, (_, index) => `b${String(index)}="1"`).join(' ')}/>`;

const encodeUnits = (text: string, bigEndian: boolean, width: 2 | 4): Uint8Array => {
  const bytes: number[] = [];
  for (const character of `\u{FEFF}${text}`) {
    const code = character.codePointAt(0) ?? 0;
    const units = width === 4 || code < 0x10000 ? [code] : [0xd800 + Math.floor((code - 0x10000) / 1024), 0xdc00 + ((code - 0x10000) % 1024)];
    for (const unit of units) {
      const unitBytes = Array.from({ length: width }, (_, index) => Math.floor(unit / 256 ** (width - 1 - index)) % 256);
      bytes.push(...(bigEndian ? unitBytes : unitBytes.toReversed()));
    }
  }
  return Uint8Array.from(bytes);
};

const decodedText = (bytes: Uint8Array): string => {
  const result = decodeXml(bytes);
  return result.ok ? `${result.encoding}:${result.text}` : result.reason;
};

describe('the XML tokenizer', () => {
  it('reads elements, attributes, text, CDATA, comments and processing instructions with their spans', () => {
    const text = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:a b = 'c&amp;d'><!-- note --><e>f &lt;&#x41;&#66;&quot;</e><![CDATA[<g>]]><h/></x:a>\n<?xpacket end="w"?>`;
    const tokens = tokensOf(text);
    expect(tokens.map(token => [token.kind, text.slice(token.span.start, token.span.end)])).toStrictEqual([
      ['pi', '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'],
      ['start', "<x:a b = 'c&amp;d'>"],
      ['comment', '<!-- note -->'],
      ['start', '<e>'],
      ['text', 'f &lt;&#x41;&#66;&quot;'],
      ['end', '</e>'],
      ['cdata', '<![CDATA[<g>]]>'],
      ['start', '<h/>'],
      ['end', '</x:a>'],
      ['pi', '<?xpacket end="w"?>'],
    ]);
    expect(characterData(tokens)).toStrictEqual(['f <AB"', '<g>']);
    expect(
      attributeValues(tokens)
        .flat()
        .map(attribute => [attribute.name, attribute.value, text.slice(attribute.span.start, attribute.span.end)]),
    ).toStrictEqual([['b', 'c&d', "b = 'c&amp;d'"]]);
    expect(instructions(tokens)).toStrictEqual([
      ['xpacket', 'begin="" id="W5M0MpCehiHzreSzNTczkc9d"'],
      ['xpacket', 'end="w"'],
    ]);
  });

  it('normalizes line ends in text and white space in attribute values', () => {
    const tokens = tokensOf('<a b="1\t2\r\n3">x\r\ny\rz</a>');
    const values = attributeValues(tokens)
      .flat()
      .map(attribute => attribute.value);
    expect([...values, ...characterData(tokens)]).toStrictEqual(['1 2 3', 'x\ny\nz']);
  });

  it('refuses a DOCTYPE declaration and entities other than the predefined ones', () => {
    expect([
      refusal('<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>'),
      refusal('<!DOCTYPE a SYSTEM "file:///etc/passwd"><a/>'),
      refusal('<a>&nbsp;</a>'),
      refusal('<a b="&e;"/>'),
      refusal('<a>&#0;</a>'),
      refusal('<a>&#x110000;</a>'),
      refusal('<a>& b</a>'),
    ]).toStrictEqual(['doctype', 'doctype', 'undefined-entity', 'undefined-entity', 'invalid-character', 'invalid-character', 'not-well-formed']);
  });

  it('expands character references with any number of leading zeros', () => {
    expect(characterData(tokensOf('<a>&#x0000041;&#00000066;&#x00000000001F600;</a>'))).toStrictEqual(['AB\u{1F600}']);
    expect(refusal('<a>&#x0000110000;</a>')).toBe('invalid-character');
  });

  it('bounds nesting and attributes', () => {
    expect([refusal(nested(64)), refusal(nested(65)), refusal(attributes(256)), refusal(attributes(257))]).toStrictEqual([
      undefined,
      'too-deep',
      undefined,
      'too-many-attributes',
    ]);
    expect(tokenizeXml(nested(1_000_000))).toStrictEqual({ ok: false, reason: 'too-deep', offset: 192 });
  });

  it('refuses text that is not well-formed', () => {
    expect(
      [
        '<a></b>',
        '<a>',
        '<a/><b/>',
        'x<a/>',
        '<a b="1" b="2"/>',
        '<a b="<"/>',
        '<a b=1/>',
        '<a><!-- a -- b --></a>',
        '<a><!-- a ---></a>',
        '<a><!-----></a>',
        '',
        '<a>]]></a>',
        '<a\u{1}/>',
        '<a>\u{D800}</a>',
      ].map(text => refusal(text)),
    ).toStrictEqual([
      'not-well-formed',
      'not-well-formed',
      'not-well-formed',
      'not-well-formed',
      'not-well-formed',
      'not-well-formed',
      'not-well-formed',
      'not-well-formed',
      'not-well-formed',
      'not-well-formed',
      'not-well-formed',
      'not-well-formed',
      'invalid-character',
      'invalid-character',
    ]);
    expect(kinds('<a><!----><!-- - --></a>')).toStrictEqual(['start', 'comment', 'comment', 'end']);
  });

  it('allows white space, comments and processing instructions around the root element, after a leading byte-order mark', () => {
    expect(kinds('\u{FEFF}<?xml version="1.0"?>\n<!-- c --><a/>  \n\n<?p?>')).toStrictEqual(['pi', 'comment', 'start', 'pi']);
    expect(kinds(' \u{FEFF}<a/>')).toStrictEqual(['not-well-formed']);
  });
});

describe('decoding XML bytes', () => {
  it('decodes UTF-8 with and without a byte-order mark, keeping the mark in the text', () => {
    const encoder = new TextEncoder();
    expect([decodedText(encoder.encode('<a>日本</a>')), decodedText(encoder.encode('\u{FEFF}<a/>'))]).toStrictEqual(['utf8:<a>日本</a>', 'utf8:\u{FEFF}<a/>']);
  });

  it('decodes UTF-16 and UTF-32 in both byte orders by their byte-order mark', () => {
    const text = '<a>山\u{20BB7}</a>';
    expect([true, false].flatMap(bigEndian => [decodedText(encodeUnits(text, bigEndian, 2)), decodedText(encodeUnits(text, bigEndian, 4))])).toStrictEqual([
      `utf-16be:\u{FEFF}${text}`,
      `utf-32be:\u{FEFF}${text}`,
      `utf-16le:\u{FEFF}${text}`,
      `utf-32le:\u{FEFF}${text}`,
    ]);
  });

  it('detects UTF-16 without a byte-order mark by the bytes of the first processing instruction', () => {
    expect([decodedText(encodeUnits('<?a?><b/>', false, 2).subarray(2)), decodedText(encodeUnits('<?a?><b/>', true, 2).subarray(2))]).toStrictEqual([
      'utf-16le:<?a?><b/>',
      'utf-16be:<?a?><b/>',
    ]);
  });

  it('refuses bytes that are invalid in their encoding', () => {
    expect([
      decodedText(Uint8Array.of(0x3c, 0x61, 0xff, 0x2f, 0x3e)),
      decodedText(Uint8Array.of(0x00, 0x00, 0xfe, 0xff, 0x00, 0x11, 0x00, 0x00)),
      decodedText(Uint8Array.of(0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0xd8, 0x00)),
      decodedText(Uint8Array.of(0x00, 0x00, 0xfe, 0xff, 0x00, 0x00)),
      decodedText(Uint8Array.of(0xfe, 0xff, 0xd8, 0x00)),
    ]).toStrictEqual(['undecodable', 'undecodable', 'undecodable', 'undecodable', 'undecodable']);
  });
});
