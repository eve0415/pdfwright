import type { DocumentInternals } from '../document/documentInternals.ts';
import type { StreamProducer } from '../document/editedObjects.ts';
import type { PdfDictionaryEntries, PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { createMd5, md5 } from '../hash/md5.ts';
import { pdfName } from '../object/pdfObject.ts';

const hex = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
};

const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

const numberText = (value: Extract<PdfObject, { kind: 'integer' | 'real' }>): string =>
  String(typeof value.value === 'number' ? value.value : Number(value.value.numerator) / Number(value.value.denominator));

const scalarText = (value: Exclude<PdfObject, { kind: 'array' | 'dictionary' | 'stream' | 'reference' }>): string => {
  switch (value.kind) {
    case 'integer':
    case 'real': {
      return `n${numberText(value)}`;
    }
    case 'name': {
      return `/${hex(value.bytes)}`;
    }
    case 'string': {
      return `(${hex(value.bytes)})`;
    }
    case 'invalid': {
      return `?${hex(value.bytes)}`;
    }
    case 'boolean': {
      return value.value ? 'true' : 'false';
    }
    case 'null': {
      return 'null';
    }
    default: {
      return 'null';
    }
  }
};

/** How many references deep a described value may lead. */
const MAX_DEPTH = 64;

/** Texts of referenced objects longer than this are replaced by their digest, so that shared objects do not multiply a text's length. */
const DIGEST_ABOVE = 64;

const FILTER = pdfName('Filter').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;
const LENGTH = pdfName('Length').bytes;

type Task =
  | { readonly kind: 'visit'; readonly value: PdfObject | undefined; readonly producer: StreamProducer | undefined }
  | { readonly kind: 'array'; readonly count: number }
  | { readonly kind: 'dictionary'; readonly keys: ReadonlyArray<Uint8Array>; readonly dataDigest?: Uint8Array }
  | { readonly kind: 'reference'; readonly key: string };

type Reference = Extract<PdfDirectObject, { kind: 'reference' }>;

/** A step of reading an object of a reference cycle into tokens: a value to read, text to add to the current run, or the end of an array or dictionary. */
type Step =
  | { readonly kind: 'value'; readonly value: PdfObject | undefined; readonly producer: StreamProducer | undefined }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'close'; readonly text: string };

/** An object of a reference cycle as it is written out: a run of text, the start of an array or dictionary, which takes the next position, or a reference to an object of the same cycle. */
type Token = { readonly kind: 'text' | 'open'; readonly text: string } | { readonly kind: 'member'; readonly key: string };

/** Where a writing of a cycle is in the tokens of one of its objects. */
interface Cursor {
  readonly tokens: ReadonlyArray<Token>;
  index: number;
}

/** The objects of a reference cycle by key, and the tokens of each once they have been read. */
interface Cycle {
  readonly members: ReadonlyMap<string, Reference>;
  readonly tokens: Map<string, ReadonlyArray<Token>>;
}

/** How much written text is gathered before it is passed to the hash. */
const HASH_CHUNK = 4096;

const referenceKey = (value: Reference): string => `${String(value.objectNumber)}.${String(value.generation)}`;

const kept = (text: string): string => (text.length > DIGEST_ABOVE ? `#${hex(md5(latin1Bytes(text)))}` : text);

/** A referenced object being described. */
interface Frame {
  readonly key: string;
  readonly reference: Reference;
  /** The order in which the walk entered it. */
  readonly index: number;
  /** The lowest index of an object still being described that it leads back to. */
  lowest: number;
  /** Where the objects of its cycle that close before it start in the walk's members. */
  readonly members: number;
  /** Whether it leads back to an object still being described, itself included. */
  cyclic: boolean;
}

interface Walk {
  readonly tasks: Array<Task>;
  readonly results: Array<string>;
  /** The referenced objects being described, innermost last. */
  readonly frames: Array<Frame>;
  /** Objects entered in this walk whose description is not yet known, with their index. */
  readonly open: Map<string, number>;
  /** Objects whose walk is done but whose cycle is still open. */
  readonly members: Array<Reference>;
  entered: number;
}

