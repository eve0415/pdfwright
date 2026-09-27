import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const codeBlock = (readme: string): string => {
  const section = readme.indexOf('## Writing a print page');
  const opener = readme.indexOf('```ts\n', section);
  const start = opener + 6;
  const end = readme.indexOf('```', start);
  if (section === -1 || opener === -1 || end === -1) throw new Error('README print page code block is missing');
  return readme.slice(start, end);
};

describe('readme example', () => {
  it('matches the runnable TypeScript file exactly', async () => {
    const readme = await readFile(new URL('../../../../README.md', import.meta.url), 'utf8');
    const source = await readFile(new URL('readmeExample.ts', import.meta.url), 'utf8');
    expect(codeBlock(readme)).toBe(source);
  });
});
