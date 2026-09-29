import { mm } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { createSerializedDictionaryWriter } from './serializedDictionary.ts';

describe('serialized document-data dictionaries', () => {
  it('writes containers, scalars, points and UTF-8 strings in the native grammar', () => {
    const writer = createNativeWriter();
    const data = createSerializedDictionaryWriter(writer);
    data.open('Document');
    data.open('Dictionary');
    data.int('AIDocumentCanvasSize', 16383);
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
});
