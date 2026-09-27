const REGULAR = 0;
const WHITESPACE = 1;
const DELIMITER = 2;

// ISO 32000-1:2008, 7.2.2: "The PDF character set is divided into three classes, called regular, delimiter, and white-space characters."
const CLASSES = ((): Uint8Array => {
  const table = new Uint8Array(256).fill(REGULAR);
  // Table 1: NUL, HORIZONTAL TAB, LINE FEED, FORM FEED, CARRIAGE RETURN and SPACE.
  for (const byte of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) table[byte] = WHITESPACE;
  // Table 2: ( ) < > [ ] { } / %.
  for (const byte of [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]) table[byte] = DELIMITER;
  return table;
})();

export const isWhitespace = (byte: number): boolean => CLASSES[byte] === WHITESPACE;

export const isDelimiter = (byte: number): boolean => CLASSES[byte] === DELIMITER;

// "All characters except the white-space characters and delimiters are referred to as regular characters."
export const isRegular = (byte: number): boolean => CLASSES[byte] === REGULAR;
