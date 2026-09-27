import type { InspectWarning } from '../../content/inspectWarning.ts';
import type { ObjectResolver } from '../../document/loadedPage.ts';
import type { PdfDictionaryEntries } from '../../object/pdfDictionaryEntries.ts';
import type { PdfObject } from '../../object/pdfObject.ts';

import { dictionaryOf, latin1, numberOf } from '../../font/fontValues.ts';
import { md5 } from '../../hash/md5.ts';
import { pdfName } from '../../object/pdfObject.ts';

const SUBTYPE = pdfName('Subtype').bytes;
const PROCESS = pdfName('Process').bytes;
const COMPONENTS = pdfName('Components').bytes;
const COLORANTS = pdfName('Colorants').bytes;

// Nested spaces (an Indexed base, a Pattern base, an NChannel colorant's Separation) are followed this deep, which ends cycles through references.
const MAX_DEPTH = 8;

/** What a colorant is: a spot colorant, a process colorant, or one of the special names All and None of ISO 32000-1:2008, 8.6.6.4. */
export type ColorantKind = 'spot' | 'process' | 'all' | 'none';

/** An alternate space a colorant is defined with, so that one colorant defined two ways can be found. */
export interface AlternateSummary {
  /** The alternate space's family name, such as DeviceCMYK or ICCBased. */
  readonly family: string;
  /** Equal for two definitions whose alternate spaces and tint transforms are equal in value, references resolved and stream data compared. */
  readonly definition: string;
}

/** A colorant a colour space names. */
export interface SpaceColorant {
  readonly name: Uint8Array;
  readonly kind: ColorantKind;
  /** False for a colorant an NChannel space's Colorants dictionary lists without it being a component of the space. */
  readonly component: boolean;
  /** The alternate of the Separation space that defines the colorant alone: the space itself, or its entry in an NChannel Colorants dictionary. */
  readonly alternate: AlternateSummary | undefined;
}

export interface SpaceColorants {
  readonly colorants: readonly SpaceColorant[];
  readonly warnings: readonly InspectWarning[];
}

// 8.6.6.4 describes a Separation space for "individual colour components of a device colour space for a subtractive device" without reserving names; these are taken as process colorants, the names 8.6.6.5 reserves for NChannel spaces.
const PROCESS_NAMES = new Set(['Cyan', 'Magenta', 'Yellow', 'Black']);

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const numberText = (object: PdfObject): string => String(numberOf(object) ?? 0);

const entriesText = (entries: PdfDictionaryEntries, item: (value: PdfObject) => string): string => {
  const pairs = [...entries.entries()].map(([key, value]) => `${hex(key)}=${item(value)}`);
  return `<<${pairs.toSorted().join(' ')}>>`;
};

// A text form of a value that is equal for equal values: references resolved, dictionary keys sorted, stream data digested.
const canonical = (resolver: ObjectResolver, value: PdfObject | undefined, depth: number): string => {
  const item = (inner: PdfObject): string => canonical(resolver, inner, depth + 1);
  const object = value?.kind === 'reference' ? resolver.deref(value) : value;
  if (object === undefined || depth > MAX_DEPTH) return '?';
  if (object.kind === 'name' || object.kind === 'string' || object.kind === 'invalid') return `${object.kind}:${hex(object.bytes)}`;
  if (object.kind === 'integer' || object.kind === 'real') return `n:${numberText(object)}`;
  if (object.kind === 'boolean') return String(object.value);
  if (object.kind === 'array') return `[${object.items.map(item).join(' ')}]`;
  if (object.kind === 'dictionary') return entriesText(object.entries, item);
  if (object.kind === 'stream') return `${entriesText(object.dictionary, item)}stream:${hex(md5(object.data))}`;
  return object.kind;
};

const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

class Reader {
  private readonly resolver: ObjectResolver;
  readonly colorants: SpaceColorant[] = [];
  readonly warnings: InspectWarning[] = [];

  constructor(resolver: ObjectResolver) {
    this.resolver = resolver;
  }

  private deref(value: PdfObject | undefined): PdfObject | undefined {
    return value?.kind === 'reference' ? this.resolver.deref(value) : value;
  }

  private unreadable(detail: string): void {
    this.warnings.push({ code: 'colorspace-unreadable', detail });
  }

  alternate(space: PdfObject | undefined, tint: PdfObject | undefined): AlternateSummary {
    const resolved = this.deref(space);
    const family = resolved?.kind === 'array' ? this.deref(resolved.items[0]) : resolved;
    const text = canonical(this.resolver, space, 0) + canonical(this.resolver, tint, 0);
    return { family: family?.kind === 'name' ? latin1(family.bytes) : 'unknown', definition: hex(md5(latin1Bytes(text))) };
  }

