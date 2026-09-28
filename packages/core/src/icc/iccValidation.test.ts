import { describe, expect, it } from 'vitest';

import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { parseIccProfile } from './iccProfile.ts';

const base = (size = 132): Uint8Array => {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  bytes[8] = 4;
  bytes.set(new TextEncoder().encode('mntrRGB XYZ '), 12);
  bytes.set(new TextEncoder().encode('acsp'), 36);
  return bytes;
};

const oneTag = (name: string, dataType: string, size = 8): Uint8Array => {
  const bytes = base(144 + size);
  const view = new DataView(bytes.buffer);
  view.setUint32(128, 1);
  bytes.set(new TextEncoder().encode(name), 132);
  view.setUint32(136, 144);
  view.setUint32(140, size);
  bytes.set(new TextEncoder().encode(dataType), 144);
  return bytes;
};

const twoTags = (): Uint8Array => {
  const bytes = base(172);
  const view = new DataView(bytes.buffer);
  view.setUint32(128, 2);
  bytes.set(new TextEncoder().encode('rTRC'), 132);
  view.setUint32(136, 156);
  view.setUint32(140, 16);
  bytes.set(new TextEncoder().encode('gTRC'), 144);
  view.setUint32(148, 156);
  view.setUint32(152, 16);
  bytes.set(new TextEncoder().encode('curv'), 156);
  return bytes;
};

const reason = (bytes: Uint8Array): string => {
  try {
    parseIccProfile(bytes);
    return 'accepted';
  } catch (error) {
    if (error instanceof InvalidProfileError) return error.reason;
    if (error instanceof UnsupportedFeatureError) return error.reason ?? 'unsupported';
    if (error instanceof ResourceLimitError) return 'resource-limit';
    return 'other';
  }
};

describe('malformed icc profiles', () => {
  it('classifies truncated and malformed ICC headers', () => {
    expect(reason(new Uint8Array(131))).toBe('truncated');
    const signature = base();
    signature[36] = 0;
    expect(reason(signature)).toBe('bad-signature');
    const size = base();
    new DataView(size.buffer).setUint32(0, 500);
    expect(reason(size)).toBe('size-mismatch');
    const version = base();
    version[8] = 5;
    expect(reason(version)).toBe('icc-version-5');
  });

  it('classifies unknown ICC header values', () => {
    const profileClass = base();
    profileClass[12] = 0;
    expect(reason(profileClass)).toBe('unknown-class');
    const space = base();
    space[16] = 0;
    expect(reason(space)).toBe('unknown-color-space');
  });

  it('classifies broken tag tables and tag payloads', () => {
    const table = base();
    new DataView(table.buffer).setUint32(128, 1);
    expect(reason(table)).toBe('tag-table-out-of-bounds');
    const outside = oneTag('rTRC', 'curv');
    new DataView(outside.buffer).setUint32(136, 999);
    expect(reason(outside)).toBe('tag-out-of-bounds');
    const curve = oneTag('rTRC', 'curv', 12);
    new DataView(curve.buffer).setUint32(152, 100);
    expect(reason(curve)).toBe('bad-tag-data');
    expect(reason(oneTag('A2B0', 'XYZ '))).toBe('tag-type-mismatch');
  });

  it('rejects duplicate signatures and partial overlap but permits shared data', () => {
    const shared = twoTags();
    expect(reason(shared)).toBe('accepted');
    shared.set(new TextEncoder().encode('rTRC'), 144);
    expect(reason(shared)).toBe('duplicate-tag');
    shared.set(new TextEncoder().encode('gTRC'), 144);
    const view = new DataView(shared.buffer);
    view.setUint32(148, 160);
    view.setUint32(152, 12);
    expect(reason(shared)).toBe('tag-overlap');
  });

  it('reports misalignment and bounds CLUT allocation', () => {
    const misaligned = base(156);
    const view = new DataView(misaligned.buffer);
    view.setUint32(128, 1);
    misaligned.set(new TextEncoder().encode('zzzz'), 132);
    view.setUint32(136, 145);
    view.setUint32(140, 8);
    expect(parseIccProfile(misaligned).warnings.map(warning => warning.code)).toContain('tag-misaligned');
    const huge = oneTag('A2B0', 'mft2', 52);
    huge[152] = 15;
    huge[153] = 3;
    huge[154] = 255;
    const hugeView = new DataView(huge.buffer);
    hugeView.setUint16(192, 2);
    hugeView.setUint16(194, 2);
    expect(reason(huge)).toBe('resource-limit');
  });

  it('refuses preferred multi-process tags instead of silently using older LUT tags', () => {
    expect(reason(oneTag('D2B0', 'mpet'))).toBe('icc-mpet');
  });
});
