import { describe, expect, it } from 'vitest';

import { lockedManualCheckModel, manualCheckModel } from './manualCheckModel.ts';

const raster = (name: string, index: number) => {
  const layer = manualCheckModel().layers.find(value => value.name === name);
  const image = layer?.items.flatMap(item => (item.kind === 'clipGroup' ? item.items.filter(child => child.kind === 'raster') : [])).at(index);
  if (image === undefined) throw new Error('raster is missing');
  return image;
};

describe('manual-check raster alpha', () => {
  it('gives the artwork and spot plates the same feathered shape', () => {
    const design = raster('Design', 0);
    const white = raster('White', 0);
    const primer = raster('Primer 30%', 0);
    expect(white.alpha).toStrictEqual(design.alpha);
    expect(primer.alpha).toStrictEqual(design.alpha);
    expect(new Set(design.alpha).size).toBeGreaterThan(2);
    expect([design.alpha[0], design.alpha[10 * design.width + 15]]).toStrictEqual([0, 255]);
  });

  it('includes a small horizontal alpha ramp', () => {
    const ramp = raster('Design', 1);
    expect(ramp.alpha[0]).toBe(0);
    expect(ramp.alpha[ramp.width - 1]).toBe(255);
    expect([...ramp.alpha.subarray(0, ramp.width)]).toStrictEqual([...ramp.alpha.subarray(ramp.width)]);
  });
});

describe('locked manual-check artwork', () => {
  it('adds a locked layer, locked object, and locked hidden layer', () => {
    const standard = manualCheckModel();
    const locked = lockedManualCheckModel();
    expect(locked.layers.slice(0, standard.layers.length)).toStrictEqual(standard.layers);
    expect(locked.layers.slice(standard.layers.length)).toMatchObject([
      { name: 'Locked layer', locked: true, items: [{}] },
      { name: 'Locked object', items: [{ locked: true }] },
      { name: 'Locked and hidden', locked: true, visible: false, items: [{}] },
    ]);
  });
});
