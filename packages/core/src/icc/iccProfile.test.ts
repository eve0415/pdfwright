import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../error/resourceLimitError.ts';

import { parseIccProfile } from './iccProfile.ts';

const sharedLutProfile = (): Uint8Array => {
  const offset = 204;
  const length = 48 + 3 * 256 + 2 ** 3 * 3 + 3 * 256;
  const bytes = new Uint8Array(offset + length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  bytes[8] = 2;
  bytes.set(new TextEncoder().encode('mntrRGB Lab '), 12);
  bytes.set(new TextEncoder().encode('acsp'), 36);
  view.setUint32(128, 6);
  for (let index = 0; index < 6; index++) {
    bytes.set(new TextEncoder().encode(index < 3 ? `A2B${index}` : `B2A${index - 3}`), 132 + index * 12);
    view.setUint32(136 + index * 12, offset);
    view.setUint32(140 + index * 12, length);
  }
  bytes.set(new TextEncoder().encode('mft1'), offset);
  bytes[offset + 8] = 3;
  bytes[offset + 9] = 3;
  bytes[offset + 10] = 2;
  return bytes;
};

describe('icc profile basic tags', () => {
  it('shares one decoded LUT across six intent tags', () => {
    const profile = parseIccProfile(sharedLutProfile());
    for (const intent of [0, 1, 2] as const) {
      expect(profile.deviceToPcs[intent]).toBe(profile.deviceToPcs[0]);
      expect(profile.pcsToDevice[intent]).toBe(profile.deviceToPcs[0]);
    }
    expect(profile.deviceToPcs[0]?.clut?.values).toBeInstanceOf(Uint8Array);
  });

  it('limits profile bytes before parsing and accepts an explicit larger limit', () => {
    const bytes = sharedLutProfile();
    expect(() => parseIccProfile(bytes, { maxIccProfileBytes: bytes.length - 1 })).toThrow(ResourceLimitError);
    expect(parseIccProfile(bytes, { maxIccProfileBytes: bytes.length }).header.size).toBe(bytes.length);
    expect(() => parseIccProfile(new Uint8Array(24 * 1024 * 1024 + 1))).toThrow(ResourceLimitError);
  });

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

  it('attaches a lut16 A2B tag with header-matching channel counts', () => {
    const bytes = new Uint8Array(224);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    bytes[8] = 2;
    bytes.set(new TextEncoder().encode('mntrGRAYLab '), 12);
    bytes.set(new TextEncoder().encode('acsp'), 36);
    view.setUint32(128, 1);
    bytes.set(new TextEncoder().encode('A2B0'), 132);
    view.setUint32(136, 144);
    view.setUint32(140, 80);
    bytes.set(new TextEncoder().encode('mft2'), 144);
    bytes[152] = 1;
    bytes[153] = 3;
    bytes[154] = 2;
    view.setUint16(192, 2);
    view.setUint16(194, 2);
    expect(parseIccProfile(bytes).deviceToPcs[0]?.clut?.outputChannels).toBe(3);
    bytes.set(new TextEncoder().encode('RGB '), 16);
    expect(() => parseIccProfile(bytes)).toThrow('channel count disagrees');
  });

  it('attaches an mAB pipeline to a v4 profile', () => {
    const bytes = new Uint8Array(212);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    bytes[8] = 4;
    bytes.set(new TextEncoder().encode('mntrRGB Lab '), 12);
    bytes.set(new TextEncoder().encode('acsp'), 36);
    view.setUint32(128, 1);
    bytes.set(new TextEncoder().encode('A2B0'), 132);
    view.setUint32(136, 144);
    view.setUint32(140, 68);
    bytes.set(new TextEncoder().encode('mAB '), 144);
    bytes[152] = 3;
    bytes[153] = 3;
    view.setUint32(156, 32);
    for (let index = 0; index < 3; index++) bytes.set(new TextEncoder().encode('curv'), 176 + index * 12);
    expect(parseIccProfile(bytes).deviceToPcs[0]?.kind).toBe('lutAtoB');
  });
});
