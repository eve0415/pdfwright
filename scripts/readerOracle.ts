import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';

export interface ToolRun {
  readonly code: number;
  readonly output: string;
}

export interface ReaderReport {
  readonly tool: 'qpdf' | 'mutool' | 'gs' | 'poppler';
  readonly code: number;
  /** The TrimBox of page 1 as the reader reports it, as four numbers. */
  readonly trimBox: readonly number[] | undefined;
  /** Lines in which the reader reports damage, a repair, an error or a warning. */
  readonly notices: readonly string[];
  readonly output: string;
}

export const runTool = async (command: string, args: readonly string[]): Promise<ToolRun> => {
  const child = spawn(command, args);
  const [closed, stdout, stderr] = await Promise.all([once(child, 'close'), text(child.stdout), text(child.stderr)]);
  const code: unknown = closed[0];
  return { code: typeof code === 'number' ? code : -1, output: `${stdout}${stderr}` };
};

const numbers = (values: readonly (string | undefined)[]): readonly number[] | undefined => {
  const parsed: number[] = [];
  for (const value of values) parsed.push(Number(value));
  return parsed.length === 4 && parsed.every(value => Number.isFinite(value)) ? parsed : undefined;
};

const NOTICE = /warning|error|repair|damaged|recover|reconstruct/iu;

const notices = (output: string): string[] =>
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
export const readerReports = async (file: string): Promise<ReaderReport[]> => Promise.all([qpdf(file), mutool(file), ghostscript(file), poppler(file)]);

/** The spot colours Ghostscript finds on page 1. */
export const spotColors = async (file: string): Promise<string[]> => {
  const run = await runTool('gs', ['-dNODISPLAY', '-dNOSAFER', '-dBATCH', '-dNOPAUSE', '-dPDFINFO', file]);
  const section = run.output.split('Page Spot colors:')[1] ?? '';
  return [...section.matchAll(/^\s+'([^']*)'$/gmu)].map(match => match[1] ?? '');
};
