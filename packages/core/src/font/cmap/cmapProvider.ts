/**
 * Supplies predefined CMap files, which pdfwright does not bundle apart from Identity-H and Identity-V.
 * A caller loads the files it needs, such as Adobe's `cmap-resources` and `mapping-resources-pdf` repositories publish them, before it inspects a document; the call is synchronous because text extraction is.
 */
export interface CMapProvider {
  /** The bytes of a predefined CMap file (ISO 32000-1:2008, Table 118) or of a registry–ordering–UCS2 map (9.10.2), or undefined when not available. */
  readonly cmap: (name: string) => Uint8Array | undefined;
}

/** ISO 32000-1:2008, 9.7.5.2, Table 118 – Predefined CJK CMap names. */
export const PREDEFINED_CMAPS: ReadonlySet<string> = new Set(
  [
    'GB-EUC-H GB-EUC-V GBpc-EUC-H GBpc-EUC-V GBK-EUC-H GBK-EUC-V GBKp-EUC-H GBKp-EUC-V GBK2K-H GBK2K-V UniGB-UCS2-H UniGB-UCS2-V UniGB-UTF16-H UniGB-UTF16-V',
    'B5pc-H B5pc-V HKscs-B5-H HKscs-B5-V ETen-B5-H ETen-B5-V ETenms-B5-H ETenms-B5-V CNS-EUC-H CNS-EUC-V UniCNS-UCS2-H UniCNS-UCS2-V UniCNS-UTF16-H UniCNS-UTF16-V',
    '83pv-RKSJ-H 90ms-RKSJ-H 90ms-RKSJ-V 90msp-RKSJ-H 90msp-RKSJ-V 90pv-RKSJ-H Add-RKSJ-H Add-RKSJ-V EUC-H EUC-V Ext-RKSJ-H Ext-RKSJ-V H V',
    'UniJIS-UCS2-H UniJIS-UCS2-V UniJIS-UCS2-HW-H UniJIS-UCS2-HW-V UniJIS-UTF16-H UniJIS-UTF16-V',
    'KSC-EUC-H KSC-EUC-V KSCms-UHC-H KSCms-UHC-V KSCms-UHC-HW-H KSCms-UHC-HW-V KSCpc-EUC-H UniKS-UCS2-H UniKS-UCS2-V UniKS-UTF16-H UniKS-UTF16-V',
    'Identity-H Identity-V',
  ].flatMap(group => group.split(' ')),
);
