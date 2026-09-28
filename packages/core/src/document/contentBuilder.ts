import type { Length } from '../length/length.ts';
import type { DeviceColor } from './color.ts';
import type { PdfGroup } from './group.ts';
import type { PdfImage } from './image.ts';
import type { Separation } from './separation.ts';

import { ValidationError } from '../error/validationError.ts';
import { formatLength } from '../length/length.ts';
import { formatNumber } from '../number/formatNumber.ts';

/** A PDF content operand expressed as a JavaScript number or exact `Length`; ISO 32000-1:2008, 8.3 defines the current user-space units. */
export type ContentNumber = number | Length;

/** Optional graphics-state changes for opacity, blend mode, overprint, and soft mask; omitted entries keep their current values, alpha is bounded to 0–1, and ISO 32000-1:2008, 8.4.5 and 11.6 define their effects. */
export interface GraphicsStateOptions {
  /** Fill opacity from 0 to 1. */
  fillAlpha?: number;
  /** Stroke opacity from 0 to 1. */
  strokeAlpha?: number;
  /** Blend mode for subsequent painting. */
  blendMode?: 'Normal' | 'Multiply' | 'Screen' | 'Overlay' | 'Darken' | 'Lighten';
  /** Whether fills overprint underlying separations. */
  overprintFill?: boolean;
  /** Whether strokes overprint underlying separations. */
  overprintStroke?: boolean;
  /** PDF overprint mode 0 or 1. */
  overprintMode?: 0 | 1;
  /** None disables a previously selected soft mask. */
  softMask?: 'None';
}

// A form starts from the graphics state of the content that invokes it (ISO 32000-1:2008, 8.10.1), so until it sets a parameter itself the value is 'inherited'.
export interface CurrentGraphicsState {
  fillColor: DeviceColor | Separation | 'inherited';
  strokeColor: DeviceColor | Separation | 'inherited';
  overprintFill: boolean | 'inherited';
  overprintStroke: boolean | 'inherited';
  overprintMode: 0 | 1 | 'inherited';
}

export type BlendingSpace = 'DeviceCMYK' | 'DeviceRGB' | 'DeviceGray' | 'inherited';

// Whether one condition of an invisible white paint holds, or depends on the state the form inherits.
export type WhiteCondition = boolean | 'inherited';

// A paint in a form that is invisible white if every inherited condition turns out true where the form is placed.
export interface WhiteRequirement {
  readonly stroking: boolean;
  readonly color: WhiteCondition;
  readonly overprint: WhiteCondition;
  readonly mode: WhiteCondition;
  readonly space: WhiteCondition;
}

/** Acknowledgment for paint that may disappear under white overprint; omission is false, and unacknowledged cases raise ValidationError with reason `invisible-overprint` under ISO 32000-1:2008, 8.6.7. */
export interface PaintOptions {
  /** Allows painting that overprint settings may make invisible. */
  acknowledgeInvisibleOverprint?: boolean;
}

// What a finished content stream tells a caller that places it as a form.
export interface ContentSummary {
  readonly whiteRequirements: readonly WhiteRequirement[];
  // The deepest q/Q nesting the content reaches, counted from the start of the stream.
  readonly depth: number;
}

export interface ContentHooks {
  registerGraphicsState?: (options: GraphicsStateOptions) => string;
  registerSeparation?: (separation: Separation) => string;
  registerImage?: (image: PdfImage) => string;
  imageMask?: (image: PdfImage) => boolean;
  groupSummary?: (group: PdfGroup) => ContentSummary;
  registerGroup?: (group: PdfGroup) => string;
  // The blending colour space paint is composited in; DeviceCMYK when omitted.
  blendingSpace?: BlendingSpace;
  // True for a form, which starts from the graphics state of whatever content invokes it (ISO 32000-1:2008, 8.10.1).
  inheritsState?: boolean;
  maxDepth?: number;
}

/** Adds move, line, cubic curve, rectangle, and close operators to a path using `ContentNumber` coordinates under ISO 32000-1:2008, 8.5.2. */
export interface PathBuilder {
  moveTo: (...coordinates: [ContentNumber, ContentNumber]) => PathBuilder;
  lineTo: (...coordinates: [ContentNumber, ContentNumber]) => PathBuilder;
  curveTo: (...coordinates: [ContentNumber, ContentNumber, ContentNumber, ContentNumber, ContentNumber, ContentNumber]) => PathBuilder;
  rect: (...coordinates: [ContentNumber, ContentNumber, ContentNumber, ContentNumber]) => PathBuilder;
  close: () => PathBuilder;
}

