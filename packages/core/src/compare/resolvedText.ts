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

/** How many steps the descriptions of reference cycles may take in all, so that a document cannot make the work grow with the square of a cycle's size by referring to each object of a wide cycle from elsewhere. */
const MAX_CYCLE_STEPS = 1 << 20;

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

/** A step of reading a value that leads into a reference cycle: a value to read, the text of a value already read, text between values, or the end of an array or dictionary. */
type Step =
  | { readonly kind: 'value'; readonly value: PdfObject | undefined; readonly producer: StreamProducer | undefined }
  | { readonly kind: 'item'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'close'; readonly text: string };

/** Where an array, dictionary or stream that leads into a reference cycle leads: to another of them in the same value, by its index, or to an object that also leads into a cycle, by its key. */
type Link = { readonly kind: 'local'; readonly index: number } | { readonly kind: 'object'; readonly key: string };

/** An array, dictionary or stream that leads into a reference cycle: the texts around its links, one more than there are links, its links in order, and a label made of both that equal ones share. */
interface Structure {
  readonly label: string;
  readonly segments: ReadonlyArray<string>;
  readonly links: ReadonlyArray<Link>;
}

/** A value that leads into a reference cycle, read once: its arrays, dictionaries and streams that lead into a cycle, innermost first, and where the value is, which is another object when the value is a reference. */
interface Shape {
  readonly structures: ReadonlyArray<Structure>;
  readonly root: Link;
}

/** An array, dictionary or stream being read into a shape: its segments and links so far, the text of the segment being read, and its whole text while it has no links. */
interface Building {
  readonly segments: Array<string>;
  readonly links: Array<Link>;
  run: string;
  whole: string;
}

/** How much written text is gathered before it is passed to the hash. */
const HASH_CHUNK = 4096;

/** The result a walk gives a value that leads into a reference cycle until the value is described; every such text starts with this, and no other text does. */
const INTO_CYCLE = '~';

const leadsIntoCycle = (text: string): boolean => text.startsWith(INTO_CYCLE);

const referenceKey = (value: Reference): string => `${String(value.objectNumber)}.${String(value.generation)}`;

const kept = (text: string): string => (text.length > DIGEST_ABOVE ? `#${hex(md5(latin1Bytes(text)))}` : text);

const isLength = (key: Uint8Array): boolean => key.length === LENGTH.length && key.every((byte, index) => byte === LENGTH[index]);

/**
 * The classes of a graph's nodes under bisimulation: two nodes share a class exactly when they have the same label and their links, place by place, lead to nodes of the same class.
 * The nodes start in one class per label, and each class in turn splits every class whose nodes differ in whether their link at some place leads into it; only the smaller part of a split is queued again, unless the class split was still queued (Hopcroft's algorithm), so the work grows with the number of links times the logarithm of the number of nodes.
 */
