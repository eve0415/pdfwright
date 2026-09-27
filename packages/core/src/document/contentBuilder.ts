import type { Length } from '../length/length.ts';
import type { DeviceColor } from './color.ts';
import type { PdfGroup } from './group.ts';
import type { PdfImage } from './image.ts';
import type { Separation } from './separation.ts';

import { ValidationError } from '../error/validationError.ts';
import { formatLength } from '../length/length.ts';
import { formatNumber } from '../number/formatNumber.ts';

export type ContentNumber = number | Length;

export interface GraphicsStateOptions {
  fillAlpha?: number;
  strokeAlpha?: number;
  blendMode?: 'Normal' | 'Multiply' | 'Screen' | 'Overlay' | 'Darken' | 'Lighten';
  overprintFill?: boolean;
  overprintStroke?: boolean;
  overprintMode?: 0 | 1;
  softMask?: 'None';
}

export interface CurrentGraphicsState {
  fillColor: DeviceColor | Separation;
  strokeColor: DeviceColor | Separation;
  overprintFill: boolean;
  overprintStroke: boolean;
  overprintMode: 0 | 1;
  ownExtGState: boolean;
}

export interface PaintOptions {
  acknowledgeInvisibleOverprint?: boolean;
}

export interface InheritedWhitePaint {
  fill: boolean;
  stroke: boolean;
}

// What a finished content stream tells a caller that places it as a form.
export interface ContentSummary {
  readonly inheritedWhite: InheritedWhitePaint;
  // The deepest q/Q nesting the content reaches, counted from the start of the stream.
  readonly depth: number;
  readonly colorSpace: 'DeviceCMYK' | 'DeviceRGB' | 'DeviceGray' | undefined;
}

export interface ContentHooks {
  registerGraphicsState?: (options: GraphicsStateOptions) => string;
  registerSeparation?: (separation: Separation) => string;
  registerImage?: (image: PdfImage) => string;
  groupSummary?: (group: PdfGroup) => ContentSummary;
  registerGroup?: (group: PdfGroup) => string;
  colorSpace?: 'DeviceCMYK' | 'DeviceRGB' | 'DeviceGray' | undefined;
  // True for a form, which starts from the graphics state of whatever content invokes it (ISO 32000-1:2008, 8.10.1).
  inheritsState?: boolean;
  maxDepth?: number;
}

export interface PathBuilder {
  moveTo: (...coordinates: [ContentNumber, ContentNumber]) => PathBuilder;
  lineTo: (...coordinates: [ContentNumber, ContentNumber]) => PathBuilder;
  curveTo: (...coordinates: [ContentNumber, ContentNumber, ContentNumber, ContentNumber, ContentNumber, ContentNumber]) => PathBuilder;
  rect: (...coordinates: [ContentNumber, ContentNumber, ContentNumber, ContentNumber]) => PathBuilder;
  close: () => PathBuilder;
}

export interface ContentBuilder {
  save: () => void;
  restore: () => void;
  transform: (...matrix: [ContentNumber, ContentNumber, ContentNumber, ContentNumber, ContentNumber, ContentNumber]) => void;
  path: (draw: (path: PathBuilder) => PathBuilder) => void;
  fill: (rule: 'nonzero' | 'evenodd', options?: PaintOptions) => void;
  stroke: (options?: PaintOptions) => void;
  fillAndStroke: (rule: 'nonzero' | 'evenodd', options?: PaintOptions) => void;
  clip: (rule: 'nonzero' | 'evenodd') => void;
  /** ISO 32000-1:2008, 8.4.3.2: "Since the results of rendering such zero-width lines are device-dependent, they should not be used." */
  lineWidth: (width: ContentNumber) => void;
  lineJoin: (join: 'miter' | 'round' | 'bevel') => void;
  lineCap: (cap: 'butt' | 'round' | 'square') => void;
  miterLimit: (limit: ContentNumber) => void;
  dash: (array: ContentNumber[], phase: ContentNumber) => void;
  fillColor: (color: DeviceColor | Separation, tint?: number) => void;
  strokeColor: (color: DeviceColor | Separation, tint?: number) => void;
  graphicsState: (options: GraphicsStateOptions) => void;
  image: (image: PdfImage, matrix: [ContentNumber, ContentNumber, ContentNumber, ContentNumber, ContentNumber, ContentNumber]) => void;
  group: (group: PdfGroup, matrix: [ContentNumber, ContentNumber, ContentNumber, ContentNumber, ContentNumber, ContentNumber], options?: PaintOptions) => void;
}

export interface FinishedContent {
  readonly data: Uint8Array;
  readonly summary: ContentSummary;
}

