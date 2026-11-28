/**
 * Supplies predefined CMap files, which pdfwright does not bundle apart from Identity-H and Identity-V.
 * A caller loads the files it needs, such as Adobe's `cmap-resources` and `mapping-resources-pdf` repositories publish them, before it inspects a document; the call is synchronous because text extraction is.
 */
export interface CMapProvider {
  /** The bytes of a predefined CMap file (ISO 32000-1:2008, Table 118) or of a registry–ordering–UCS2 map (9.10.2), or undefined when not available. */
  readonly cmap: (name: string) => Uint8Array | undefined;
}
