import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

interface ExportEntry {
  readonly name: string;
  readonly source: URL;
}

const declarations = (index: string, root: URL): ExportEntry[] => {
  const entries: ExportEntry[] = [];
  const blocks = /export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'([^']+)'/gu;
  for (const match of index.matchAll(blocks)) {
    const [names, source] = match.slice(1);
    if (names === undefined || source === undefined) continue;
    for (const entry of names.split(',')) {
      const name = entry
        .trim()
        .split(/\s+as\s+/u)
        .at(-1);
      if (name !== undefined && name.length > 0) entries.push({ name, source: new URL(source, root) });
    }
  }
  return entries;
};

const hasDoc = async (entry: ExportEntry, depth = 0): Promise<boolean> => {
  if (depth >= 4) return false;
  const text = await readFile(entry.source, 'utf8');
  const reExport = new RegExp(`export\\s+(?:type\\s+)?\\{[^}]*\\b${entry.name}\\b[^}]*\\}\\s+from\\s+'([^']+)'`, 'u').exec(text);
  if (reExport?.[1] !== undefined) return hasDoc({ name: entry.name, source: new URL(reExport[1], entry.source) }, depth + 1);
  const declaration = new RegExp(`export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:type|interface|class|const|function|enum)\\s+${entry.name}\\b`, 'u').exec(text);
  if (declaration?.index === undefined) return false;
  const previous = text.slice(0, declaration.index).trimEnd();
  return previous.endsWith('*/') && previous.lastIndexOf('/**') > previous.lastIndexOf('*/', previous.length - 3);
};

const undocumented = async (index: string, root: URL): Promise<string[]> => {
  const checks = await Promise.all(declarations(index, root).map(async entry => ({ name: entry.name, documented: await hasDoc(entry) })));
  return checks.filter(check => !check.documented).map(check => check.name);
};

describe('core API docs', () => {
  it('documents each public export at its declaration', async () => {
    const indexUrl = new URL('../packages/core/src/index.ts', import.meta.url);
    const index = await readFile(indexUrl, 'utf8');
    await expect(undocumented(index, indexUrl)).resolves.toStrictEqual([]);
  });
});
