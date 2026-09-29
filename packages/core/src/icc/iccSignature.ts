export const iccSignature = (bytes: Uint8Array, offset: number): string =>
  String.fromCodePoint(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
