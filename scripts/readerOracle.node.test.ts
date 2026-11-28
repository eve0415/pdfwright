import type { CheckedRun, ToolRun } from './readerOracle.ts';

import { describe, expect, it } from 'vitest';

import { runChecked, runTool } from './readerOracle.ts';

const node = process.execPath;
const MISSING = 'pdfwright-no-such-tool';

describe('running oracle tools', () => {
  it('returns what a checked tool writes and passes it standard input', async () => {
    const run = await runChecked(node, ['-e', 'process.stdin.pipe(process.stdout); process.stderr.write("note")'], Uint8Array.from([0, 1, 255]));
    expect([[...run.stdout], run.stderr]).toStrictEqual([[0, 1, 255], 'note']);
  });

  it('rejects a checked tool that exits nonzero, with its exit code and stderr', async () => {
    await expect(runChecked(node, ['-e', 'process.stderr.write("broken input"); process.exit(3)'])).rejects.toThrow(/exited 3: broken input/u);
  });

  it('reports the exit code of a tool run without checking', async () => {
    await expect(runTool(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(2)'])).resolves.toStrictEqual({
      code: 2,
      output: 'outerr',
    });
  });

  it.each([
    ['checked', async (): Promise<CheckedRun | ToolRun> => runChecked(MISSING, [])],
    ['unchecked', async (): Promise<CheckedRun | ToolRun> => runTool(MISSING, [])],
  ])('names a missing tool when a %s run cannot start it', async (_, run) => {
    await expect(run()).rejects.toThrow(`${MISSING} is not installed or not on PATH`);
  });
});
