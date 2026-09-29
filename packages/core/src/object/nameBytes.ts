import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

// ISO 32000-1:2008, 7.3.5 defines a name as "a sequence of any characters (8-bit values) except null"; Annex C, Table C.1 limits a name to 127 bytes.
export const assertNameBytes = (bytes: Uint8Array): void => {
  if (bytes.length > 127 || bytes.includes(0)) throw new InvalidArgumentError('a name must have at most 127 bytes and no null byte');
};
