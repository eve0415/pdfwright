import { ParseError } from '../error/parseError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

/** Whether an error means that an object or stream cannot be read: it does not parse, or it needs a filter or feature the library does not decode. Inspection reports these and goes on. */
export const unreadable = (error: unknown): error is ParseError | UnsupportedFeatureError =>
  error instanceof ParseError || error instanceof UnsupportedFeatureError;
