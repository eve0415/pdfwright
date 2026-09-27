import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { LexContext, Token } from '../parse/lexer.ts';

import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseObject } from '../parse/parseObject.ts';

import { inlineImageData } from './inlineImageData.ts';

// An operator cannot consume an unbounded stack, even when the stream has few or no operators.
export const MAX_CONTENT_OPERANDS = 16_384;

/** An operand: a parsed value, or a closing delimiter with nothing open, kept so that the operator it precedes can be seen to have bad operands. */
export type ContentOperand = PdfDirectObject | { readonly kind: 'stray-delimiter'; readonly bytes: Uint8Array };

export interface InlineImage {
  /** The key and value operands between BI and ID, in order (ISO 32000-1:2008, 8.9.7, Table 93). */
  readonly parameters: readonly ContentOperand[];
  /** The data between ID and EI, as a view of the stream's bytes. */
  readonly data: Uint8Array;
}

export interface ContentOperation {
  readonly operator: string;
  readonly operands: readonly ContentOperand[];
  /** For BI, the inline image that ID and EI delimit; the ID and EI operators are consumed with it. Absent when no ID follows the parameters. */
  readonly inlineImage?: InlineImage;
  /** The index of the stream the operator is in, among the streams given. */
  readonly stream: number;
  /** The operator's byte offset within its stream. */
  readonly offset: number;
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
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

// A stray delimiter reads as null where the inline image data length is computed from the parameters.
const directValues = (operands: readonly ContentOperand[]): PdfDirectObject[] =>
  operands.map(operand => (operand.kind === 'stray-delimiter' ? { kind: 'null' } : operand));

interface PendingImage {
  readonly operands: readonly ContentOperand[];
  readonly stream: number;
  readonly offset: number;
}

/** Reads operations from successive streams with one operand stack, as the streams of a page's Contents array are read. */
class OperationReader {
  private readonly maxNesting: number;
  private operands: ContentOperand[] = [];
  private image: PendingImage | undefined = undefined;

  constructor(maxNesting: number) {
    this.maxNesting = maxNesting;
  }

  private take(): ContentOperand[] {
    const { operands } = this;
    this.operands = [];
    return operands;
  }

  private append(operand: ContentOperand): void {
    if (this.operands.length >= MAX_CONTENT_OPERANDS) throw new ResourceLimitError(`content has more than ${String(MAX_CONTENT_OPERANDS)} pending operands`);
    this.operands.push(operand);
  }

  *read(bytes: Uint8Array, stream: number): Generator<ContentOperation> {
    const lexer = new Lexer({ bytes, base: 0, final: true }, 0, quiet());
    for (let token = lexer.peek(); token.kind !== 'eof'; token = lexer.peek()) {
      if (isStray(token)) {
        lexer.next();
        this.append({ kind: 'stray-delimiter', bytes: bytes.slice(token.start, token.end) });
        continue;
      }
      if (!isOperator(token)) {
        if (this.operands.length >= MAX_CONTENT_OPERANDS) {
          throw new ResourceLimitError(`content has more than ${String(MAX_CONTENT_OPERANDS)} pending operands`);
        }
        this.append(parseObject(lexer, this.maxNesting, MAX_CONTENT_OPERANDS));
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
          yield { operator: 'BI', operands: image.operands, inlineImage: { parameters, data }, stream: image.stream, offset: image.offset };
          continue;
        }
        // Without ID the parameters stay on the operand stack for the operator that follows them.
        yield { operator: 'BI', operands: image.operands, stream: image.stream, offset: image.offset };
      }
      if (operator === 'BI') this.image = { operands: this.take(), stream, offset: token.start };
      else yield { operator, operands: this.take(), stream, offset: token.start };
    }
  }

  // A BI still waiting for its ID when the content ends is reported without an image; the operands left over are returned.
  *finish(): Generator<ContentOperation, readonly ContentOperand[]> {
    const { image } = this;
    this.image = undefined;
    if (image !== undefined) yield { operator: 'BI', operands: image.operands, stream: image.stream, offset: image.offset };
    return this.take();
  }
}

/**
 * Reads content operations with their parsed operands (ISO 32000-1:2008, 7.8.2), from one stream or from the streams of a page's Contents array.
 * Streams are lexed one at a time with one operand stack across them: Table 30 says "The division between streams may occur only at the boundaries between lexical tokens", so no token spans two streams but an operation may.
 * Operands left after the last operator are the generator's return value. Iterating throws ParseError for an operand that cannot be read, such as an unterminated string, and ResourceLimitError for nesting deeper than maxNesting.
 */
export const readContent = function* (content: Uint8Array | readonly Uint8Array[], maxNesting: number): Generator<ContentOperation, readonly ContentOperand[]> {
  const reader = new OperationReader(maxNesting);
  const streams = content instanceof Uint8Array ? [content] : content;
  for (const [index, bytes] of streams.entries()) yield* reader.read(bytes, index);
  return yield* reader.finish();
};
