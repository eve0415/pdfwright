import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

interface ConversionResult {
  readonly pixels: number;
  readonly converted: number;
  readonly kind: string;
  readonly savedBytes: number;
}

const measured = (value: unknown): ConversionResult => {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('conversion result is missing');
  }
  if (!('pixels' in value) || !('converted' in value) || !('kind' in value) || !('savedBytes' in value)) {
    throw new Error('conversion result is incomplete');
  }
  if (typeof value.pixels !== 'number' || typeof value.converted !== 'number' || typeof value.kind !== 'string' || typeof value.savedBytes !== 'number') {
    throw new TypeError('conversion result is invalid');
  }
  return { pixels: value.pixels, converted: value.converted, kind: value.kind, savedBytes: value.savedBytes };
};

describe('image conversion in Node', () => {
  it('converts the shared performance fixture through a streamed save in a Node child process', async () => {
    const child = spawn(process.execPath, ['scripts/measureImageConversion.ts'], { cwd: process.cwd() });
    const [output, errors, closed] = await Promise.all([text(child.stdout), text(child.stderr), once(child, 'close')]);
    expect([closed[0], errors]).toStrictEqual([0, '']);
    const value: unknown = JSON.parse(output);
    const result = measured(value);
    expect([result.converted, result.kind, result.pixels]).toStrictEqual([1, 'streamed', 524_288]);
    expect(result.savedBytes).toBeGreaterThan(0);
  }, 120_000);
});
