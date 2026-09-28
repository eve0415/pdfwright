import type { Coordinate, Paint, PathGeometry, PathItem, Point } from '../model/illustratorDocument.ts';
import type { NativeWriter } from './nativeWriter.ts';

import { formatNativeNumber } from './formatNativeNumber.ts';

export interface NativePathOptions {
  readonly yOffset?: number;
}

const number = (value: Coordinate): number => (typeof value === 'number' ? value : Number(value.numerator) / Number(value.denominator));
const formatted = (point: Point, yOffset: number): readonly [string, string] => [
  formatNativeNumber(point[0]),
  yOffset === 0 ? formatNativeNumber(point[1]) : formatNativeNumber(number(point[1]) + yOffset),
];

const needsClosingLine = (geometry: PathGeometry, yOffset: number): boolean => {
  const last = geometry.segments.at(-1)?.to;
  if (last === undefined) return false;
  const [startX, startY] = formatted(geometry.start, yOffset);
  const [lastX, lastY] = formatted(last, yOffset);
  return lastX !== startX || lastY !== startY;
};

export const anchorCount = (geometry: PathGeometry, yOffset = 0): number => geometry.segments.length + (needsClosingLine(geometry, yOffset) ? 1 : 0);

/** Writes a path's operators and repeats the first point when its segments do not close it. */
export const writePathGeometry = (writer: NativeWriter, geometry: PathGeometry, yOffset = 0): void => {
  const [startX, startY] = formatted(geometry.start, yOffset);
  writer.line(`${startX} ${startY} m`);
  for (const segment of geometry.segments) {
    const [x, y] = formatted(segment.to, yOffset);
    const smooth = segment.anchor === 'smooth';
    if (segment.kind === 'line') {
      writer.line(`${x} ${y} ${smooth ? 'l' : 'L'}`);
    } else {
      const [x1, y1] = formatted(segment.control1, yOffset);
      const [x2, y2] = formatted(segment.control2, yOffset);
      writer.line(`${x1} ${y1} ${x2} ${y2} ${x} ${y} ${smooth ? 'c' : 'C'}`);
    }
  }
  if (needsClosingLine(geometry, yOffset)) writer.line(`${startX} ${startY} L`);
};

const writePaint = (writer: NativeWriter, paint: Paint, channel: 'fill' | 'stroke'): void => {
  if (paint.kind === 'process') {
    writer.line(...paint.cmyk.map(component => formatNativeNumber(component)), channel === 'fill' ? 'k' : 'K');
  } else {
    writer.line(
      ...paint.spot.alternate.map(component => formatNativeNumber(component)),
      { utf8: paint.spot.name },
      formatNativeNumber(1 - (paint.tint ?? 1)),
      channel === 'fill' ? 'x' : 'X',
    );
  }
};

/** Writes one native filled, stroked or fill-and-stroke path object. */
export const writePath = (writer: NativeWriter, item: PathItem, options: NativePathOptions = {}): void => {
  const yOffset = options.yOffset ?? 0;
  writer.line(`${String(anchorCount(item.geometry, yOffset))} As`);
  if (item.fill !== undefined) {
    writer.line(item.fill.overprint === true ? '1 O' : '0 O');
    writePaint(writer, item.fill.paint, 'fill');
  }
  if (item.stroke !== undefined) {
    writer.line(item.stroke.overprint === true ? '1 R' : '0 R');
    writePaint(writer, item.stroke.paint, 'stroke');
  }
  writer.line('0 1 0 0 0 Xy');
  writer.line(`0 J 0 j ${item.stroke === undefined ? '1' : formatNativeNumber(item.stroke.width)} w 10 M []0 d`);
  writer.line('0 XR');
  writePathGeometry(writer, item.geometry, yOffset);
  let operator = 'b';
  if (item.fill === undefined) operator = 's';
  else if (item.stroke === undefined) operator = 'f';
  writer.line(operator);
};
