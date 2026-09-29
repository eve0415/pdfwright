import { describe, expect, it } from 'vitest';

import { preservePagePieceData } from './pieceInfoExample.ts';

describe('page-piece example', () => {
  it('keeps application data through a page edit', () => {
    const result = preservePagePieceData();
    expect([result.retained, result.saved.mode]).toStrictEqual([true, 'incremental']);
  });
});
