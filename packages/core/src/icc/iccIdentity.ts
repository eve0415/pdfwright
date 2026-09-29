import { createMd5 } from '../hash/md5.ts';

/** ICC.1:2022, 7.2.18: MD5 over the declared profile bytes with flags, intent and header ID set to zero. */
export const iccIdentity = (bytes: Uint8Array): Uint8Array => {
  const zero4 = new Uint8Array(4);
  const zero16 = new Uint8Array(16);
  return createMd5()
    .update(bytes.subarray(0, 44))
    .update(zero4)
    .update(bytes.subarray(48, 64))
    .update(zero4)
    .update(bytes.subarray(68, 84))
    .update(zero16)
    .update(bytes.subarray(100))
    .digest();
};
