import { describe, expect, it } from 'vitest';

import { createImageRegistry } from './imageRegistry.ts';

describe('image registry', () => {
  it('gives each pixel full tint', () => {
    expect(createImageRegistry().fullTint(2, 3)).toStrictEqual(new Uint8Array(6).fill(255));
  });

  it('returns the same samples for the same dimensions', () => {
    const registry = createImageRegistry();
    const first = registry.fullTint(2, 3);
    expect(registry.fullTint(2, 3)).toBe(first);
  });

  it('returns samples sized for each dimension pair', () => {
    const registry = createImageRegistry();
    registry.fullTint(2, 3);
    // 2 × 4 shares its width with 2 × 3 and 4 × 2 its height with 3 × 2, so a registry keyed by width or by height alone returns too few samples.
    expect([registry.fullTint(2, 4), registry.fullTint(3, 2), registry.fullTint(4, 2)]).toStrictEqual([
      new Uint8Array(8).fill(255),
      new Uint8Array(6).fill(255),
      new Uint8Array(8).fill(255),
    ]);
  });
});
