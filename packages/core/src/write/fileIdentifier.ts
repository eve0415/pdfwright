import { ByteWriter } from '../bytes/byteWriter.ts';
import { md5 } from '../hash/md5.ts';

export const fileIdentifier = (body: Uint8Array, trailerWithoutId: Uint8Array, supplied?: [Uint8Array, Uint8Array]): [Uint8Array, Uint8Array] => {
  if (supplied !== undefined) return supplied;
  // ISO 32000-1:2008, 14.4 says the identifier calculation need not be reproducible; this implementation hashes the serialized body through the last endobj followed by the serialized trailer dictionary without /ID.
  const input = new ByteWriter();
  input.writeBytes(body);
  input.writeBytes(trailerWithoutId);
  const digest = md5(input.toUint8Array());
  return [digest, digest];
};
