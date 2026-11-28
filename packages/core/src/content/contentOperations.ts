import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { LexContext, Token } from '../parse/lexer.ts';

import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseObject } from '../parse/parseObject.ts';
import { WindowEndError } from '../parse/windowEndError.ts';

import { inlineImageData } from './inlineImageData.ts';

// An operator cannot consume an unbounded stack, even when the stream has few or no operators.
export const MAX_CONTENT_OPERANDS = 16_384;

/** An operand: a parsed value, or a closing delimiter with nothing open, kept so that the operator it precedes can be seen to have bad operands. */
export type ContentOperand = PdfDirectObject | { readonly kind: 'stray-delimiter'; readonly bytes: Uint8Array };

export interface InlineImage {
  /** The key and value operands between BI and ID, in order (ISO 32000-1:2008, 8.9.7, Table 93). */
  readonly parameters: ReadonlyArray<ContentOperand>;
  /** The data between ID and EI, as a view of the stream's bytes. */
  readonly data: Uint8Array;
}

export interface ContentOperation {
  readonly operator: string;
  readonly operands: ReadonlyArray<ContentOperand>;
  /** For BI, the inline image that ID and EI delimit; the ID and EI operators are consumed with it. Absent when no ID follows the parameters. */
  readonly inlineImage?: InlineImage;
  /** The index of the stream the operator is in, among the streams given. */
  readonly stream: number;
  /** The operator's byte offset within its stream. */
  readonly offset: number;
}

export interface SpannedContentOperation extends ContentOperation {
  /** First operand byte, or the operator byte when it has no operands. */
  readonly start: number;
  /** First byte after the operator, including EI for an inline image. */
  readonly end: number;
}

const quiet = (): LexContext => ({
  warn: (): void => {
    // Malformed operands are kept as values; the reader of the operations decides what they mean.
  },
  names: new Map(),
});

const isOperator = (token: Token): boolean => token.kind === 'keyword' && token.keyword !== 'true' && token.keyword !== 'false' && token.keyword !== 'null';

const isStray = (token: Token): boolean =>
  token.kind === 'arrayClose' || token.kind === 'dictionaryClose' || (token.kind === 'invalid' && token.reason === 'stray-delimiter');

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) {
    text += String.fromCodePoint(byte);
  }
  return text;
};

// A stray delimiter reads as null where the inline image data length is computed from the parameters.
const directValues = (operands: ReadonlyArray<ContentOperand>): Array<PdfDirectObject> =>
  operands.map(operand => (operand.kind === 'stray-delimiter' ? { kind: 'null' } : operand));

interface PendingImage {
  readonly operands: ReadonlyArray<ContentOperand>;
  readonly stream: number;
  readonly offset: number;
}

/** An array or dictionary operand that a stream ends inside: its bytes in each stream so far, and the arrays and dictionaries still open. */
interface OpenOperand {
  readonly pieces: Array<Uint8Array>;
  readonly stream: number;
  readonly offset: number;
  depth: number;
}

/** Where the arrays and dictionaries open before a stream close in it, or how many are still open at its end. */
interface Closing {
  readonly end?: number;
  readonly depth: number;
}

/** Lexes bytes from start, counting arrays and dictionaries opened and closed from depth, and returns the end of the token that closes the last one, or the depth still open at the end. */
const closingEnd = (bytes: Uint8Array, start: number, depth: number, context: LexContext): Closing => {
  const lexer = new Lexer({ bytes, base: 0, final: true }, start, context);
  let open = depth;
  for (let token = lexer.next(); token.kind !== 'eof'; token = lexer.next()) {
    if (token.kind === 'arrayOpen' || token.kind === 'dictionaryOpen') {
      open++;
    } else if ((token.kind === 'arrayClose' || token.kind === 'dictionaryClose') && --open === 0) {
      return { end: token.end, depth: 0 };
    }
  }
  return { depth: open };
};

const LINE_FEED = 0x0a;

// The pieces of an operand, one white-space byte between them so that no two tokens join.
const joined = (pieces: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length + 1, -1));
  let position = 0;
  for (const piece of pieces) {
    if (position > 0) {
      bytes[position - 1] = LINE_FEED;
    }
    bytes.set(piece, position);
    position += piece.length + 1;
  }
  return bytes;
};

/** Reads operations from successive streams with one operand stack, as the streams of a page's Contents array are read. */
class OperationReader {
  private readonly maxNesting: number;
  private operands: Array<ContentOperand> = [];
  private firstOperand: { readonly stream: number; readonly offset: number } | undefined = undefined;
  private image: PendingImage | undefined = undefined;
  private open: OpenOperand | undefined = undefined;

  constructor(maxNesting: number) {
    this.maxNesting = maxNesting;
  }

  private take(): Array<ContentOperand> {
    const { operands } = this;
    this.operands = [];
    this.firstOperand = undefined;
    return operands;
  }

  private append(operand: ContentOperand, stream: number, offset: number): void {
    if (this.operands.length >= MAX_CONTENT_OPERANDS) {
      throw new ResourceLimitError(`content has more than ${String(MAX_CONTENT_OPERANDS)} pending operands`);
    }
    this.firstOperand ??= { stream, offset };
    this.operands.push(operand);
  }

  // Continues an operand left open by the streams before, and returns where the operations after it start, or undefined when this stream ends inside it too.
  private resume(open: OpenOperand, bytes: Uint8Array, last: boolean, context: LexContext): number | undefined {
    const closed = closingEnd(bytes, 0, open.depth, context);
    if (closed.end === undefined && !last) {
      open.pieces.push(bytes);
      open.depth = closed.depth;
      return undefined;
    }
    this.open = undefined;
    const end = closed.end ?? bytes.length;
    open.pieces.push(bytes.subarray(0, end));
    // Parsed once from all its pieces; still open after the last stream, it throws ParseError as it would in one stream.
    const lexer = new Lexer({ bytes: joined(open.pieces), base: open.offset, final: true }, 0, context);
    this.append(parseObject(lexer, this.maxNesting, MAX_CONTENT_OPERANDS), open.stream, open.offset);
    return end;
  }

