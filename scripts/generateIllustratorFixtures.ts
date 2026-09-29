import type { TestObject, TestSection } from '../packages/core/src/testing/pdfBuilder.ts';

import { mkdir, writeFile } from 'node:fs/promises';
import { constants, deflateSync, zstdCompressSync } from 'node:zlib';

import { buildPdf, latin1Text, streamBody } from '../packages/core/src/testing/pdfBuilder.ts';

const output = new URL('../tests/fixtures/illustrator-shaped/', import.meta.url);
const header = '%!PS-Adobe-3.0 \r%%Creator: pdfwright synthetic\r%%Title: Synthetic artwork\r%AI5_FileFormat 14.0\r%%EndComments\r';
const line = '%AI5_SyntheticArtwork 0 0 200 200\r';

// The unique comment lines make the wrapped frame cross several 65,536-byte boundaries while the repeated artwork keeps its decoded window above 2 MiB.
let state = 0x53_a9_21;
const noise = Array.from({ length: 15_000 }, () => {
  let value = '%';
  for (let index = 0; index < 64; index++) {
    state = (state * 1_664_525 + 1_013_904_223) % 2 ** 32;
    value += Math.floor(state / 2 ** 28).toString(16);
  }
  return `${value}\r`;
}).join('');
const native = `${header}${noise}${line.repeat(Math.ceil((2_200_000 - header.length - noise.length) / line.length))}`;
const frame = zstdCompressSync(Buffer.from(native), {
  params: {
    [constants.ZSTD_c_contentSizeFlag]: 0,
    [constants.ZSTD_c_checksumFlag]: 0,
    [constants.ZSTD_c_windowLog]: 21,
  },
});
if (frame[4] !== 0 || frame[5] !== 0x58) throw new Error('the Zstandard encoder changed the expected frame header');
const wrapped = Buffer.concat([Buffer.from('%AI24_ZStandard_Data'), frame]);
const chunks = Array.from({ length: Math.ceil(wrapped.length / 65_536) }, (_, index) => wrapped.subarray(index * 65_536, (index + 1) * 65_536));
if (chunks.length < 2) throw new Error('the native data did not cross a chunk boundary');

const date = "D:20260927204901+09'00'";
const page = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/TrimBox[0 0 200 200]/Group<</S/Transparency/CS/DeviceCMYK/I true>>/Resources<<>>/Contents 4 0 R/PieceInfo<< /Illustrator 5 0 R >>/LastModified(${date})>>`;
const privateDictionary = `<< /AIMetaData 7 0 R ${chunks.map((_, index) => `/AIPDFPrivateData${String(index + 1)} ${String(index + 8)} 0 R`).join(' ')} /ContainerVersion 9 /CreatorVersion 30 /NumBlock ${String(chunks.length)} /RoundtripStreamType 2 /RoundtripVersion 30 >>`;
const stream = (bytes: Uint8Array, filtered: boolean): string => {
  const stored = filtered ? deflateSync(bytes) : bytes;
  return streamBody(filtered ? '/Filter/FlateDecode' : '', latin1Text(stored));
};

const objects = (filtered: boolean, pageTopLevel: boolean): TestObject[] => [
  { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
  { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
  ...(pageTopLevel ? [{ number: 3, body: page }] : []),
  { number: 4, body: streamBody('', 'q 0 0 0 1 k 20 20 30 30 re f Q') },
  { number: 5, body: `<</LastModified(${date})/Private 6 0 R>>` },
  { number: 6, body: privateDictionary },
  { number: 7, body: stream(Buffer.from(header), filtered) },
  ...chunks.map((chunk, index) => ({ number: index + 8, body: stream(chunk, filtered && (index === 3 || index === chunks.length - 1)) })),
  { number: 40, body: '<</Producer(pdfwright synthetic)/ModDate(D:20260927204901Z)>>' },
];

const classic: TestSection = { xref: 'classic', objects: objects(false, true), trailer: '/Root 1 0 R/Info 40 0 R' };
const packed: TestSection = {
  xref: 'stream',
  objects: objects(true, false),
  objectStreams: [{ number: 41, members: [{ number: 3, body: page }] }],
  trailer: '/Root 1 0 R/Info 40 0 R',
};
const update: TestSection = {
  xref: 'classic',
  objects: [{ number: 40, body: '<</Producer(pdfwright synthetic)/ModDate(D:20260927205000Z)>>' }],
  trailer: '/Root 1 0 R/Info 40 0 R',
};

await mkdir(output, { recursive: true });
const files = [
  ['classic', [classic]],
  ['object-stream', [packed]],
  ['incremental', [classic, update]],
] as const;
await Promise.all(files.map(async ([name, sections]) => writeFile(new URL(`${name}.pdf`, output), buildPdf(sections).bytes)));
