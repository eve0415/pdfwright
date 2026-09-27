import type { ContentOperand } from '../../content/contentOperations.ts';
import type { PdfDirectObject } from '../../object/pdfObject.ts';

import { readContent } from '../../content/contentOperations.ts';
import { ParseError } from '../../error/parseError.ts';
import { ResourceLimitError } from '../../error/resourceLimitError.ts';
import { pdfName } from '../../object/pdfObject.ts';

/** The most codespace ranges, character mappings and notdef mappings one CMap may define; more throws ResourceLimitError. */
export const MAX_CMAP_ENTRIES = 65_536;

/** A codespace range: codes of the bounds' length whose every byte lies between the corresponding bytes of the bounds (ISO 32000-1:2008, 9.7.6.2). */
export interface CodespaceRange {
  readonly low: Uint8Array;
  readonly high: Uint8Array;
}

/** Consecutive codes of one length, as big-endian numbers from `low` to `high`; a single-code mapping has `low` equal to `high`. */
export interface CodeRange {
  readonly length: number;
  readonly low: number;
  readonly high: number;
}

/** A cidchar, cidrange, notdefchar or notdefrange mapping: in a cidrange, code `low + i` selects CID `cid + i`. */
export interface CidMapping extends CodeRange {
  readonly cid: number;
}

/**
 * A bfchar or bfrange mapping to text (ISO 32000-1:2008, 9.10.3).
 * `units` is the UTF-16 destination of a bfchar or of a bfrange with a string destination, whose last code unit is incremented for each code after `low`; `strings` is the decoded array destination of a bfrange.
 */
export type UnicodeMapping = (CodeRange & { readonly units: readonly number[] }) | (CodeRange & { readonly strings: readonly (string | undefined)[] });

export interface CidSystemInfo {
  readonly registry: Uint8Array | undefined;
  readonly ordering: Uint8Array | undefined;
  readonly supplement: number | undefined;
}

/** Damage a CMap parse found: `damaged` for an entry or token it skipped, `range-overflow` for a bfrange string destination past the bound of 9.10.3. */
export interface CMapProblem {
  readonly kind: 'damaged' | 'range-overflow';
  readonly detail: string;
}

/** A CMap file's definitions, in the order read, before any usecmap is resolved. */
export interface ParsedCMap {
  readonly name: string | undefined;
  readonly writingMode: 0 | 1 | undefined;
  readonly cidSystemInfo: CidSystemInfo | undefined;
  /** The name a usecmap operator gives. */
  readonly useCMap: string | undefined;
  readonly codespaces: readonly CodespaceRange[];
  readonly cids: readonly CidMapping[];
  readonly notdefs: readonly CidMapping[];
  readonly unicode: readonly UnicodeMapping[];
  readonly problems: readonly CMapProblem[];
}

const REGISTRY = pdfName('Registry').bytes;
const ORDERING = pdfName('Ordering').bytes;
const SUPPLEMENT = pdfName('Supplement').bytes;

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const codeValue = (bytes: Uint8Array): number => {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
};

const hexOf = (bytes: Uint8Array): string => `<${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}>`;

// ISO 32000-1:2008, 9.7.6.2: "The code length shall not be greater than 4."
const codeBytes = (operand: ContentOperand | undefined): Uint8Array | undefined =>
  operand?.kind === 'string' && operand.bytes.length > 0 && operand.bytes.length <= 4 ? operand.bytes : undefined;

const integerOf = (operand: ContentOperand | undefined): number | undefined => (operand?.kind === 'integer' && operand.value >= 0 ? operand.value : undefined);

/** UTF-16 code units of a big-endian byte string; an odd leading byte is read as a unit of its own, as a 1-byte destination such as `<41>` means U+0041. */
const utf16Units = (bytes: Uint8Array): number[] => {
  const units: number[] = [];
  const start = bytes.length % 2;
  if (start === 1) units.push(bytes[0] ?? 0);
  for (let index = start; index + 1 < bytes.length; index += 2) units.push((bytes[index] ?? 0) * 256 + (bytes[index + 1] ?? 0));
  return units;
};

const isHigh = (unit: number | undefined): boolean => unit !== undefined && unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number | undefined): boolean => unit !== undefined && unit >= 0xdc00 && unit <= 0xdfff;

/** Text of UTF-16 code units with surrogate pairs joined. */
/** Text decoded from UTF-16, and whether a lone surrogate in it became U+FFFD. */
export interface Utf16Text {
  readonly text: string;
  readonly unpaired: boolean;
}

export const utf16Text = (units: readonly number[]): Utf16Text => {
  let text = '';
  let unpaired = false;
  for (let index = 0; index < units.length; index++) {
    const unit = units[index] ?? 0;
    const next = units[index + 1];
    if (isHigh(unit) && isLow(next)) {
      text += String.fromCodePoint(0x10000 + (unit - 0xd800) * 1024 + ((next ?? 0) - 0xdc00));
      index++;
    } else if (isHigh(unit) || isLow(unit)) {
      text += '�';
      unpaired = true;
    } else text += String.fromCodePoint(unit);
  }
  return { text, unpaired };
};

