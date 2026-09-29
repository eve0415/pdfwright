import { FULL_WIDTH_OR_WIDE } from './eastAsianWidth.ts';

const RANGES: readonly (readonly [number, number])[] = FULL_WIDTH_OR_WIDE.split('\n').map(line => {
  const [first = '', last = ''] = line.split(';');
  return [Number.parseInt(first, 16), Number.parseInt(last, 16)] as const;
});

/** Whether a code point's Unicode East_Asian_Width is F (fullwidth) or W (wide) (UAX #11), which CJK fonts draw one em wide. */
export const isFullWidthOrWide = (codePoint: number): boolean => RANGES.some(([first, last]) => codePoint >= first && codePoint <= last);
