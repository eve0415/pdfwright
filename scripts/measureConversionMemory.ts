import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { createDeflate } from 'node:zlib';

import { convertToCmyk } from '../packages/core/src/colorConvert/convertToCmyk.ts';
import { pdfDate } from '../packages/core/src/date/pdfDate.ts';
import { loadDocument } from '../packages/core/src/document/loadDocument.ts';

const writeAll = (file: number, bytes: Uint8Array): number => {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(file, bytes, offset);
  return bytes.length;
};

const imageRows = function* (): Generator<Uint8Array> {
  for (let group = 0; group < 1170; group++) {
    const row = new Uint8Array(7440);
    row.set(randomBytes(6800));
    for (let repeat = 0; repeat < Math.min(3, 3508 - group * 3); repeat++) yield row;
  }
};

const createFixture = async (filePath: string, pageCount: number): Promise<void> => {
  const file = openSync(filePath, 'w+');
  const encoder = new TextEncoder();
  let length = 0;
  const offsets: number[] = [0];
  const write = (value: string | Uint8Array): void => {
    length += writeAll(file, typeof value === 'string' ? encoder.encode(value) : value);
  };
  const start = (number: number): void => {
    offsets[number] = length;
    write(`${String(number)} 0 obj\n`);
  };
  try {
    write('%PDF-1.7\n');
    start(1);
    write('<</Type/Catalog/Pages 2 0 R>>\nendobj\n');
    start(2);
    write(
      `<</Type/Pages/Count ${String(pageCount)}/Kids[${Array.from({ length: pageCount }, (_, index) => `${String(3 + index * 3)} 0 R`).join(' ')}]>>\nendobj\n`,
    );
    const writePage = async (page: number): Promise<void> => {
      const number = 3 + page * 3;
      start(number);
      write(
        `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595.28 841.89]/Resources<</XObject<</Im ${String(number + 2)} 0 R>>/ColorSpace<</Spot[/Separation/Varnish/DeviceCMYK<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0 0 0 0.2]/N 1>>]>>>>/Contents ${String(number + 1)} 0 R>>\nendobj\n`,
      );
      const content = 'q 595 0 0 841 0 0 cm /Im Do Q 0 0 0 1 k 5 5 585 831 re S /Spot cs 1 scn 20 20 555 801 re S';
      start(number + 1);
      write(`<</Length ${String(content.length)}>>\nstream\n${content}\nendstream\nendobj\n`);
      start(number + 2);
      const dictionaryAt = length;
      write(' '.repeat(180));
      write('stream\n');
      const streamAt = length;
      for await (const chunk of Readable.from(imageRows()).pipe(createDeflate({ level: 1 }))) {
        if (!(chunk instanceof Uint8Array)) throw new Error('deflate returned non-byte data');
        write(chunk);
      }
      const streamLength = length - streamAt;
      write('\nendstream\nendobj\n');
      const dictionary = `<</Type/XObject/Subtype/Image/Width 2480/Height 3508/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/FlateDecode/Length ${String(streamLength)}>>`;
      if (dictionary.length > 180) throw new Error('image dictionary is too long');
      writeSync(file, dictionary.padEnd(180, ' '), dictionaryAt);
    };
    const writePages = async (page: number): Promise<void> => {
      if (page === pageCount) return;
      await writePage(page);
      await writePages(page + 1);
    };
    await writePages(0);
    const xref = length;
    write(`xref\n0 ${String(offsets.length)}\n0000000000 65535 f \n`);
    for (const offset of offsets.slice(1)) write(`${String(offset).padStart(10, '0')} 00000 n \n`);
    write(`trailer<</Size ${String(offsets.length)}/Root 1 0 R>>\nstartxref\n${String(xref)}\n%%EOF\n`);
  } finally {
    closeSync(file);
  }
};

const measure = async (filePath: string): Promise<void> => {
  const stages: Record<string, number> = {};
  let stage = 'start';
  let peakBytes = 0;
  let allocationPeakBytes = 0;
  const retained: number[] = [];
  const sample = (): void => {
    const usage = process.memoryUsage();
    const bytes = usage.heapUsed + usage.external;
    allocationPeakBytes = Math.max(allocationPeakBytes, bytes);
  };
  const sampleLive = (): void => {
    globalThis.gc?.();
    globalThis.gc?.();
    const usage = process.memoryUsage();
    const bytes = usage.heapUsed + usage.external;
    stages[stage] = Math.max(stages[stage] ?? 0, bytes);
    peakBytes = Math.max(peakBytes, bytes);
    sample();
  };
  sampleLive();
  const interval = setInterval(sample, 1);
  try {
    stage = 'load';
    const input = readFileSync(filePath);
    sampleLive();
    const document = loadDocument(input);
    sampleLive();
    stage = 'convert';
    convertToCmyk(document, {
      sourceRgbProfile: readFileSync('tests/fixtures/icc/sRGB.icm'),
      outputProfile: readFileSync('tests/fixtures/icc/fogra28l.icc'),
      outputIntent: { outputConditionIdentifier: 'FOGRA28' },
      pdfx: {
        trapped: 'False',
        documentId: 'uuid:10c18da4-d7f3-4bc2-8c22-6a490b9f55f2',
        metadataDate: pdfDate({ year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: 'Z' }),
      },
    });
    sampleLive();
    stage = 'streamed save';
    const streamed = document.save();
    sampleLive();
    let streamedBytes = 0;
    let chunks = 0;
    for await (const chunk of streamed.toStream()) {
      streamedBytes += chunk.length;
      sample();
      if (++chunks % 256 === 0) sampleLive();
    }
    sampleLive();
    retained.push(process.memoryUsage().heapUsed + process.memoryUsage().external);
    sample();
    clearInterval(interval);
    console.log(
      JSON.stringify({
        inputBytes: input.length,
        pages: document.pageCount,
        peakBytes,
        allocationPeakBytes,
        stages,
        retained,
        finalUsage: process.memoryUsage(),
        streamedBytes,
        streamedKind: streamed.kind,
      }),
    );
  } catch (error) {
    clearInterval(interval);
    throw error;
  }
};

if (process.argv[2] === '--measure') {
  const filePath = process.argv.at(3);
  if (filePath === undefined) throw new Error('fixture path is missing');
  await measure(filePath);
} else {
  const directory = mkdtempSync(path.join(tmpdir(), 'pdfwright-memory-'));
  try {
    const filePath = path.join(directory, 'print.pdf');
    const pageCount = Number(process.argv[2] ?? 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10) throw new Error('page count must be from 1 to 10');
    await createFixture(filePath, pageCount);
    const child = spawn(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname, '--measure', filePath]);
    const [output, errors, closed] = await Promise.all([text(child.stdout), text(child.stderr), once(child, 'close')]);
    if (closed[0] !== 0) throw new Error(errors);
    process.stdout.write(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