class CMapReader {
  name: string | undefined = undefined;
  writingMode: 0 | 1 | undefined = undefined;
  useCMap: string | undefined = undefined;
  registry: Uint8Array | undefined = undefined;
  ordering: Uint8Array | undefined = undefined;
  supplement: number | undefined = undefined;
  hasSystemInfo = false;
  readonly codespaces: CodespaceRange[] = [];
  readonly cids: CidMapping[] = [];
  readonly notdefs: CidMapping[] = [];
  readonly unicode: UnicodeMapping[] = [];
  readonly problems: CMapProblem[] = [];
  private entries = 0;

  private count(): void {
    this.entries++;
    if (this.entries > MAX_CMAP_ENTRIES) throw new ResourceLimitError(`a CMap defines more than ${String(MAX_CMAP_ENTRIES)} entries`);
  }

  damaged(detail: string): void {
    this.problems.push({ kind: 'damaged', detail });
  }

  private systemInfo(entries: Extract<PdfDirectObject, { kind: 'dictionary' }>['entries']): void {
    const registry = entries.get(REGISTRY);
    const ordering = entries.get(ORDERING);
    const supplement = entries.get(SUPPLEMENT);
    this.hasSystemInfo = true;
    if (registry?.kind === 'string') this.registry = registry.bytes;
    if (ordering?.kind === 'string') this.ordering = ordering.bytes;
    if (supplement?.kind === 'integer') this.supplement = supplement.value;
  }

  // `/Key value def`, at the top level or inside the `3 dict dup begin … end def` form that Adobe's CMap files use for CIDSystemInfo (9.7.5.4, EXAMPLE).
  define(operands: readonly ContentOperand[]): void {
    const key = operands.at(-2);
    const value = operands.at(-1);
    if (key?.kind !== 'name' || value === undefined) return;
    const name = latin1(key.bytes);
    if (name === 'CMapName' && value.kind === 'name') this.name = latin1(value.bytes);
    else if (name === 'WMode' && value.kind === 'integer' && (value.value === 0 || value.value === 1)) this.writingMode = value.value;
    else if (name === 'CIDSystemInfo' && value.kind === 'dictionary') this.systemInfo(value.entries);
    else if (name === 'Registry' && value.kind === 'string') {
      this.hasSystemInfo = true;
      this.registry = value.bytes;
    } else if (name === 'Ordering' && value.kind === 'string') {
      this.hasSystemInfo = true;
      this.ordering = value.bytes;
    } else if (name === 'Supplement' && value.kind === 'integer') {
      this.hasSystemInfo = true;
      this.supplement = value.value;
    }
  }

  codespaceRanges(operands: readonly ContentOperand[]): void {
    for (let index = 0; index + 1 < operands.length; index += 2) {
      const low = codeBytes(operands[index]);
      const high = codeBytes(operands[index + 1]);
      this.count();
      if (low === undefined || high === undefined || low.length !== high.length) this.damaged('a codespace range is not two codes of one length');
      else this.codespaces.push({ low, high });
    }
    if (operands.length % 2 !== 0) this.damaged('a codespace range has no upper bound');
  }

  // cidchar and notdefchar entries are `code CID`; cidrange and notdefrange entries are `low high CID` (9.7.5.4, EXAMPLE).
  cidMappings(operands: readonly ContentOperand[], range: boolean, target: CidMapping[]): void {
    const size = range ? 3 : 2;
    for (let index = 0; index + size - 1 < operands.length; index += size) {
      const low = codeBytes(operands[index]);
      const high = range ? codeBytes(operands[index + 1]) : low;
      const cid = integerOf(operands[index + size - 1]);
      this.count();
      if (low === undefined || high === undefined || cid === undefined || low.length !== high.length || codeValue(low) > codeValue(high)) {
        this.damaged(`a CID mapping at ${hexOf(low ?? new Uint8Array())} is malformed`);
      } else target.push({ length: low.length, low: codeValue(low), high: codeValue(high), cid });
    }
    if (operands.length % size !== 0) this.damaged('a CID mapping is incomplete');
  }

  private destination(bytes: Uint8Array): Utf16Text & { readonly units: readonly number[] } {
    const units = utf16Units(bytes);
    const decoded = utf16Text(units);
    if (decoded.unpaired) this.damaged(`the destination ${hexOf(bytes)} has an unpaired surrogate`);
    return { ...decoded, units };
  }

  bfChars(operands: readonly ContentOperand[]): void {
    for (let index = 0; index + 1 < operands.length; index += 2) {
      const source = codeBytes(operands[index]);
      const target = operands[index + 1];
      this.count();
      if (source === undefined || target?.kind !== 'string') this.damaged('a bfchar entry is not a code and a string');
      else {
        const value = codeValue(source);
        this.unicode.push({ length: source.length, low: value, high: value, units: this.destination(target.bytes).units });
      }
    }
    if (operands.length % 2 !== 0) this.damaged('a bfchar entry is incomplete');
  }