const bisimilarClasses = (labels: ReadonlyArray<string>, links: ReadonlyArray<ReadonlyArray<number>>, step: (count: number) => void): Array<number> => {
  const byLabel = new Map<string, Array<number>>();
  for (const [node, label] of labels.entries()) {
    const nodes = byLabel.get(label);
    if (nodes === undefined) {
      byLabel.set(label, [node]);
    } else {
      nodes.push(node);
    }
  }
  // Each class is the range of `order` from its start to its end, and `place` is where each node is in `order`.
  const order: Array<number> = [];
  const classOf = labels.map(() => 0);
  const starts: Array<number> = [];
  const ends: Array<number> = [];
  for (const nodes of byLabel.values()) {
    const id = starts.length;
    starts.push(order.length);
    for (const node of nodes) {
      classOf[node] = id;
      order.push(node);
    }
    ends.push(order.length);
  }
  const place = labels.map(() => 0);
  for (const [index, node] of order.entries()) {
    place[node] = index;
  }
  // The links into each node, as pairs of the node they leave and their place among its links.
  const into: Array<Array<number>> = labels.map(() => []);
  for (const [from, out] of links.entries()) {
    for (const [position, to] of out.entries()) {
      into[to]?.push(from, position);
    }
  }
  const marked = starts.map(() => 0);
  const queued = starts.map(() => true);
  const waiting = starts.map((_, id) => id);
  for (let splitter = waiting.pop(); splitter !== undefined; splitter = waiting.pop()) {
    queued[splitter] = false;
    // The nodes whose link at each place leads into the splitter, gathered before any class splits.
    const leading = new Map<number, Array<number>>();
    for (let index = starts[splitter] ?? 0; index < (ends[splitter] ?? 0); index += 1) {
      const pairs = into[order[index] ?? 0] ?? [];
      step(1 + pairs.length / 2);
      for (let pair = 0; pair < pairs.length; pair += 2) {
        const from = pairs[pair] ?? 0;
        const position = pairs[pair + 1] ?? 0;
        const nodes = leading.get(position);
        if (nodes === undefined) {
          leading.set(position, [from]);
        } else {
          nodes.push(from);
        }
      }
    }
    for (const nodes of leading.values()) {
      // Each node is moved to the front of its class, behind the nodes of the class already moved.
      const touched: Array<number> = [];
      for (const node of nodes) {
        const id = classOf[node] ?? 0;
        const count = marked[id] ?? 0;
        if (count === 0) {
          touched.push(id);
        }
        const at = place[node] ?? 0;
        const front = (starts[id] ?? 0) + count;
        const other = order[front] ?? 0;
        order[at] = other;
        place[other] = at;
        order[front] = node;
        place[node] = front;
        marked[id] = count + 1;
      }
      for (const id of touched) {
        const start = starts[id] ?? 0;
        const count = marked[id] ?? 0;
        const end = ends[id] ?? 0;
        marked[id] = 0;
        if (start + count === end) {
          continue;
        }
        const split = starts.length;
        starts.push(start);
        ends.push(start + count);
        marked.push(0);
        starts[id] = start + count;
        step(count);
        for (let index = start; index < start + count; index += 1) {
          classOf[order[index] ?? 0] = split;
        }
        if (queued[id] === true || count <= end - start - count) {
          queued.push(true);
          waiting.push(split);
        } else {
          queued.push(false);
          queued[id] = true;
          waiting.push(id);
        }
      }
    }
  }
  return classOf;
};

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
 * Objects that lead back to each other through references are found as one cycle while the walk runs. A value that leads into a cycle unfolds without end, so it is described by a digest of the graph of its arrays, dictionaries and streams that lead into a cycle, direct or indirect: those that unfold to the same value are merged into one, and the merged graph is written out from the value, each merged one in full where it is first met, dictionary keys in sorted order, and at every later link as its position in that writing.
 * Two such values therefore read the same exactly when they unfold to the same value, whichever object of a cycle a walk met first, whether a dictionary is direct or an indirect object, and however many objects hold the same value; each value in them that leads into no cycle compares by its text, by digest when long, whether it is direct or an indirect object.
 * A chain of references alone that comes back to where it started leads to no object, and reads as null like a reference to an undefined object.
 * ISO 32000-1:2008, 7.3.10: "An indirect reference to an undefined object shall not be considered an error by a conforming reader; it shall be treated as a reference to the null object."
 */
export class ResolvedTexts {
  private readonly document: DocumentInternals;
  private readonly known = new Map<string, string>();
  /** The objects found to lead into a reference cycle, by key. */
  private readonly endless = new Map<string, Reference>();
  /** The shapes of those objects, each read once. */
  private readonly shapes = new Map<string, Shape>();
  private readonly maxCycleSteps: number;
  private cycleSteps = 0;

  constructor(document: DocumentInternals, maxCycleSteps: number = MAX_CYCLE_STEPS) {
    this.document = document;
    this.maxCycleSteps = maxCycleSteps;
  }

