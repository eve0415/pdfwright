import type { Runtime } from './providedContext.ts';

import { readConfigureGlobal } from 'fast-check';
import { describe, expect, inject, it } from 'vitest';

// Vite expands both globs when it transforms this file, so a package added later is loaded here too.
const manifests = import.meta.glob('../packages/*/package.json', { eager: true });
const entries = import.meta.glob('../packages/*/src/index.ts', { eager: true });

/** `../packages/<name>` for a path inside a package. */
const packageDirectory = (file: string): string => file.split('/').slice(0, 3).join('/');

/** The runtime this module is evaluated in, read from globals only that runtime defines. */
const detectRuntime = (): Runtime => {
  if ('Bun' in globalThis) {
    return 'bun';
  }
  if ('Deno' in globalThis) {
    return 'deno';
  }
  // workerd reports this fixed user agent: https://developers.cloudflare.com/workers/runtime-apis/web-standards/#navigatoruseragent
  if (navigator.userAgent === 'Cloudflare-Workers') {
    return 'workers';
  }
  if ('document' in globalThis) {
    return 'browser';
  }
  return 'node';
};

describe('runtime', () => {
  it('runs the test body in the runtime its project is configured for', () => {
    expect(detectRuntime()).toBe(inject('runtime'));
  });

  it('loads the property-test setup, which sets a seed and a run count', () => {
    // fast-check draws a fresh seed and runs 100 times unless the setup file configured it.
    const { seed, numRuns } = readConfigureGlobal();
    expect([typeof seed, typeof numRuns]).toStrictEqual(['number', 'number']);
  });

  it('loads the entry of every package, each with exports', () => {
    const loaded = Object.fromEntries(Object.entries(entries).map(([file, entry]) => [packageDirectory(file), Object.keys(entry).length > 0]));
    expect(loaded).toStrictEqual(Object.fromEntries(Object.keys(manifests).map(file => [packageDirectory(file), true])));
  });
});
