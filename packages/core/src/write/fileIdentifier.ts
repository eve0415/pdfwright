import { createMd5 } from '../hash/md5.ts';

export const fileIdentifier = (body: readonly Uint8Array[], trailerWithoutId: Uint8Array, supplied?: [Uint8Array, Uint8Array]): [Uint8Array, Uint8Array] => {
  if (supplied !== undefined) return supplied;
  // ISO 32000-1:2008, 14.4 says the identifier calculation need not be reproducible; this implementation hashes the serialized body through the last endobj followed by the serialized trailer dictionary without /ID.
  const hash = createMd5();
  for (const chunk of body) hash.update(chunk);
  const digest = hash.update(trailerWithoutId).digest();
  return [digest, digest];
};
