import { InvalidArgumentError, md5 } from '@pdfwright/core';

const NAMESPACE = new Uint8Array([0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]);
const encoder = new TextEncoder();

/** Computes UUIDv3 in network byte order, with version and variant bits set per RFC 9562, 5.3. */
export const uuidV3 = (namespace: Uint8Array, name: Uint8Array): string => {
  if (namespace.length !== 16) throw new InvalidArgumentError('UUID namespace must contain 16 bytes');
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const digest = md5(input);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x30;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Derives a stable artboard or raster identifier from its role, content digest and item path. */
export const nameBasedUuid = (role: string, content: Uint8Array, path = ''): string => {
  const roleBytes = encoder.encode(role);
  const pathBytes = encoder.encode(path);
  const name = new Uint8Array(roleBytes.length + 1 + 16 + 1 + pathBytes.length);
  name.set(roleBytes);
  name.set(md5(content), roleBytes.length + 1);
  name.set(pathBytes, roleBytes.length + 18);
  return uuidV3(NAMESPACE, name);
};
