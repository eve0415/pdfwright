import type { XmlAttribute, XmlEncoding, XmlRefusal, XmlSpan, XmlToken } from './xmlTokenizer.ts';

import { DEFAULT_XML_LIMITS, decodeXml, tokenizeXml } from './xmlTokenizer.ts';

export const RDF_NAMESPACE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

/** One item of an XMP array, with the xml:lang in effect for it. */
export interface XmpArrayItem {
  readonly text: string;
  readonly language: string | undefined;
}

/** A property value as far as metadata mapping reads it: simple text, a URI, an array of simple items, or anything else, which is never interpreted. */
export type XmpValue =
  | { readonly kind: 'text'; readonly text: string; readonly language: string | undefined }
  | { readonly kind: 'uri'; readonly uri: string }
  | { readonly kind: 'array'; readonly type: 'Alt' | 'Seq' | 'Bag'; readonly items: readonly XmpArrayItem[] }
  | { readonly kind: 'opaque' };

export interface XmpProperty {
  readonly namespace: string;
  readonly localName: string;
  /** An element in an rdf:Description, or an attribute of one (the shorthand of XMP Part 1 7.9.2.2). */
  readonly form: 'element' | 'attribute';
  /** Where the property is in the packet bytes: the element from its start tag through its end tag, or the attribute. */
  readonly span: XmlSpan;
  readonly value: XmpValue;
}

export type XmpFindingCode = 'xmp-not-utf8' | 'rdf-about-unprefixed' | 'rdf-about-mismatch' | 'duplicate-property';

export interface XmpFinding {
  readonly code: XmpFindingCode;
  readonly detail: string;
}

export interface XmpPacket {
  readonly encoding: XmlEncoding;
  /** Whether the packet has the header and which trailer it has (XMP Part 1 7.3.2). */
  readonly wrapper: { readonly begin: boolean; readonly end: 'r' | 'w' | undefined };
  /** The non-empty rdf:about of the top-level rdf:Description elements, or empty. */
  readonly subject: string;
  /** The top-level properties in document order. */
  readonly properties: readonly XmpProperty[];
  readonly findings: readonly XmpFinding[];
}

/** A property with its place in the decoded text, for editing. */
export interface ReadProperty extends XmpProperty {
  readonly textSpan: XmlSpan;
}

/** A packet as read, with what an edit of it needs: the decoded text and where the rdf:RDF element ends. */
export interface ReadPacket extends XmpPacket {
  readonly text: string;
  readonly properties: readonly ReadProperty[];
  /** Offset of the rdf:RDF end tag in the text, or of the "/>" that closes it when it is an empty-element tag. */
  readonly rdfEnd: number;
  /** The qualified name of rdf:RDF as written when it is an empty-element tag, else undefined. */
  readonly rdfEmptyTag: string | undefined;
  /** The xml:lang in effect inside rdf:RDF, which a new rdf:Description would inherit. */
  readonly rdfLanguage: string | undefined;
}

/** Why a packet cannot be read: its XML is refused, its bytes do not decode, or its structure is not the RDF subset of XMP Part 1 7.4. */
export type XmpUnreadableReason = XmlRefusal | 'undecodable' | 'unbound-prefix' | 'no-rdf' | 'multiple-rdf' | 'not-xmp';

export type ReadXmp = { readonly ok: true; readonly packet: ReadPacket } | { readonly ok: false; readonly reason: XmpUnreadableReason };

interface Attribute extends XmlAttribute {
  readonly namespace: string | undefined;
  readonly localName: string;
}

interface XmlElement {
  /** The qualified name as written. */
  readonly name: string;
  readonly selfClosing: boolean;
  readonly namespace: string | undefined;
  readonly localName: string;
  readonly attributes: readonly Attribute[];
  readonly language: string | undefined;
  readonly children: XmlElement[];
  /** Character data and CDATA directly inside the element, in order. */
  readonly text: string[];
  /** Array items are collected when each rdf:li closes, so the tree does not retain a node for every item. */
  arrayItems?: XmpArrayItem[];
  arrayInvalid?: boolean;
  readonly span: { start: number; end: number };
  endTagStart: number;
}

class UnreadableError extends Error {
  readonly reason: XmpUnreadableReason;

  constructor(reason: XmpUnreadableReason) {
    super(reason);
    this.name = 'UnreadableError';
    this.reason = reason;
  }
}

const splitName = (name: string): readonly [string, string] => {
  const colon = name.indexOf(':');
  if (name === '' || colon === 0 || colon === name.length - 1 || (colon !== -1 && name.includes(':', colon + 1))) {
    throw new UnreadableError('not-well-formed');
  }
  return colon === -1 ? ['', name] : [name.slice(0, colon), name.slice(colon + 1)];
};

