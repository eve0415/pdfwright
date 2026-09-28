import type { LoadedDocument } from '../document/loadDocument.ts';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';
import { text as streamText } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { createDocument } from '../document/pdfDocument.ts';
import { rect } from '../document/rect.ts';
import { pt } from '../length/length.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { readMetadata } from './readMetadata.ts';
import { setMetadata } from './setMetadata.ts';

const CORPUS = path.join(import.meta.dirname, '../../test/corpus');
const GOVDOCS = path.join(CORPUS, 'govdocs1/.cache/files');
const SUMMARY = path.join(CORPUS, 'metadata-summary.json');

const MODIFIED = pdfDate({ year: 2024, month: 3, day: 1, hour: 12, minute: 0, second: 0, offset: { sign: '+', hours: 9, minutes: 0 } });
const INPUT = {
  title: '山田 太郎',
  author: 'Example',
  subject: 'Name',
  producer: 'pdfwright',
  trapped: 'False',
  modificationDate: MODIFIED,
} as const;

interface Run {
  readonly code: number;
  readonly stdout: string;
}

// Standard output alone, so that warnings on standard error cannot corrupt the JSON or the metadata a tool prints.
const run = async (command: string, args: readonly string[]): Promise<Run> => {
  const child = spawn(command, args);
  child.stderr.resume();
  const [closed, stdout] = await Promise.all([once(child, 'close'), streamText(child.stdout)]);
  const code: unknown = closed[0];
  return { code: typeof code === 'number' ? code : -1, stdout };
};

const isRecord = (value: unknown): value is object => typeof value === 'object' && value !== null;

// qpdf --json lists every object under qpdf[1]; each stream's dictionary is under stream.dict.
const metadataStreams = (json: string): readonly (readonly [string, boolean])[] => {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || !('qpdf' in parsed) || !Array.isArray(parsed.qpdf)) return [];
  const objects: unknown = parsed.qpdf[1];
  if (!isRecord(objects)) return [];
  const streams: (readonly [string, boolean])[] = [];
  for (const [key, value] of new Map<string, unknown>(Object.entries(objects))) {
    const stream: unknown = isRecord(value) && 'stream' in value ? value.stream : undefined;
    const dictionary: unknown = isRecord(stream) && 'dict' in stream ? stream.dict : undefined;
    if (isRecord(dictionary) && '/Type' in dictionary && dictionary['/Type'] === '/Metadata') streams.push([key, '/Filter' in dictionary]);
  }
  return streams;
};

// A source with a direct Info dictionary, an orphaned packet, and a document packet that an incremental update replaced, so that the file holds three packet headers.
const source = (): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R/Metadata 4 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' },
        { number: 4, body: streamBody('/Type/Metadata/Subtype/XML', '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x/><?xpacket end="w"?>') },
        { number: 5, body: streamBody('/Type/Metadata/Subtype/XML', '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x/><?xpacket end="w"?>') },
      ],
      trailer: `/Root 1 0 R/Info<</Title(Old)/Custom(kept)>>/ID[<${'12'.repeat(16)}><${'34'.repeat(16)}>]`,
    },
    {
      xref: 'classic',
      objects: [
        {
          number: 4,
          body: streamBody(
            '/Type/Metadata/Subtype/XML',
            '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" pdf:Producer="Old" pdf:Title="Legacy"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>',
          ),
        },
      ],
      trailer: `/Root 1 0 R/Info<</Title(Old)/Custom(kept)>>/ID[<${'12'.repeat(16)}><${'34'.repeat(16)}>]`,
    },
  ]).bytes;

interface ToolView {
  readonly check: number;
  readonly streams: readonly (readonly [string, boolean])[];
  readonly meta: string;
  readonly info: string;
  readonly headers: number;
}

