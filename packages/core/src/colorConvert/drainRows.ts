/** Decodes every row of a row iterator without keeping any, so a malformed row throws while only one row is held at a time. */
export const drainRows = (rows: Iterator<unknown>): void => {
  while (rows.next().done !== true) {
    // Decoding the row is the whole purpose, so its value is dropped.
  }
};
