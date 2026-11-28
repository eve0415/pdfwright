const END_COMMENTS = new TextEncoder().encode('%%EndComments\r');

/** The byte length of the native header through the CR that closes its first `%%EndComments` line, or -1 when there is none. */
export const endCommentsLength = (native: Uint8Array): number => {
  for (let start = 0; start + END_COMMENTS.length <= native.length; start++) {
    if ((start === 0 || native[start - 1] === 13) && END_COMMENTS.every((byte, index) => native[start + index] === byte)) {
      return start + END_COMMENTS.length;
    }
  }
  return -1;
};
