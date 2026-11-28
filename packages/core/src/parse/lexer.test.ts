import type { Token } from './lexer.ts';
import type { LoadWarning } from './loadWarning.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';

import { Lexer } from './lexer.ts';
import { WindowEndError } from './windowEndError.ts';

const encode = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

const ignore = (): void => {
  // Warnings are not under test here.
};

const lexer = (text: string, final = true): Lexer => new Lexer({ bytes: encode(text), base: 0, final }, 0, { warn: ignore, names: new Map() });

interface Lexed {
  tokens: Array<Token>;
  warnings: Array<LoadWarning>;
}

const lex = (text: string): Lexed => {
  const warnings: Array<LoadWarning> = [];
  const source = new Lexer({ bytes: encode(text), base: 0, final: true }, 0, {
    warn: warning => {
      warnings.push(warning);
    },
    names: new Map(),
  });
  const tokens: Array<Token> = [];
  for (let token = source.next(); token.kind !== 'eof'; token = source.next()) {
    tokens.push(token);
  }
  return { tokens, warnings };
};

const summary = (token: Token): number | string => {
  if (token.kind === 'integer' || token.kind === 'real') {
    return token.value;
  }
  if (token.kind === 'invalid') {
    return token.reason;
  }
  if (token.kind === 'keyword') {
    return token.keyword;
  }
  if (token.kind === 'name') {
    return `/${String.fromCodePoint(...token.bytes)}`;
  }
  if (token.kind === 'string') {
    return token.encoding;
  }
  return token.kind;
};

const summaries = (text: string): Array<number | string> => lex(text).tokens.map(token => summary(token));

const stringBytes = (text: string): Array<Array<number>> => {
  const strings: Array<Array<number>> = [];
  for (const token of lex(text).tokens) {
    if (token.kind === 'string') {
      strings.push([...token.bytes]);
    }
  }
  return strings;
};

const nameLengths = (text: string): Array<number> => lex(text).tokens.map(token => (token.kind === 'name' ? token.bytes.length : -1));

const sameNameArray = (left: Token, right: Token): boolean => left.kind === 'name' && right.kind === 'name' && left.bytes === right.bytes;

