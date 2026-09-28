import { describe, expect, it } from 'vitest';

import { InvalidProfileError } from '../error/invalidProfileError.ts';

import { readIccText } from './iccText.ts';

describe('icc text tags', () => {
  it('reads the invariant ASCII part of v2 desc and null-terminated text', () => {
    const desc = new Uint8Array(20);
    const view = new DataView(desc.buffer);
    desc.set(new TextEncoder().encode('desc'));
    view.setUint32(8, 5);
    desc.set(new TextEncoder().encode('Press'), 12);
    desc[16] = 0;
    expect(readIccText(desc, 0, desc.length)).toBe('Pres');
    const text = new Uint8Array(14);
    text.set(new TextEncoder().encode('text'));
    text.set(new TextEncoder().encode('Hello'), 8);
    expect(readIccText(text, 0, text.length)).toBe('Hello');
  });

  it('prefers en-US in a v4 mluc tag and checks string bounds', () => {
    const bytes = new Uint8Array(54);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('mluc'));
    view.setUint32(8, 2);
    view.setUint32(12, 12);
    bytes.set(new TextEncoder().encode('frFR'), 16);
    view.setUint32(20, 6);
    view.setUint32(24, 40);
    bytes.set(new TextEncoder().encode('enUS'), 28);
    view.setUint32(32, 8);
    view.setUint32(36, 46);
    bytes.set([0, 80, 0, 114, 0, 101], 40);
    bytes.set([0, 84, 0, 101, 0, 115, 0, 116], 46);
    expect(readIccText(bytes, 0, bytes.length)).toBe('Test');
    view.setUint32(36, 100);
    expect(() => readIccText(bytes, 0, bytes.length)).toThrow(InvalidProfileError);
  });
});
