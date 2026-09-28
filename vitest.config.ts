import type { Runtime } from './tests/providedContext.ts';
import type { TestProjectInlineConfiguration } from 'vitest/config';

import { readFile } from 'node:fs/promises';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const include = ['packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'];
const oracleInclude = ['packages/*/src/**/*.oracle.test.ts'];

const project = (runtime: Runtime) => ({ name: runtime, include, exclude: oracleInclude, provide: { runtime } });

// Bun and Deno each run this config in their own process, and there the suite runs once, in that runtime.
// Everywhere else the config runs in Node, which hosts the Node, browser, workerd and oracle projects.
const projects = (): TestProjectInlineConfiguration[] => {
  if ('Bun' in globalThis) return [{ test: project('bun') }];
  if ('Deno' in globalThis) return [{ test: project('deno') }];
  return [
    { test: project('node') },
    { test: { name: 'oracle', include: oracleInclude, provide: { runtime: 'node' } } },
    {
      optimizeDeps: { include: ['fflate', 'pako'] },
      test: {
        ...project('browser'),
        browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: 'chromium' }] },
      },
    },
    {
      plugins: [cloudflareTest({ miniflare: { compatibilityDate: '2026-09-23', compatibilityFlags: [] } })],
      test: project('workers'),
    },
  ];
};

export default defineConfig({
  plugins: [
    {
      name: 'icc-fixture-bytes',
      async load(id: string): Promise<string | undefined> {
        const suffix = '?icc-bytes';
        if (!id.endsWith(suffix)) return undefined;
        const bytes = await readFile(id.slice(0, -suffix.length));
        return `export default Uint8Array.from(atob('${bytes.toString('base64')}'), character => character.charCodeAt(0));`;
      },
    },
  ],
  test: {
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    expect: { requireAssertions: true },
    sequence: { shuffle: true },
    projects: projects(),
  },
});