describe('pdf lexer', () => {
  it('reads the integer and real forms of 7.3.3', () => {
    expect(summaries('123 43445 +17 -98 0')).toStrictEqual([123, 43_445, 17, -98, 0]);
    expect(summaries('34.5 -3.62 +123.6 4. -.002 0.0 .5')).toStrictEqual([34.5, -3.62, 123.6, 4, -0.002, 0, 0.5]);
    expect(lex('4. 4').tokens.map(token => token.kind)).toStrictEqual(['real', 'integer']);
  });

  it('reads negative zero as zero', () => {
    const values = lex('-0 -0.0').tokens.map(token => (token.kind === 'integer' || token.kind === 'real' ? [token.kind, Object.is(token.value, 0)] : []));
    expect(values).toStrictEqual([
      ['integer', true],
      ['real', true],
    ]);
  });

  it('keeps malformed numbers as invalid tokens instead of inventing values', () => {
    expect(summaries('--5 1.2.3 3e2 - . +')).toStrictEqual(Array.from({ length: 6 }, () => 'malformed-number'));
    expect(summaries('9007199254740991 9007199254740992 9007199254740993 -9007199254740993')).toStrictEqual([
      9_007_199_254_740_991,
      'integer-out-of-range',
      'integer-out-of-range',
      'integer-out-of-range',
    ]);
    expect(summaries(`1${'0'.repeat(400)}.0`)).toStrictEqual(['real-out-of-range']);
    expect(lex(' --300 ').tokens).toStrictEqual([{ kind: 'invalid', reason: 'malformed-number', start: 1, end: 6 }]);
  });

  it('recognises keywords and reports other regular runs as operators', () => {
    expect(summaries('true false null obj endobj stream endstream R xref trailer startxref BT Tf')).toStrictEqual([
      'true',
      'false',
      'null',
      'obj',
      'endobj',
      'stream',
      'endstream',
      'R',
      'xref',
      'trailer',
      'startxref',
      'other',
      'other',
    ]);
  });

  it('decodes names with number-sign escapes and the empty name', () => {
    expect(summaries('/Name1 /A#20B /#23 / /a#2F /a#2f')).toStrictEqual(['/Name1', '/A B', '/#', '/', '/a/', '/a/']);
    expect(lex('/Type/Page').tokens.map(token => [token.start, token.end])).toStrictEqual([
      [0, 5],
      [5, 10],
    ]);
  });

  it('keeps malformed name escapes, null bytes and long names with warnings', () => {
    const text = `/A#4 /B#G1 /C#00 /${'x'.repeat(128)}`;
    expect(nameLengths(text)).toStrictEqual([3, 4, 2, 128]);
    expect(lex(text).warnings.map(warning => [warning.code, warning.offset])).toStrictEqual([
      ['malformed-name-escape', 2],
      ['malformed-name-escape', 7],
      ['name-contains-null', 11],
      ['name-too-long', 17],
    ]);
    // Annex C, Table C.1 limits the decoded name to 127 bytes, not its spelling: the second name is 129 bytes long as written.
    const atLimit = `/${'x'.repeat(127)} /#41${'x'.repeat(126)}`;
    expect([nameLengths(atLimit), lex(atLimit).warnings]).toStrictEqual([[127, 127], []]);
  });

  it('reports warning offsets in the source, not in the window', () => {
    const warnings: Array<LoadWarning> = [];
    const source = new Lexer({ bytes: encode(`/A#4 /${'x'.repeat(128)}`), base: 100, final: true }, 0, {
      warn: warning => {
        warnings.push(warning);
      },
      names: new Map(),
    });
    source.next();
    source.next();
    expect(warnings.map(warning => [warning.code, warning.offset])).toStrictEqual([
      ['malformed-name-escape', 102],
      ['name-too-long', 105],
    ]);
  });

  it('interns identical names and only those', () => {
    const source = lexer('/Type /Type /Typf');
    const [first, second, third] = [source.next(), source.next(), source.next()];
    expect([sameNameArray(first, second), sameNameArray(first, third)]).toStrictEqual([true, false]);
  });

  it('decodes the escapes of Table 3 and ignores a backslash before any other byte', () => {
    expect(stringBytes(String.raw`(\n\r\t\b\f\(\)\\\q)`)).toStrictEqual([[0x0a, 0x0d, 0x09, 0x08, 0x0c, 0x28, 0x29, 0x5c, 0x71]]);
    expect(stringBytes(String.raw`(\0053 \053 \53 \777 \7)`)).toStrictEqual([[5, 0x33, 0x20, 0x2b, 0x20, 0x2b, 0x20, 0xff, 0x20, 7]]);
    // 8 is not an octal digit, so it ends the escape and stays in the string.
    expect(stringBytes(String.raw`(\18)`)).toStrictEqual([[0x01, 0x38]]);
  });

  it('keeps balanced parentheses and normalises line ends in literal strings', () => {
    expect(stringBytes('(a(b)c)')).toStrictEqual([[0x61, 0x28, 0x62, 0x29, 0x63]]);
    expect(stringBytes('(a\r\nb\rc\nd)')).toStrictEqual([[0x61, 0x0a, 0x62, 0x0a, 0x63, 0x0a, 0x64]]);
    expect(stringBytes('(a\\\r\nb\\\rc\\\nd)')).toStrictEqual([[0x61, 0x62, 0x63, 0x64]]);
    expect(lex('(x) (y)').tokens.map(token => [token.start, token.end])).toStrictEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it('reads hexadecimal strings with white space and an odd final digit', () => {
    expect(stringBytes('<901FA3> < 90 1f\nA >')).toStrictEqual([
      [0x90, 0x1f, 0xa3],
      [0x90, 0x1f, 0xa0],
    ]);
    expect(lex('<> ()').tokens.map(token => summary(token))).toStrictEqual(['hex', 'literal']);
  });

  // ISO 32000-1:2008, 7.3.4.3: a hexadecimal string holds the digits 0-9 and A-F or a-f.
  it('reads every hexadecimal digit in either case', () => {
    expect(stringBytes('<0123456789> <abcdef> <ABCDEF>')).toStrictEqual([
      [0x01, 0x23, 0x45, 0x67, 0x89],
      [0xab, 0xcd, 0xef],
      [0xab, 0xcd, 0xef],
    ]);
  });

  it.each(['/', ':', '@', 'G', '`', 'g'])('rejects %s, one past a hexadecimal digit range', character => {
    const source = `<0${character}>`;
    expect(() => lex(source)).toThrow(ParseError);
    expect(() => lex(source)).toThrow(expect.objectContaining({ offset: 2 }));
    expect(() => lex(source)).toThrow(/digit/);
  });

  it.each([
    ['an unterminated literal string', ' (abc', 1, [/unterminated/, /literal/]],
    ['a literal string ending in a backslash', '(a\\', 0, [/unterminated/, /literal/]],
    ['an unterminated hexadecimal string', '<12', 0, [/unterminated/, /hexadecimal/]],
    ['an invalid hexadecimal digit', '<12G4>', 3, [/digit/]],
  ] as const)('rejects %s at its offset', (_, source, offset, words) => {
    // ParseError carries no reason for PDF syntax, so the words that name the kind of failure and the failing construct stand in for one.
    expect(() => lex(source)).toThrow(ParseError);
    expect(() => lex(source)).toThrow(expect.objectContaining({ offset }));
    for (const word of words) {
      expect(() => lex(source)).toThrow(word);
    }
  });

  it('skips comments as white space and reads delimiters', () => {
    expect(summaries('abc% comment ( /% ) blah\n123 [ ] << >> { } ) >')).toStrictEqual([
      'other',
      123,
      'arrayOpen',
      'arrayClose',
      'dictionaryOpen',
      'dictionaryClose',
      'stray-delimiter',
      'stray-delimiter',
      'stray-delimiter',
      'stray-delimiter',
    ]);
    expect(summaries('% (unbalanced\n(% not a comment)')).toStrictEqual(['literal']);
    expect(summaries('1%x\r2')).toStrictEqual([1, 2]);
  });

  it('peeks without consuming and seeks to an offset', () => {
    const source = lexer('1 0 R');
    source.next();
    const peeked = source.peek();
    expect([source.position, peeked]).toStrictEqual([1, { kind: 'integer', value: 0, start: 2, end: 3 }]);
    expect(source.peek()).toBe(source.next());
    source.seek(4);
    expect(source.next()).toStrictEqual({ kind: 'keyword', keyword: 'R', start: 4, end: 5 });
    expect(source.next()).toStrictEqual({ kind: 'eof', start: 5, end: 5 });
  });

  it('peeks two tokens ahead, reading each once, and forgets both on seek', () => {
    const warnings: Array<LoadWarning> = [];
    const source = new Lexer({ bytes: encode('/A#zz /B#zz 3 4'), base: 0, final: true }, 0, {
      warn: warning => {
        warnings.push(warning);
      },
      names: new Map(),
    });
    expect([summary(source.peekSecond()), source.position]).toStrictEqual(['/B#zz', 0]);
    expect([summary(source.next()), summary(source.next()), summary(source.next())]).toStrictEqual(['/A#zz', '/B#zz', 3]);
    expect(warnings.map(warning => warning.offset)).toStrictEqual([2, 8]);
    const seeking = lexer('1 2 3 4');
    seeking.peekSecond();
    seeking.seek(4);
    expect([summary(seeking.next()), summary(seeking.next())]).toStrictEqual([3, 4]);
  });

  it('asks for more bytes when a token reaches the end of a window that is not the end of the source', () => {
    const source = lexer('12 34', false);
    expect(source.next()).toMatchObject({ kind: 'integer', value: 12 });
    expect(() => source.next()).toThrow(WindowEndError);
    const commented = lexer('12 % comment', false);
    expect(commented.next()).toMatchObject({ kind: 'integer', value: 12 });
    expect(() => commented.next()).toThrow(WindowEndError);
  });

  it.each([
    ['a literal string', '(abc'],
    ['a hexadecimal string', '<12'],
    ['a name', '/Name'],
    ['a lone less-than sign', '<'],
    ['an octal escape after one digit', String.raw`(\1`],
  ])('asks for more bytes when %s reaches the end of a window', (_, source) => {
    expect(() => lexer(source, false).next()).toThrow(WindowEndError);
  });
});
