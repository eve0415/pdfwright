/**
 * Writes `content` as one Zstandard frame of a single raw block under the given Frame_Header_Descriptor, with no checksum, so a test controls every header byte.
 *
 * RFC 8878, 3.1.1: the magic number, the Frame_Header_Descriptor, a Window_Descriptor (here 0x58) unless the Single_Segment_flag (bit 5) is set, then a Frame_Content_Size field whose size the flag in bits 6-7 selects; 3.1.1.1.4: the field is one byte only for a single segment, and a two-byte value is stored minus 256.
 * RFC 8878, 3.1.1.2: the block header is three little-endian bytes holding the size shifted left by 3, block type 0 (raw) and the Last_Block bit. A raw block holds at most 131,072 bytes.
 */
export const rawZstandardFrame = (content: Uint8Array, descriptor: number): Uint8Array => {
  const singleSegment = Math.floor(descriptor / 32) % 2 === 1;
  const flag = Math.floor(descriptor / 64);
  const sizeBytes = flag === 0 ? (singleSegment ? 1 : 0) : 2 ** flag;
  const size = sizeBytes === 2 ? content.length - 256 : content.length;
  const sizeField = Array.from({ length: sizeBytes }, (_, index) => Math.floor(size / 256 ** index) % 256);
  const blockHeader = content.length * 8 + 1;
  const blockField = [0, 1, 2].map(index => Math.floor(blockHeader / 256 ** index) % 256);
  return Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, descriptor, ...(singleSegment ? [] : [0x58]), ...sizeField, ...blockField, ...content);
};
