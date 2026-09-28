import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';

interface Procedure {
  readonly kind: 'procedure';
  readonly tokens: readonly Token[];
}
type Value = number | boolean | Procedure;
type Token = Value | string;

const error = (message: string): ParseError => new ParseError(`calculator function: ${message}`, 0);

const literal = (word: string): Token => {
  if (word === 'true' || word === 'false') return word === 'true';
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/u.test(word)) return Number(word);
  return word;
};

const lex = (data: Uint8Array): Token[] => {
  // ISO 32000-1:2008, 7.10.5.1: calculator code is enclosed in braces; conditional expressions use nested braces.
  const source = new TextDecoder('latin1').decode(data).replaceAll(/%[^\r\n]*/gu, ' ');
  const words = source.match(/\{|\}|[^\s{}]+/gu) ?? [];
  if (words.length > 10_000) throw new ResourceLimitError('calculator function has too many tokens');
  const frames: Token[][] = [[]];
  for (const word of words) {
    if (word === '{') {
      if (frames.length > 16) throw new ResourceLimitError('calculator function nesting exceeds 16');
      frames.push([]);
    } else if (word === '}') {
      const closed = frames.pop();
      if (closed === undefined || frames.length === 0) throw error('unmatched brace');
      frames.at(-1)?.push({ kind: 'procedure', tokens: closed });
    } else frames.at(-1)?.push(literal(word));
  }
  if (frames.length !== 1) throw error('unclosed brace');
  const [outer] = frames;
  if (outer?.length !== 1) throw error('expected one outer procedure');
  const [first] = outer;
  if (typeof first !== 'object') throw error('expected outer braces');
  return [...first.tokens];
};

const pop = (stack: Value[]): Value => {
  const value = stack.pop();
  if (value === undefined) throw error('stack underflow');
  return value;
};

const number = (stack: Value[]): number => {
  const value = pop(stack);
  if (typeof value !== 'number') throw error('expected number');
  return value;
};

const boolean = (stack: Value[]): boolean => {
  const value = pop(stack);
  if (typeof value !== 'boolean') throw error('expected boolean');
  return value;
};

const procedure = (stack: Value[]): Procedure => {
  const value = pop(stack);
  if (typeof value !== 'object') throw error('expected procedure');
  return value;
};

const int = (value: number): number => {
  if (!Number.isFinite(value)) throw error('non-finite integer');
  return Math.trunc(value);
};

const unary = (operator: string, value: number): number | undefined => {
  switch (operator) {
    case 'abs': {
      return Math.abs(value);
    }
    case 'ceiling': {
      return Math.ceil(value);
    }
    case 'cvi':
    case 'truncate': {
      return Math.trunc(value);
    }
    case 'cvr': {
      return value;
    }
    case 'floor': {
      return Math.floor(value);
    }
    case 'neg': {
      return -value;
    }
    case 'round': {
      return value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
    }
    case 'sqrt': {
      return Math.sqrt(value);
    }
    case 'sin': {
      return Math.sin((value * Math.PI) / 180);
    }
    case 'cos': {
      return Math.cos((value * Math.PI) / 180);
    }
    case 'ln': {
      return Math.log(value);
    }
    case 'log': {
      return Math.log10(value);
    }
    default: {
      return undefined;
    }
  }
};

const binary = (operator: string, left: number, right: number): number | boolean | undefined => {
  switch (operator) {
    case 'add': {
      return left + right;
    }
    case 'sub': {
      return left - right;
    }
    case 'mul': {
      return left * right;
    }
    case 'div': {
      return left / right;
    }
    case 'idiv': {
      return int(left / right);
    }
    case 'mod': {
      return int(left) % int(right);
    }
    case 'exp': {
      return left ** right;
    }
    case 'atan': {
      return ((Math.atan2(left, right) * 180) / Math.PI + 360) % 360;
    }
    case 'eq': {
      return left === right;
    }
    case 'ne': {
      return left !== right;
    }
    case 'lt': {
      return left < right;
    }
    case 'le': {
      return left <= right;
    }
    case 'gt': {
      return left > right;
    }
    case 'ge': {
      return left >= right;
    }
    default: {
      return undefined;
    }
  }
};

const logic = (operator: string, left: Value, right: Value): Value => {
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    if (operator === 'and') return left && right;
    if (operator === 'or') return left || right;
    return left !== right;
  }
  if (typeof left !== 'number' || typeof right !== 'number') throw error('invalid boolean operands');
  let a = ((int(left) % 4294967296) + 4294967296) % 4294967296;
  let b = ((int(right) % 4294967296) + 4294967296) % 4294967296;
  let result = 0;
  let place = 1;
  for (let index = 0; index < 32; index++) {
    const first = a % 2 === 1;
    const second = b % 2 === 1;
    let set = first !== second;
    if (operator === 'and') set = first && second;
    else if (operator === 'or') set = first || second;
    if (set) result += place;
    a = Math.floor(a / 2);
    b = Math.floor(b / 2);
    place *= 2;
  }
  return result >= 2147483648 ? result - 4294967296 : result;
};

