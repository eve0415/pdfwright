import type { DocumentInternals } from '../../document/documentInternals.ts';
import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { CMap } from './cmap.ts';
import type { CMapProvider } from './cmapProvider.ts';
import type { CMapResult } from './cmapResolver.ts';

import { describe, expect, it, vi } from 'vitest';

import { internalsOf } from '../../document/documentInternals.ts';
import { loadDocument } from '../../document/loadDocument.ts';
import { pdfName, pdfReference } from '../../object/pdfObject.ts';
import { buildPdf, latin1Bytes, streamBody } from '../../testing/pdfBuilder.ts';

import { PREDEFINED_CMAPS } from './cmapProvider.ts';
import { CMapResolver } from './cmapResolver.ts';

const document = (objects: readonly TestObject[] = []): DocumentInternals => {
  const loaded = loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }, { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' }, ...objects],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );
  const parts = internalsOf(loaded);
  if (parts === undefined) throw new Error('the document has no internals');
  return parts;
};

const provider = (files: Readonly<Record<string, string>>): CMapProvider => ({
  cmap: vi.fn<(name: string) => Uint8Array | undefined>((name: string) => (name in files ? latin1Bytes(files[name] ?? '') : undefined)),
});

const cmapOf = (result: CMapResult): CMap => {
  if (result.kind !== 'cmap') throw new Error(`expected a CMap, got ${result.kind}`);
  return result.cmap;
};

const PARENT = '/CMapName /Parent def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 begincidrange <0000> <00FF> 100 endcidrange';

describe('resolved CMaps', () => {
  it('lists the predefined CMaps of Table 118', () => {
    expect(PREDEFINED_CMAPS.size).toBe(61);
    expect(['90ms-RKSJ-H', 'UniJIS-UTF16-V', 'H', 'V', 'Identity-H', 'Identity-V'].filter(name => !PREDEFINED_CMAPS.has(name))).toStrictEqual([]);
  });

  it('builds in Identity-H and Identity-V without a provider', () => {
    const resolver = new CMapResolver(document(), undefined);
    const horizontal = cmapOf(resolver.named('Identity-H'));
    expect(horizontal.read(Uint8Array.of(0x4e, 0x00, 0x41), 0)).toStrictEqual({ code: { value: 0x4e00, length: 2 }, valid: true });
    expect(horizontal.cid({ value: 0x4e00, length: 2 })).toBe(0x4e00);
    expect([horizontal.writingMode, cmapOf(resolver.named('Identity-V')).writingMode]).toStrictEqual([0, 1]);
  });

  it('reports another predefined CMap as unavailable without a provider', () => {
    expect(new CMapResolver(document(), undefined).named('UniJIS-UTF16-H')).toStrictEqual({ kind: 'unavailable', name: 'UniJIS-UTF16-H' });
  });

  it('reports a CMap the provider supplies as empty or unparsable bytes as unavailable', () => {
    const resolver = new CMapResolver(document(), provider({ Empty: '', Garbage: 'not a CMap )]>> at all' }));
    expect([resolver.named('Empty'), resolver.named('Garbage')]).toStrictEqual([
      { kind: 'unavailable', name: 'Empty' },
      { kind: 'unavailable', name: 'Garbage' },
    ]);
  });

  it('parses a CMap the provider supplies once, and follows its usecmap through the provider', () => {
    const files = provider({ Parent: PARENT, Child: '/Parent usecmap /WMode 1 def 1 begincidchar <0041> 7 endcidchar' });
    const resolver = new CMapResolver(document(), files);
    const child = cmapOf(resolver.named('Child'));
    expect([child.cid({ value: 0x41, length: 2 }), child.cid({ value: 0x42, length: 2 }), child.writingMode]).toStrictEqual([7, 166, 1]);
    resolver.named('Child');
    resolver.named('Parent');
    expect(files.cmap).toHaveBeenCalledTimes(2);
  });

  it('reports a usecmap cycle as unreadable', () => {
    const resolver = new CMapResolver(document(), provider({ A: '/B usecmap', B: '/A usecmap' }));
    expect(resolver.named('A').kind).toBe('unreadable');
  });

  it('keeps a CMap whose usecmap names a CMap that is not available, and records the name', () => {
    const files = provider({ Child: '/UniJIS-UTF16-H usecmap 1 begincodespacerange <0000> <FFFF> endcodespacerange' });
    const child = cmapOf(new CMapResolver(document(), files).named('Child'));
    expect(child.unavailableParent).toBe('UniJIS-UTF16-H');
    expect(child.mapped({ value: 0x41, length: 2 })).toBeUndefined();
  });

  it('reads an embedded CMap stream whose UseCMap entry is another stream', () => {
    const internals = document([
      { number: 4, body: streamBody('/Type/CMap/CMapName/Child/UseCMap 5 0 R', '/Parent usecmap 1 begincidchar <0041> 7 endcidchar') },
      { number: 5, body: streamBody('/Type/CMap/CMapName/Parent', PARENT) },
    ]);
    const cmap = cmapOf(new CMapResolver(internals, undefined).encoding(pdfReference(4, 0)));
    expect([cmap.cid({ value: 0x41, length: 2 }), cmap.cid({ value: 0x42, length: 2 })]).toStrictEqual([7, 166]);
  });

  it('resolves an Encoding name through the provider and reports a stream that does not decode as unreadable', () => {
    const internals = document([{ number: 4, body: streamBody('/Filter/FlateDecode', 'not deflate data') }]);
    const resolver = new CMapResolver(internals, undefined);
    const vertical = cmapOf(resolver.encoding(pdfName('Identity-V')));
    expect(vertical.writingMode).toBe(1);
    expect(resolver.encoding(pdfReference(4, 0)).kind).toBe('unreadable');
    expect(resolver.encoding({ kind: 'integer', value: 3 }).kind).toBe('unreadable');
  });

  it('reads a ToUnicode CMap only from a stream', () => {
    const internals = document([{ number: 4, body: streamBody('', '1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <0042> endbfchar') }]);
    const resolver = new CMapResolver(internals, undefined);
    const toUnicode = cmapOf(resolver.stream(pdfReference(4, 0)));
    expect(toUnicode.unicode({ value: 0x41, length: 1 })).toBe('B');
    expect(resolver.stream(pdfName('Identity-H')).kind).toBe('unreadable');
  });
});
