import type { Length } from '../length/length.ts';

import { ValidationError } from '../error/validationError.ts';
import { formatLength } from '../length/length.ts';
import { formatNumber } from '../number/formatNumber.ts';

export type ContentNumber = number | Length;

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
  finish: () => Uint8Array;
}

export const createContentBuilder = (fractionDigits: number): ContentBuilder => {
  const commands: string[] = [];
  let depth = 0;
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
      emit('q');
    },
    restore: (): void => {
      if (depth === 0) throw new ValidationError('graphics state restore has no matching save');
      depth--;
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
    finish: (): Uint8Array => {
      if (depth !== 0) throw new ValidationError('graphics state save and restore must be balanced');
      return new TextEncoder().encode(commands.join(''));
    },
  };
};
