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
  /** The TrimBox of page 1 as the reader reports it, as four numbers; undefined when the reader reports none. */
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
  // A tool that exits before reading all of its input breaks the pipe; the exit code says more, so the write error is kept for a tool that then exits 0.
  let unread: unknown;
  child.stdin.on('error', (error: unknown) => {
    unread = error;
  });
  child.stdin.end(input);
  const [closed, stdout, stderr] = await started(command, Promise.all([once(child, 'close'), buffer(child.stdout), text(child.stderr)]));
  if (closed[0] !== 0) {
    throw new Error(`${command} exited ${String(closed[0])}: ${stderr}`);
  }
  if (unread !== undefined) {
    throw new Error(`${command} exited 0 without reading all of its input`, { cause: unread });
  }
  return { stdout: new Uint8Array(stdout), stderr };
};

/** Runs qpdf and returns its stdout and stderr as text, rejecting unless it exits 0 (qpdf exits 3 when it only warns). */
export const runQpdf = async (args: ReadonlyArray<string>): Promise<{ readonly stdout: string; readonly stderr: string }> => {
  const run = await runChecked('qpdf', args);
  return { stdout: new TextDecoder().decode(run.stdout), stderr: run.stderr };
};

/** Runs ImageMagick with `input` on standard input and returns what it writes to standard output. */
export const magick = async (args: ReadonlyArray<string>, input: Uint8Array): Promise<Uint8Array> => {
  const { stdout, stderr } = await runChecked('magick', args, input);
  // ImageMagick exits 0 and writes nothing for an output format it does not know.
  if (stdout.length === 0) {
    throw new Error(`magick wrote nothing: ${stderr}`);
  }
  return stdout;
};

const fourNumbers = (values: ReadonlyArray<unknown>, what: string): ReadonlyArray<number> => {
  const parsed = values.map(value => (typeof value === 'string' ? Number(value) : value));
  if (parsed.length !== 4 || !parsed.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error(`${what} reports a TrimBox that is not four numbers: ${JSON.stringify(values)}`);
  }
  return parsed.filter(value => typeof value === 'number');
};

/** The four numbers `pattern` captures in `scope`, or undefined when `scope` has no TrimBox; a TrimBox the pattern cannot read means the reader changed its format, and reading that as "no TrimBox" would pass a missing-box assertion, so it throws. */
export const boxFromText = (what: string, scope: string, pattern: RegExp): ReadonlyArray<number> | undefined => {
  const match = pattern.exec(scope);
  if (match === null) {
    if (scope.includes('TrimBox')) {
      throw new Error(`${what} reports a TrimBox in a form this oracle cannot read: ${scope}`);
    }
    return undefined;
  }
  return fourNumbers(match.slice(1), what);
};

// The entries of a JSON object, or none for anything else.
const entries = (value: unknown): ReadonlyMap<string, unknown> =>
  new Map(typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.entries(value) : []);

/** The box of page 1 in the output of `qpdf --json=2 --json-key=pages --json-key=qpdf`, following one indirect reference; undefined when qpdf lists no pages or page 1 has no such box. */
export const qpdfPageBox = (json: unknown, name = '/TrimBox'): ReadonlyArray<number> | undefined => {
  const pages = entries(json).get('pages');
  const sections = entries(json).get('qpdf');
  if (!Array.isArray(pages) || !Array.isArray(sections)) {
    throw new TypeError('qpdf JSON has no pages or qpdf key');
  }
  // qpdf lists no pages when it cannot read the page tree, as when page 1 lies above the object numbers it reads; that reader then reports no box.
  if (pages.length === 0) {
    return undefined;
  }
  const objects = entries(sections[1]);
  const pageReference = entries(pages[0]).get('object');
  const page = typeof pageReference === 'string' ? entries(objects.get(`obj:${pageReference}`)).get('value') : undefined;
  if (typeof page !== 'object' || page === null || Array.isArray(page)) {
    throw new TypeError('qpdf JSON has no dictionary for page 1');
  }
  const box = entries(page).get(name);
  if (box === undefined) {
    return undefined;
  }
  const value = typeof box === 'string' ? entries(objects.get(`obj:${box}`)).get('value') : box;
  return fourNumbers(Array.isArray(value) ? value : [value], 'qpdf');
};

const NOTICE = /warning|error|repair|damaged|recover|reconstruct/iu;

const notices = (output: string): Array<string> =>
  output
    .split('\n')
    .filter(line => NOTICE.test(line) && !/^\s*No syntax or stream encoding errors found/u.test(line) && !line.includes('errors that qpdf cannot detect'));

// qpdf --check reports damage and warnings; the page's TrimBox comes from its JSON form, which lists objects by number, so page 1 is found through the pages key.
const qpdf = async (file: string): Promise<ReaderReport> => {
  const check = await runTool('qpdf', ['--check', file]);
  const child = spawn('qpdf', ['--json=2', '--json-key=pages', '--json-key=qpdf', file]);
  const [closed, json] = await started('qpdf', Promise.all([once(child, 'close'), text(child.stdout), text(child.stderr)]));
  // qpdf exits 3 when it read the file with warnings, which still gives JSON; exit 2 means it could not read the file at all.
  const parsed: unknown = closed[0] === 0 || closed[0] === 3 ? JSON.parse(json) : undefined;
  return {
    tool: 'qpdf',
    code: check.code,
    trimBox: parsed === undefined ? undefined : qpdfPageBox(parsed),
    notices: notices(check.output),
    output: check.output,
  };
};

const mutool = async (file: string): Promise<ReaderReport> => {
  const run = await runTool('mutool', ['pages', file, '1']);
  const trimBox = boxFromText('MuPDF', run.output, /<TrimBox l="([^"]+)" b="([^"]+)" r="([^"]+)" t="([^"]+)"/u);
  return { tool: 'mutool', code: run.code, trimBox, notices: notices(run.output), output: run.output };
};

// Ghostscript runs without -q, because -q hides its notice that it repaired the cross-reference table.
const ghostscript = async (file: string): Promise<ReaderReport> => {
  const run = await runTool('gs', ['-dNODISPLAY', '-dNOSAFER', '-dBATCH', '-dNOPAUSE', '-dPDFINFO', file]);
  const line = run.output.split('\n').find(text => text.startsWith('Page 1 ')) ?? '';
  const trimBox = boxFromText('Ghostscript', line, /TrimBox: \[([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)\]/u);
  return { tool: 'gs', code: run.code, trimBox, notices: notices(run.output), output: run.output };
};

const poppler = async (file: string): Promise<ReaderReport> => {
  const run = await runTool('pdfinfo', ['-box', file]);
  const line = run.output.split('\n').find(text => text.startsWith('TrimBox:')) ?? '';
  const trimBox = boxFromText('poppler', line, /TrimBox:\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/u);
  return { tool: 'poppler', code: run.code, trimBox, notices: notices(run.output), output: run.output };
};

/** How qpdf, MuPDF, Ghostscript and poppler read page 1 of a file, and what damage each reports. */
export const readerReports = async (file: string): Promise<Array<ReaderReport>> => Promise.all([qpdf(file), mutool(file), ghostscript(file), poppler(file)]);

/** The spot colours Ghostscript finds on page 1. */
export const spotColors = async (file: string): Promise<Array<string>> => {
  const run = await runTool('gs', ['-dNODISPLAY', '-dNOSAFER', '-dBATCH', '-dNOPAUSE', '-dPDFINFO', file]);
  const section = run.output.split('Page Spot colors:')[1] ?? '';
  return [...section.matchAll(/^\s+'([^']*)'$/gmu)].map(match => match[1] ?? '');
};
