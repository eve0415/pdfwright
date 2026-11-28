import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { buffer, text } from 'node:stream/consumers';

export interface ToolRun {
  readonly code: number;
  readonly output: string;
}

export interface ReaderReport {
  readonly tool: 'qpdf' | 'mutool' | 'gs' | 'poppler';
  readonly code: number;
  /** The TrimBox of page 1 as the reader reports it, as four numbers. */
  readonly trimBox: ReadonlyArray<number> | undefined;
  /** Lines in which the reader reports damage, a repair, an error or a warning. */
  readonly notices: ReadonlyArray<string>;
  readonly output: string;
}

export interface CheckedRun {
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

// A spawn of a missing command rejects with ENOENT, which names neither the command nor what to do about it.
const started = async <T>(command: string, run: Promise<T>): Promise<T> => {
  try {
    return await run;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`${command} is not installed or not on PATH; the devcontainer and the CI oracle job install every tool the oracle tests run`, {
        cause: error,
      });
    }
    throw error;
  }
};

/** Runs a tool and reports its exit code and its stdout and stderr together; a tool that cannot be started rejects. */
export const runTool = async (command: string, args: ReadonlyArray<string>): Promise<ToolRun> => {
  const child = spawn(command, args);
  const [closed, stdout, stderr] = await started(command, Promise.all([once(child, 'close'), text(child.stdout), text(child.stderr)]));
  const code: unknown = closed[0];
  return { code: typeof code === 'number' ? code : -1, output: `${stdout}${stderr}` };
};

/** Runs a tool with optional standard input and rejects unless it exits 0, with its stderr in the message. */
export const runChecked = async (command: string, args: ReadonlyArray<string>, input?: Uint8Array): Promise<CheckedRun> => {
  const child = spawn(command, args);
  child.stdin.end(input);
  const [closed, stdout, stderr] = await started(command, Promise.all([once(child, 'close'), buffer(child.stdout), text(child.stderr)]));
  if (closed[0] !== 0) {
    throw new Error(`${command} exited ${String(closed[0])}: ${stderr}`);
  }
  return { stdout: new Uint8Array(stdout), stderr };
};

/** Runs qpdf and returns its stdout and stderr as text, rejecting unless it exits 0 (qpdf exits 3 when it only warns). */
export const runQpdf = async (args: ReadonlyArray<string>): Promise<{ readonly stdout: string; readonly stderr: string }> => {
  const run = await runChecked('qpdf', args);
  return { stdout: new TextDecoder().decode(run.stdout), stderr: run.stderr };
};

/** Runs ImageMagick with `input` on standard input and returns what it writes to standard output. */
export const magick = async (args: ReadonlyArray<string>, input: Uint8Array): Promise<Uint8Array> => (await runChecked('magick', args, input)).stdout;

const numbers = (values: ReadonlyArray<string | undefined>): ReadonlyArray<number> | undefined => {
  const parsed: Array<number> = [];
  for (const value of values) {
    parsed.push(Number(value));
  }
  return parsed.length === 4 && parsed.every(value => Number.isFinite(value)) ? parsed : undefined;
};

const NOTICE = /warning|error|repair|damaged|recover|reconstruct/iu;

const notices = (output: string): Array<string> =>
  output
    .split('\n')
    .filter(line => NOTICE.test(line) && !/^\s*No syntax or stream encoding errors found/u.test(line) && !line.includes('errors that qpdf cannot detect'));

// qpdf --check reports damage and warnings; the page's TrimBox comes from its JSON form.
const qpdf = async (file: string): Promise<ReaderReport> => {
  const check = await runTool('qpdf', ['--check', file]);
  const json = await runTool('qpdf', ['--json=2', '--json-key=qpdf', file]);
  const match = /"\/TrimBox": \[\s*([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+)\s*\]/u.exec(json.output);
  return { tool: 'qpdf', code: check.code, trimBox: numbers(match?.slice(1) ?? []), notices: notices(check.output), output: check.output };
};

const mutool = async (file: string): Promise<ReaderReport> => {
  const run = await runTool('mutool', ['pages', file, '1']);
  const match = /<TrimBox l="([^"]+)" b="([^"]+)" r="([^"]+)" t="([^"]+)"/u.exec(run.output);
  return { tool: 'mutool', code: run.code, trimBox: numbers(match?.slice(1) ?? []), notices: notices(run.output), output: run.output };
};

// Ghostscript runs without -q, because -q hides its notice that it repaired the cross-reference table.
const ghostscript = async (file: string): Promise<ReaderReport> => {
  const run = await runTool('gs', ['-dNODISPLAY', '-dNOSAFER', '-dBATCH', '-dNOPAUSE', '-dPDFINFO', file]);
  const match = /Page 1 .*TrimBox: \[([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)\]/u.exec(run.output);
  return { tool: 'gs', code: run.code, trimBox: numbers(match?.slice(1) ?? []), notices: notices(run.output), output: run.output };
};

const poppler = async (file: string): Promise<ReaderReport> => {
  const run = await runTool('pdfinfo', ['-box', file]);
  const match = /TrimBox:\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/u.exec(run.output);
  return { tool: 'poppler', code: run.code, trimBox: numbers(match?.slice(1) ?? []), notices: notices(run.output), output: run.output };
};

/** How qpdf, MuPDF, Ghostscript and poppler read page 1 of a file, and what damage each reports. */
export const readerReports = async (file: string): Promise<Array<ReaderReport>> => Promise.all([qpdf(file), mutool(file), ghostscript(file), poppler(file)]);

/** The spot colours Ghostscript finds on page 1. */
export const spotColors = async (file: string): Promise<Array<string>> => {
  const run = await runTool('gs', ['-dNODISPLAY', '-dNOSAFER', '-dBATCH', '-dNOPAUSE', '-dPDFINFO', file]);
  const section = run.output.split('Page Spot colors:')[1] ?? '';
  return [...section.matchAll(/^\s+'([^']*)'$/gmu)].map(match => match[1] ?? '');
};
