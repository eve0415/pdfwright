import type { FillRule, Paint, PathGeometry, PathItem, Point, Subpath } from '../model/illustratorDocument.ts';
import type { NativeWriter } from './nativeWriter.ts';

import { coordinateNumber } from '../model/coordinateNumber.ts';
import { cubicSegments } from '../model/cubicSegments.ts';

import { formatNativeNumber } from './formatNativeNumber.ts';

/** The fill rule selected by the last `XR` operator written in one layer, which later path objects inherit until another `XR` changes it. */
export interface FillRuleState {
  value: FillRule;
}

export interface NativePathOptions {
  readonly yOffset?: number;
  /** Updated to the fill rule this path selects; a fresh state is used when omitted. */
  readonly fillRuleState?: FillRuleState;
}

interface NativeGeometryOptions {
  readonly yOffset: number;
  /** Writes the state lines that follow the first path object's anchor count. */
  readonly writeState: () => void;
  /** The lines that end every path object. */
  readonly ending: readonly string[];
}

const number = coordinateNumber;
const formatted = (point: Point, yOffset: number): readonly [string, string] => [
  formatNativeNumber(point[0]),
  yOffset === 0 ? formatNativeNumber(point[1]) : formatNativeNumber(number(point[1]) + yOffset),
];

const needsClosingLine = (subpath: Subpath, yOffset: number): boolean => {
  const last = subpath.segments.at(-1)?.to;
  if (last === undefined) return false;
  const [startX, startY] = formatted(subpath.start, yOffset);
  const [lastX, lastY] = formatted(last, yOffset);
  return lastX !== startX || lastY !== startY;
};

const anchorCount = (subpath: Subpath, yOffset: number): number => subpath.segments.length + (needsClosingLine(subpath, yOffset) ? 1 : 0);

/** Writes a subpath's operators and repeats the first point when its segments do not close it. */
const writeSubpath = (writer: NativeWriter, subpath: Subpath, yOffset: number): void => {
  const [startX, startY] = formatted(subpath.start, yOffset);
  writer.line(`${startX} ${startY} m`);
  for (const segment of cubicSegments(subpath)) {
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
  if (needsClosingLine(subpath, yOffset)) writer.line(`${startX} ${startY} L`);
};

/** The `XR` line selecting a fill rule. Illustrator 30.8.2 saves write `0 XR` on ordinary paths and `1 XR` only on a compound path, so `1` is taken to be the even-odd rule; no file using it has been opened in Illustrator. */
export const fillRuleLine = (rule: FillRule): string => (rule === 'evenodd' ? '1 XR' : '0 XR');

/**
 * Writes geometry as one native path object, or, for several subpaths, as a compound path: `*u`, one path object per subpath, then `*U`.
 * Illustrator 30.8.2 saves write `0 Ae` before `*u`, give every member its own anchor count and ending operator, and write the paint state once, on the first member.
 */
export const writeNativeGeometry = (writer: NativeWriter, geometry: PathGeometry, options: NativeGeometryOptions): void => {
  const compound = geometry.subpaths.length > 1;
  if (compound) {
    writer.line('0 Ae');
    writer.line('*u');
  }
  for (const [index, subpath] of geometry.subpaths.entries()) {
    writer.line(`${String(anchorCount(subpath, options.yOffset))} As`);
    if (index === 0) options.writeState();
    writeSubpath(writer, subpath, options.yOffset);
    for (const line of options.ending) writer.line(line);
  }
  if (compound) writer.line('*U');
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

/** Writes one native filled, stroked or fill-and-stroke path object, or a compound path of one such object per subpath. */
export const writePath = (writer: NativeWriter, item: PathItem, options: NativePathOptions = {}): void => {
  const rule = item.geometry.fillRule ?? 'nonzero';
  let operator = 'b';
  if (item.fill === undefined) operator = 's';
  else if (item.stroke === undefined) operator = 'f';
  const writeState = (): void => {
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
    writer.line(fillRuleLine(rule));
  };
  writeNativeGeometry(writer, item.geometry, { yOffset: options.yOffset ?? 0, writeState, ending: [operator] });
  if (options.fillRuleState !== undefined) options.fillRuleState.value = rule;
};
