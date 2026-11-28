import type { Artboard, IllustratorDocument } from '../model/illustratorDocument.ts';
import type { NativeOrigin } from './nativeOrigin.ts';

import { mm, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { writeDocumentData } from './writeDocumentData.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 0, minute: 0, second: 0, offset: 'Z' });
const uuid = 'd1407a68-df67-3fd7-9ab1-e274337d49bd';

const render = (artboard: Artboard, nativeOrigin?: NativeOrigin): string => {
  const document: IllustratorDocument = { artboard, layers: [], lastModified: date };
  const writer = createNativeWriter();
  writeDocumentData(writer, document, nativeOrigin === undefined ? { artboardUuid: uuid } : { artboardUuid: uuid, nativeOrigin });
  return new TextDecoder().decode(writer.finish());
};

const bleedLines = (text: string): Array<string> => text.split('\r').filter(line => /Bleed\w+Value/u.test(line));

describe('native document data', () => {
  it('declares the artboard, ruler origin, bleed and the UUID it is given', () => {
    const text = render({ width: 100, height: 70, bleed: { top: 3, right: 2, bottom: 1, left: 4 } });
    expect(text).toContain('%_0 70 /RealPointRelToROrigin\r%_ (PositionPoint1) ,\r%_100 0 /RealPointRelToROrigin\r');
    expect(text).toContain('%_8141 8156 /RealPoint\r%_ (RulerOrigin) ,\r');
    expect(text).toContain(`%_(${uuid}) /String (ArtboardUUID) ,\r`);
    expect(text).toContain('%_4 /Real (BleedLeftValue) ,\r%_2 /Real (BleedRightValue) ,\r%_3 /Real (BleedTopValue) ,\r%_1 /Real (BleedBottomValue) ,\r');
    expect(text).toMatch(/%_; \/Recorded ,\r%_;\r%AI9_EndDocumentData\r$/u);
  });

  it('places the artboard below a top-left ruler origin without flooring it', () => {
    const text = render({ width: 100, height: 70 }, 'artboard-top-left');
    expect(text).toContain('%_0 0 /RealPointRelToROrigin\r%_ (PositionPoint1) ,\r%_100 -70 /RealPointRelToROrigin\r%_ (PositionPoint2) ,\r');
    expect(text).toContain('%_8141.5 8226.5 /RealPoint\r%_ (RulerOrigin) ,\r');
  });

  it.each([
    ['no bleed', undefined, []],
    ['a zero bleed', 0, []],
    ['a zero exact bleed', mm(0), []],
    ['a uniform bleed', 3, ['3', '3', '3', '3']],
    ['a uniform exact bleed', mm(3), ['8.5039370079', '8.5039370079', '8.5039370079', '8.5039370079']],
    ['a bleed on the left only', { top: 0, right: 0, bottom: 0, left: 0.5 }, ['0.5', '0', '0', '0']],
    ['a bleed on the right only', { top: 0, right: 0.5, bottom: 0, left: 0 }, ['0', '0.5', '0', '0']],
    ['a bleed on the top only', { top: 0.5, right: 0, bottom: 0, left: 0 }, ['0', '0', '0.5', '0']],
    ['a bleed on the bottom only', { top: 0, right: 0, bottom: 0.5, left: 0 }, ['0', '0', '0', '0.5']],
  ] as const)('writes the bleed keys for %s', (_name, bleed, values) => {
    const text = render(bleed === undefined ? { width: 100, height: 70 } : { width: 100, height: 70, bleed });
    const keys = ['BleedLeftValue', 'BleedRightValue', 'BleedTopValue', 'BleedBottomValue'];
    expect(bleedLines(text)).toStrictEqual(values.map((value, index) => `%_${value} /Real (${keys[index] ?? ''}) ,`));
  });

  it.each([
    ['an unnamed artboard as the default name', undefined, '%_1 /Bool (IsArtboardDefaultName) ,\r', '%_(Artboard 1) /UnicodeString (Name) ,\r'],
    ['a named artboard by its name', 'Cover', '%_0 /Bool (IsArtboardDefaultName) ,\r', '%_(Cover) /UnicodeString (Name) ,\r'],
  ] as const)('writes %s', (_name, name, flag, nameLine) => {
    const text = render(name === undefined ? { width: 100, height: 70 } : { width: 100, height: 70, name });
    expect(text).toContain(flag);
    expect(text).toContain(nameLine);
  });
});
