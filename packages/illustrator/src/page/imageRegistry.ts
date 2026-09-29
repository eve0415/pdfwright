export interface ImageRegistry {
  fullTint: (width: number, height: number) => Uint8Array;
}

/** Reuses full-tint samples for spot rasters with equal pixel dimensions. */
export const createImageRegistry = (): ImageRegistry => {
  const samples = new Map<string, Uint8Array>();
  return {
    fullTint: (width, height) => {
      const key = `${String(width)}:${String(height)}`;
      let tint = samples.get(key);
      if (tint === undefined) {
        tint = new Uint8Array(width * height).fill(255);
        samples.set(key, tint);
      }
      return tint;
    },
  };
};
