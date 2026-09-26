import type { Runtime } from './providedContext.ts';

import { describe, expect, inject, it } from 'vitest';

import { placeholder as corePlaceholder } from '../packages/core/src/index.ts';
import { placeholder as illustratorPlaceholder } from '../packages/illustrator/src/index.ts';

/** The runtime this module is evaluated in, read from globals only that runtime defines. */
const detectRuntime = (): Runtime => {
  if ('Bun' in globalThis) return 'bun';
  if ('Deno' in globalThis) return 'deno';
  // workerd reports this fixed user agent: https://developers.cloudflare.com/workers/runtime-apis/web-standards/#navigatoruseragent
  if (navigator.userAgent === 'Cloudflare-Workers') return 'workers';
  if ('document' in globalThis) return 'browser';
  return 'node';
};

describe('runtime', () => {
  it('runs the test body in the runtime its project is configured for', () => {
    expect(detectRuntime()).toBe(inject('runtime'));
  });

  it('loads every package entry', () => {
    expect([corePlaceholder, illustratorPlaceholder]).toStrictEqual([true, true]);
  });
});