// Namespaces in XML 1.0, 3 and 6: xmlns and xmlns:p attributes declare namespaces for the element and its content; xml is bound to its fixed URI.
const declarations = (attributes: readonly XmlAttribute[], scope: ReadonlyMap<string, string>): ReadonlyMap<string, string> => {
  const declared = attributes.filter(attribute => attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:'));
  if (declared.length === 0) return scope;
  const next = new Map(scope);
  for (const attribute of declared) {
    const prefix = attribute.name === 'xmlns' ? '' : attribute.name.slice(6);
    if (
      prefix === 'xmlns' ||
      (prefix === 'xml') !== (attribute.value === XML_NAMESPACE) ||
      attribute.value === XMLNS_NAMESPACE ||
      (prefix !== '' && prefix.includes(':'))
    ) {
      throw new UnreadableError('not-well-formed');
    }
    // Namespaces in XML 1.0, 3, Namespace constraint No Prefix Undeclaring: "In a namespace declaration for a prefix (i.e., where the NSAttName is a PrefixedAttName), the attribute value MUST NOT be empty."
    if (attribute.name !== 'xmlns' && attribute.value === '') throw new UnreadableError('not-well-formed');
    next.set(prefix, attribute.value);
  }
  return next;
};

const resolve = (prefix: string, scope: ReadonlyMap<string, string>, isAttribute: boolean): string | undefined => {
  if (prefix === 'xml') return XML_NAMESPACE;
  if (prefix === 'xmlns') return XMLNS_NAMESPACE;
  // Namespaces in XML 1.0, 6.2: an unprefixed attribute is in no namespace, whatever the default namespace.
  if (prefix === '' && isAttribute) return undefined;
  const namespace = scope.get(prefix);
  if (namespace === undefined && prefix !== '') throw new UnreadableError('unbound-prefix');
  return namespace === '' ? undefined : namespace;
};

interface OpenElement {
  readonly element: XmlElement;
  readonly scope: ReadonlyMap<string, string>;
}

const openElement = (token: Extract<XmlToken, { kind: 'start' }>, parent: OpenElement | undefined): OpenElement => {
  const scope = declarations(token.attributes, parent?.scope ?? new Map<string, string>());
  const [prefix, localName] = splitName(token.name);
  const attributes = token.attributes.map(attribute => {
    const [attributePrefix, attributeLocal] = splitName(attribute.name);
    return { ...attribute, namespace: resolve(attributePrefix, scope, true), localName: attributeLocal };
  });
  const lang = attributes.find(attribute => attribute.namespace === XML_NAMESPACE && attribute.localName === 'lang');
  const element: XmlElement = {
    name: token.name,
    selfClosing: token.selfClosing,
    namespace: resolve(prefix, scope, false),
    localName,
    attributes,
    language: lang === undefined ? parent?.element.language : lang.value,
    children: [],
    text: [],
    span: { start: token.span.start, end: token.span.end },
    endTagStart: token.span.end,
  };
  parent?.element.children.push(element);
  return { element, scope };
};

const isDeclaration = (attribute: Attribute): boolean => attribute.namespace === XMLNS_NAMESPACE || attribute.name === 'xmlns';
const language = (value: string | undefined): string | undefined => (value === '' ? undefined : value);

const collectArrayItem = (parent: XmlElement | undefined, item: XmlElement): void => {
  if (parent?.namespace !== RDF_NAMESPACE || !['Alt', 'Seq', 'Bag'].includes(parent.localName)) return;
  parent.children.pop();
  const qualified = item.attributes.some(attribute => !isDeclaration(attribute) && !(attribute.namespace === XML_NAMESPACE && attribute.localName === 'lang'));
  if (item.namespace !== RDF_NAMESPACE || item.localName !== 'li' || item.children.length > 0 || qualified) {
    parent.arrayInvalid = true;
    return;
  }
  parent.arrayItems ??= [];
  parent.arrayItems.push({ text: item.text.join(''), language: language(item.language) });
};

// Builds the element tree with a stack; the tokenizer has already bounded the depth.
const buildTree = (tokens: readonly XmlToken[]): readonly XmlElement[] => {
  const rdfs: XmlElement[] = [];
  const stack: OpenElement[] = [];
  for (const token of tokens) {
    const parent = stack.at(-1);
    if (token.kind === 'start') {
      const open = openElement(token, parent);
      if (open.element.namespace === RDF_NAMESPACE && open.element.localName === 'RDF') rdfs.push(open.element);
      if (token.selfClosing) collectArrayItem(parent?.element, open.element);
      else stack.push(open);
    } else if (token.kind === 'end' && parent !== undefined) {
      parent.element.span.end = token.span.end;
      parent.element.endTagStart = token.span.start;
      stack.pop();
      collectArrayItem(stack.at(-1)?.element, parent.element);
    } else if ((token.kind === 'text' || token.kind === 'cdata') && parent !== undefined) parent.element.text.push(token.text);
  }
  return rdfs;
};

const isRdf = (element: XmlElement, localName: string): boolean => element.namespace === RDF_NAMESPACE && element.localName === localName;
const isBlank = (element: XmlElement): boolean => element.text.every(text => /^[ \t\r\n]*$/u.test(text));

// XMP Part 1 7.7: an array is an rdf:Alt, rdf:Seq or rdf:Bag whose items are rdf:li elements; only items with simple, unqualified values are read.
const arrayValue = (element: XmlElement): XmpValue => {
  const [array] = element.children;
  if (array === undefined || element.children.length !== 1 || array.attributes.some(attribute => !isDeclaration(attribute))) return { kind: 'opaque' };
  const type = array.localName;
  if (array.namespace !== RDF_NAMESPACE || (type !== 'Alt' && type !== 'Seq' && type !== 'Bag') || !isBlank(array) || array.arrayInvalid === true) {
    return { kind: 'opaque' };
  }
  return { kind: 'array', type, items: array.arrayItems ?? [] };
};

const isLanguage = (attribute: Attribute): boolean => attribute.namespace === XML_NAMESPACE && attribute.localName === 'lang';

// XMP Part 1 7.5: a simple value is the element content, "only character data, entity references, character references, and CDATA sections", and "The element content for an XMP property with a URI simple value shall be empty. The value shall be provided as the value of an rdf:resource attribute"; a parseType, other qualifiers or nested elements make the value opaque here.
const elementValue = (element: XmlElement): XmpValue => {
  if (element.children.length > 0) return isBlank(element) ? arrayValue(element) : { kind: 'opaque' };
  const others = element.attributes.filter(attribute => !isDeclaration(attribute) && !isLanguage(attribute));
  if (others.length === 0) return { kind: 'text', text: element.text.join(''), language: language(element.language) };
  const [resource] = others;
  const uri = others.length === 1 && resource?.namespace === RDF_NAMESPACE && resource.localName === 'resource' && element.text.join('') === '';
  return uri ? { kind: 'uri', uri: resource.value } : { kind: 'opaque' };
};

interface Subjects {
  readonly values: string[];
  unprefixed: boolean;
}

const descriptionProperties = (description: XmlElement, subjects: Subjects): Omit<ReadProperty, 'span'>[] => {
  const properties: Omit<ReadProperty, 'span'>[] = [];
  for (const attribute of description.attributes) {
    if (isDeclaration(attribute) || attribute.namespace === XML_NAMESPACE) continue;
    if (attribute.namespace === undefined) {
      // XMP Part 1 7.4 recommends tolerating early XMP; packets written before 2003 carry about without the rdf prefix.
      if (attribute.localName === 'about') {
        subjects.values.push(attribute.value);
        subjects.unprefixed = true;
      }
      continue;
    }
    if (attribute.namespace === RDF_NAMESPACE) {
      if (attribute.localName === 'about') subjects.values.push(attribute.value);
      continue;
    }
    // XMP Part 1 7.9.2.2: a simple unqualified property may be an attribute of the rdf:Description element.
    properties.push({
      namespace: attribute.namespace,
      localName: attribute.localName,
      form: 'attribute',
      textSpan: attribute.span,
      value: { kind: 'text', text: attribute.value, language: language(description.language) },
    });
  }
  for (const child of description.children) {
    properties.push({ namespace: child.namespace ?? '', localName: child.localName, form: 'element', textSpan: child.span, value: elementValue(child) });
  }
  return properties;
};

const codePointBytes = (code: number, encoding: XmlEncoding): number => {
  if (encoding === 'utf-32be' || encoding === 'utf-32le') return 4;
  if (encoding === 'utf-16be' || encoding === 'utf-16le') return code > 0xffff ? 4 : 2;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return code > 0xffff ? 4 : 3;
};

// Byte offsets of text offsets, in one pass over the text; every offset given lies between code points, since the text decoded without error.
const byteOffsets = (text: string, encoding: XmlEncoding, offsets: readonly number[]): ReadonlyMap<number, number> => {
  const sorted = [...new Set(offsets)].toSorted((left, right) => left - right);
  const result = new Map<number, number>();
  let bytes = 0;
  let index = 0;
  for (const offset of sorted) {
    while (index < offset) {
      const code = text.codePointAt(index) ?? 0;
      bytes += codePointBytes(code, encoding);
      index += code > 0xffff ? 2 : 1;
    }
    result.set(offset, bytes);
  }
  return result;
};

const wrapper = (tokens: readonly XmlToken[]): XmpPacket['wrapper'] => {
  const instructions = tokens.flatMap(token => (token.kind === 'pi' && token.target === 'xpacket' ? [token.content] : []));
  const end = instructions.map(content => /^end=(["'])([rw])\1/u.exec(content)?.[2]).find(value => value !== undefined);
  return { begin: instructions.some(content => content.startsWith('begin=')), end: end === 'r' || end === 'w' ? end : undefined };
};

const findingsOf = (encoding: XmlEncoding, subjects: Subjects, properties: readonly ReadProperty[]): XmpFinding[] => {
  const findings: XmpFinding[] = [];
  // XMP Part 3 1.6.1: "The XMP must be encoded as UTF-8".
  if (encoding !== 'utf8') findings.push({ code: 'xmp-not-utf8', detail: `the packet is encoded as ${encoding}` });
  if (subjects.unprefixed) findings.push({ code: 'rdf-about-unprefixed', detail: 'an rdf:Description has an about attribute without the rdf prefix' });
  const distinct = new Set(subjects.values.filter(value => value !== ''));
  if (distinct.size > 1) findings.push({ code: 'rdf-about-mismatch', detail: `the rdf:Description elements name ${String(distinct.size)} different subjects` });
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const property of properties) {
    const name = `${property.namespace}${property.localName}`;
    if (seen.has(name) && !reported.has(name)) {
      findings.push({ code: 'duplicate-property', detail: `${name} occurs more than once` });
      reported.add(name);
    }
    seen.add(name);
  }
  return findings;
};

const readTree = (text: string, encoding: XmlEncoding, tokens: readonly XmlToken[]): ReadPacket => {
  const rdfs = buildTree(tokens);
  // XMP Part 1 7.4: "A single XMP packet shall be serialized using a single rdf:RDF XML element"; 7.3.3: x:xmpmeta or other elements may surround it.
  const [rdf] = rdfs;
  if (rdf === undefined) throw new UnreadableError('no-rdf');
  if (rdfs.length > 1) throw new UnreadableError('multiple-rdf');
  // XMP Part 1 7.4: "The rdf:RDF element content shall consist of only zero or more rdf:Description elements."
  if (!isBlank(rdf) || rdf.children.some(child => !isRdf(child, 'Description'))) throw new UnreadableError('not-xmp');
  const subjects: Subjects = { values: [], unprefixed: false };
  const found = rdf.children.flatMap(description => descriptionProperties(description, subjects));
  const offsets = byteOffsets(
    text,
    encoding,
    found.flatMap(property => [property.textSpan.start, property.textSpan.end]),
  );
  const properties: ReadProperty[] = [];
  for (const { namespace, localName, form, textSpan, value } of found) {
    properties.push({ namespace, localName, form, textSpan, value, span: { start: offsets.get(textSpan.start) ?? 0, end: offsets.get(textSpan.end) ?? 0 } });
  }
  return {
    encoding,
    wrapper: wrapper(tokens),
    subject: subjects.values.find(value => value !== '') ?? '',
    properties,
    findings: findingsOf(encoding, subjects, properties),
    text,
    rdfEnd: rdf.selfClosing ? rdf.span.end - 2 : rdf.endTagStart,
    rdfEmptyTag: rdf.selfClosing ? rdf.name : undefined,
    rdfLanguage: rdf.language,
  };
};

/**
 * Reads an XMP packet (XMP Part 1 7): the xpacket wrapper if present, the one rdf:RDF element, inside x:xmpmeta or not, and the top-level properties of its rdf:Description elements with their spans.
 * Values that are not simple text or arrays of simple items are reported as opaque and never interpreted.
 */
export const readXmp = (bytes: Uint8Array, maxTokens: number = DEFAULT_XML_LIMITS.maxTokens): ReadXmp => {
  const decoded = decodeXml(bytes);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  const tokens = tokenizeXml(decoded.text, { ...DEFAULT_XML_LIMITS, maxTokens });
  if (!tokens.ok) return { ok: false, reason: tokens.reason };
  try {
    return { ok: true, packet: readTree(decoded.text, decoded.encoding, tokens.tokens) };
  } catch (error: unknown) {
    if (error instanceof UnreadableError) return { ok: false, reason: error.reason };
    throw error;
  }
};