// The drawing operations go to the caller's callback; finish stays with the document, which calls it once the callback returns.
export interface ContentSession {
  readonly content: ContentBuilder;
  readonly finish: () => FinishedContent;
}

const EMPTY_SUMMARY: ContentSummary = { inheritedWhite: { fill: false, stroke: false }, depth: 0, colorSpace: undefined };

const validAlpha = (value: number | undefined): boolean => value === undefined || (Number.isFinite(value) && value >= 0 && value <= 1);

// ISO 32000-1:2008, 8.4.5, Table 58: "Specifying an OP entry shall set both parameters unless there is also an op entry in the same graphics state parameter dictionary", and for op, "If this entry is absent, the OP entry, if any, shall also set this parameter."
// So op alone sets only the fill flag, while the stroke flag alone needs op beside OP to keep the fill flag. Page content knows both flags and writes both; a form cannot know the flags it inherits, so it writes op alone and refuses OP alone.
const overprintFlags = (
  ...[options, state, inheritsState]: [GraphicsStateOptions, CurrentGraphicsState, boolean]
): Pick<GraphicsStateOptions, 'overprintFill' | 'overprintStroke'> => {
  if (options.overprintFill === undefined && options.overprintStroke === undefined) return {};
  if (!inheritsState) return { overprintFill: options.overprintFill ?? state.overprintFill, overprintStroke: options.overprintStroke ?? state.overprintStroke };
  if (options.overprintFill === undefined) {
    throw new ValidationError(
      'inside a group, overprintStroke also needs overprintFill: OP alone sets both flags, and a group cannot know the fill flag it inherits',
    );
  }
  return options.overprintStroke === undefined
    ? { overprintFill: options.overprintFill }
    : { overprintFill: options.overprintFill, overprintStroke: options.overprintStroke };
};

const normalizeGraphicsState = (...[options, state, inheritsState]: [GraphicsStateOptions, CurrentGraphicsState, boolean]): GraphicsStateOptions => {
  if (!validAlpha(options.fillAlpha)) throw new ValidationError('fill alpha must be in [0, 1]');
  if (!validAlpha(options.strokeAlpha)) throw new ValidationError('stroke alpha must be in [0, 1]');
  const normalized: GraphicsStateOptions = overprintFlags(options, state, inheritsState);
  if (options.fillAlpha !== undefined) normalized.fillAlpha = options.fillAlpha;
  if (options.strokeAlpha !== undefined) normalized.strokeAlpha = options.strokeAlpha;
  if (options.blendMode !== undefined) normalized.blendMode = options.blendMode;
  if (options.overprintMode !== undefined) normalized.overprintMode = options.overprintMode;
  if (options.softMask !== undefined) normalized.softMask = options.softMask;
  if (normalized.overprintFill !== undefined) state.overprintFill = normalized.overprintFill;
  if (normalized.overprintStroke !== undefined) state.overprintStroke = normalized.overprintStroke;
  if (options.overprintMode !== undefined) state.overprintMode = options.overprintMode;
  state.ownExtGState = true;
  return normalized;
};

