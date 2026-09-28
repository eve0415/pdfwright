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

const examples = [
  ['## Writing a print page', 'readmeExample.ts'],
  ['## Colorant names and overprint', 'colorantExample.ts'],
  ['## Page-piece data', 'pieceInfoExample.ts'],
  ['## Editing an existing file', 'editExample.ts'],
  ['### Checking the text of a proof', '../inspect/proofExample.ts'],
  ['## Setting metadata', '../metadata/metadataExample.ts'],
  ['## Colour conversion and PDF/X-4 checks', '../colorConvert/printConversionExample.ts'],
] as const;

describe('readme example', () => {
  it.each(examples)('shows the runnable source under %s', async (heading, file) => {
    const readme = await readFile(new URL('../../../../README.md', import.meta.url), 'utf8');
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    expect(codeBlock(readme, heading)).toBe(source);
  });

  it('covers every TypeScript code block', async () => {
    const readme = await readFile(new URL('../../../../README.md', import.meta.url), 'utf8');
    expect([...readme.matchAll(/^```ts$/gmu)]).toHaveLength(examples.length);
  });
});