  read(value: PdfObject | undefined, depth: number): void {
    const space = this.deref(value);
    if (space?.kind !== 'array' || depth > MAX_DEPTH) return;
    const [familyValue, first, second, third, fourth] = space.items;
    const family = this.deref(familyValue);
    const familyName = family?.kind === 'name' ? latin1(family.bytes) : undefined;
    if (familyName === 'Separation') this.separation(this.deref(first), { alternate: second, tint: third, component: true });
    else if (familyName === 'DeviceN') this.deviceN(this.deref(first), { alternate: second, tint: third, attributes: this.deref(fourth) });
    // 8.6.6.3: an Indexed space's base may be "(PDF 1.3) a Separation or DeviceN space"; 8.7.3.3: an uncoloured pattern paints in the Pattern space's underlying space.
    else if (familyName === 'Indexed' || familyName === 'Pattern') this.read(first, depth + 1);
  }

  // 8.6.6.4: "The special colorant name All shall refer collectively to all colorants available on an output device"; "The special colorant name None shall not produce any visible output".
  separation(
    name: PdfObject | undefined,
    { alternate, tint, component }: { alternate: PdfObject | undefined; tint: PdfObject | undefined; component: boolean },
  ): void {
    if (name?.kind !== 'name') {
      this.unreadable('the colorant of a Separation space is not a name');
      return;
    }
    const text = latin1(name.bytes);
    let kind: ColorantKind = 'spot';
    if (text === 'All') kind = 'all';
    else if (text === 'None') kind = 'none';
    else if (PROCESS_NAMES.has(text)) kind = 'process';
    this.colorants.push({ name: name.bytes, kind, component, alternate: this.alternate(alternate, tint) });
  }

  private nchannel(attributes: PdfObject | undefined): { process: Set<string>; colorants: PdfDictionaryEntries | undefined } | undefined {
    const dictionary = dictionaryOf(attributes);
    const subtype = this.deref(dictionary?.get(SUBTYPE));
    if (subtype?.kind !== 'name' || latin1(subtype.bytes) !== 'NChannel') return undefined;
    const process = dictionaryOf(this.deref(dictionary?.get(PROCESS)));
    const components = this.deref(process?.get(COMPONENTS));
    const names = new Set<string>();
    for (const item of components?.kind === 'array' ? components.items : []) {
      const component = this.deref(item);
      if (component?.kind === 'name') names.add(latin1(component.bytes));
    }
    return { process: names, colorants: dictionaryOf(this.deref(dictionary?.get(COLORANTS))) };
  }

  // 8.6.6.5: "The special name All, used by Separation colour spaces, shall not be used"; a None component "shall never be painted on the page"; for NChannel spaces, "Any component not specified in the process dictionary shall be considered to be a spot colorant" and "The reserved names Cyan, Magenta, Yellow, and Black shall always be considered to be process colours".
  deviceN(
    names: PdfObject | undefined,
    { attributes }: { alternate: PdfObject | undefined; tint: PdfObject | undefined; attributes: PdfObject | undefined },
  ): void {
    if (names?.kind !== 'array') {
      this.unreadable('the names of a DeviceN space are not an array');
      return;
    }
    const nchannel = this.nchannel(attributes);
    const listed = new Set<string>();
    for (const item of names.items) {
      const name = this.deref(item);
      if (name?.kind !== 'name') {
        this.unreadable('a component of a DeviceN space is not a name');
        continue;
      }
      const text = latin1(name.bytes);
      listed.add(text);
      let kind: ColorantKind = 'spot';
      if (text === 'None') kind = 'none';
      else if (text === 'All') {
        kind = 'all';
        this.warnings.push({ code: 'devicen-all', detail: 'a DeviceN space names the colorant All' });
      } else if (PROCESS_NAMES.has(text) || nchannel?.process.has(text) === true) kind = 'process';
      this.colorants.push({ name: name.bytes, kind, component: true, alternate: this.colorantAlternate(nchannel?.colorants, name.bytes) });
    }
    // Table 71, Colorants: "This dictionary may also include additional colorants not used by this colour space."
    for (const [key, value] of nchannel?.colorants?.entries() ?? []) {
      if (listed.has(latin1(key))) continue;
      const separation = this.deref(value);
      const [alternate, tint] = separation?.kind === 'array' ? separation.items.slice(2) : [];
      this.separation({ kind: 'name', bytes: key }, { alternate, tint, component: false });
    }
  }

  // Table 71, Colorants: each value is "an array defining a Separation colour space for that colorant".
  private colorantAlternate(colorants: PdfDictionaryEntries | undefined, name: Uint8Array): AlternateSummary | undefined {
    const separation = this.deref(colorants?.get(name));
    if (separation?.kind !== 'array') return undefined;
    const [alternate, tint] = separation.items.slice(2);
    return this.alternate(alternate, tint);
  }
}

/**
 * The colorants a colour space names (ISO 32000-1:2008, 8.6.6): a Separation space's colorant, a DeviceN space's components and an NChannel space's listed colorants, and those of an Indexed or Pattern space's base.
 * Device, CIE-based and ICC-based spaces name none. The space is a value as a resource dictionary or an operand holds it, resolved; names stay bytes.
 */
export const colorSpaceColorants = (resolver: ObjectResolver, space: PdfObject | undefined): SpaceColorants => {
  const reader = new Reader(resolver);
  reader.read(space, 0);
  return { colorants: reader.colorants, warnings: reader.warnings };
};
