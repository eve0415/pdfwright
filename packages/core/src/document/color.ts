import { ValidationError } from '../error/validationError.ts';

export type DeviceColor =
  | { readonly kind: 'DeviceCMYK'; readonly components: readonly [number, number, number, number] }
  | { readonly kind: 'DeviceRGB'; readonly components: readonly [number, number, number] }
  | { readonly kind: 'DeviceGray'; readonly components: readonly [number] };

const validate = (components: readonly number[]): void => {
  for (const component of components) {
    if (!Number.isFinite(component) || component < 0 || component > 1) throw new ValidationError('device colour components must be in [0, 1]');
  }
};

export const cmyk = (...components: [number, number, number, number]): DeviceColor => {
  validate(components);
  return { kind: 'DeviceCMYK', components };
};

export const rgb = (...components: [number, number, number]): DeviceColor => {
  validate(components);
  return { kind: 'DeviceRGB', components };
};

export const gray = (component: number): DeviceColor => {
  validate([component]);
  return { kind: 'DeviceGray', components: [component] };
};
