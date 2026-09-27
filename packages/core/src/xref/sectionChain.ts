import type { ByteSource } from '../parse/byteSource.ts';
import type { ClassicSection } from './classicSection.ts';
import type { XrefSection } from './xrefSection.ts';
import type { StreamSection, XrefContext } from './xrefStream.ts';

import { ParseError } from '../error/parseError.ts';
import { pdfName } from '../object/pdfObject.ts';

import { readClassicSection } from './classicSection.ts';
import { sectionStartNear } from './locate.ts';
import { readXrefStream } from './xrefStream.ts';

export interface ChainedSection {
  readonly section: ClassicSection | StreamSection;
  /** The cross-reference stream a classic section's XRefStm entry names (ISO 32000-1:2008, 7.5.8.4). */
  readonly hybrid?: StreamSection;
}

export interface SectionChain {
  /** Newest first, as reached through the Prev entries. */
  readonly sections: readonly ChainedSection[];
  readonly startxrefCorrected: boolean;
  /** Whether some Prev entry links a classic section to a cross-reference stream or the reverse. */
  readonly mixed: boolean;
}

export interface ChainStart {
  readonly startxref: number;
  /** Added to every offset the file gives: the position of the header for header-relative offsets, or 0. */
  readonly shift: number;
}

const PREV = pdfName('Prev').bytes;
const XREF_STM = pdfName('XRefStm').bytes;

const XREF = [0x78, 0x72, 0x65, 0x66];

const offsetEntry = (section: XrefSection, key: Uint8Array, name: string): number | undefined => {
  const value = section.trailer.get(key);
  if (value === undefined) return undefined;
  // ISO 32000-1:2008, Table 15 gives Prev as a byte offset; 7.5.8.2 requires the values of cross-reference stream entries to be direct, and an indirect one cannot be resolved before the index exists.
  if (value.kind !== 'integer' || value.value < 0) throw new ParseError(`the ${name} entry is not a byte offset`, section.trailerStart);
  return value.value;
};

const readSection = (source: ByteSource, offset: number, context: XrefContext): ClassicSection | StreamSection => {
  const isClassic = XREF.every((byte, index) => source.byteAt(offset + index) === byte);
  return isClassic ? readClassicSection(source, offset, context) : readXrefStream(source, offset, context);
};

/**
 * Reads every cross-reference section from the one startxref names back through the Prev entries.
 * ISO 32000-1:2008, 7.5.6: "the most recent copy of each object shall be the one accessed from the file"; searchOrder gives the order in which sections are consulted.
 */
export const readSectionChain = (source: ByteSource, start: ChainStart, context: XrefContext): SectionChain => {
  const first = sectionStartNear(source, start.startxref + start.shift);
  if (first === undefined) throw new ParseError('startxref does not point at a cross-reference section', start.startxref + start.shift);
  if (first.corrected) {
    context.warn({
      code: 'startxref-corrected',
      detail: `startxref points ${String(first.offset - start.startxref - start.shift)} bytes away from the section`,
      offset: first.offset,
    });
  }
  const sections: ChainedSection[] = [];
  const visited = new Set<number>();
  let mixed = false;
  for (let offset: number | undefined = first.offset; offset !== undefined;) {
    if (visited.has(offset)) {
      context.warn({ code: 'prev-cycle', detail: 'a Prev entry points back at a section already read', offset });
      break;
    }
    visited.add(offset);
    const located = sectionStartNear(source, offset);
    if (located?.corrected !== false) throw new ParseError('a Prev entry does not point at a cross-reference section', offset);
    const section = readSection(source, located.offset, context);
    const previous = sections.at(-1)?.section;
    if (previous !== undefined && previous.kind !== section.kind) {
      mixed = true;
      context.warn({ code: 'mixed-xref-chain', detail: `a ${previous.kind} section's Prev points at a ${section.kind} section`, offset: section.offset });
    }
    const hybridOffset = section.kind === 'classic' ? offsetEntry(section, XREF_STM, 'XRefStm') : undefined;
    const hybrid = hybridOffset === undefined ? undefined : readXrefStream(source, hybridOffset + start.shift, context);
    sections.push(hybrid === undefined ? { section } : { section, hybrid });
    const prev = offsetEntry(section, PREV, 'Prev');
    offset = prev === undefined ? undefined : prev + start.shift;
  }
  return { sections, startxrefCorrected: first.corrected, mixed };
};

// ISO 32000-1:2008, 7.5.8.4: "if an entry is not found in any given standard cross-reference section, the search shall proceed to a cross-reference stream specified by the XRefStm entry before looking in the previous cross-reference section (the Prev entry in the trailer)."
export const searchOrder = (chain: SectionChain): XrefSection[] =>
  chain.sections.flatMap(({ section, hybrid }) => (hybrid === undefined ? [section] : [section, hybrid]));
