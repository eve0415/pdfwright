import { ValidationError } from '../error/validationError.ts';

/** A DeviceGray, DeviceRGB, or DeviceCMYK colour whose components are in 0–1; the constructors raise ValidationError without a reason outside that range under ISO 32000-1:2008, 8.6.8, Table 74. */
export type DeviceColor =
  | { readonly kind: 'DeviceCMYK'; readonly components: readonly [number, number, number, number] }
  | { readonly kind: 'DeviceRGB'; readonly components: readonly [number, number, number] }
  | { readonly kind: 'DeviceGray'; readonly components: readonly [number] };

const validate = (components: readonly number[]): void => {
  // ISO 32000-1:2008, 8.6.8, Table 74 bounds DeviceGray, DeviceRGB, and DeviceCMYK operands to 0.0 through 1.0.
  for (const component of components) {
    if (!Number.isFinite(component) || component < 0 || component > 1) throw new ValidationError('device colour components must be in [0, 1]');
  }
};

/** Creates a DeviceCMYK colour from four components in the range 0 to 1. */
export const cmyk = (...components: [number, number, number, number]): DeviceColor => {
  validate(components);
  return { kind: 'DeviceCMYK', components };
};

/** Creates a DeviceRGB colour from three components in the range 0 to 1. */
export const rgb = (...components: [number, number, number]): DeviceColor => {
  validate(components);
  return { kind: 'DeviceRGB', components };
};

/** Creates a DeviceGray colour from one component in the range 0 to 1. */
export const gray = (component: number): DeviceColor => {
  validate([component]);
  return { kind: 'DeviceGray', components: [component] };
};
