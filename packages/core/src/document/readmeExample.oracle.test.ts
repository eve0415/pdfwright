import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const codeBlock = (readme: string, heading = '## Writing a print page'): string => {
  const section = readme.indexOf(heading);
  const opener = readme.indexOf('```ts\n', section);
  const start = opener + 6;
  const end = readme.indexOf('```', start);
  if (section === -1 || opener === -1 || end === -1) throw new Error(`README code block under ${heading} is missing`);
  return readme.slice(start, end);
};

describe('readme example', () => {
  it('matches the runnable TypeScript file exactly', async () => {
    const readme = await readFile(new URL('../../../../README.md', import.meta.url), 'utf8');
    const source = await readFile(new URL('readmeExample.ts', import.meta.url), 'utf8');
    expect(codeBlock(readme)).toBe(source);
  });

  it('shows the editing example exactly as the runnable file', async () => {
    const readme = await readFile(new URL('../../../../README.md', import.meta.url), 'utf8');
    const source = await readFile(new URL('editExample.ts', import.meta.url), 'utf8');
    expect(codeBlock(readme, '## Editing an existing file')).toBe(source);
  });
});
