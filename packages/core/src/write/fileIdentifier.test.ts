import { describe, expect, it } from 'vitest';

import { md5 } from '../hash/md5.ts';

import { fileIdentifier } from './fileIdentifier.ts';

describe('pdf file identifiers', () => {
  it('hashes the body and trailer without ID in that order', () => {
    const body = ['%PDF-1.7\n', '1 0 obj\n<<>>\nendobj\n', '2 0 obj\nnull\nendobj\n'].map(chunk => new TextEncoder().encode(chunk));
    const trailer = new TextEncoder().encode('<</Size 3>>');
    const expected = md5(new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n2 0 obj\nnull\nendobj\n<</Size 3>>'));
    const pair = fileIdentifier(body, trailer);
    expect(pair).toStrictEqual([expected, expected]);
  });

  it('keeps a supplied pair', () => {
    const first = new Uint8Array(16).fill(1);
    const second = new Uint8Array(16).fill(2);
    expect(fileIdentifier([], new Uint8Array(), [first, second])).toStrictEqual([first, second]);
  });
});
