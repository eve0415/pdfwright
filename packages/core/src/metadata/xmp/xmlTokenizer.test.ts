import type { XmlAttribute, XmlToken } from './xmlTokenizer.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decodeXml, tokenizeXml, visitXml } from './xmlTokenizer.ts';

const tokensOf = (text: string): ReadonlyArray<XmlToken> => {
  const result = tokenizeXml(text);
  return result.ok ? result.tokens : [];
};

const characterData = (tokens: ReadonlyArray<XmlToken>): Array<string> =>
  tokens.flatMap(token => (token.kind === 'text' || token.kind === 'cdata' ? [token.text] : []));

const attributeValues = (tokens: ReadonlyArray<XmlToken>): Array<ReadonlyArray<XmlAttribute>> =>
  tokens.flatMap(token => (token.kind === 'start' ? [token.attributes] : []));

const instructions = (tokens: ReadonlyArray<XmlToken>): Array<Array<string>> =>
  tokens.flatMap(token => (token.kind === 'pi' ? [[token.target, token.content]] : []));

const refusal = (text: string): string | undefined => {
  const result = tokenizeXml(text);
  return result.ok ? undefined : result.reason;
};

const kinds = (text: string): ReadonlyArray<string> => {
  const result = tokenizeXml(text);
  return result.ok ? result.tokens.map(token => token.kind) : [result.reason];
};

const nested = (depth: number): string => `${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`;

const attributes = (count: number): string => `<a ${Array.from({ length: count }, (_, index) => `b${String(index)}="1"`).join(' ')}/>`;

const encodeUnits = (text: string, bigEndian: boolean, width: 2 | 4): Uint8Array => {
  const bytes: Array<number> = [];
  for (const character of `\u{FEFF}${text}`) {
    const code = character.codePointAt(0) ?? 0;
    const units = width === 4 || code < 0x1_00_00 ? [code] : [0xd8_00 + Math.floor((code - 0x1_00_00) / 1024), 0xdc_00 + ((code - 0x1_00_00) % 1024)];
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
  it('visits tokens in order with the same limit and refusal semantics', () => {
    const visitedKinds: Array<string> = [];
    const result = visitXml(
      '<a><b/>text</a>',
      token => {
        visitedKinds.push(token.kind);
      },
      { maxDepth: 64, maxAttributes: 256, maxTokens: 4 },
    );
    const refusedKinds: Array<string> = [];
    const refused = visitXml(
      '<a><b/>text</a>',
      token => {
        refusedKinds.push(token.kind);
      },
      { maxDepth: 64, maxAttributes: 256, maxTokens: 3 },
    );
    expect([result, visitedKinds, refused, refusedKinds]).toStrictEqual([
      { ok: true },
      ['start', 'start', 'text', 'end'],
      { ok: false, reason: 'too-many-tokens', offset: 15 },
      ['start', 'start', 'text', 'end'],
    ]);
  });

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

  it('ignores what follows the packet trailer after the root element', () => {
    expect(kinds('<a/><?xpacket end="w"?>\u{0}\u{0}junk</b>')).toStrictEqual(['start', 'pi']);
    expect(kinds('<a><?xpacket end="w"?></a>\u{0}')).toStrictEqual(['invalid-character']);
    expect(kinds('<a>\u{0}</a><?xpacket end="w"?>')).toStrictEqual(['invalid-character']);
    expect(kinds('<a><!-- \u{0} --></a><?xpacket end="w"?>')).toStrictEqual(['invalid-character']);
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

describe('refusing truncated and misplaced markup', () => {
  // XML 1.0, 2.5, 2.6, 2.7 and 3.1: a comment, processing instruction, CDATA section or attribute value must be closed, and only one root element, with nothing but white space, comments and processing instructions around it, makes a document.
  it.each([
    ['an unterminated comment after the root', '<a/><!-- x'],
    ['an unterminated processing instruction after the root', '<a/><?p x'],
    ['an unterminated CDATA section', '<a><![CDATA[x</a>'],
    ['an unterminated attribute value', '<a b="1/>'],
    ['an end tag before the root', '</a><a/>'],
    ['CDATA outside the root', '<![CDATA[x]]><a/>'],
    ['a markup declaration inside the root', '<a><!ELEMENT x></a>'],
    ['a character reference without digits', '<a>&#;</a>'],
    ['a hexadecimal character reference without digits', '<a>&#x;</a>'],
    ['a character reference with a letter after its digits', '<a>&#65x;</a>'],
  ])('refuses %s as not well-formed', (_name, text) => {
    expect(refusal(text)).toBe('not-well-formed');
  });

  // XML 1.0, 2.2, production [2] Char: a reference must name a character no greater than U+10FFFF.
  it('refuses a decimal character reference too large for any character', () => {
    expect(refusal('<a>&#99999999999999999999;</a>')).toBe('invalid-character');
  });
});

describe('detecting UTF-32 without a byte-order mark', () => {
  // XML 1.0, Appendix F.1: without a byte-order mark, 00 00 00 3C and 3C 00 00 00 are the first "<" in UTF-32.
  it.each([
    ['big-endian', true, 'utf-32be'],
    ['little-endian', false, 'utf-32le'],
  ])('decodes %s UTF-32 as %s', (_name, bigEndian, encoding) => {
    expect(decodedText(encodeUnits('<a>山</a>', bigEndian, 4).subarray(4))).toBe(`${encoding}:<a>山</a>`);
  });
});

interface Tree {
  readonly name: string;
  readonly children: ReadonlyArray<Tree | string>;
}

const written = (tree: Tree): string =>
  tree.children.length === 0
    ? `<${tree.name}/>`
    : `<${tree.name}>${tree.children.map(child => (typeof child === 'string' ? child : written(child))).join('')}</${tree.name}>`;

describe('properties', () => {
  const { tree } = fc.letrec<{ tree: Tree; node: Tree | string }>(arbitrary => ({
    tree: fc.record({ name: fc.constantFrom('a', 'b', 'p:c'), children: fc.array(arbitrary('node'), { maxLength: 4 }) }),
    node: fc.oneof({ depthSize: 'small', withCrossShrink: true }, fc.constantFrom('x', 'y z', '&amp;', '&#65;'), arbitrary('tree')),
  }));

  it('balances start and end tokens and covers a generated document with its spans', () => {
    fc.assert(
      fc.property(tree, value => {
        const text = written(value);
        const result = tokenizeXml(text);
        const tokens = result.ok ? result.tokens : [];
        const open: Array<string> = [];
        let balanced = true;
        for (const token of tokens) {
          if (token.kind === 'start' && !token.selfClosing) {
            open.push(token.name);
          } else if (token.kind === 'end') {
            balanced &&= open.pop() === token.name;
          }
        }
        expect([result.ok, balanced, open, tokens.map(token => text.slice(token.span.start, token.span.end)).join('')]).toStrictEqual([true, true, [], text]);
      }),
    );
  });
});
