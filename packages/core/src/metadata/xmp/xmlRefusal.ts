import type { XmlRefusal } from './xmlTokenizer.ts';

/** Thrown inside the tokenizer to stop at the first problem; the tokenizer returns it as a result. */
export class RefusalError extends Error {
  readonly reason: XmlRefusal;
  readonly offset: number;

  constructor(reason: XmlRefusal, offset: number) {
    super(`${reason} at ${String(offset)}`);
    this.name = 'RefusalError';
    this.reason = reason;
    this.offset = offset;
  }
}
