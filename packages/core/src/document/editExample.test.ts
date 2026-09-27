import { describe, expect, it } from 'vitest';

import { addVarnishPlate } from './editExample.ts';
import { writePrintPage } from './readmeExample.ts';

describe('readme edit example', () => {
  it('adds a plate and a trim box as an incremental update', () => {
    const input = writePrintPage().toBytes();
    const { saved, differences } = addVarnishPlate(input);
    expect([saved.mode, saved.byteLength > input.length, differences.map(difference => difference.kind)]).toStrictEqual([
      'incremental',
      true,
      ['page-box', 'page-content', 'page-resources'],
    ]);
  });
});
