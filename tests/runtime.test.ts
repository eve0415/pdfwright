import type { Runtime } from './providedContext.ts';

import { readConfigureGlobal } from 'fast-check';
import { describe, expect, inject, it } from 'vitest';

import { PdfwrightError } from '../packages/core/src/index.ts';
import { writeIllustratorPdf } from '../packages/illustrator/src/index.ts';

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

  it('runs properties with a fixed seed and a bounded number of runs', () => {
    // fast-check draws a fresh seed and runs 100 times unless the setup file configured it.
    const { seed, numRuns } = readConfigureGlobal();
    expect([typeof seed, typeof numRuns]).toStrictEqual(['number', 'number']);
  });

  it('loads every package entry', () => {
    expect([typeof PdfwrightError, typeof writeIllustratorPdf]).toStrictEqual(['function', 'function']);
  });
});