/** Writes page or form graphics operators, including paths, colour, images, and groups; invalid numeric or paint states raise ValidationError, including reason `invisible-overprint`, under ISO 32000-1:2008, 8.4–8.7. */
export interface ContentBuilder {
  save: () => void;
  restore: () => void;
  transform: (...matrix: [ContentNumber, ContentNumber, ContentNumber, ContentNumber, ContentNumber, ContentNumber]) => void;
  path: (draw: (path: PathBuilder) => PathBuilder) => void;
  fill: (rule: 'nonzero' | 'evenodd', options?: PaintOptions) => void;
  stroke: (options?: PaintOptions) => void;
  fillAndStroke: (rule: 'nonzero' | 'evenodd', options?: PaintOptions) => void;
  clip: (rule: 'nonzero' | 'evenodd') => void;
  /** Sets the line width with the w operator (ISO 32000-1:2008, 8.4.3.2); a negative width throws ValidationError, and 0 is written as given, which 8.4.3.2 defines as the thinnest line the device can render. */
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

const EMPTY_SUMMARY: ContentSummary = { whiteRequirements: [], depth: 0 };

const INHERITED_STATE: CurrentGraphicsState = {
  fillColor: 'inherited',
  strokeColor: 'inherited',
  overprintFill: 'inherited',
  overprintStroke: 'inherited',
  overprintMode: 'inherited',
};

// ISO 32000-1:2008, 8.4.1, Tables 52 and 53: the initial colour is black in DeviceGray, both overprint flags are false and the overprint mode is 0.
const INITIAL_STATE: CurrentGraphicsState = {
  fillColor: { kind: 'DeviceGray', components: [0] },
  strokeColor: { kind: 'DeviceGray', components: [0] },
  overprintFill: false,
  overprintStroke: false,
  overprintMode: 0,
};

const validAlpha = (value: number | undefined): boolean => value === undefined || (Number.isFinite(value) && value >= 0 && value <= 1);

// ISO 32000-1:2008, 8.4.5, Table 58: "Specifying an OP entry shall set both parameters unless there is also an op entry in the same graphics state parameter dictionary", and for op, "If this entry is absent, the OP entry, if any, shall also set this parameter."
// So op alone sets only the fill flag, while the stroke flag alone needs op beside OP to keep the fill flag. A missing flag is filled in only from a value this content set itself: a form cannot know a flag it inherits, so it writes op alone and refuses OP alone.
const overprintFlags = (options: GraphicsStateOptions, state: CurrentGraphicsState): Pick<GraphicsStateOptions, 'overprintFill' | 'overprintStroke'> => {
  const { overprintFill, overprintStroke } = options;
  if (overprintFill === undefined) {
    if (overprintStroke === undefined) return {};
    if (state.overprintFill === 'inherited') {
      throw new ValidationError(
        'inside a group, overprintStroke also needs overprintFill: OP alone sets both flags, and a group cannot know the fill flag it inherits',
      );
    }
    return { overprintFill: state.overprintFill, overprintStroke };
  }
  if (overprintStroke !== undefined) return { overprintFill, overprintStroke };
  if (state.overprintStroke === 'inherited') return { overprintFill };
  return { overprintFill, overprintStroke: state.overprintStroke };
};

const normalizeGraphicsState = (options: GraphicsStateOptions, state: CurrentGraphicsState): GraphicsStateOptions => {
  if (!validAlpha(options.fillAlpha)) throw new ValidationError('fill alpha must be in [0, 1]');
  if (!validAlpha(options.strokeAlpha)) throw new ValidationError('stroke alpha must be in [0, 1]');
  const normalized: GraphicsStateOptions = overprintFlags(options, state);
  if (options.fillAlpha !== undefined) normalized.fillAlpha = options.fillAlpha;
  if (options.strokeAlpha !== undefined) normalized.strokeAlpha = options.strokeAlpha;
  if (options.blendMode !== undefined) normalized.blendMode = options.blendMode;
  if (options.overprintMode !== undefined) normalized.overprintMode = options.overprintMode;
  if (options.softMask !== undefined) normalized.softMask = options.softMask;
  if (normalized.overprintFill !== undefined) state.overprintFill = normalized.overprintFill;
  if (normalized.overprintStroke !== undefined) state.overprintStroke = normalized.overprintStroke;
  if (options.overprintMode !== undefined) state.overprintMode = options.overprintMode;
  return normalized;
};

export const createContentBuilder = (fractionDigits: number, hooks: ContentHooks = {}): ContentSession => {
  const commands: string[] = [];
  let finished = false;
  const ensureOpen = (): void => {
    if (finished) throw new ValidationError('content can be drawn only inside its draw callback');
  };
  const push = (command: string): void => {
    ensureOpen();
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
  let state: CurrentGraphicsState = { ...(hooks.inheritsState === true ? INHERITED_STATE : INITIAL_STATE) };
  const blendingSpace = hooks.blendingSpace ?? 'DeviceCMYK';
  const whiteRequirements = new Map<string, WhiteRequirement>();
  const stack: CurrentGraphicsState[] = [];
  const localStates = new Map<string, string>();
  const localSeparations = new Map<Separation, string>();
  const localImages = new Map<PdfImage, string>();
  const localGroups = new Map<PdfGroup, string>();
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
  const currentConditions = (stroking: boolean): WhiteRequirement => {
    const color = stroking ? state.strokeColor : state.fillColor;
    return {
      stroking,
      color: color === 'inherited' ? 'inherited' : color.kind === 'DeviceCMYK' && color.components.every(component => component === 0),
      overprint: stroking ? state.overprintStroke : state.overprintFill,
      mode: state.overprintMode === 'inherited' ? 'inherited' : state.overprintMode === 1,
      space: blendingSpace === 'inherited' ? 'inherited' : blendingSpace === 'DeviceCMYK',
    };
  };
  // ISO 32000-1:2008, 8.6.7: "When the overprint mode is 1 (also called nonzero overprint mode), a tint value of 0.0 for a source colour component shall leave the corresponding component of the previously painted colour unchanged."
  // 11.7.4.3 applies that only when "the current colour space and group colour space are both DeviceCMYK", so an all-zero DeviceCMYK paint with overprint on prints on no plate.
  // A condition a form inherits is kept as a requirement and settled where the form is placed.
  const settle = (...[requirement, options, message]: [WhiteRequirement, PaintOptions | undefined, string]): void => {
    const conditions = [requirement.color, requirement.overprint, requirement.mode, requirement.space];
    if (conditions.includes(false) || options?.acknowledgeInvisibleOverprint === true) return;
    if (conditions.every(condition => condition === true)) throw new ValidationError(message, 'invisible-overprint');
    whiteRequirements.set(JSON.stringify(requirement), requirement);
  };
  const checkWhiteOverprint = (stroking: boolean, options?: PaintOptions): void => {
    settle(
      currentConditions(stroking),
      options,
      'Writer policy: DeviceCMYK white with overprint mode 1 leaves underlying colorants unchanged and prints on no plate; pass acknowledgeInvisibleOverprint: true to acknowledge',
    );
  };
  const checkGroupWhite = (summary: ContentSummary, options?: PaintOptions): void => {
    for (const requirement of summary.whiteRequirements) {
      const current = currentConditions(requirement.stroking);
      const resolve = (condition: WhiteCondition, caller: WhiteCondition): WhiteCondition => (condition === 'inherited' ? caller : condition);
      settle(
        {
          stroking: requirement.stroking,
          color: resolve(requirement.color, current.color),
          overprint: resolve(requirement.overprint, current.overprint),
          mode: resolve(requirement.mode, current.mode),
          space: resolve(requirement.space, current.space),
        },
        options,
        'Writer policy: DeviceCMYK white inside this group gets overprint mode 1 from the graphics state here and prints on no plate; pass acknowledgeInvisibleOverprint: true to acknowledge',
      );
    }
  };
  const pathBuilder: PathBuilder = {
    // ISO 32000-1:2008, 8.5.2, Table 59 defines m, l, c, re, and h as path construction operators.
    moveTo: (...coordinates): PathBuilder => {
      ensureOpen();
      emit('m', coordinates);
      return pathBuilder;
    },
    lineTo: (...coordinates): PathBuilder => {
      ensureOpen();
      emit('l', coordinates);
      return pathBuilder;
    },
    curveTo: (...coordinates): PathBuilder => {
      ensureOpen();
      emit('c', coordinates);
      return pathBuilder;
    },
    rect: (...coordinates): PathBuilder => {
      ensureOpen();
      emit('re', coordinates);
      return pathBuilder;
    },
    close: (): PathBuilder => {
      ensureOpen();
      emit('h');
      return pathBuilder;
    },
  };
  const content: ContentBuilder = {
    save: (): void => {
      ensureOpen();
      reach(depth + 1);
      depth++;
      stack.push({ ...state });
      emit('q');
    },
    restore: (): void => {
      ensureOpen();
      if (depth === 0) throw new ValidationError('graphics state restore has no matching save');
      depth--;
      const previous = stack.pop();
      if (previous !== undefined) state = previous;
      emit('Q');
    },
    // ISO 32000-1:2008, 8.4.4, Table 57 writes cm with six separate numeric operands.
    transform: (...matrix): void => {
      ensureOpen();
      emit('cm', matrix);
    },
    path: (draw): void => {
      ensureOpen();
      draw(pathBuilder);
    },
    // ISO 32000-1:2008, 8.5.3.1, Table 60 defines f, f*, S, B, and B* as path-painting operators.
    fill: (rule, options): void => {
      ensureOpen();
      checkWhiteOverprint(false, options);
      emit(rule === 'evenodd' ? 'f*' : 'f');
    },
    stroke: (options): void => {
      ensureOpen();
      checkWhiteOverprint(true, options);
      emit('S');
    },
    fillAndStroke: (rule, options): void => {
      ensureOpen();
      checkWhiteOverprint(false, options);
      checkWhiteOverprint(true, options);
      emit(rule === 'evenodd' ? 'B*' : 'B');
    },
    clip: (rule): void => {
      ensureOpen();
      // ISO 32000-1:2008, 8.5.4 applies W or W* before the path-ending n operator.
      emit(rule === 'evenodd' ? 'W*' : 'W');
      emit('n');
    },
    lineWidth: (width): void => {
      ensureOpen();
      // ISO 32000-1:2008, 8.4.3.2 allows width 0 for the thinnest device line but says device-dependent hairlines should not be used.
      nonnegative(width, 'line width');
      emit('w', [width]);
    },
    // ISO 32000-1:2008, 8.4.4, Table 57 defines j, J, M, and d as graphics state operators.
    lineJoin: (join): void => {
      ensureOpen();
      emit('j', [{ miter: 0, round: 1, bevel: 2 }[join]]);
    },
    lineCap: (cap): void => {
      ensureOpen();
      emit('J', [{ butt: 0, round: 1, square: 2 }[cap]]);
    },
    miterLimit: (limit): void => {
      ensureOpen();
      // ISO 32000-1:2008, 8.4.3.5: "The miter limit shall impose a maximum on the ratio of the miter length to the line width"; that ratio is 1 / sin(φ / 2), never below 1.
      if (Number(number(limit)) < 1) throw new ValidationError('miter limit must be at least 1');
      emit('M', [limit]);
    },
    dash: (array, phase): void => {
      ensureOpen();
      // ISO 32000-1:2008, 8.4.3.6 permits an empty array for a solid line, but a nonempty dash array shall not be all zero.
      for (const value of array) nonnegative(value, 'dash length');
      if (array.length > 0 && !array.some(value => Number(number(value)) > 0)) {
        throw new ValidationError('dash array must contain a positive length after rounding');
      }
      nonnegative(phase, 'dash phase');
      push(`[${array.map(value => number(value)).join(' ')}] ${number(phase)} d\n`);
    },
    fillColor: (color, tint): void => {
      ensureOpen();
      state.fillColor = color;
      paintColor(color, tint, false);
    },
    strokeColor: (color, tint): void => {
      ensureOpen();
      state.strokeColor = color;
      paintColor(color, tint, true);
    },
    graphicsState: (options): void => {
      ensureOpen();
      const normalized = normalizeGraphicsState(options, state);
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
      ensureOpen();
      if (hooks.imageMask?.(image) === true) checkWhiteOverprint(false);
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
      ensureOpen();
      const summary = hooks.groupSummary?.(group) ?? EMPTY_SUMMARY;
      // The placement's own q, then Do, which ISO 32000-1:2008, 8.10.1 says "Saves the current graphics state", then the form's own nesting.
      reach(depth + 2 + summary.depth);
      checkGroupWhite(summary, options);
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
        summary: { whiteRequirements: [...whiteRequirements.values()], depth: deepest },
      };
    },
  };
};
