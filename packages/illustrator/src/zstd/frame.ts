const BLOCK_SIZE = 128 * 1024;

/** Encodes one RFC 8878 frame using raw blocks and the 2 MiB window used by Illustrator 30.8.2. */
export const encodeRawFrame = (input: Uint8Array): Uint8Array => {
  const blocks = Math.max(1, Math.ceil(input.length / BLOCK_SIZE));
  const output = new Uint8Array(6 + input.length + 3 * blocks);
  // RFC 8878, 3.1.1 and 3.1.1.1.1.1: magic number, no content size, and an explicit window descriptor.
  output.set([0x28, 0xb5, 0x2f, 0xfd, 0, 0x58]);
  let position = 6;
  for (let index = 0; index < blocks; index++) {
    const start = index * BLOCK_SIZE;
    const size = Math.min(BLOCK_SIZE, input.length - start);
    // RFC 8878, 3.1.1.2.1-3.1.1.2.4: a little-endian block header gives last-block, type 0 (Raw_Block), and size.
    const header = (size << 3) | (index === blocks - 1 ? 1 : 0);
    output[position] = header & 255;
    output[position + 1] = (header >>> 8) & 255;
    output[position + 2] = (header >>> 16) & 255;
    position += 3;
    output.set(input.subarray(start, start + size), position);
    position += size;
  }
  return output;
};
