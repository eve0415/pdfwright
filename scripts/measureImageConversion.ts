import { readFile } from 'node:fs/promises';

import { imageConversionFixture, measureImageConversion } from '../packages/core/src/colorConvert/performanceFixture.ts';
import { parseIccProfile } from '../packages/core/src/icc/iccProfile.ts';

const sourceBytes = await readFile(new URL('../tests/fixtures/icc/sRGB.icm', import.meta.url));
const outputBytes = await readFile(new URL('../tests/fixtures/icc/fogra28l.icc', import.meta.url));
const source = parseIccProfile(sourceBytes);
const output = parseIccProfile(outputBytes);
const input = imageConversionFixture();

// The same heapUsed + external measure as the repository's print-file memory test counts V8 allocations and backing stores once.
const bytes = (): number => {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
};
const baselineBytes = bytes();
let peakBytes = baselineBytes;
const sample = (): void => {
  peakBytes = Math.max(peakBytes, bytes());
};
const interval = setInterval(sample, 1);
try {
  const result = await measureImageConversion(input, { source, output, sample });
  sample();
  process.stdout.write(`${JSON.stringify({ ...result, inputBytes: input.length, baselineBytes, peakBytes })}\n`);
} finally {
  clearInterval(interval);
}
