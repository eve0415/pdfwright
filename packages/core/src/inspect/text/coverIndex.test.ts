import { describe, expect, it } from 'vitest';

import { Clip, rectanglePath } from '../../content/clip.ts';
import { IDENTITY } from '../../content/matrix.ts';
import { ResourceLimitError } from '../../error/resourceLimitError.ts';

import { CoverIndex } from './coverIndex.ts';

describe('cover index', () => {
  it('does not repeat comparisons for identical fills', () => {
    const index = new CoverIndex({ left: 0, bottom: 0, right: 100, top: 100 }, 4000);
    const clip = Clip.NONE.intersect(rectanglePath([10, 10, 20, 20], IDENTITY), 'nonzero');
    for (let sequence = 0; sequence < 40_000; sequence++) {
      index.add({ rectangle: [0, 0, 100, 100], clip, sequence, context: { sources: [{ kind: 'page' }], colour: 'used' } });
    }
    const hidden = Array.from({ length: 200 }, () => index.hides(50, 50));
    expect([hidden.every(value => !value)]).toStrictEqual([true]);
  });

  it('omits wide fills from queries outside their coarse bands', () => {
    const index = new CoverIndex({ left: 0, bottom: 0, right: 100, top: 100 }, 4000);
    for (let sequence = 0; sequence < 2001; sequence++) {
      index.add({ rectangle: [10, 10, 90, 90], clip: Clip.NONE, sequence, context: { sources: [{ kind: 'page' }], colour: 'used' } });
    }
    const outside = Array.from({ length: 1000 }, () => index.hides(0, 0));
    expect([outside.every(value => !value), index.hides(50, 50)]).toStrictEqual([true, true]);
  });

  it('bounds comparisons when many large fills overlap a query but their clips exclude it', () => {
    const index = new CoverIndex({ left: 0, bottom: 0, right: 100, top: 100 }, 4000);
    const clip = Clip.NONE.intersect(rectanglePath([10, 10, 80, 80], IDENTITY), 'nonzero');
    for (let sequence = 0; sequence < 2001; sequence++) {
      index.add({ rectangle: [0, 0, 100 + sequence / 1_000_000, 100], clip, sequence, context: { sources: [{ kind: 'page' }], colour: 'used' } });
    }
    expect(() => {
      for (let query = 0; query < 2001; query++) index.hides(0, 0);
    }).toThrow(ResourceLimitError);
  });
});
