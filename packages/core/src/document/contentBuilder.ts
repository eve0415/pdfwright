import type { Length } from '../length/length.ts';
import type { DeviceColor } from './color.ts';

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
  fillColor: DeviceColor;
  strokeColor: DeviceColor;
  overprintFill: boolean;
  overprintStroke: boolean;
  overprintMode: 0 | 1;
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
  fill: (rule: 'nonzero' | 'evenodd') => void;
  stroke: () => void;
  fillAndStroke: (rule: 'nonzero' | 'evenodd') => void;
  clip: (rule: 'nonzero' | 'evenodd') => void;
  lineWidth: (width: ContentNumber) => void;
  lineJoin: (join: 'miter' | 'round' | 'bevel') => void;
  lineCap: (cap: 'butt' | 'round' | 'square') => void;
  miterLimit: (limit: ContentNumber) => void;
  dash: (array: ContentNumber[], phase: ContentNumber) => void;
  fillColor: (color: DeviceColor) => void;
  strokeColor: (color: DeviceColor) => void;
  graphicsState: (options: GraphicsStateOptions) => void;
  finish: () => Uint8Array;
}

const normalizeGraphicsState = (options: GraphicsStateOptions, state: CurrentGraphicsState): GraphicsStateOptions => {
  if (options.fillAlpha !== undefined && (!Number.isFinite(options.fillAlpha) || options.fillAlpha < 0 || options.fillAlpha > 1)) {
    throw new ValidationError('fill alpha must be in [0, 1]');
  }
  if (options.strokeAlpha !== undefined && (!Number.isFinite(options.strokeAlpha) || options.strokeAlpha < 0 || options.strokeAlpha > 1)) {
    throw new ValidationError('stroke alpha must be in [0, 1]');
  }
  const normalized: GraphicsStateOptions = {};
  if (options.fillAlpha !== undefined) normalized.fillAlpha = options.fillAlpha;
  if (options.strokeAlpha !== undefined) normalized.strokeAlpha = options.strokeAlpha;
  if (options.blendMode !== undefined) normalized.blendMode = options.blendMode;
  if (options.overprintMode !== undefined) normalized.overprintMode = options.overprintMode;
  if (options.softMask !== undefined) normalized.softMask = options.softMask;
  if (options.overprintFill !== undefined || options.overprintStroke !== undefined) {
    normalized.overprintFill = options.overprintFill ?? state.overprintFill;
    normalized.overprintStroke = options.overprintStroke ?? state.overprintStroke;
    state.overprintFill = normalized.overprintFill;
    state.overprintStroke = normalized.overprintStroke;
  }
  if (options.overprintMode !== undefined) state.overprintMode = options.overprintMode;
  return normalized;
};

export const createContentBuilder = (fractionDigits: number, registerGraphicsState?: (options: GraphicsStateOptions) => string): ContentBuilder => {
  const commands: string[] = [];
  let depth = 0;
  let state: CurrentGraphicsState = {
    fillColor: { kind: 'DeviceGray', components: [0] },
    strokeColor: { kind: 'DeviceGray', components: [0] },
    overprintFill: false,
    overprintStroke: false,
    overprintMode: 0,
  };
  const stack: CurrentGraphicsState[] = [];
  const localStates = new Map<string, string>();
  const number = (value: ContentNumber): string => (typeof value === 'number' ? formatNumber(value, fractionDigits) : formatLength(value, fractionDigits));
  const emit = (operator: string, operands: ContentNumber[] = []): void => {
    commands.push(`${operands.map(value => number(value)).join(' ')}${operands.length === 0 ? '' : ' '}${operator}\n`);
  };
  const nonnegative = (value: ContentNumber, name: string): void => {
    if (Number(number(value)) < 0) throw new ValidationError(`${name} must be non-negative`);
  };
  const pathBuilder: PathBuilder = {
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
  return {
    save: (): void => {
      // ISO 32000-1:2008, Annex C, Table C.1 limits graphics state nesting to 28 levels.
      if (depth === 28) throw new ValidationError('graphics state nesting exceeds 28 levels');
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
    transform: (...matrix): void => {
      emit('cm', matrix);
    },
    path: (draw): void => {
      draw(pathBuilder);
    },
    fill: (rule): void => {
      emit(rule === 'evenodd' ? 'f*' : 'f');
    },
    stroke: (): void => {
      emit('S');
    },
    fillAndStroke: (rule): void => {
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
    lineJoin: (join): void => {
      emit('j', [{ miter: 0, round: 1, bevel: 2 }[join]]);
    },
    lineCap: (cap): void => {
      emit('J', [{ butt: 0, round: 1, square: 2 }[cap]]);
    },
    miterLimit: (limit): void => {
      nonnegative(limit, 'miter limit');
      emit('M', [limit]);
    },
    dash: (array, phase): void => {
      for (const value of array) nonnegative(value, 'dash length');
      nonnegative(phase, 'dash phase');
      commands.push(`[${array.map(value => number(value)).join(' ')}] ${number(phase)} d\n`);
    },
    fillColor: (color): void => {
      state.fillColor = color;
      emit({ DeviceCMYK: 'k', DeviceRGB: 'rg', DeviceGray: 'g' }[color.kind], [...color.components]);
    },
    strokeColor: (color): void => {
      state.strokeColor = color;
      emit({ DeviceCMYK: 'K', DeviceRGB: 'RG', DeviceGray: 'G' }[color.kind], [...color.components]);
    },
    graphicsState: (options): void => {
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
        name = registerGraphicsState?.(normalized) ?? `GS${localStates.size + 1}`;
        localStates.set(key, name);
      }
      commands.push(`/${name} gs\n`);
    },
    finish: (): Uint8Array => {
      if (depth !== 0) throw new ValidationError('graphics state save and restore must be balanced');
      return new TextEncoder().encode(commands.join(''));
    },
  };
};