const stackOperation = (operator: string, stack: Value[]): boolean => {
  if (operator === 'pop') {
    pop(stack);
    return true;
  }
  if (operator === 'dup') {
    const value = pop(stack);
    stack.push(value, value);
    return true;
  }
  if (operator === 'exch') {
    const right = pop(stack);
    const left = pop(stack);
    stack.push(right, left);
    return true;
  }
  if (operator === 'copy') {
    const count = int(number(stack));
    if (count < 0 || count > stack.length) throw error('invalid copy count');
    if (count > 0) stack.push(...stack.slice(-count));
    return true;
  }
  if (operator === 'index') {
    const index = int(number(stack));
    if (index < 0 || index >= stack.length) throw error('invalid index');
    stack.push(stack[stack.length - index - 1] ?? 0);
    return true;
  }
  if (operator === 'roll') {
    const shift = int(number(stack));
    const count = int(number(stack));
    if (count < 0 || count > stack.length) throw error('invalid roll count');
    if (count > 0) {
      const items = stack.splice(-count);
      const offset = ((shift % count) + count) % count;
      stack.push(...items.slice(count - offset), ...items.slice(0, count - offset));
    }
    return true;
  }
  return false;
};

const controlOperation = (operator: string, stack: Value[], run: (tokens: readonly Token[]) => void): boolean => {
  if (operator !== 'if' && operator !== 'ifelse') return false;
  const falseBranch = operator === 'ifelse' ? procedure(stack) : undefined;
  const trueBranch = procedure(stack);
  const condition = boolean(stack);
  if (condition) run(trueBranch.tokens);
  else if (falseBranch !== undefined) run(falseBranch.tokens);
  return true;
};

const logicalOperation = (operator: string, stack: Value[]): boolean => {
  if (operator === 'not') {
    const value = pop(stack);
    if (typeof value === 'boolean') stack.push(!value);
    else if (typeof value === 'number') stack.push(-int(value) - 1);
    else throw error('invalid not operand');
    return true;
  }
  if (operator === 'and' || operator === 'or' || operator === 'xor') {
    const right = pop(stack);
    stack.push(logic(operator, pop(stack), right));
    return true;
  }
  if (operator === 'bitshift') {
    const shift = int(number(stack));
    const value = int(number(stack));
    stack.push(shift >= 0 ? (value * 2 ** Math.min(shift, 32)) % 4294967296 : Math.floor(value / 2 ** Math.min(-shift, 32)));
    return true;
  }
  return false;
};

const arithmeticOperation = (operator: string, stack: Value[]): boolean => {
  if (['abs', 'ceiling', 'cvi', 'cvr', 'floor', 'neg', 'round', 'sqrt', 'sin', 'cos', 'ln', 'log', 'truncate'].includes(operator)) {
    const result = unary(operator, number(stack));
    if (result === undefined || !Number.isFinite(result)) throw error('invalid arithmetic result');
    stack.push(result);
    return true;
  }
  if (['add', 'sub', 'mul', 'div', 'idiv', 'mod', 'exp', 'atan', 'eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(operator)) {
    const right = number(stack);
    const result = binary(operator, number(stack), right);
    if (result === undefined || (typeof result === 'number' && !Number.isFinite(result))) throw error('invalid arithmetic result');
    stack.push(result);
    return true;
  }
  return false;
};

const execute = (tokens: readonly Token[], stack: Value[]): void => {
  let steps = 0;
  let depth = 0;
  const run = (body: readonly Token[]): void => {
    if (++depth > 16) throw new ResourceLimitError('calculator execution nesting exceeds 16');
    for (const token of body) {
      if (++steps > 10_000) throw new ResourceLimitError('calculator execution exceeds 10000 steps');
      if (typeof token !== 'string') stack.push(token);
      else if (!controlOperation(token, stack, run) && !stackOperation(token, stack) && !logicalOperation(token, stack) && !arithmeticOperation(token, stack)) {
        throw error(`unknown operator ${token}`);
      }
      if (stack.length > 100) throw new ResourceLimitError('calculator stack exceeds 100 values');
    }
    depth--;
  };
  run(tokens);
};

export const createCalculatorFunction = (data: Uint8Array, inputs: number, outputs: number): ((values: readonly number[]) => number[]) => {
  const tokens = lex(data);
  return values => {
    if (values.length !== inputs) throw error('input dimension mismatch');
    const stack: Value[] = [...values];
    execute(tokens, stack);
    if (stack.length !== outputs || stack.some(value => typeof value !== 'number')) throw error('output dimension mismatch');
    return stack.map(value => {
      if (typeof value !== 'number') throw error('non-number output');
      return value;
    });
  };
};
