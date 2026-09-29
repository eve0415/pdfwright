import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

interface MemoryResult {
  readonly baselineBytes: number;
  readonly peakBytes: number;
  readonly elapsedMs: number;
  readonly savedBytes: number;
}

const measured = (value: unknown): MemoryResult => {
  if (typeof value !== 'object' || value === null) throw new TypeError('memory result is missing');
  if (!('baselineBytes' in value) || !('peakBytes' in value) || !('elapsedMs' in value) || !('savedBytes' in value)) {
    throw new Error('memory result is incomplete');
  }
  if (
    typeof value.baselineBytes !== 'number' ||
    typeof value.peakBytes !== 'number' ||
    typeof value.elapsedMs !== 'number' ||
    typeof value.savedBytes !== 'number'
  ) {
    throw new TypeError('memory result is invalid');
  }
  return { baselineBytes: value.baselineBytes, peakBytes: value.peakBytes, elapsedMs: value.elapsedMs, savedBytes: value.savedBytes };
};

describe('image conversion memory', () => {
  it('measures peak heapUsed plus external while streaming in a Node child process', async () => {
    const child = spawn(process.execPath, ['scripts/measureImageConversion.ts'], { cwd: process.cwd() });
    const [output, errors, closed] = await Promise.all([text(child.stdout), text(child.stderr), once(child, 'close')]);
    expect([closed[0], errors]).toStrictEqual([0, '']);
    const value: unknown = JSON.parse(output);
    const result = measured(value);
    expect(result.peakBytes).toBeGreaterThanOrEqual(result.baselineBytes);
    expect(result.savedBytes).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeLessThan(60_000);
  }, 120_000);
});
