import { ParseError } from './parseError.ts';

/** A reference names a generation other than its object's in-use entry; pdfwright refuses it unless the caller chooses to read it as null. */
export class GenerationMismatchError extends ParseError {
  constructor(message: string, offset: number) {
    super(message, offset);
    this.name = 'GenerationMismatchError';
  }
}
