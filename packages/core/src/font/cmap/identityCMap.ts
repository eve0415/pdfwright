import { CMap } from './cmap.ts';

const ADOBE = Uint8Array.from('Adobe', character => character.codePointAt(0) ?? 0);
const IDENTITY = Uint8Array.from('Identity', character => character.codePointAt(0) ?? 0);

/**
 * The predefined Identity-H or Identity-V CMap, built in rather than parsed.
 * ISO 32000-1:2008, 9.7.5.2, Table 118: Identity-H "maps 2-byte character codes ranging from 0 to 65,535 to the same 2-byte CID value, interpreted high-order byte first"; Identity-V is the "Vertical version of Identity-H. The mapping is the same as for Identity-H."
 * Table 119 gives both the character collection Adobe-Identity-0.
 */
export const identityCMap = (name: 'Identity-H' | 'Identity-V'): CMap =>
  new CMap({
    name,
    writingMode: name === 'Identity-V' ? 1 : 0,
    cidSystemInfo: { registry: ADOBE, ordering: IDENTITY, supplement: 0 },
    useCMap: undefined,
    codespaces: [{ low: Uint8Array.of(0x00, 0x00), high: Uint8Array.of(0xff, 0xff) }],
    cids: [{ length: 2, low: 0, high: 0xffff, cid: 0 }],
    notdefs: [],
    unicode: [],
    problems: [],
  });
