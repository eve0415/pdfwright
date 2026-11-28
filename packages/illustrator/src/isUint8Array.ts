/** Whether the value is a Uint8Array, by the brand every typed array reports in `Symbol.toStringTag`, so a Uint8Array from another realm counts and a Uint8ClampedArray does not. */
export const isUint8Array = (value: unknown): value is Uint8Array =>
  ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