const inspect = async (bytes: Uint8Array): Promise<ToolView> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-metadata-'));
  try {
    const file = path.join(directory, 'saved.pdf');
    await writeFile(file, bytes);
    const [check, json, meta, info] = await Promise.all([
      run('qpdf', ['--check', file]),
      run('qpdf', ['--json', file]),
      run('pdfinfo', ['-meta', file]),
      // pdfinfo prints Info values in UTF-8, poppler's default text encoding.
      run('pdfinfo', ['-custom', file]),
    ]);
    return {
      check: check.code,
      streams: metadataStreams(json.stdout),
      meta: meta.stdout,
      info: info.stdout,
      headers: latin1Text(bytes).split('<?xpacket begin=').length - 1,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const infoLine = (info: string, key: string): string | undefined =>
  info
    .split('\n')
    .find(line => line.startsWith(`${key}:`))
    ?.slice(key.length + 1)
    .trim();

describe('metadata saves against qpdf and poppler', () => {
  it('leaves one unfiltered document packet that pdfinfo prints, with the Info values set', async () => {
    const document = loadDocument(source());
    setMetadata(document, INPUT);
    const view = await inspect(document.save().toBytes());
    expect({
      check: view.check,
      streams: view.streams.length,
      filtered: view.streams.some(([, filtered]) => filtered),
      printed: view.meta.includes('<dc:title><rdf:Alt><rdf:li xml:lang="x-default">山田 太郎</rdf:li>'),
      title: infoLine(view.info, 'Title'),
      author: infoLine(view.info, 'Author'),
      custom: infoLine(view.info, 'Custom'),
      headers: view.headers,
    }).toStrictEqual({ check: 0, streams: 1, filtered: false, printed: true, title: '山田 太郎', author: 'Example', custom: 'kept', headers: 1 });
  });

  it('writes a created document whose packet and Info both tools read', async () => {
    const created = createDocument({ info: { ...INPUT, creationDate: MODIFIED }, metadata: { xmp: true } });
    created.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
    const view = await inspect(created.save().toBytes());
    expect([
      view.check,
      view.streams.length,
      view.meta.includes('<pdf:Producer>pdfwright</pdf:Producer>'),
      infoLine(view.info, 'Title'),
      view.headers,
    ]).toStrictEqual([0, 1, true, '山田 太郎', 1]);
  });
});

/** Corpus files expected to fail loading, as `set/name`. */
const expectedErrors = async (): Promise<ReadonlySet<string>> => {
  const parsed: unknown = JSON.parse(await readFile(path.join(CORPUS, 'expected-failures.json'), 'utf8'));
  const failing = new Set<string>();
  if (typeof parsed !== 'object' || parsed === null) return failing;
  for (const [file, entry] of Object.entries(parsed)) {
    if (typeof entry === 'object' && entry !== null && 'error' in entry) failing.add(file);
  }
  return failing;
};

// Without the fetched govdocs1 files, a set has no files and the tests over it have nothing to check.
const corpusFiles = async (directory: string): Promise<readonly string[]> => {
  try {
    const names = await readdir(directory);
    const files = names.filter(name => name.endsWith('.pdf')).toSorted();
    if (directory === GOVDOCS && env['CI'] !== undefined && files.length === 0) throw new Error('govdocs1 corpus is missing');
    return files;
  } catch {
    if (directory === GOVDOCS && env['CI'] !== undefined) throw new Error('govdocs1 corpus is missing');
    return [];
  }
};

const SETS = [
  ['qpdf', path.join(CORPUS, 'qpdf')],
  ['cabinet', path.join(CORPUS, 'cabinet')],
  ['safedocs', path.join(CORPUS, 'safedocs')],
  ['govdocs1', GOVDOCS],
] as const;

interface FileSummary {
  readonly orphans: number;
  readonly superseded: number;
  readonly mismatches: readonly string[];
}

// The metadata findings the summary records for one document: orphaned metadata objects, packets only earlier revisions hold, and the Table 20 keys on which Info and XMP disagree.
const summarize = (document: LoadedDocument): FileSummary => {
  const metadata = readMetadata(document);
  return {
    orphans: metadata.packets.orphans.length,
    superseded: metadata.packets.scanned.superseded,
    mismatches: metadata.properties.filter(property => property.agreement === 'differ').map(property => property.key),
  };
};

interface CorpusSummary {
  /** The sets whose files are present. */
  readonly sets: readonly string[];
  readonly files: Record<string, FileSummary>;
}

// Files are read one after another, so that the fetched govdocs1 files are not all held at once.
const corpusSummary = async (): Promise<CorpusSummary> => {
  const failing = await expectedErrors();
  const listed = await Promise.all(SETS.map(async ([set, directory]) => ({ set, directory, names: await corpusFiles(directory) })));
  const queue = listed.flatMap(({ set, directory, names }) =>
    names.filter(name => !failing.has(`${set}/${name}`)).map(name => ({ key: `${set}/${name}`, file: path.join(directory, name) })),
  );
  const files: Record<string, FileSummary> = {};
  const readFrom = async (index: number): Promise<Record<string, FileSummary>> => {
    const item = queue[index];
    if (item === undefined) return files;
    const bytes = await readFile(item.file);
    const summary = summarize(loadDocument(bytes));
    if (summary.orphans > 0 || summary.superseded > 0 || summary.mismatches.length > 0) files[item.key] = summary;
    return readFrom(index + 1);
  };
  await readFrom(0);
  return { sets: listed.filter(({ names }) => names.length > 0).map(({ set }) => set), files };
};

// The summary entries of the sets that are present.
const recordedSummary = async (sets: readonly string[]): Promise<ReadonlyMap<string, unknown>> => {
  const recorded: unknown = JSON.parse(await readFile(SUMMARY, 'utf8'));
  if (typeof recorded !== 'object' || recorded === null) return new Map();
  return new Map([...new Map<string, unknown>(Object.entries(recorded))].filter(([file]) => sets.some(set => file.startsWith(`${set}/`))));
};

interface Rewritten {
  readonly document: number;
  readonly superseded: number;
  readonly orphans: number;
}

// Sets the metadata of a file, rewrites it, and counts the packets of the result.
const rewritten = async (name: string): Promise<Rewritten> => {
  const bytes = await readFile(path.join(GOVDOCS, name));
  const document = loadDocument(bytes);
  setMetadata(document, { modificationDate: MODIFIED });
  const { scanned, orphans } = readMetadata(loadDocument(document.save().chunks)).packets;
  return { document: scanned.document, superseded: scanned.superseded, orphans: orphans.length };
};

// The dc:creator items of a file after an edit that sets only Keywords.
const creatorsAfterKeywords = async (name: string): Promise<readonly string[]> => {
  const document = loadDocument(await readFile(path.join(GOVDOCS, name)));
  setMetadata(document, { modificationDate: MODIFIED, keywords: 'keywords' });
  const creator = readMetadata(loadDocument(document.save().chunks)).properties.find(property => property.key === 'Author')?.xmp;
  return creator?.kind === 'array' ? creator.items.map(item => item.text) : [];
};

describe('metadata in the corpus', () => {
  it('reads the metadata of every file that loads, with the recorded orphans, superseded packets and mismatches', { timeout: 600_000 }, async () => {
    const { sets, files } = await corpusSummary();
    await expect(recordedSummary(sets)).resolves.toStrictEqual(new Map(Object.entries(files)));
  });

  it('sets metadata on a file whose catalog holds integers beyond the range the writer produces', async () => {
    const document = loadDocument(await readFile(path.join(CORPUS, 'qpdf/weird-tokens.pdf')));
    setMetadata(document, { modificationDate: MODIFIED, title: 'Set' }, { documentId: { value: 'uuid:given' } });
    const view = await inspect(document.save().toBytes());
    expect([view.check, view.streams.length, infoLine(view.info, 'Title'), view.headers]).toStrictEqual([0, 1, 'Set', 1]);
  });

  it('keeps every creator of a packet when the edit sets another key', async () => {
    const names = await corpusFiles(GOVDOCS);
    const present = names.filter(name => name === '000150.pdf');
    const creators = await Promise.all(present.map(async name => [name, await creatorsAfterKeywords(name)] as const));
    expect(Object.fromEntries(creators)).toStrictEqual(
      Object.fromEntries(present.map(name => [name, ['C. Lambert', 'Y. Cheng', 'D. Dobson', 'J. Hangas', 'M. Jagner', 'J. Warner']])),
    );
  });

  it('leaves one document packet and no superseded or orphan packet after rewriting each affected file', { timeout: 120_000 }, async () => {
    const names = await corpusFiles(GOVDOCS);
    const summary = await recordedSummary(['govdocs1']);
    const present = names.filter(name => summary.has(`govdocs1/${name}`));
    const results = await Promise.all(present.map(async name => [name, await rewritten(name)] as const));
    expect(Object.fromEntries(results)).toStrictEqual(Object.fromEntries(present.map(name => [name, { document: 1, superseded: 0, orphans: 0 }])));
  });
});
