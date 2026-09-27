import type { CMapCode } from './mappingTable.ts';
import type { CidMapping, CidSystemInfo, CodespaceRange, ParsedCMap, UnicodeMapping } from './parseCMap.ts';

import { MappingTable } from './mappingTable.ts';
import { utf16Text } from './parseCMap.ts';

/** The code a CMap reads at a position, and whether it matched a codespace range (ISO 32000-1:2008, 9.7.6.2) or was consumed by the partial-match rules for invalid codes (9.7.6.3). */
export interface CodeRead {
  readonly code: CMapCode;
  readonly valid: boolean;
}

const matchesPrefix = (range: CodespaceRange, bytes: Uint8Array, offset: number): number => {
  let matched = 0;
  while (matched < range.low.length && offset + matched < bytes.length) {
    const byte = bytes[offset + matched] ?? 0;
    if (byte < (range.low[matched] ?? 0) || byte > (range.high[matched] ?? 0)) break;
    matched++;
  }
  return matched;
};

const readValue = (bytes: Uint8Array, offset: number, length: number): number => {
  let value = 0;
  for (let index = offset; index < offset + length; index++) value = value * 256 + (bytes[index] ?? 0);
  return value;
};

const unicodeOf = (mapping: UnicodeMapping, value: number): string | undefined => {
  if ('strings' in mapping) return mapping.strings[value - mapping.low];
  const units = [...mapping.units];
  // ISO 32000-1:2008, 9.10.3: "the last byte of the string shall be incremented for each consecutive code in the source code range"; the last UTF-16 code unit is incremented as an integer, which gives the same result wherever the clause defines one.
  if (units.length > 0) units[units.length - 1] = (units.at(-1) ?? 0) + (value - mapping.low);
  return utf16Text(units.map(unit => (unit > 0xffff ? 0xfffd : unit))).text;
};

/**
 * A CMap ready for lookups: code splitting by codespace ranges, character codes to CIDs and to Unicode text, with the CMap a usecmap names as `parent`.
 * ISO 32000-1:2008, Table 120, UseCMap: "the referencing CMap shall specify only the character mappings that differ from the referenced CMap", so codespace ranges and the writing mode come from the parent unless this CMap defines its own, and a code this CMap does not map is looked up in the parent.
 */
export class CMap {
  readonly name: string | undefined;
  readonly writingMode: 0 | 1;
  readonly cidSystemInfo: CidSystemInfo | undefined;
  readonly codespaces: readonly CodespaceRange[];
  /** The name a usecmap gave for a CMap that could not be had; codes this CMap does not map are then of unknown meaning. */
  readonly unavailableParent: string | undefined;
  private readonly parent: CMap | undefined;
  private readonly cids: MappingTable<CidMapping>;
  private readonly notdefs: MappingTable<CidMapping>;
  private readonly unicodes: MappingTable<UnicodeMapping>;
  private readonly shortest: number;

  constructor(parsed: ParsedCMap, used?: CMap | { readonly unavailable: string }) {
    const parent = used instanceof CMap ? used : undefined;
    this.name = parsed.name;
    this.writingMode = parsed.writingMode ?? parent?.writingMode ?? 0;
    this.cidSystemInfo = parsed.cidSystemInfo ?? parent?.cidSystemInfo;
    this.codespaces = [...parsed.codespaces, ...(parent?.codespaces ?? [])];
    this.unavailableParent = used === undefined || used instanceof CMap ? parent?.unavailableParent : used.unavailable;
    this.parent = parent;
    this.cids = new MappingTable(parsed.cids);
    this.notdefs = new MappingTable(parsed.notdefs);
    this.unicodes = new MappingTable(parsed.unicode);
    this.shortest = Math.min(...this.codespaces.map(range => range.low.length), 4);
  }

  // 9.7.6.3: "a) If the first byte extracted from the string to be shown does not match the first byte of any codespace range, the range having the shortest codes shall be chosen."
  // "b) Otherwise …, for each additional byte extracted, the code accumulated so far shall be matched against the beginnings of all longer codespace ranges until the longest such partial match has been found. If multiple codespace ranges have partial matches of the same length, the one having the shortest codes shall be chosen."
  private invalidLength(bytes: Uint8Array, offset: number): number {
    let best = 0;
    let length = this.codespaces.length === 0 ? 1 : this.shortest;
    for (const range of this.codespaces) {
      const matched = matchesPrefix(range, bytes, offset);
      const { length: rangeLength } = range.low;
      if (matched > best || (matched === best && matched > 0 && rangeLength < length)) {
        best = matched;
        length = rangeLength;
      }
    }
    return length;
  }

  /**
   * Reads the code at `offset`. ISO 32000-1:2008, 9.7.6.2: "the first byte shall be matched against 1-byte codespace ranges; if no match is found, a second byte shall be extracted, and the 2-byte code shall be matched against 2-byte codespace ranges", up to 4 bytes.
   * A code that matches no range is consumed by the rules of 9.7.6.3 and is `valid: false`; a code cut short by the end of the string is shorter than its range.
   */
  read(bytes: Uint8Array, offset: number): CodeRead {
    const remaining = bytes.length - offset;
    for (let length = 1; length <= 4 && length <= remaining; length++) {
      for (const range of this.codespaces) {
        const valid = range.low.length === length && matchesPrefix(range, bytes, offset) === length;
        if (valid) return { code: { value: readValue(bytes, offset, length), length }, valid };
      }
    }
    const length = Math.max(1, Math.min(this.invalidLength(bytes, offset), remaining));
    return { code: { value: readValue(bytes, offset, length), length }, valid: false };
  }

  /** The CID a character mapping gives the code, here or in the CMap usecmap names, or undefined when none does. */
  mapped(code: CMapCode): number | undefined {
    const mapping = this.cids.find(code);
    if (mapping !== undefined) return mapping.cid + (code.value - mapping.low);
    return this.parent?.mapped(code);
  }

  /**
   * The CID a notdef mapping gives the code, here or in the CMap usecmap names, or undefined when none does.
   * A notdef range maps every code in it to its one CID, a substitute glyph (9.7.6.3): the 9.7.5.4 EXAMPLE maps codes <00> to <1F> to CID 231, the CID its cidrange gives the space code <20>.
   */
  notdef(code: CMapCode): number | undefined {
    const mapping = this.notdefs.find(code);
    if (mapping !== undefined) return mapping.cid;
    return this.parent?.notdef(code);
  }

  /**
   * The CID a code selects: its character mapping, else its notdef mapping, else 0.
   * ISO 32000-1:2008, 9.7.6.3: "If the CMap does not contain either a character mapping or a notdef mapping for the code, descendant 0 shall be selected and the glyph for CID 0 shall be substituted".
   */
  cid(code: CMapCode): number {
    return this.mapped(code) ?? this.notdef(code) ?? 0;
  }

  /** The text a ToUnicode CMap maps the code to (ISO 32000-1:2008, 9.10.3), or undefined when it has no mapping for it. */
  unicode(code: CMapCode): string | undefined {
    const mapping = this.unicodes.find(code);
    if (mapping !== undefined) return unicodeOf(mapping, code.value);
    return this.parent?.unicode(code);
  }
}
