import { describe, expect, it } from 'vitest';

import { parseIccProfile } from './iccProfile.ts';

describe('icc profile basic tags', () => {
  it('exposes gray TRC and media white point from a complete profile', () => {
    const bytes = new Uint8Array(192);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    bytes[8] = 4;
    bytes.set(new TextEncoder().encode('mntrGRAYXYZ '), 12);
    bytes.set(new TextEncoder().encode('acsp'), 36);
    view.setUint32(128, 2);
    bytes.set(new TextEncoder().encode('kTRC'), 132);
    view.setUint32(136, 156);
    view.setUint32(140, 16);
    bytes.set(new TextEncoder().encode('wtpt'), 144);
    view.setUint32(148, 172);
    view.setUint32(152, 20);
    bytes.set(new TextEncoder().encode('curv'), 156);
    view.setUint32(164, 1);
    view.setUint16(168, 0x0200);
    bytes.set(new TextEncoder().encode('XYZ '), 172);
    view.setInt32(180, 0x0000f6d6);
    view.setInt32(184, 0x00010000);
    view.setInt32(188, 0x0000d32d);
    const profile = parseIccProfile(bytes);
    expect(profile.trc).toStrictEqual({ gray: { kind: 'gamma', gamma: 2 } });
    expect(profile.mediaWhitePoint).toStrictEqual({ x: 0xf6d6 / 65536, y: 1, z: 0xd32d / 65536 });
    expect(profile.identity).toHaveLength(16);
  });
});