// Dictionaries compare regardless of key order, and an entry whose value is null is the same as an absent one (ISO 32000-1:2008, 7.3.7); a stream adds the digest of its data.
const dictionaryText = (keys: ReadonlyArray<Uint8Array>, parts: ReadonlyArray<string>, dataDigest: Uint8Array | undefined): string => {
  const texts: Array<string> = [];
  for (const [index, key] of keys.entries()) {
    const text = parts[index] ?? 'null';
    if (text !== 'null') {
      texts.push(`/${hex(key)} ${text}`);
    }
  }
  const dictionary = `<<${texts.toSorted().join(' ')}>>`;
  return dataDigest === undefined ? dictionary : `${dictionary}stream${hex(dataDigest)}`;
};

const producedDigest = (produce: StreamProducer): Uint8Array => {
  const hash = createMd5();
  for (const chunk of produce()) {
    hash.update(chunk);
  }
  return hash.digest();
};

// Resolved text, or undefined when an object the value leads to cannot be read.
const readable = (read: () => string): string | undefined => {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof ParseError) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Canonical texts for values with their references followed, for comparing values that two documents may number, order or spell differently: numbers by value, strings and names by bytes, dictionaries by sorted keys, stream data by digest.
 * The text of each referenced object is worked out once and kept, and the walk keeps its own work list, so shared objects and deep nesting cost neither repeated work nor call stack.
 * Objects that lead back to each other through references are found as one cycle while the walk runs, and each is then described by a digest of the cycle written out from that object: every object of the cycle is written in full where it is first met, dictionary keys in sorted order, and a later reference to it as the position of its array or dictionary in that writing.
 * An object of a cycle therefore reads the same whichever object of the cycle a walk met first and whether a dictionary of the cycle is direct or an indirect object, and two cycles read the same only when their objects refer to each other in the same way.
 * ISO 32000-1:2008, 7.3.10: "An indirect reference to an undefined object shall not be considered an error by a conforming reader; it shall be treated as a reference to the null object."
 */
export class ResolvedTexts {
  private readonly document: DocumentInternals;
  private readonly known = new Map<string, string>();
  /** The objects of each reference cycle found, by the key of each of them, until the text of that object is asked for. */
  private readonly cycles = new Map<string, Cycle>();

  constructor(document: DocumentInternals) {
    this.document = document;
  }