  /** The text of a value; throws ParseError when an object it leads to cannot be read, and ResourceLimitError when it leads through too many references or the reference cycles described so far take too many steps. */
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
        results.push(
          parts.some(leadsIntoCycle) ? INTO_CYCLE : task.kind === 'array' ? `[${parts.join(' ')}]` : dictionaryText(task.keys, parts, task.dataDigest),
        );
      }
    }
    // Only the value asked for is described, since a value that leads into a cycle is described from its own shape and not from the texts of the objects it leads to.
    const text = results.pop() ?? 'null';
    if (!leadsIntoCycle(text)) {
      return text;
    }
    return value?.kind === 'reference' ? this.objectText(referenceKey(value)) : this.described({ shape: this.shape(value, undefined) });
  }

  // The innermost referenced object is done: an object whose cycle is still open leads into a cycle, and the object that closes its cycle marks every object of it as leading into one.
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
      walk.results.push(INTO_CYCLE);
      return;
    }
    const cycle = [frame.reference, ...walk.members.splice(frame.members)];
    for (const member of cycle) {
      walk.open.delete(referenceKey(member));
    }
    if (frame.cyclic && cycle.every(member => this.document.objects.deref(member)?.kind === 'reference')) {
      for (const member of cycle) {
        this.known.set(referenceKey(member), 'null');
      }
      walk.results.push('null');
      return;
    }
    if (!frame.cyclic && !leadsIntoCycle(text)) {
      const own = kept(text);
      this.known.set(frame.key, own);
      walk.results.push(own);
      return;
    }
    for (const member of cycle) {
      this.endless.set(referenceKey(member), member);
    }
    walk.results.push(INTO_CYCLE);
  }

  // The text of an object that leads into a reference cycle, worked out when it is first asked for.
  private objectText(key: string): string {
    const known = this.known.get(key);
    if (known !== undefined) {
      return known;
    }
    const text = this.described({ key });
    this.known.set(key, text);
    return text;
  }

  private step(count: number): void {
    this.cycleSteps += count;
    if (this.cycleSteps > this.maxCycleSteps) {
      throw new ResourceLimitError(`describing the reference cycles of compared values takes more than ${String(this.maxCycleSteps)} steps`);
    }
  }

  // The digest of the graph a value that leads into a reference cycle unfolds to, written out from the value with each class of bisimilar nodes in full where it is first met and as its position later; the writing is hashed as it goes, so its length costs no memory.
  private described(start: { readonly shape: Shape } | { readonly key: string }): string {
    const nodes: Array<Structure> = [];
    const links: Array<ReadonlyArray<number>> = [];
    const placed = new Map<string, number>();
    const unlinked: Array<{ readonly shape: Shape; readonly base: number }> = [];
    const place = (shape: Shape): number => {
      const base = nodes.length;
      this.step(shape.structures.length);
      for (const structure of shape.structures) {
        nodes.push(structure);
        links.push([]);
      }
      unlinked.push({ shape, base });
      return base;
    };
    // An object that is a reference to another stands for the object it leads to.
    const objectNode = (key: string): number => {
      const passed: Array<string> = [];
      let at = key;
      let node = placed.get(at);
      while (node === undefined) {
        this.step(1);
        const shape = this.objectShape(at);
        if (shape.root.kind === 'object') {
          passed.push(at);
          at = shape.root.key;
          node = placed.get(at);
        } else {
          node = place(shape) + shape.root.index;
          placed.set(at, node);
        }
      }
      for (const alias of passed) {
        placed.set(alias, node);
      }
      return node;
    };
    const linked = (link: Link, base: number): number => (link.kind === 'local' ? base + link.index : objectNode(link.key));
    const first = 'key' in start ? objectNode(start.key) : linked(start.shape.root, place(start.shape));
    for (let item = unlinked.pop(); item !== undefined; item = unlinked.pop()) {
      const { shape, base } = item;
      for (const [index, structure] of shape.structures.entries()) {
        this.step(structure.links.length);
        links[base + index] = structure.links.map(link => linked(link, base));
      }
    }
    const classes = bisimilarClasses(
      nodes.map(node => node.label),
      links,
      count => {
        this.step(count);
      },
    );
    const hash = createMd5();
    let pending = '';
    const write = (text: string): void => {
      pending += `${text}\n`;
      if (pending.length >= HASH_CHUNK) {
        hash.update(latin1Bytes(pending));
        pending = '';
      }
    };
    // A node is written as the number of its links and then its texts and the nodes it links to in turn; a node of a class already written is written as that class's position.
    const positions = new Map<number, number>();
    const writing: Array<number | string> = [first];
    for (let item = writing.pop(); item !== undefined; item = writing.pop()) {
      this.step(1);
      if (typeof item === 'string') {
        write(`s${item}`);
        continue;
      }
      const kind = classes[item] ?? -1;
      const position = positions.get(kind);
      if (position !== undefined) {
        write(`@${String(position)}`);
        continue;
      }
      positions.set(kind, positions.size);
      const segments = nodes[item]?.segments ?? [];
      const out = links[item] ?? [];
      write(`+${String(out.length)}`);
      write(`s${segments[0] ?? ''}`);
      for (let index = out.length - 1; index >= 0; index -= 1) {
        writing.push(segments[index + 1] ?? '', out[index] ?? -1);
      }
    }
    hash.update(latin1Bytes(pending));
    return `${INTO_CYCLE}${hex(hash.digest())}`;
  }

  private objectShape(key: string): Shape {
    const cached = this.shapes.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const reference = this.endless.get(key);
    const shape =
      reference === undefined
        ? this.shape(undefined, undefined)
        : this.shape(this.document.objects.deref(reference), this.document.objects.producedStreams.get(reference.objectNumber));
    this.shapes.set(key, shape);
    return shape;
  }

  // The text of a value that leads into no reference cycle, met while reading one that does.
  private leafText(value: Exclude<PdfObject, { kind: 'array' | 'dictionary' | 'stream' }> | undefined): string {
    if (value === undefined) {
      return 'null';
    }
    return value.kind === 'reference' ? (this.known.get(referenceKey(value)) ?? this.text(value)) : scalarText(value);
  }

  // A value that leads into a reference cycle, read into its arrays, dictionaries and streams that lead into one; each value in them that does not is folded into the text around it as its text, by digest when long, so that it reads as it would as an indirect object.
  private shape(value: PdfObject | undefined, producer: StreamProducer | undefined): Shape {
    if (value?.kind === 'reference') {
      return { structures: [], root: { kind: 'object', key: referenceKey(value) } };
    }
    const structures: Array<Structure> = [];
    const open: Array<Building> = [];
    let root: Link = { kind: 'local', index: 0 };
    const add = (text: string, item: boolean): void => {
      const parent = open.at(-1);
      if (parent !== undefined) {
        parent.run += item ? kept(text) : text;
        if (parent.links.length === 0) {
          parent.whole += text;
        }
      }
    };
    const link = (to: Link): void => {
      const parent = open.at(-1);
      if (parent === undefined) {
        root = to;
        return;
      }
      parent.segments.push(kept(parent.run));
      parent.links.push(to);
      parent.run = '';
    };
    const steps: Array<Step> = [{ kind: 'value', value, producer }];
    for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
      if (step.kind === 'item' || step.kind === 'text') {
        add(step.text, step.kind === 'item');
        continue;
      }
      if (step.kind === 'close') {
        const done = open.pop();
        if (done === undefined) {
          continue;
        }
        if (done.links.length === 0) {
          add(done.whole + step.text, true);
          continue;
        }
        done.segments.push(kept(done.run + step.text));
        structures.push({ label: `${String(done.links.length)}\n${done.segments.join('\n')}`, segments: done.segments, links: done.links });
        link({ kind: 'local', index: structures.length - 1 });
        continue;
      }
      const item = step.value;
      if (item?.kind === 'reference' && this.endless.has(referenceKey(item))) {
        link({ kind: 'object', key: referenceKey(item) });
      } else if (item?.kind === 'array') {
        open.push({ segments: [], links: [], run: '[', whole: '[' });
        // Pushed one at a time, in reverse, since a call takes only so many arguments.
        steps.push({ kind: 'close', text: ']' });
        for (let index = item.items.length - 1; index >= 0; index -= 1) {
          steps.push({ kind: 'value', value: item.items[index], producer: undefined });
          if (index > 0) {
            steps.push({ kind: 'text', text: ' ' });
          }
        }
      } else if (item?.kind === 'dictionary' || item?.kind === 'stream') {
        open.push({ segments: [], links: [], run: '<<', whole: '<<' });
        steps.push({
          kind: 'close',
          text: item.kind === 'stream' ? `>>stream${hex(step.producer === undefined ? md5(item.data) : producedDigest(step.producer))}` : '>>',
        });
        const entries = this.entrySteps(item.kind === 'stream' ? item.dictionary : item.entries, item.kind === 'stream');
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index];
          if (entry !== undefined) {
            steps.push(entry);
          }
        }
      } else {
        add(this.leafText(item), true);
      }
    }
    return { structures, root };
  }

  // A dictionary's entries in sorted key order, leaving out a stream's Length and every entry whose value is null (ISO 32000-1:2008, 7.3.7).
  private entrySteps(entries: PdfDictionaryEntries, stream: boolean): Array<Step> {
    const named: Array<{ readonly name: string; readonly step: Step }> = [];
    for (const [key, item] of entries.entries()) {
      if (stream && isLength(key)) {
        continue;
      }
      let step: Step = { kind: 'value', value: item, producer: undefined };
      if (item.kind !== 'array' && item.kind !== 'dictionary' && (item.kind !== 'reference' || !this.endless.has(referenceKey(item)))) {
        step = { kind: 'item', text: this.leafText(item) };
      }
      if (step.kind !== 'item' || step.text !== 'null') {
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
      const known = this.known.get(key) ?? (this.endless.has(key) ? INTO_CYCLE : undefined);
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
        results.push(INTO_CYCLE);
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
      const entries = [...(value.kind === 'stream' ? value.dictionary : value.entries).entries()].filter(([key]) => value.kind !== 'stream' || !isLength(key));
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