export const createContentBuilder = (fractionDigits: number, hooks: ContentHooks = {}): ContentSession => {
  const commands: string[] = [];
  let finished = false;
  const push = (command: string): void => {
    if (finished) throw new ValidationError('content can be drawn only inside its draw callback');
    commands.push(command);
  };
  let depth = 0;
  let deepest = 0;
  // ISO 32000-1:2008, Annex C, Table C.1 limits graphics state nesting to 28 levels.
  const maxDepth = hooks.maxDepth ?? 28;
  const reach = (level: number): void => {
    if (level > maxDepth) throw new ValidationError('graphics state nesting exceeds 28 levels');
    deepest = Math.max(deepest, level);
  };
  let state: CurrentGraphicsState = {
    fillColor: { kind: 'DeviceGray', components: [0] },
    strokeColor: { kind: 'DeviceGray', components: [0] },
    overprintFill: false,
    overprintStroke: false,
    overprintMode: 0,
    ownExtGState: false,
  };
  const stack: CurrentGraphicsState[] = [];
  const localStates = new Map<string, string>();
  const localSeparations = new Map<Separation, string>();
  const localImages = new Map<PdfImage, string>();
  const localGroups = new Map<PdfGroup, string>();
  const inheritedWhite = { fill: false, stroke: false };
  const number = (value: ContentNumber): string => (typeof value === 'number' ? formatNumber(value, fractionDigits) : formatLength(value, fractionDigits));
  const emit = (operator: string, operands: ContentNumber[] = []): void => {
    push(`${operands.map(value => number(value)).join(' ')}${operands.length === 0 ? '' : ' '}${operator}\n`);
  };
  const nonnegative = (value: ContentNumber, name: string): void => {
    if (Number(number(value)) < 0) throw new ValidationError(`${name} must be non-negative`);
  };
  const separationName = (separation: Separation): string => {
    let name = localSeparations.get(separation);
    if (name === undefined) {
      name = hooks.registerSeparation?.(separation) ?? `CS${localSeparations.size + 1}`;
      localSeparations.set(separation, name);
    }
    return name;
  };
  const paintColor = (color: DeviceColor | Separation, tint: number | undefined, stroking: boolean): void => {
    if (color.kind === 'Separation') {
      if (tint === undefined || !Number.isFinite(tint) || tint < 0 || tint > 1) throw new ValidationError('separation tint must be in [0, 1]');
      push(`/${separationName(color)} ${stroking ? 'CS' : 'cs'}\n`);
      emit(stroking ? 'SCN' : 'scn', [tint]);
      return;
    }
    if (tint !== undefined) throw new ValidationError('device colour does not accept a tint');
    const operator = stroking
      ? { DeviceCMYK: 'K', DeviceRGB: 'RG', DeviceGray: 'G' }[color.kind]
      : { DeviceCMYK: 'k', DeviceRGB: 'rg', DeviceGray: 'g' }[color.kind];
    emit(operator, [...color.components]);
  };
  const checkWhiteOverprint = (stroking: boolean, options?: PaintOptions): void => {
    const color = stroking ? state.strokeColor : state.fillColor;
    const overprint = stroking ? state.overprintStroke : state.overprintFill;
    if (color.kind === 'DeviceCMYK' && color.components.every(component => component === 0) && !state.ownExtGState) {
      if (stroking) inheritedWhite.stroke = true;
      else inheritedWhite.fill = true;
    }
    // ISO 32000-1:2008, 8.6.7 and Table 148: with OPM 1, zero DeviceCMYK components specified directly do not paint their process plates.
    if (
      color.kind === 'DeviceCMYK' &&
      color.components.every(component => component === 0) &&
      overprint &&
      state.overprintMode === 1 &&
      (hooks.colorSpace === undefined || hooks.colorSpace === 'DeviceCMYK') &&
      options?.acknowledgeInvisibleOverprint !== true
    ) {
      throw new ValidationError(
        'Writer policy: DeviceCMYK white with overprint mode 1 leaves underlying colorants unchanged and prints on no plate; pass acknowledgeInvisibleOverprint: true to acknowledge',
      );
    }
  };
  const pathBuilder: PathBuilder = {
    // ISO 32000-1:2008, 8.5.2, Table 59 defines m, l, c, re, and h as path construction operators.
    moveTo: (...coordinates): PathBuilder => {
      emit('m', coordinates);
      return pathBuilder;
    },
    lineTo: (...coordinates): PathBuilder => {
      emit('l', coordinates);
      return pathBuilder;
    },
    curveTo: (...coordinates): PathBuilder => {
      emit('c', coordinates);
      return pathBuilder;
    },
    rect: (...coordinates): PathBuilder => {
      emit('re', coordinates);
      return pathBuilder;
    },
    close: (): PathBuilder => {
      emit('h');
      return pathBuilder;
    },
  };
  const content: ContentBuilder = {
    save: (): void => {
      reach(depth + 1);
      depth++;
      stack.push({ ...state });
      emit('q');
    },
    restore: (): void => {
      if (depth === 0) throw new ValidationError('graphics state restore has no matching save');
      depth--;
      const previous = stack.pop();
      if (previous !== undefined) state = previous;
      emit('Q');
    },
    // ISO 32000-1:2008, 8.4.4, Table 57 writes cm with six separate numeric operands.
    transform: (...matrix): void => {
      emit('cm', matrix);
    },
    path: (draw): void => {
      draw(pathBuilder);
    },
    // ISO 32000-1:2008, 8.5.3.1, Table 60 defines f, f*, S, B, and B* as path-painting operators.
    fill: (rule, options): void => {
      checkWhiteOverprint(false, options);
      emit(rule === 'evenodd' ? 'f*' : 'f');
    },
    stroke: (options): void => {
      checkWhiteOverprint(true, options);
      emit('S');
    },
    fillAndStroke: (rule, options): void => {
      checkWhiteOverprint(false, options);
      checkWhiteOverprint(true, options);
      emit(rule === 'evenodd' ? 'B*' : 'B');
    },
    clip: (rule): void => {
      // ISO 32000-1:2008, 8.5.4 applies W or W* before the path-ending n operator.
      emit(rule === 'evenodd' ? 'W*' : 'W');
      emit('n');
    },
    lineWidth: (width): void => {
      // ISO 32000-1:2008, 8.4.3.2 allows width 0 for the thinnest device line but says device-dependent hairlines should not be used.
      nonnegative(width, 'line width');
      emit('w', [width]);
    },
    // ISO 32000-1:2008, 8.4.4, Table 57 defines j, J, M, and d as graphics state operators.
    lineJoin: (join): void => {
      emit('j', [{ miter: 0, round: 1, bevel: 2 }[join]]);
    },
    lineCap: (cap): void => {
      emit('J', [{ butt: 0, round: 1, square: 2 }[cap]]);
    },
    miterLimit: (limit): void => {
      // ISO 32000-1:2008, 8.4.3.5: "The miter limit shall impose a maximum on the ratio of the miter length to the line width"; that ratio is 1 / sin(φ / 2), never below 1.
      if (Number(number(limit)) < 1) throw new ValidationError('miter limit must be at least 1');
      emit('M', [limit]);
    },
    dash: (array, phase): void => {
      // ISO 32000-1:2008, 8.4.3.6 permits an empty array for a solid line, but a nonempty dash array shall not be all zero.
      for (const value of array) nonnegative(value, 'dash length');
      if (array.length > 0 && !array.some(value => Number(number(value)) > 0)) {
        throw new ValidationError('dash array must contain a positive length after rounding');
      }
      nonnegative(phase, 'dash phase');
      push(`[${array.map(value => number(value)).join(' ')}] ${number(phase)} d\n`);
    },
    fillColor: (color, tint): void => {
      state.fillColor = color;
      paintColor(color, tint, false);
    },
    strokeColor: (color, tint): void => {
      state.strokeColor = color;
      paintColor(color, tint, true);
    },
    graphicsState: (options): void => {
      const normalized = normalizeGraphicsState(options, state, hooks.inheritsState === true);
      const key = JSON.stringify([
        normalized.fillAlpha,
        normalized.strokeAlpha,
        normalized.blendMode,
        normalized.overprintStroke,
        normalized.overprintFill,
        normalized.overprintMode,
        normalized.softMask,
      ]);
      let name = localStates.get(key);
      if (name === undefined) {
        name = hooks.registerGraphicsState?.(normalized) ?? `GS${localStates.size + 1}`;
        localStates.set(key, name);
      }
      push(`/${name} gs\n`);
    },
    image: (image, matrix): void => {
      reach(depth + 1);
      let name = localImages.get(image);
      if (name === undefined) {
        name = hooks.registerImage?.(image) ?? `Im${localImages.size + 1}`;
        localImages.set(image, name);
      }
      // ISO 32000-1:2008, 8.9.4 paints an image XObject into the unit square under the current transformation matrix.
      emit('q');
      emit('cm', matrix);
      push(`/${name} Do\n`);
      emit('Q');
    },
    group: (group, matrix, options): void => {
      const summary = hooks.groupSummary?.(group) ?? EMPTY_SUMMARY;
      // The placement's own q, then Do, which ISO 32000-1:2008, 8.10.1 says "Saves the current graphics state", then the form's own nesting.
      reach(depth + 2 + summary.depth);
      const inheritedOverprint = (summary.inheritedWhite.fill && state.overprintFill) || (summary.inheritedWhite.stroke && state.overprintStroke);
      // ISO 32000-1:2008, 8.10.1 makes a form inherit the graphics state at Do; 8.6.7 and Table 148 leave zero DeviceCMYK components unchanged under OPM 1.
      if (
        inheritedOverprint &&
        state.overprintMode === 1 &&
        (hooks.colorSpace === undefined || hooks.colorSpace === 'DeviceCMYK') &&
        (summary.colorSpace === undefined || summary.colorSpace === 'DeviceCMYK') &&
        options?.acknowledgeInvisibleOverprint !== true
      ) {
        throw new ValidationError(
          'Writer policy: DeviceCMYK white inside this group inherits overprint mode 1 and prints on no plate; pass acknowledgeInvisibleOverprint: true to acknowledge',
        );
      }
      let name = localGroups.get(group);
      if (name === undefined) {
        name = hooks.registerGroup?.(group) ?? `Fm${localGroups.size + 1}`;
        localGroups.set(group, name);
      }
      emit('q');
      emit('cm', matrix);
      push(`/${name} Do\n`);
      emit('Q');
    },
  };
  Object.freeze(content);
  return {
    content,
    finish: (): FinishedContent => {
      if (depth !== 0) throw new ValidationError('graphics state save and restore must be balanced');
      finished = true;
      return {
        data: new TextEncoder().encode(commands.join('')),
        summary: { inheritedWhite: { ...inheritedWhite }, depth: deepest, colorSpace: hooks.colorSpace },
      };
    },
  };
};
