// ECMA-262 16th edition (ES2025), 23.2.3.38: the get accessor of %TypedArray%.prototype[%Symbol.toStringTag%] returns the receiver's [[TypedArrayName]] internal slot, and undefined for a receiver without one.
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype);
const typedArrayName = typedArrayPrototype === null ? undefined : Reflect.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;

/** Whether the value is a Uint8Array, read from its [[TypedArrayName]] internal slot, so a subclass and a Uint8Array from another realm count while a Uint8ClampedArray, another typed array, a DataView or an object that only claims the `Symbol.toStringTag` does not. */
export const isUint8Array = (value: unknown): value is Uint8Array => {
  const name: unknown = typedArrayName?.call(value);
  return name === 'Uint8Array';
};
