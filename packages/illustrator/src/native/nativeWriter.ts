import { escapeNativeString } from './nativeString.ts';

export type NativeToken = string | { readonly utf8: string };

export interface NativeWriter {
  readonly offset: number;
  line: (...tokens: ReadonlyArray<NativeToken>) => void;
  raw: (bytes: Uint8Array) => void;
  finish: () => Uint8Array;
}

const encoder = new TextEncoder();

const tokenBytes = (token: NativeToken): Uint8Array => {
  if (typeof token === 'string') {
    return encoder.encode(token);
  }
  return escapeNativeString(token.utf8);
};

export const createNativeWriter = (): NativeWriter => {
  const chunks: Array<Uint8Array> = [];
  let offset = 0;
  const raw = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const line = (...tokens: ReadonlyArray<NativeToken>): void => {
    for (const [index, token] of tokens.entries()) {
      if (index > 0) {
        raw(new Uint8Array([32]));
      }
      raw(tokenBytes(token));
    }
    raw(new Uint8Array([13]));
  };
  const finish = (): Uint8Array => {
    const output = new Uint8Array(offset);
    let position = 0;
    for (const chunk of chunks) {
      output.set(chunk, position);
      position += chunk.length;
    }
    return output;
  };
  return {
    get offset() {
      return offset;
    },
    line,
    raw,
    finish,
  };
};
