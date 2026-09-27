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

export interface InspectWarning {
  readonly code: InspectWarningCode;
  readonly detail: string;
}
