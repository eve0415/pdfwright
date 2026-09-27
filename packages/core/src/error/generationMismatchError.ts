import { ParseError } from './parseError.ts';

/** A reference names a generation other than its object's in-use entry; readers disagree about such references, so loading refuses them unless told otherwise. */
export class GenerationMismatchError extends ParseError {
  constructor(message: string, offset: number) {
    super(message, offset);
    this.name = 'GenerationMismatchError';
  }
}
