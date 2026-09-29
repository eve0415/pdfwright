import type { Length, PdfDate } from '@pdfwright/core';

/** A distance in points, as a number or an exact rational length. */
export type Coordinate = number | Length;
/** A point measured from the artboard's lower-left corner, with y increasing upward. */
export type Point = readonly [x: Coordinate, y: Coordinate];

export interface IllustratorDocument {
  readonly artboard: Artboard;
  /** Paint order, bottom layer first. */
  readonly layers: readonly Layer[];
  readonly lastModified: PdfDate;
  /** ASCII only; defaults to empty. */
  readonly title?: string;
}

export interface Artboard {
  readonly width: Coordinate;
  readonly height: Coordinate;
  readonly bleed?: Coordinate | { readonly top: Coordinate; readonly right: Coordinate; readonly bottom: Coordinate; readonly left: Coordinate };
  readonly name?: string;
}

export interface Layer {
  readonly name: string;
  readonly visible?: boolean;
  readonly locked?: boolean;
  readonly opacity?: number;
  readonly color?: readonly [red: number, green: number, blue: number];
  /** Paint order, bottom item first. */
  readonly items: readonly Item[];
}

export type Item = PathItem | RasterItem | ClipGroup | Group;

/** A closed path. The writer adds a final line to the start when needed. */
export interface PathGeometry {
  readonly start: Point;
  readonly segments: readonly Segment[];
}

export type Segment =
  | { readonly kind: 'line'; readonly to: Point; readonly anchor?: Anchor }
  | { readonly kind: 'curve'; readonly control1: Point; readonly control2: Point; readonly to: Point; readonly anchor?: Anchor };

export type Anchor = 'corner' | 'smooth';

export interface SpotColor {
  /** Unicode name used in native data. */
  readonly name: string;
  /** Optional colorant-name bytes used on the visible PDF page. */
  readonly nameBytes?: Uint8Array;
  readonly alternate: readonly [c: number, m: number, y: number, k: number];
}

export type Paint =
  | { readonly kind: 'process'; readonly cmyk: readonly [c: number, m: number, y: number, k: number] }
  | { readonly kind: 'spot'; readonly spot: SpotColor; readonly tint?: number };

export interface Fill {
  readonly paint: Paint;
  readonly overprint?: boolean;
}

export interface Stroke {
  readonly paint: Paint;
  /** Width zero draws a device hairline; ISO 32000-1:2008, 8.4.3.2. */
  readonly width: Coordinate;
  readonly overprint?: boolean;
}

export interface PathItem {
  readonly kind: 'path';
  readonly locked?: boolean;
  readonly geometry: PathGeometry;
  readonly fill?: Fill;
  readonly stroke?: Stroke;
}

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

export interface ClipGroup {
  readonly kind: 'clipGroup';
  readonly locked?: boolean;
  readonly clip: PathGeometry;
  readonly items: readonly Item[];
}

export interface Group {
  readonly kind: 'group';
  readonly locked?: boolean;
  readonly opacity?: number;
  readonly isolated?: boolean;
  readonly items: readonly Item[];
}
