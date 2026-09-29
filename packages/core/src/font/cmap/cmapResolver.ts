import type { PdfDirectObject } from '../../object/pdfObject.ts';
import type { FontSource, PdfStream } from '../fontValues.ts';
import type { CMapProvider } from './cmapProvider.ts';
import type { CMapProblem, ParsedCMap } from './parseCMap.ts';

import { ResourceLimitError } from '../../error/resourceLimitError.ts';
import { pdfName } from '../../object/pdfObject.ts';
import { decodedData, latin1 } from '../fontValues.ts';

import { CMap } from './cmap.ts';
import { identityCMap } from './identityCMap.ts';
import { parseCMap } from './parseCMap.ts';

/** A CMap ready for lookups with the problems its parse and the parses of the CMaps it uses found; a name no provider supplied; or a CMap that cannot be read. */
export type CMapResult =
  | { readonly kind: 'cmap'; readonly cmap: CMap; readonly problems: readonly CMapProblem[] }
  | { readonly kind: 'unavailable'; readonly name: string }
  | { readonly kind: 'unreadable'; readonly reason: string };

const USE_CMAP = pdfName('UseCMap').bytes;

const build = (parsed: ParsedCMap, used: CMapResult | undefined): CMapResult => {
  if (used === undefined) return { kind: 'cmap', cmap: new CMap(parsed), problems: parsed.problems };
  if (used.kind === 'unreadable') return used;
  if (used.kind === 'unavailable') return { kind: 'cmap', cmap: new CMap(parsed, { unavailable: used.name }), problems: parsed.problems };
  return { kind: 'cmap', cmap: new CMap(parsed, used.cmap), problems: [...parsed.problems, ...used.problems] };
};

// A provider's file with no codespace range, mapping or usecmap, such as empty or unparsable bytes, supplies nothing, so the CMap is still not available.
const definesNothing = (parsed: ParsedCMap): boolean =>
  parsed.useCMap === undefined && [parsed.codespaces, parsed.cids, parsed.notdefs, parsed.unicode].every(entries => entries.length === 0);

/**
 * Resolves the CMaps of one document: Identity-H and Identity-V built in, other names through the caller's provider (a file that defines nothing counts as not supplied), embedded CMap streams from the document, each with the CMap its usecmap operator or UseCMap entry names.
 * Results are cached by name and by stream reference. A usecmap cycle makes every CMap on it unreadable; a chain deeper than the document's `maxNesting` throws ResourceLimitError, and so does a stream that decodes past `maxDecodedBytes` or a CMap past its entry limit.
 */
export class CMapResolver {
  private readonly document: FontSource;
  private readonly provider: CMapProvider | undefined;
  private readonly results = new Map<string, CMapResult>();
  private readonly resolving = new Set<string>();

  constructor(document: FontSource, provider: CMapProvider | undefined) {
    this.document = document;
    this.provider = provider;
  }

  private cached(key: string, load: () => CMapResult): CMapResult {
    const known = this.results.get(key);
    if (known !== undefined) return known;
    // ISO 32000-1:2008, Table 120, UseCMap names the CMap this one differs from; a CMap that uses itself, directly or through others, defines nothing.
    if (this.resolving.has(key)) return { kind: 'unreadable', reason: 'the CMaps that usecmap names form a cycle' };
    const { maxNesting } = this.document;
    if (this.resolving.size >= maxNesting) throw new ResourceLimitError(`usecmap chains deeper than maxNesting (${String(maxNesting)})`);
    this.resolving.add(key);
    try {
      const result = load();
      this.results.set(key, result);
      return result;
    } finally {
      this.resolving.delete(key);
    }
  }

  /** A predefined CMap by name: Identity-H and Identity-V built in, any other name from the provider. */
  named(name: string): CMapResult {
    return this.cached(`name:${name}`, () => {
      if (name === 'Identity-H' || name === 'Identity-V') return { kind: 'cmap', cmap: identityCMap(name), problems: [] };
      const bytes = this.provider?.cmap(name);
      if (bytes === undefined) return { kind: 'unavailable', name };
      const parsed = parseCMap(bytes, this.document.maxNesting);
      if (definesNothing(parsed)) return { kind: 'unavailable', name };
      return build(parsed, parsed.useCMap === undefined ? undefined : this.named(parsed.useCMap));
    });
  }

  // The stream dictionary's UseCMap entry, a name or a stream, is preferred to the file's usecmap operator; 9.7.5.4 a) requires them to name the same CMap.
  private embedded(stream: PdfStream): CMapResult {
    const bytes = decodedData(this.document, stream);
    if (typeof bytes === 'string') return { kind: 'unreadable', reason: bytes };
    const parsed = parseCMap(bytes, this.document.maxNesting);
    const entry = stream.dictionary.get(USE_CMAP);
    if (entry !== undefined) return build(parsed, this.encoding(entry));
    return build(parsed, parsed.useCMap === undefined ? undefined : this.named(parsed.useCMap));
  }

  /** An embedded CMap stream, as a ToUnicode entry requires (9.10.3); a name or any other value is unreadable there. */
  stream(value: PdfDirectObject | undefined): CMapResult {
    const resolved = this.document.objects.deref(value);
    if (resolved?.kind !== 'stream') return { kind: 'unreadable', reason: 'the CMap is not a stream' };
    if (value?.kind !== 'reference') return this.embedded(resolved);
    return this.cached(`stream:${String(value.objectNumber)}.${String(value.generation)}`, () => this.embedded(resolved));
  }

  /** A Type 0 font's Encoding or a CMap's UseCMap: "a name object identifying a predefined CMap" or "a stream object whose contents shall be a CMap file" (ISO 32000-1:2008, 9.7.5.1). */
  encoding(value: PdfDirectObject | undefined): CMapResult {
    const resolved = this.document.objects.deref(value);
    if (resolved?.kind === 'name') return this.named(latin1(resolved.bytes));
    return this.stream(value);
  }
}
