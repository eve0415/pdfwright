import { ValidationError } from '../../error/validationError.ts';
import { DC_NAMESPACE, PDFX_ID_NAMESPACE, PDF_NAMESPACE, XMP_MM_NAMESPACE, XMP_NAMESPACE } from '../mapping.ts';

import { RDF_NAMESPACE } from './readXmp.ts';

/** The values of the properties a metadata edit manages, already resolved and formatted; undefined leaves a property out. */
export interface ManagedValues {
  readonly title: string | undefined;
  readonly author: string | undefined;
  readonly subject: string | undefined;
  readonly keywords: string | undefined;
  readonly creator: string | undefined;
  readonly producer: string | undefined;
  readonly trapped: 'True' | 'False' | undefined;
  readonly createDate: string | undefined;
  readonly modifyDate: string;
  readonly metadataDate: string;
  readonly documentId: string;
  readonly instanceId: string;
  readonly pdfxVersion?: 'PDF/X-4' | undefined;
  readonly versionId?: string | undefined;
  readonly renditionClass?: string | undefined;
}

// XML 1.0 (Fifth Edition), 2.2, production [2] Char: C0 controls other than tab, line feed and carriage return, surrogates, U+FFFE and U+FFFF cannot appear in XML text, even as references.
const UNREPRESENTABLE = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/u;

// XML 1.0, 2.4: & and < are escaped in character data, and > so that ]]> cannot occur; 2.11: a carriage return is written as a reference, since a literal one reads back as a line feed.
const escapeText = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;');

// XML 1.0, 3.3.3: white space in an attribute value reads back as a space, so it is written as references.
const escapeAttribute = (value: string): string => escapeText(value).replaceAll('"', '&quot;').replaceAll('\t', '&#9;').replaceAll('\n', '&#10;');

/** Throws ValidationError xmp-unrepresentable when a value holds a character XML 1.0 cannot carry, which the Info string could hold but the packet could not. */
export const checkRepresentable = (values: ManagedValues): void => {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string' && UNREPRESENTABLE.test(value)) {
      throw new ValidationError(`the ${name} value holds a character that XML 1.0 cannot represent`, 'xmp-unrepresentable');
    }
  }
};

const simple = (name: string, value: string | undefined): string[] => (value === undefined ? [] : [`<${name}>${escapeText(value)}</${name}>`]);

// XMP Part 1 8.2.2.4: a Language Alternative is an rdf:Alt whose items carry xml:lang, with x-default for the default value.
const alternative = (name: string, value: string | undefined): string[] =>
  value === undefined ? [] : [`<${name}><rdf:Alt><rdf:li xml:lang="x-default">${escapeText(value)}</rdf:li></rdf:Alt></${name}>`];

// XMP Part 1 8.3: dc:creator is an ordered array, "An entity primarily responsible for making the resource".
const sequence = (name: string, value: string | undefined): string[] =>
  value === undefined ? [] : [`<${name}><rdf:Seq><rdf:li>${escapeText(value)}</rdf:li></rdf:Seq></${name}>`];

/** The managed properties, one per line, in their fixed order. */
const managedProperties = (values: ManagedValues): string[] => [
  ...alternative('dc:title', values.title),
  ...sequence('dc:creator', values.author),
  ...alternative('dc:description', values.subject),
  ...simple('pdf:Keywords', values.keywords),
  ...simple('pdf:Producer', values.producer),
  ...simple('pdf:Trapped', values.trapped),
  ...simple('xmp:CreatorTool', values.creator),
  ...simple('xmp:CreateDate', values.createDate),
  ...simple('xmp:ModifyDate', values.modifyDate),
  ...simple('xmp:MetadataDate', values.metadataDate),
  ...simple('xmpMM:DocumentID', values.documentId),
  ...simple('xmpMM:InstanceID', values.instanceId),
  ...simple('xmpMM:VersionID', values.versionId),
  ...simple('xmpMM:RenditionClass', values.renditionClass),
  ...simple('pdfxid:GTS_PDFXVersion', values.pdfxVersion),
];

export interface DescriptionOptions {
  /** The rdf:about value, which XMP Part 1 7.4 requires to be the same on every top-level rdf:Description. */
  readonly about: string;
  /** Declare the rdf prefix on the element itself, for insertion into a packet that may bind it elsewhere. */
  readonly declareRdf: boolean;
  /** Set xml:lang to empty, so that a language set on an enclosing element does not apply to the new values. */
  readonly resetLanguage: boolean;
}

/** An rdf:Description element holding the managed properties, with every namespace it uses declared on itself. */
export const managedDescription = (values: ManagedValues, options: DescriptionOptions): string => {
  checkRepresentable(values);
  const declarations = [
    ...(options.declareRdf ? [`xmlns:rdf="${RDF_NAMESPACE}"`] : []),
    `xmlns:dc="${DC_NAMESPACE}"`,
    `xmlns:xmp="${XMP_NAMESPACE}"`,
    `xmlns:pdf="${PDF_NAMESPACE}"`,
    `xmlns:xmpMM="${XMP_MM_NAMESPACE}"`,
    ...(values.pdfxVersion === undefined ? [] : [`xmlns:pdfxid="${PDFX_ID_NAMESPACE}"`]),
    ...(options.resetLanguage ? ['xml:lang=""'] : []),
  ];
  return [`<rdf:Description rdf:about="${escapeAttribute(options.about)}" ${declarations.join(' ')}>`, ...managedProperties(values), '</rdf:Description>'].join(
    '\n',
  );
};

/**
 * A new packet holding only the managed properties, deterministic byte for byte: UTF-8, line feeds, the byte-order mark in begin, and no padding.
 * XMP Part 1 7.2 NOTE 3 says padding "facilitates modification of the XMP packet in-place"; every edit here writes a new stream body instead.
 */
export const newPacket = (values: ManagedValues): Uint8Array =>
  new TextEncoder().encode(
    [
      '<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      `<rdf:RDF xmlns:rdf="${RDF_NAMESPACE}">`,
      managedDescription(values, { about: '', declareRdf: false, resetLanguage: false }),
      '</rdf:RDF>',
      '</x:xmpmeta>',
      '<?xpacket end="w"?>',
    ].join('\n'),
  );
