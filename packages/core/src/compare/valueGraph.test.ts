import type { TestObject } from '../testing/pdfBuilder.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { compareDocuments } from './compareDocuments.ts';

const catalog = (extra: string): TestObject => ({ number: 1, body: `<</Type/Catalog/Pages 2 0 R${extra}>>` });

const pdf = (objects: readonly TestObject[]): Uint8Array => buildPdf([{ xref: 'classic', objects, trailer: '/Root 1 0 R' }]).bytes;

const outline = (items: number, lastTitle: string): Uint8Array => {
  const objects: TestObject[] = [
    catalog('/Outlines 4 0 R'),
    { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 10 10]/Resources<<>>>>' },
    { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
    { number: 4, body: `<</Type/Outlines/First 10 0 R/Last ${String(9 + items)} 0 R/Count ${String(items)}>>` },
  ];
  for (let index = 0; index < items; index++) {
    const links = [index > 0 ? `/Prev ${String(9 + index)} 0 R` : '', index < items - 1 ? `/Next ${String(11 + index)} 0 R` : ''].join('');
    const title = index === items - 1 ? lastTitle : `item ${String(index)}`;
    objects.push({ number: 10 + index, body: `<</Title(${title})/Parent 4 0 R/Dest[3 0 R/Fit]${links}>>` });
  }
  return pdf(objects);
};

const sharedResources = (font: string): Uint8Array =>
  pdf([
    catalog(''),
    { number: 2, body: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/MediaBox[0 0 10 10]/Resources 7 0 R>>' },
    { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
    { number: 4, body: '<</Type/Page/Parent 2 0 R>>' },
    { number: 7, body: '<</Font<</F1 8 0 R>>>>' },
    { number: 8, body: font },
  ]);

describe('value graph comparison', () => {
  it('follows reference chains far deeper than a call stack allows', () => {
    const one = loadDocument(outline(10_000, 'last'));
    const two = loadDocument(outline(10_000, 'changed'));
    const { differences } = compareDocuments(one, two, { include: ['documentAttributes'] });
    expect(differences).toMatchObject([{ kind: 'document-attribute', a: { text: '(last)' }, b: { text: '(changed)' } }]);
    expect(differences[0]).toHaveProperty('path.length', 10_003);
  });

  it('reports a change to a shared object on every page that reaches it', () => {
    const one = loadDocument(sharedResources('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'));
    const two = loadDocument(sharedResources('<</Type/Font/Subtype/Type1/BaseFont/Courier>>'));
    const { differences } = compareDocuments(one, two, { include: ['resources'] });
    expect(differences).toMatchObject([
      { kind: 'page-resources', page: 0, path: ['Resources', 'Font', 'F1', 'BaseFont'] },
      { kind: 'page-resources', page: 1, path: ['Resources', 'Font', 'F1', 'BaseFont'] },
    ]);
  });

  it('reports an object that cannot be parsed as undecodable', () => {
    const bytes = sharedResources('<</Type/Font/Subtype [1 2>>');
    const { differences } = compareDocuments(loadDocument(bytes), loadDocument(Uint8Array.from(bytes)), { include: ['resources'] });
    expect(differences).toMatchObject([
      { kind: 'undecodable', where: ['page', 0, 'Resources', 'Font', 'F1'], document: 'a' },
      { kind: 'undecodable', where: ['page', 0, 'Resources', 'Font', 'F1'], document: 'b' },
      { kind: 'undecodable', where: ['page', 1, 'Resources', 'Font', 'F1'], document: 'a' },
      { kind: 'undecodable', where: ['page', 1, 'Resources', 'Font', 'F1'], document: 'b' },
    ]);
  });
});
