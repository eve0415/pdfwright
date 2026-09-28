import type { Coordinate, IllustratorDocument } from '../model/illustratorDocument.ts';
import type { NativeWriter } from './nativeWriter.ts';

import { createSerializedDictionaryWriter } from './serializedDictionary.ts';

export interface DocumentDataOptions {
  readonly artboardUuid: string;
  readonly convention?: 'bottom-left' | 'top-left';
}

const number = (value: Coordinate): number => (typeof value === 'number' ? value : Number(value.numerator) / Number(value.denominator));

const bleedSides = (
  document: IllustratorDocument,
): { readonly top: Coordinate; readonly right: Coordinate; readonly bottom: Coordinate; readonly left: Coordinate } => {
  const bleed = document.artboard.bleed ?? 0;
  return typeof bleed === 'number' || 'numerator' in bleed ? { top: bleed, right: bleed, bottom: bleed, left: bleed } : bleed;
};

/** Writes the minimal document-data dictionary with one artboard and optional bleed keys. */
export const writeDocumentData = (writer: NativeWriter, document: IllustratorDocument, options: DocumentDataOptions): void => {
  const width = number(document.artboard.width);
  const height = number(document.artboard.height);
  const topLeft = options.convention === 'top-left';
  const rulerX = topLeft ? 8191.5 - width / 2 : Math.floor(8191.5 - width / 2);
  const rulerY = topLeft ? 8191.5 + height / 2 : Math.floor(8191.5 - height / 2);
  const data = createSerializedDictionaryWriter(writer);
  writer.line('%AI9_BeginDocumentData');
  data.open('Document');
  data.open('Dictionary');
  data.int('AIDocumentCanvasSize', 16383);
  data.open('Array');
  data.open('Dictionary');
  data.bool('IsArtboardSelected', true);
  data.bool('IsArtboardDefaultName', document.artboard.name === undefined);
  data.bool('IsArtboardLocked', false);
  data.rawLine('/FillStyle : 0 1 0 0 0 Xy');
  data.rawLine('0 J 0 j 1 w 10 M []0 d');
  data.rawLine('0 XR');
  data.rawLine('0 0 Xd');
  data.rawLine('/Def ; ');
  data.rawLine(' (EachArtboardColor) ,');
  data.point('PositionPoint1', [0, topLeft ? 0 : height], 'RealPointRelToROrigin');
  data.point('PositionPoint2', [width, topLeft ? -height : 0], 'RealPointRelToROrigin');
  data.real('PAR', 1);
  data.unicodeString('Name', document.artboard.name ?? 'Artboard 1');
  data.int('DisplayMark', 0);
  data.point('RulerOrigin', [rulerX, rulerY], 'RealPoint');
  data.asciiString('ArtboardUUID', options.artboardUuid);
  data.close('');
  data.close('ArtboardArray');
  const bleed = bleedSides(document);
  if ([bleed.left, bleed.right, bleed.top, bleed.bottom].some(side => number(side) !== 0)) {
    data.real('BleedLeftValue', bleed.left);
    data.real('BleedRightValue', bleed.right);
    data.real('BleedTopValue', bleed.top);
    data.real('BleedBottomValue', bleed.bottom);
  }
  data.closeRecorded();
  data.close();
  writer.line('%AI9_EndDocumentData');
};
