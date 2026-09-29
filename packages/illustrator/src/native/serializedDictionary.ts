import type { NativeWriter } from './nativeWriter.ts';
import type { Length } from '@pdfwright/core';

import { InvalidArgumentError, formatInteger } from '@pdfwright/core';

import { formatNativeNumber } from './formatNativeNumber.ts';
import { escapeNativeString } from './nativeString.ts';

export interface SerializedDictionaryWriter {
  open: (kind: 'Document' | 'Dictionary' | 'Array') => void;
  int: (name: string, value: number) => void;
  real: (name: string, value: number | Length) => void;
  bool: (name: string, value: boolean) => void;
  unicodeString: (name: string, value: string) => void;
  asciiString: (name: string, value: string) => void;
  point: (name: string, value: readonly [x: number | Length, y: number | Length], kind: 'RealPoint' | 'RealPointRelToROrigin') => void;
  close: (name?: string) => void;
  closeRecorded: () => void;
  rawLine: (line: string) => void;
}

const encoder = new TextEncoder();

/** Emits the `%_` document-data grammar used in Illustrator's native Setup section. */
export const createSerializedDictionaryWriter = (writer: NativeWriter): SerializedDictionaryWriter => {
  let depth = 0;
  const text = (value: string): void => {
    writer.raw(encoder.encode(value));
  };
  const name = (value: string): void => {
    writer.raw(escapeNativeString(value));
  };
  const scalar = (key: string, type: string, value: Uint8Array): void => {
    text('%_');
    writer.raw(value);
    text(` /${type} `);
    name(key);
    writer.line(' ,');
  };
  const closeDepth = (): void => {
    if (depth === 0) throw new InvalidArgumentError('document-data container is already closed');
    depth--;
  };
  return {
    open: kind => {
      writer.line(`%_/${kind} :`);
      depth++;
    },
    int: (key, value) => {
      scalar(key, 'Int', encoder.encode(formatInteger(value)));
    },
    real: (key, value) => {
      scalar(key, 'Real', encoder.encode(formatNativeNumber(value)));
    },
    bool: (key, value) => {
      scalar(key, 'Bool', encoder.encode(value ? '1' : '0'));
    },
    unicodeString: (key, value) => {
      scalar(key, 'UnicodeString', escapeNativeString(value));
    },
    asciiString: (key, value) => {
      scalar(key, 'String', escapeNativeString(value, 'ascii'));
    },
    point: (key, [x, y], kind) => {
      writer.line(`%_${formatNativeNumber(x)} ${formatNativeNumber(y)} /${kind}`);
      text('%_ ');
      name(key);
      writer.line(' ,');
    },
    close: key => {
      closeDepth();
      if (key === undefined) writer.line('%_;');
      else if (key.length === 0) writer.line('%_; ,');
      else {
        text('%_; ');
        name(key);
        writer.line(' ,');
      }
    },
    closeRecorded: () => {
      closeDepth();
      writer.line('%_; /Recorded ,');
    },
    rawLine: line => {
      writer.line(`%_${line}`);
    },
  };
};