  /** The text of a value; throws ParseError when an object it leads to cannot be read. */
  text(value: PdfObject | undefined): string {
    const walk: Walk = { tasks: [{ kind: 'visit', value, producer: undefined }], results: [], frames: [], open: new Map(), members: [], entered: 0 };
    const { tasks, results } = walk;
    for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
      if (task.kind === 'visit') {
        this.visit(task.value, task.producer, walk);
      } else if (task.kind === 'reference') {
        this.close(walk);
      } else {
        const parts = results.splice(results.length - (task.kind === 'array' ? task.count : task.keys.length));
        results.push(task.kind === 'array' ? `[${parts.join(' ')}]` : dictionaryText(task.keys, parts, task.dataDigest));
      }
    }
    return results.pop() ?? 'null';
  }

  // The innermost referenced object is done: an object whose cycle is still open reads as `cycle` to the object that referenced it, and the object that closes its cycle registers every object of it.
  private close(walk: Walk): void {
    const frame = walk.frames.pop();
    const text = walk.results.pop() ?? 'null';
    if (frame === undefined) {
      return;
    }
    const parent = walk.frames.at(-1);
    if (frame.lowest < frame.index && parent !== undefined) {
      walk.members.push(frame.reference);
      parent.lowest = Math.min(parent.lowest, frame.lowest);
      parent.cyclic = true;
      walk.results.push('cycle');
      return;
    }
    const cycle = [frame.reference, ...walk.members.splice(frame.members)];
    for (const member of cycle) {
      walk.open.delete(referenceKey(member));
    }
    if (!frame.cyclic) {
      const own = kept(text);
      this.known.set(frame.key, own);
      walk.results.push(own);
      return;
    }
    const found: Cycle = { members: new Map(cycle.map(member => [referenceKey(member), member])), tokens: new Map() };
    for (const key of found.members.keys()) {
      this.cycles.set(key, found);
    }
    walk.results.push(this.cycleText(frame.key) ?? 'null');
  }

  // The text of a referenced object outside the cycle being written out, which the walk that found the cycle has already described.
  private referencedText(reference: Reference): string {
    const key = referenceKey(reference);
    return this.known.get(key) ?? this.cycleText(key) ?? this.text(reference);
  }

  // The digest of the cycle written out from the object with this key, or undefined when the object is in no cycle whose text is still to be worked out; the writing is hashed as it goes, so its length costs no memory.
  private cycleText(key: string): string | undefined {
    const cycle = this.cycles.get(key);
    if (cycle?.members.has(key) !== true) {
      return undefined;
    }
    const hash = createMd5();
    let pending = '';
    const write = (text: string): void => {
      pending += `${text}\n`;
      if (pending.length >= HASH_CHUNK) {
        hash.update(latin1Bytes(pending));
        pending = '';
      }
    };
    // Each array and dictionary takes the next position as it is written, and an object of the cycle takes the position of the value it is written as.
    const positions = new Map<string, number>();
    let next = 0;
    const enter = (member: string): Cursor => {
      const tokens = this.tokensOf(cycle, member);
      positions.set(member, next);
      if (tokens[0]?.kind !== 'open') {
        next += 1;
      }
      return { tokens, index: 0 };
    };
    const cursors = [enter(key)];
    for (let cursor = cursors.at(-1); cursor !== undefined; cursor = cursors.at(-1)) {
      const token = cursor.tokens[cursor.index];
      cursor.index += 1;
      if (token === undefined) {
        cursors.pop();
      } else if (token.kind === 'member') {
        const position = positions.get(token.key);
        if (position === undefined) {
          cursors.push(enter(token.key));
        } else {
          write(`@${String(position)}`);
        }
      } else {
        if (token.kind === 'open') {
          next += 1;
        }
        write(token.text);
      }
    }
    hash.update(latin1Bytes(pending));
    const text = `~${hex(hash.digest())}`;
    this.known.set(key, text);
    this.cycles.delete(key);
    return text;
  }

  // The tokens of an object of a cycle, read once: text between arrays, dictionaries and references to objects of the cycle is gathered into runs and kept short, so that a cycle costs memory for its structure and not for the length of its values.
  private tokensOf(cycle: Cycle, key: string): ReadonlyArray<Token> {
    const cached = cycle.tokens.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const reference = cycle.members.get(key);
    const tokens: Array<Token> = [];
    let run = '';
    const end = (token: Token): void => {
      if (run !== '') {
        tokens.push({ kind: 'text', text: kept(run) });
        run = '';
      }
      tokens.push(token);
    };
    const steps: Array<Step> = [
      {
        kind: 'value',
        value: this.document.objects.deref(reference),
        producer: reference === undefined ? undefined : this.document.objects.producedStreams.get(reference.objectNumber),
      },
    ];
    for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
      if (step.kind === 'text') {
        run += step.text;
        continue;
      }
      if (step.kind === 'close') {
        end({ kind: 'text', text: step.text });
        continue;
      }
      const { value } = step;
      if (value === undefined) {
        run += 'null';
      } else if (value.kind === 'reference') {
        const member = referenceKey(value);
        if (cycle.members.has(member)) {
          end({ kind: 'member', key: member });
        } else {
          run += this.referencedText(value);
        }
      } else if (value.kind === 'array') {
        end({ kind: 'open', text: '[' });
        const items: Array<Step> = [];
        for (const [index, item] of value.items.entries()) {
          if (index > 0) {
            items.push({ kind: 'text', text: ' ' });
          }
          items.push({ kind: 'value', value: item, producer: undefined });
        }
        steps.push({ kind: 'close', text: ']' }, ...items.toReversed());
      } else if (value.kind === 'dictionary' || value.kind === 'stream') {
        end({ kind: 'open', text: '<<' });
        steps.push(
          {
            kind: 'close',
            text: value.kind === 'stream' ? `>>stream${hex(step.producer === undefined ? md5(value.data) : producedDigest(step.producer))}` : '>>',
          },
          ...this.entrySteps(value.kind === 'stream' ? value.dictionary : value.entries, value.kind === 'stream', cycle.members).toReversed(),
        );
      } else {
        run += scalarText(value);
      }
    }
    if (run !== '') {
      tokens.push({ kind: 'text', text: kept(run) });
    }
    cycle.tokens.set(key, tokens);
    return tokens;
  }

  // A dictionary's entries in sorted key order, leaving out a stream's Length and every entry whose value is null (ISO 32000-1:2008, 7.3.7).
  private entrySteps(entries: PdfDictionaryEntries, stream: boolean, cycle: ReadonlyMap<string, Reference>): Array<Step> {
    const named: Array<{ readonly name: string; readonly step: Step }> = [];
    for (const [key, item] of entries.entries()) {
      if (stream && key.length === LENGTH.length && key.every((byte, index) => byte === LENGTH[index])) {
        continue;
      }
      const step: Step =
        item.kind === 'reference' && !cycle.has(referenceKey(item))
          ? { kind: 'text', text: this.referencedText(item) }
          : { kind: 'value', value: item, producer: undefined };
      if (step.kind !== 'text' || step.text !== 'null') {
        named.push({ name: hex(key), step });
      }
    }
    return named
      .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .flatMap(({ name, step }, index): Array<Step> => [{ kind: 'text', text: `${index === 0 ? '' : ' '}/${name} ` }, step]);
  }

  private visit(value: PdfObject | undefined, producer: StreamProducer | undefined, walk: Walk): void {
    const { tasks, results, frames, open } = walk;
    if (value === undefined) {
      results.push('null');
      return;
    }
    if (value.kind === 'reference') {
      const key = referenceKey(value);
      const known = this.known.get(key) ?? this.cycleText(key);
      if (known !== undefined) {
        results.push(known);
        return;
      }
      const index = open.get(key);
      if (index !== undefined) {
        const top = frames.at(-1);
        if (top !== undefined) {
          top.lowest = Math.min(top.lowest, index);
          top.cyclic = true;
        }
        results.push('cycle');
        return;
      }
      if (frames.length >= MAX_DEPTH) {
        throw new ResourceLimitError(`a compared value leads through more than ${String(MAX_DEPTH)} references`);
      }
      const entered = walk.entered++;
      open.set(key, entered);
      frames.push({ key, reference: value, index: entered, lowest: entered, members: walk.members.length, cyclic: false });
      tasks.push(
        { kind: 'reference', key },
        { kind: 'visit', value: this.document.objects.deref(value), producer: this.document.objects.producedStreams.get(value.objectNumber) },
      );
      return;
    }
    if (value.kind === 'array') {
      tasks.push(
        { kind: 'array', count: value.items.length },
        ...value.items.map((item): Task => ({ kind: 'visit', value: item, producer: undefined })).toReversed(),
      );
      return;
    }
    if (value.kind === 'dictionary' || value.kind === 'stream') {
      const entries = [...(value.kind === 'stream' ? value.dictionary : value.entries).entries()].filter(
        ([key]) => value.kind !== 'stream' || key.length !== LENGTH.length || key.some((byte, index) => byte !== LENGTH[index]),
      );
      const keys = entries.map(([key]) => key);
      tasks.push(
        value.kind === 'stream'
          ? { kind: 'dictionary', keys, dataDigest: producer === undefined ? md5(value.data) : producedDigest(producer) }
          : { kind: 'dictionary', keys },
        ...entries.map(([, item]): Task => ({ kind: 'visit', value: item, producer: undefined })).toReversed(),
      );
      return;
    }
    results.push(scalarText(value));
  }

  /** The filters and their parameters that a stream's data is encoded with (ISO 32000-1:2008, 7.3.8.2, Table 5); undefined when an object they lead to cannot be read. */
  encoding(stream: Extract<PdfObject, { kind: 'stream' }>): string | undefined {
    return readable(() => `${this.text(stream.dictionary.get(FILTER))} ${this.text(stream.dictionary.get(DECODE_PARMS))}`);
  }

  /** A value's text; undefined when an object it leads to cannot be read. */
  value(value: PdfObject | undefined): string | undefined {
    return readable(() => this.text(value));
  }
}

/** Whether two resolved texts are known to be the same. */
export const sameText = (left: string | undefined, right: string | undefined): boolean => left !== undefined && left === right;