  // ISO 32000-1:2008, 9.10.3: "the value of the last byte in the string shall be less than or equal to 255 − (srcCode2 − srcCode1)"; "otherwise, the result of mapping is undefined."
  private stringRange(range: CodeRange, bytes: Uint8Array): void {
    const { units } = this.destination(bytes);
    const last = bytes.at(-1) ?? 0;
    const span = range.high - range.low;
    if (last + span > 255) this.problems.push({ kind: 'range-overflow', detail: `the bfrange ${hexOf(bytes)} passes byte 255 over ${String(span + 1)} codes` });
    this.unicode.push({ ...range, units });
  }

  // "Consecutive codes starting with srcCode1 and ending with srcCode2 shall be mapped to the destination strings in the array starting with dstString1 and ending with dstStringm."
  private arrayRange(range: CodeRange, items: readonly PdfDirectObject[]): void {
    const count = range.high - range.low + 1;
    const strings = items.slice(0, count).map(item => (item.kind === 'string' ? this.destination(item.bytes).text : undefined));
    if (strings.includes(undefined)) this.damaged('a bfrange array holds a value that is not a string');
    if (items.length < count) this.damaged(`a bfrange array has ${String(items.length)} strings for ${String(count)} codes`);
    this.unicode.push({ ...range, strings });
  }

  bfRanges(operands: readonly ContentOperand[]): void {
    for (let index = 0; index + 2 < operands.length; index += 3) {
      const low = codeBytes(operands[index]);
      const high = codeBytes(operands[index + 1]);
      const target = operands[index + 2];
      this.count();
      const range =
        low === undefined || high === undefined || low.length !== high.length ? undefined : { length: low.length, low: codeValue(low), high: codeValue(high) };
      if (range === undefined || range.low > range.high) this.damaged('a bfrange has malformed bounds');
      else if (target?.kind === 'string') this.stringRange(range, target.bytes);
      else if (target?.kind === 'array') this.arrayRange(range, target.items);
      else this.damaged('a bfrange destination is not a string or an array');
    }
    if (operands.length % 3 !== 0) this.damaged('a bfrange entry is incomplete');
  }

  operation(operator: string, operands: readonly ContentOperand[]): void {
    switch (operator) {
      case 'def': {
        this.define(operands);
        break;
      }
      case 'usecmap': {
        const name = operands.at(-1);
        if (name?.kind === 'name') this.useCMap = latin1(name.bytes);
        else this.damaged('usecmap is not preceded by a name');
        break;
      }
      case 'endcodespacerange': {
        this.codespaceRanges(operands);
        break;
      }
      case 'endcidchar': {
        this.cidMappings(operands, false, this.cids);
        break;
      }
      case 'endcidrange': {
        this.cidMappings(operands, true, this.cids);
        break;
      }
      case 'endnotdefchar': {
        this.cidMappings(operands, false, this.notdefs);
        break;
      }
      case 'endnotdefrange': {
        this.cidMappings(operands, true, this.notdefs);
        break;
      }
      case 'endbfchar': {
        this.bfChars(operands);
        break;
      }
      case 'endbfrange': {
        this.bfRanges(operands);
        break;
      }
      default: {
        // The PostScript around the mappings (findresource, begincmap, defineresource and the like) defines nothing a PDF reader uses.
        break;
      }
    }
  }

  result(): ParsedCMap {
    return {
      name: this.name,
      writingMode: this.writingMode,
      cidSystemInfo: this.hasSystemInfo ? { registry: this.registry, ordering: this.ordering, supplement: this.supplement } : undefined,
      useCMap: this.useCMap,
      codespaces: this.codespaces,
      cids: this.cids,
      notdefs: this.notdefs,
      unicode: this.unicode,
      problems: this.problems,
    };
  }
}

/**
 * Parses a CMap file: an embedded CMap (ISO 32000-1:2008, 9.7.5.3), a ToUnicode CMap, which "shall follow the syntax for CMaps introduced in 9.7.5" (9.10.3), or a predefined CMap a provider supplies.
 * The file is read as PDF tokens, operands before the operator that uses them; the PostScript procedures around the mappings are skipped.
 * Damage never throws: a token that cannot be lexed ends the parse and entries that are malformed are skipped, each recorded in `problems`.
 * More than MAX_CMAP_ENTRIES entries, or operands nested deeper than `maxNesting`, throw ResourceLimitError.
 */
export const parseCMap = (bytes: Uint8Array, maxNesting: number): ParsedCMap => {
  const reader = new CMapReader();
  try {
    for (const { operator, operands } of readContent(bytes, maxNesting)) reader.operation(operator, operands);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    reader.damaged(`the CMap cannot be read past byte ${String(error.offset)}: ${error.message}`);
  }
  return reader.result();
};
