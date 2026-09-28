import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

interface Measurement {
  readonly inputBytes: number;
  readonly pages: number;
  readonly peakBytes: number;
  readonly streamedKind: string;
}

const measurement = (value: unknown): Measurement => {
  if (typeof value !== 'object' || value === null || !('inputBytes' in value) || !('pages' in value) || !('peakBytes' in value) || !('streamedKind' in value)) {
    throw new Error('conversion memory measurement is incomplete');
  }
  if (
    typeof value.inputBytes !== 'number' ||
    typeof value.pages !== 'number' ||
    typeof value.peakBytes !== 'number' ||
    typeof value.streamedKind !== 'string'
  ) {
    throw new TypeError('conversion memory measurement is invalid');
  }
  return { inputBytes: value.inputBytes, pages: value.pages, peakBytes: value.peakBytes, streamedKind: value.streamedKind };
};

describe('conversion memory', () => {
  it('streams ten 300 dpi A4 RGB pages within 120 MB', async () => {
    const child = spawn(process.execPath, ['scripts/measureConversionMemory.ts'], { cwd: process.cwd() });
    const [output, errors, closed] = await Promise.all([text(child.stdout), text(child.stderr), once(child, 'close')]);
    expect([closed[0], errors]).toStrictEqual([0, '']);
    const result: unknown = JSON.parse(output);
    const measured = measurement(result);
    expect([measured.pages, measured.streamedKind]).toStrictEqual([10, 'streamed']);
    expect([measured.inputBytes > 80_000_000, measured.inputBytes < 90_000_000]).toStrictEqual([true, true]);
    expect(measured.peakBytes).toBeLessThanOrEqual(120_000_000);
  }, 600_000);
});
