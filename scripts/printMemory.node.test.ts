import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

interface Measurement {
  readonly inputBytes: number;
  readonly pages: number;
  readonly peakBytes: number;
  readonly fullBytes: number;
  readonly streamedBytes: number;
}

const measurement = (value: unknown): Measurement => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('inputBytes' in value) ||
    !('pages' in value) ||
    !('peakBytes' in value) ||
    !('fullBytes' in value) ||
    !('streamedBytes' in value)
  ) {
    throw new Error('memory result is incomplete');
  }
  if (
    typeof value.inputBytes !== 'number' ||
    typeof value.pages !== 'number' ||
    typeof value.peakBytes !== 'number' ||
    typeof value.fullBytes !== 'number' ||
    typeof value.streamedBytes !== 'number'
  ) {
    throw new TypeError('memory result is invalid');
  }
  return {
    inputBytes: value.inputBytes,
    pages: value.pages,
    peakBytes: value.peakBytes,
    fullBytes: value.fullBytes,
    streamedBytes: value.streamedBytes,
  };
};

describe('print file memory', () => {
  it('keeps an 80 MB print file under the 120 MB Node memory ceiling', async () => {
    const child = spawn(process.execPath, ['scripts/measurePrintMemory.ts'], { cwd: process.cwd() });
    const [output, errors, closed] = await Promise.all([text(child.stdout), text(child.stderr), once(child, 'close')]);
    expect([closed[0], errors]).toStrictEqual([0, '']);
    const result: unknown = JSON.parse(output);
    const measured = measurement(result);
    expect(measured.pages).toBe(10);
    expect([measured.inputBytes > 80_000_000, measured.inputBytes < 90_000_000]).toStrictEqual([true, true]);
    expect([measured.fullBytes > 0, measured.streamedBytes > 0]).toStrictEqual([true, true]);
    expect(measured.peakBytes).toBeLessThanOrEqual(120_000_000);
  }, 120_000);
});
