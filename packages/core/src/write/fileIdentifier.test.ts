import { describe, expect, it } from 'vitest';

import { md5 } from '../hash/md5.ts';

import { fileIdentifier } from './fileIdentifier.ts';

describe('pdf file identifiers', () => {
  it('hashes the body and trailer without ID in that order', () => {
    const body = new TextEncoder().encode('body');
    const trailer = new TextEncoder().encode('trailer');
    const expected = md5(new TextEncoder().encode('bodytrailer'));
    const pair = fileIdentifier(body, trailer);
    expect(pair).toStrictEqual([expected, expected]);
  });

  it('keeps a supplied pair', () => {
    const first = new Uint8Array(16).fill(1);
    const second = new Uint8Array(16).fill(2);
    expect(fileIdentifier(new Uint8Array(), new Uint8Array(), [first, second])).toStrictEqual([first, second]);
  });
});
