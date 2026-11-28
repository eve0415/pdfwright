import type { SerializedDictionaryWriter } from './serializedDictionary.ts';

import { InvalidArgumentError, ValidationError, mm } from '@pdfwright/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { createSerializedDictionaryWriter } from './serializedDictionary.ts';

const render = (write: (data: SerializedDictionaryWriter) => void): string => {
  const writer = createNativeWriter();
  write(createSerializedDictionaryWriter(writer));
  return new TextDecoder().decode(writer.finish());
};

describe('serialized document-data dictionaries', () => {
  it('writes containers, scalars, points and UTF-8 strings in the native grammar', () => {
    const writer = createNativeWriter();
    const data = createSerializedDictionaryWriter(writer);
    data.open('Document');
    data.open('Dictionary');
    data.int('AIDocumentCanvasSize', 16_383);
    data.open('Array');
    data.open('Dictionary');
    data.bool('IsArtboardSelected', true);
    data.point('PositionPoint1', [0, mm(70)], 'RealPointRelToROrigin');
    data.unicodeString('Name', 'アートボード 1');
    data.close('');
    data.close('ArtboardArray');
    data.real('BleedLeftValue', mm(3));
    data.closeRecorded();
    data.close();
    expect(new TextDecoder().decode(writer.finish())).toBe(
      '%_/Document :\r%_/Dictionary :\r%_16383 /Int (AIDocumentCanvasSize) ,\r%_/Array :\r%_/Dictionary :\r%_1 /Bool (IsArtboardSelected) ,\r%_0 198.4251968504 /RealPointRelToROrigin\r%_ (PositionPoint1) ,\r%_(アートボード 1) /UnicodeString (Name) ,\r%_; ,\r%_; (ArtboardArray) ,\r%_8.5039370079 /Real (BleedLeftValue) ,\r%_; /Recorded ,\r%_;\r',
    );
  });

  it.each([
    [
      'a false Bool',
      (data: SerializedDictionaryWriter) => {
        data.bool('k', false);
      },
      '%_0 /Bool (k) ,\r',
    ],
    [
      'an ASCII String',
      (data: SerializedDictionaryWriter) => {
        data.asciiString('ArtboardUUID', 'abc');
      },
      '%_(abc) /String (ArtboardUUID) ,\r',
    ],
    [
      'a raw line',
      (data: SerializedDictionaryWriter) => {
        data.rawLine('x');
      },
      '%_x\r',
    ],
    [
      'an absolute point',
      (data: SerializedDictionaryWriter) => {
        data.point('RulerOrigin', [1, 2], 'RealPoint');
      },
      '%_1 2 /RealPoint\r%_ (RulerOrigin) ,\r',
    ],
    [
      'an escaped key',
      (data: SerializedDictionaryWriter) => {
        data.int('a(b', 1);
      },
      String.raw`%_1 /Int (a\(b) ,` + '\r',
    ],
  ] as const)('writes %s', (_name, write, expected) => {
    expect(render(write)).toBe(expected);
  });

  it('rejects a non-ASCII value in an ASCII String', () => {
    expect(() =>
      render(data => {
        data.asciiString('k', 'é');
      }),
    ).toThrow(ValidationError);
  });

  it('rejects closing a container that is not open', () => {
    expect(() =>
      render(data => {
        data.open('Document');
        data.close();
        data.close();
      }),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      render(data => {
        data.closeRecorded();
      }),
    ).toThrow(InvalidArgumentError);
  });
});

describe('properties', () => {
  const closers: ReadonlyArray<(data: SerializedDictionaryWriter) => void> = [
    data => {
      data.close();
    },
    data => {
      data.close('');
    },
    data => {
      data.close('Key');
    },
    data => {
      data.closeRecorded();
    },
  ];

  it('accepts every balanced sequence of opens and closes and rejects one close more', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ open: fc.boolean(), kind: fc.constantFrom('Document', 'Dictionary', 'Array'), closer: fc.integer({ min: 0, max: 3 }) }), {
          maxLength: 16,
        }),
        fc.integer({ min: 0, max: 3 }),
        (steps, extra) => {
          const data = createSerializedDictionaryWriter(createNativeWriter());
          let depth = 0;
          for (const step of steps) {
            if (step.open || depth === 0) {
              data.open(step.kind);
              depth++;
            } else {
              closers[step.closer]?.(data);
              depth--;
            }
          }
          for (; depth > 0; depth--) {
            data.close();
          }
          expect(() => closers[extra]?.(data)).toThrow(InvalidArgumentError);
        },
      ),
    );
  });
});
