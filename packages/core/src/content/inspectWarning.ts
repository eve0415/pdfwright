import type { FontWarningCode } from '../font/fontModel.ts';

/**
 * Why part of a page could not be inspected. The font codes are those font loading reports; the others come from reading and interpreting content.
 * A warning never stops an inspection: the result says what could be read and whether it is complete.
 */
export type InspectWarningCode =
  | FontWarningCode
  | 'content-unreadable'
  | 'content-cycle'
  | 'unknown-operator'
  | 'bad-operands'
  | 'resource-missing'
  | 'devicen-all'
  | 'colorspace-unreadable'
  | 'marked-content-unbalanced';

/** A typed nonfatal reason why content, font, or a resource could not be inspected; the page result remains available with `complete` false under ISO 32000-1:2008, 7.8 and 9.10. */
export interface InspectWarning {
  readonly code: InspectWarningCode;
  readonly detail: string;
}
