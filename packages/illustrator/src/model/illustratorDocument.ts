import type { Length, PdfDate } from '@pdfwright/core';

/** A distance in points, as a number or an exact rational length. */
export type Coordinate = number | Length;
/** A point measured from the artboard's lower-left corner, with y increasing upward. */
export type Point = readonly [x: Coordinate, y: Coordinate];

/** Print-production artwork on one artboard, written as a visible PDF page and an Illustrator-native layer copy. */
export interface IllustratorDocument {
  readonly artboard: Artboard;
  /** Paint order, bottom layer first. */
  readonly layers: readonly Layer[];
  readonly lastModified: PdfDate;
  /** ASCII only; defaults to empty. */
  readonly title?: string;
}

/** The artboard's size in points, with optional bleed on every side or per side and an optional name. */
export interface Artboard {
  readonly width: Coordinate;
  readonly height: Coordinate;
  readonly bleed?: Coordinate | { readonly top: Coordinate; readonly right: Coordinate; readonly bottom: Coordinate; readonly left: Coordinate };
  readonly name?: string;
}

/** A top-level layer, visible, unlocked and opaque by default, with an RGB Layers-panel colour that defaults by position. */
export interface Layer {
  readonly name: string;
  readonly visible?: boolean;
  readonly locked?: boolean;
  readonly opacity?: number;
  readonly color?: readonly [red: number, green: number, blue: number];
  /** Paint order, bottom item first. */
  readonly items: readonly Item[];
}

/** One object on a layer or in a group. */
export type Item = PathItem | RasterItem | ClipGroup | Group;

/**
 * One or more closed subpaths filled, stroked or clipped as a single path.
 *
 * One subpath is written to the native copy as an ordinary path; two or more are written as a compound path.
 */
export interface PathGeometry {
  /** At least one subpath, each closed. */
  readonly subpaths: readonly Subpath[];
  /** How overlapping subpaths and self-intersections enclose area for the fill and the clip; `'nonzero'` by default. The stroke is the same under both rules. */
  readonly fillRule?: FillRule;
}

/** A closed subpath. The writer adds a final line to the start when needed. */
export interface Subpath {
  readonly start: Point;
  readonly segments: readonly Segment[];
}

/** The nonzero winding number rule or the even-odd rule of ISO 32000-1:2008, 8.5.3.3. */
export type FillRule = 'nonzero' | 'evenodd';

/** A quadratic segment is written as the cubic curve that traces the same points. */
export type Segment =
  | { readonly kind: 'line'; readonly to: Point; readonly anchor?: Anchor }
  | { readonly kind: 'curve'; readonly control1: Point; readonly control2: Point; readonly to: Point; readonly anchor?: Anchor }
  | { readonly kind: 'quadratic'; readonly control: Point; readonly to: Point; readonly anchor?: Anchor };

/** Whether the anchor a segment ends on is a corner or a smooth point in the native copy; `'corner'` by default. */
export type Anchor = 'corner' | 'smooth';

/** A named spot colorant with its CMYK alternate, components from 0 to 1. */
export interface SpotColor {
  /** Unicode name used in native data. */
  readonly name: string;
  /** Optional colorant-name bytes used on the visible PDF page. */
  readonly nameBytes?: Uint8Array;
  readonly alternate: readonly [c: number, m: number, y: number, k: number];
}

/** A process CMYK colour with components from 0 to 1, or a spot colour at a tint from 0 to 1, 1 by default. */
export type Paint =
  | { readonly kind: 'process'; readonly cmyk: readonly [c: number, m: number, y: number, k: number] }
  | { readonly kind: 'spot'; readonly spot: SpotColor; readonly tint?: number };

/** A path's fill paint, knocking out by default. */
export interface Fill {
  readonly paint: Paint;
  readonly overprint?: boolean;
}

/** A path's stroke paint and width, knocking out by default. */
export interface Stroke {
  readonly paint: Paint;
  /** Width zero draws a device hairline; ISO 32000-1:2008, 8.4.3.2. */
  readonly width: Coordinate;
  readonly overprint?: boolean;
}

/** A path with a fill, a stroke or both. */
export interface PathItem {
  readonly kind: 'path';
  readonly locked?: boolean;
  readonly geometry: PathGeometry;
  readonly fill?: Fill;
  readonly stroke?: Stroke;
}

/** An 8-bit CMYK or spot raster of `width` by `height` pixels placed in `bounds`, with an alpha plane. */
export interface RasterItem {
  readonly kind: 'raster';
  readonly locked?: boolean;
  readonly width: number;
  readonly height: number;
  readonly bounds: { readonly x: Coordinate; readonly y: Coordinate; readonly width: Coordinate; readonly height: Coordinate };
  readonly color:
    | { readonly space: 'cmyk'; readonly samples: Uint8Array }
    | { readonly space: 'spot'; readonly spot: SpotColor; readonly samples?: Uint8Array };
  /** Unassociated alpha, one byte per pixel, with 255 opaque. */
  readonly alpha: Uint8Array;
}

/** Items clipped by a path geometry. */
export interface ClipGroup {
  readonly kind: 'clipGroup';
  readonly locked?: boolean;
  readonly clip: PathGeometry;
  readonly items: readonly Item[];
}

/** Items grouped under one opacity, opaque and non-isolated by default. */
export interface Group {
  readonly kind: 'group';
  readonly locked?: boolean;
  readonly opacity?: number;
  readonly isolated?: boolean;
  readonly items: readonly Item[];
}
