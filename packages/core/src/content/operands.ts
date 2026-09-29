import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { ContentOperand } from './contentOperations.ts';

import { numberOf } from '../font/fontValues.ts';

/** What one operand of an operator must be. */
type OperandKind = 'number' | 'name' | 'string' | 'array' | 'properties';

const N = 'number';

// ISO 32000-1:2008, Annex A, Table A.1 gives every operator and its operands; the operators with a variable operand count (SC, SCN, sc, scn) are checked where they are executed.
const SIGNATURES: ReadonlyMap<string, readonly OperandKind[]> = new Map<string, readonly OperandKind[]>([
  ['b', []],
  ['B', []],
  ['b*', []],
  ['B*', []],
  ['BDC', ['name', 'properties']],
  ['BMC', ['name']],
  ['BT', []],
  ['BX', []],
  ['c', [N, N, N, N, N, N]],
  ['cm', [N, N, N, N, N, N]],
  ['CS', ['name']],
  ['cs', ['name']],
  ['d', ['array', N]],
  ['d0', [N, N]],
  ['d1', [N, N, N, N, N, N]],
  ['Do', ['name']],
  ['DP', ['name', 'properties']],
  ['EMC', []],
  ['ET', []],
  ['EX', []],
  ['f', []],
  ['F', []],
  ['f*', []],
  ['G', [N]],
  ['g', [N]],
  ['gs', ['name']],
  ['h', []],
  ['i', [N]],
  ['j', [N]],
  ['J', [N]],
  ['K', [N, N, N, N]],
  ['k', [N, N, N, N]],
  ['l', [N, N]],
  ['m', [N, N]],
  ['M', [N]],
  ['MP', ['name']],
  ['n', []],
  ['q', []],
  ['Q', []],
  ['re', [N, N, N, N]],
  ['RG', [N, N, N]],
  ['rg', [N, N, N]],
  ['ri', ['name']],
  ['s', []],
  ['S', []],
  ['sh', ['name']],
  ['T*', []],
  ['Tc', [N]],
  ['Td', [N, N]],
  ['TD', [N, N]],
  ['Tf', ['name', N]],
  ['Tj', ['string']],
  ['TJ', ['array']],
  ['TL', [N]],
  ['Tm', [N, N, N, N, N, N]],
  ['Tr', [N]],
  ['Ts', [N]],
  ['Tw', [N]],
  ['Tz', [N]],
  ['v', [N, N, N, N]],
  ['w', [N]],
  ['W', []],
  ['W*', []],
  ['y', [N, N, N, N]],
  ["'", ['string']],
  ['"', [N, N, 'string']],
]);

const VARIABLE = new Set(['SC', 'SCN', 'sc', 'scn', 'BI']);

const matches = (operand: ContentOperand, kind: OperandKind): boolean => {
  if (operand.kind === 'stray-delimiter') return false;
  if (kind === 'number') return numberOf(operand) !== undefined;
  if (kind === 'properties') return operand.kind === 'name' || operand.kind === 'dictionary';
  return operand.kind === kind;
};

export type Operands = { readonly kind: 'known'; readonly values: readonly PdfDirectObject[] } | { readonly kind: 'unknown' } | { readonly kind: 'bad' };

/**
 * Checks an operation's operands against the operator's signature: the last operands before the operator are the ones it takes, as the Type 3 procedure reader also reads them, and too few or a value of the wrong type is bad.
 * Operators with a variable number of operands come back with all of them.
 */
export const checkOperands = (operator: string, operands: readonly ContentOperand[]): Operands => {
  if (VARIABLE.has(operator)) {
    const values = operands.filter(operand => operand.kind !== 'stray-delimiter');
    return values.length === operands.length ? { kind: 'known', values } : { kind: 'bad' };
  }
  const signature = SIGNATURES.get(operator);
  if (signature === undefined) return { kind: 'unknown' };
  if (operands.length < signature.length) return { kind: 'bad' };
  const taken = operands.slice(operands.length - signature.length);
  const values: PdfDirectObject[] = [];
  for (const [index, operand] of taken.entries()) {
    const kind = signature[index];
    if (kind === undefined || operand.kind === 'stray-delimiter' || !matches(operand, kind)) return { kind: 'bad' };
    values.push(operand);
  }
  return { kind: 'known', values };
};
