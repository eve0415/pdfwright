export type Rgb = readonly [number, number, number];

const xor64 = (left: bigint, right: bigint): bigint => {
  let a = left;
  let b = right;
  let result = 0n;
  let place = 1n;
  for (let index = 0; index < 64; index++) {
    if (a % 2n !== b % 2n) result += place;
    a /= 2n;
    b /= 2n;
    place *= 2n;
  }
  return result;
};

export const samples = (): Rgb[] => {
  const result: Rgb[] = [];
  for (let red = 0; red < 17; red++) {
    for (let green = 0; green < 17; green++) {
      for (let blue = 0; blue < 17; blue++) result.push([Math.round((red * 255) / 16), Math.round((green * 255) / 16), Math.round((blue * 255) / 16)]);
    }
  }
  for (let value = 0; value < 256; value++) result.push([value, value, value]);
  result.push(
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 1],
    [2, 2, 2],
    [254, 0, 0],
    [0, 254, 0],
    [0, 0, 254],
    [255, 1, 1],
    [1, 255, 1],
    [1, 1, 255],
    [254, 254, 254],
    [255, 255, 254],
    [254, 255, 255],
    [255, 254, 255],
    [0, 0, 1],
    [1, 0, 0],
    [128, 0, 0],
    [0, 128, 0],
    [0, 0, 128],
  );
  let state = 0x9e3779b97f4a7c15n;
  const modulus = 2n ** 64n;
  for (let sample = 0; sample < 1000; sample++) {
    const rgb: number[] = [];
    for (let channel = 0; channel < 3; channel++) {
      state = xor64(state, (state * 2n ** 13n) % modulus);
      state = xor64(state, state / 2n ** 7n);
      state = xor64(state, (state * 2n ** 17n) % modulus);
      rgb.push(Number(state % 256n));
    }
    result.push([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0]);
  }
  return result;
};