  *read(bytes: Uint8Array, stream: number, last: boolean): Generator<SpannedContentOperation> {
    const context = quiet();
    let start = 0;
    if (this.open !== undefined) {
      const resumed = this.resume(this.open, bytes, last, context);
      if (resumed === undefined) {
        return;
      }
      start = resumed;
    }
    const lexer = new Lexer({ bytes, base: 0, final: true }, start, context);
    // A stream other than the last may end inside an array or dictionary operand, which this lexer reports by throwing WindowEndError.
    const unfinished = last ? undefined : new Lexer({ bytes, base: 0, final: false }, 0, context);
    for (let token = lexer.peek(); token.kind !== 'eof'; token = lexer.peek()) {
      if (isStray(token)) {
        lexer.next();
        this.append({ kind: 'stray-delimiter', bytes: bytes.slice(token.start, token.end) }, stream, token.start);
        continue;
      }
      if (!isOperator(token)) {
        if (this.operands.length >= MAX_CONTENT_OPERANDS) {
          throw new ResourceLimitError(`content has more than ${String(MAX_CONTENT_OPERANDS)} pending operands`);
        }
        if (unfinished !== undefined && (token.kind === 'arrayOpen' || token.kind === 'dictionaryOpen')) {
          unfinished.seek(token.start);
          let operand: ContentOperand;
          try {
            operand = parseObject(unfinished, this.maxNesting, MAX_CONTENT_OPERANDS);
          } catch (error: unknown) {
            if (!(error instanceof WindowEndError)) {
              throw error;
            }
            // Lexing the piece alone throws ParseError for a token that the end of the stream cuts, such as a string.
            const { depth } = closingEnd(bytes, token.start, 0, context);
            this.open = { pieces: [bytes.subarray(token.start)], stream, offset: token.start, depth };
            return;
          }
          lexer.seek(unfinished.position);
          this.append(operand, stream, token.start);
          continue;
        }
        this.append(parseObject(lexer, this.maxNesting, MAX_CONTENT_OPERANDS), stream, token.start);
        continue;
      }
      lexer.next();
      const operator = latin1(bytes.subarray(token.start, token.end));
      const { image } = this;
      if (image !== undefined) {
        this.image = undefined;
        // ISO 32000-1:2008, 8.9.7: "BI and ID shall bracket a series of key-value pairs specifying the characteristics of the image, such as its dimensions and colour space; the image data shall follow between the ID and EI operators".
        if (operator === 'ID') {
          const parameters = this.take();
          const data = inlineImageData(lexer, directValues(parameters));
          yield {
            operator: 'BI',
            operands: image.operands,
            inlineImage: { parameters, data },
            stream: image.stream,
            offset: image.offset,
            start: image.offset,
            end: lexer.position,
          };
          continue;
        }
        // Without ID the parameters stay on the operand stack for the operator that follows them.
        yield { operator: 'BI', operands: image.operands, stream: image.stream, offset: image.offset, start: image.offset, end: image.offset + 2 };
      }
      if (operator === 'BI') {
        this.image = { operands: this.take(), stream, offset: token.start };
      } else {
        const start = this.firstOperand?.stream === stream ? this.firstOperand.offset : token.start;
        yield { operator, operands: this.take(), stream, offset: token.start, start, end: token.end };
      }
    }
  }

  // A BI still waiting for its ID when the content ends is reported without an image; the operands left over are returned.
  *finish(): Generator<SpannedContentOperation, ReadonlyArray<ContentOperand>> {
    const { image } = this;
    this.image = undefined;
    if (image !== undefined) {
      yield { operator: 'BI', operands: image.operands, stream: image.stream, offset: image.offset, start: image.offset, end: image.offset + 2 };
    }
    return this.take();
  }
}

/**
 * Reads content operations with their parsed operands (ISO 32000-1:2008, 7.8.2), from one stream or from the streams of a page's Contents array.
 * Streams are lexed one at a time with one operand stack across them: Table 30 says "The division between streams may occur only at the boundaries between lexical tokens", so no token spans two streams but an operation, or an array or dictionary operand, may.
 * Operands left after the last operator are the generator's return value. Iterating throws ParseError for an operand that cannot be read, such as an unterminated string, and ResourceLimitError for nesting deeper than maxNesting.
 */
export const readContentSpans = function* (
  content: Uint8Array | ReadonlyArray<Uint8Array>,
  maxNesting: number,
): Generator<SpannedContentOperation, ReadonlyArray<ContentOperand>> {
  const reader = new OperationReader(maxNesting);
  const streams: ReadonlyArray<Uint8Array> = Array.isArray(content) ? content : [content];
  for (const [index, bytes] of streams.entries()) {
    yield* reader.read(bytes, index, index === streams.length - 1);
  }
  return yield* reader.finish();
};

/** Reads operations without byte spans for inspection and comparison. */
export const readContent = function* (
  content: Uint8Array | ReadonlyArray<Uint8Array>,
  maxNesting: number,
): Generator<ContentOperation, ReadonlyArray<ContentOperand>> {
  const reader = readContentSpans(content, maxNesting);
  for (let step = reader.next(); ; step = reader.next()) {
    if (step.done === true) {
      return step.value;
    }
    const { start: _start, end: _end, ...operation } = step.value;
    yield operation;
  }
};
