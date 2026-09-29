import { describe, expect, it } from 'vitest';

import { updateMetadata } from './metadataExample.ts';

describe('metadata example', () => {
  it('updates Info and XMP and saves identical bytes twice', () => {
    const result = updateMetadata();
    const before = result.before.properties.find(property => property.key === 'Title');
    const after = result.after.properties.find(property => property.key === 'Title');
    expect([before?.info, after?.info, after?.agreement, result.identicalBytes]).toStrictEqual(['Original title', 'Revised title', 'agree', true]);
  });
});
