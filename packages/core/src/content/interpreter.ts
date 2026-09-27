import type { DocumentInternals } from '../document/documentInternals.ts';
import type { InheritedCache } from '../document/loadedPage.ts';
import type { PageEntry } from '../document/pageTree.ts';
import type { FontGlyph, FontModel, FontString } from '../font/fontModel.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { ContentOperand, ContentOperation, InlineImage } from './contentOperations.ts';
import type { InspectWarning, InspectWarningCode } from './inspectWarning.ts';
import type { Matrix } from './matrix.ts';

import { createInheritedCache, inherited } from '../document/loadedPage.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { dictionaryOf, latin1, numberOf } from '../font/fontValues.ts';
import { FontCache, fontKey } from '../font/loadFont.ts';
import { pdfName } from '../object/pdfObject.ts';

import { readContent } from './contentOperations.ts';
import { IDENTITY, multiply } from './matrix.ts';
import { checkOperands } from './operands.ts';
import { pageContent } from './pageContent.ts';

const RESOURCES = pdfName('Resources').bytes;
const FONT = pdfName('Font').bytes;
const COLOR_SPACE = pdfName('ColorSpace').bytes;
const PATTERN = pdfName('Pattern').bytes;
const EXT_G_STATE = pdfName('ExtGState').bytes;
const XOBJECT = pdfName('XObject').bytes;
const SHADING = pdfName('Shading').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
const IMAGE_MASK = pdfName('ImageMask').bytes;

/** A content stream being interpreted. */
export interface ContentSource {
  readonly kind: 'page';
}

/** Where a paint or text-show event happened. */
export interface PaintContext {
  /** The content streams being interpreted, outermost first. */
  readonly sources: readonly ContentSource[];
}

/** A pattern that scn or SCN selected in a Pattern colour space. */
export interface PatternUse {
  readonly name: Uint8Array;
  readonly reference: PdfReference | undefined;
  readonly value: PdfObject | undefined;
}

/** A colour space as a content stream selected it, and the colour set in it. */
export interface ColorSpaceUse {
  /** A family name, or the value a ColorSpace resource names, resolved; undefined when the operand named no resource. */
  readonly space: PdfObject | undefined;
  /** The ColorSpace resource name the operand used; undefined for a family name. */
  readonly resourceName: Uint8Array | undefined;
  /** The colour's components as last set; empty until a colour is set after the space is selected. */
  readonly components: readonly number[];
  /** In a Pattern space, the pattern scn or SCN selected. */
  readonly pattern: PatternUse | undefined;
}

/** The graphics state parameters the interpreter keeps (ISO 32000-1:2008, 8.4.1), including the text state (9.3.1), which q and Q save and restore with the rest. */
export interface GraphicsState {
  readonly ctm: Matrix;
  readonly fill: ColorSpaceUse;
  readonly stroke: ColorSpaceUse;
  readonly font: FontModel | undefined;
  /** Tfs. */
  readonly fontSize: number;
  /** Tc. */
  readonly characterSpacing: number;
  /** Tw. */
  readonly wordSpacing: number;
  /** Th: Tz divided by 100 (9.3.4). */
  readonly horizontalScaling: number;
  /** TL. */
  readonly leading: number;
  /** Tr, 0 to 7 (9.3.6, Table 106). */
  readonly renderMode: number;
  /** Trise. */
  readonly rise: number;
}

export type PaintKind = 'fill' | 'stroke' | 'fill-stroke' | 'clip' | 'text' | 'image' | 'image-mask' | 'inline-image' | 'inline-image-mask' | 'shading';

/**
 * A painting operation. `colorSpaces` are the spaces it paints in: the fill space, the stroke space or both for paths and text, an image's own space or the fill space for an image mask, a shading's space.
 * A `clip` event is a path ended by n after W or W*, which paints nothing; its spaces are the fill and stroke spaces current when it was built.
 */
export interface PaintEvent {
  readonly kind: PaintKind;
  readonly colorSpaces: readonly ColorSpaceUse[];
  readonly context: PaintContext;
  /** The event's position among every event of the interpretation. */
  readonly sequence: number;
}

/** A colour space selected as the current fill or stroke space: CS, cs, or one of the operators that also set a device space (8.6.8, Table 74). */
export interface ColorSelectEvent {
  readonly target: 'fill' | 'stroke';
  readonly use: ColorSpaceUse;
  readonly context: PaintContext;
  readonly sequence: number;
}

/** A shown glyph, with the text matrix in force when it is painted. */
export interface ShownGlyph {
  readonly glyph: FontGlyph;
  readonly textMatrix: Matrix;
  /** False after a glyph whose displacement is unknown or a string that could not be split, until a text-positioning operator sets the position again. */
  readonly positionKnown: boolean;
}

/** One string shown by Tj, ', " or one string of a TJ array, with the glyphs it split into and the state they were shown in. */
export interface TextShowEvent {
  readonly font: FontModel;
  readonly string: Uint8Array;
  /** The sum of the TJ numbers between the previous string and this one, in thousandths of text space; undefined when there are none. */
  readonly adjustment: number | undefined;
  readonly glyphs: readonly ShownGlyph[];
  /** Why the string could not be split into glyphs, when it could not. */
  readonly unsplit: Exclude<FontString, { readonly kind: 'glyphs' }> | undefined;
  readonly state: GraphicsState;
  readonly context: PaintContext;
  readonly sequence: number;
}

export interface InterpretHandlers {
  readonly paint?: (event: PaintEvent) => void;
  readonly text?: (event: TextShowEvent) => void;
  readonly select?: (event: ColorSelectEvent) => void;
}

export interface InterpretOptions extends InterpretHandlers {
  /** The document's font cache, shared between pages so that each font is read once; a new one is made when absent. */
  readonly fonts?: FontCache;
  /** Inherited page attributes shared between pages. */
  readonly inheritance?: InheritedCache;
}

export interface InterpretResult {
  /** False when some content could not be read or interpreted: undecodable streams, bad operands, missing resources. */
  readonly complete: boolean;
  readonly warnings: readonly InspectWarning[];
  /** The operations executed. */
  readonly operations: number;
}

const INITIAL_COLOR: ColorSpaceUse = { space: pdfName('DeviceGray'), resourceName: undefined, components: [0], pattern: undefined };

// ISO 32000-1:2008, 8.4.1, Table 52 and 9.3.1, Table 104: the initial values of the parameters kept.
const INITIAL_STATE: GraphicsState = {
  ctm: IDENTITY,
  fill: INITIAL_COLOR,
  stroke: INITIAL_COLOR,
  font: undefined,
  fontSize: 0,
  characterSpacing: 0,
  wordSpacing: 0,
  horizontalScaling: 1,
  leading: 0,
  renderMode: 0,
  rise: 0,
};

// 8.6.5.1 and 8.6.6.1: these family names select a colour space directly; any other name is a ColorSpace resource.
const FAMILIES = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern']);

// 8.9.7, Table 94: the abbreviations of inline image colour spaces, which "always identify the corresponding colour spaces directly".
const INLINE_FAMILIES = new Map([
  ['G', 'DeviceGray'],
  ['RGB', 'DeviceRGB'],
  ['CMYK', 'DeviceCMYK'],
  ['I', 'Indexed'],
  ['DeviceGray', 'DeviceGray'],
  ['DeviceRGB', 'DeviceRGB'],
  ['DeviceCMYK', 'DeviceCMYK'],
  ['Indexed', 'Indexed'],
]);

// 9.3.6, Table 106: render modes 0, 2, 4 and 6 fill glyphs; 1, 2, 5 and 6 stroke them; 3 and 7 paint nothing.
const FILLING_MODES = new Set([0, 2, 4, 6]);
const STROKING_MODES = new Set([1, 2, 5, 6]);

const PATH_PAINTS = new Map<string, 'fill' | 'stroke' | 'fill-stroke'>([
  ['S', 'stroke'],
  ['s', 'stroke'],
  ['f', 'fill'],
  ['F', 'fill'],
  ['f*', 'fill'],
  ['B', 'fill-stroke'],
  ['B*', 'fill-stroke'],
  ['b', 'fill-stroke'],
  ['b*', 'fill-stroke'],
]);

const referenceKey = (reference: PdfReference): string => `${String(reference.objectNumber)}.${String(reference.generation)}`;

const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

const number = (values: readonly PdfDirectObject[], index: number): number => numberOf(values[index]) ?? 0;

const nameBytes = (value: PdfDirectObject | undefined): Uint8Array => (value?.kind === 'name' ? value.bytes : new Uint8Array());

/**
 * The displacement a glyph moves the text position by, in unscaled text space, before the next glyph (ISO 32000-1:2008, 9.4.4):
 * tx = ((w0 − Tj/1000) × Tfs + Tc + Tw) × Th in horizontal writing and ty = (w1 − Tj/1000) × Tfs + Tc + Tw in vertical writing, where 9.3.4 says horizontal scaling applies to Tc and Tw only "If the writing mode is horizontal".
 * TJ numbers are applied apart from the glyph (see `adjustmentDisplacement`). Undefined when the font gives no width or vertical metrics for the glyph.
 */
export const glyphDisplacement = (glyph: FontGlyph, writingMode: 0 | 1, state: GraphicsState): readonly [number, number] | undefined => {
  // 9.3.3: word spacing applies to "the single-byte character code 32", which the font model flags.
  const wordSpacing = glyph.wordSpace ? state.wordSpacing : 0;
  if (writingMode === 1) {
    if (glyph.vertical === undefined) return undefined;
    return [0, glyph.vertical.w1 * state.fontSize + state.characterSpacing + wordSpacing];
  }
  if (glyph.width === undefined) return undefined;
  return [(glyph.width * state.fontSize + state.characterSpacing + wordSpacing) * state.horizontalScaling, 0];
};

/** The displacement of a TJ number: Table 109, "This amount shall be subtracted from the current horizontal or vertical coordinate, depending on the writing mode", in thousandths of text space, scaled by Th only horizontally (9.3.4). */
export const adjustmentDisplacement = (adjustment: number, writingMode: 0 | 1, state: GraphicsState): readonly [number, number] =>
  writingMode === 1 ? [0, (-adjustment / 1000) * state.fontSize] : [(-adjustment / 1000) * state.fontSize * state.horizontalScaling, 0];

/** The resources a content stream uses and how its events are attributed. */
interface Scope {
  readonly resources: PdfDictionaryEntries | undefined;
  /** The key of the nearest indirect object holding the resource dictionary, which names direct fonts (see `fontKey`). */
  readonly owner: string;
  readonly context: PaintContext;
  /** Names a stream of this content in warnings. */
  readonly label: (stream: number) => string;
}

/** The operation being executed: the content it is in, and how warnings name it. */
interface Step {
  readonly scope: Scope;
  readonly where: string;
}

class Interpreter {
  private readonly document: DocumentInternals;
  private readonly handlers: InterpretHandlers;
  private readonly fonts: FontCache;
  private readonly warnings: InspectWarning[] = [];
  private readonly reportedFonts = new Set<string>();
  private readonly stack: GraphicsState[] = [];
  private state: GraphicsState = INITIAL_STATE;
  private textMatrix: Matrix = IDENTITY;
  private lineMatrix: Matrix = IDENTITY;
  private positionKnown = true;
  private pendingClip = false;
  private compatibility = 0;
  private complete = true;
  private operations = 0;
  private sequence = 0;

  constructor(document: DocumentInternals, handlers: InterpretHandlers, fonts: FontCache) {
    this.document = document;
    this.handlers = handlers;
    this.fonts = fonts;
  }

  result(): InterpretResult {
    return { complete: this.complete, warnings: this.warnings, operations: this.operations };
  }

  warn(code: InspectWarningCode, detail: string, incomplete: boolean): void {
    this.warnings.push({ code, detail });
    if (incomplete) this.complete = false;
  }

  private deref(value: PdfDirectObject | undefined): PdfObject | undefined {
    try {
      return this.document.objects.deref(value);
    } catch (error: unknown) {
      if (!(error instanceof ParseError)) throw error;
      this.warn('content-unreadable', `an object cannot be read: ${error.message}`, true);
      return undefined;
    }
  }

  // A named resource of a category (7.8.3); a name the resource dictionary does not define is reported.
  private resource({ scope, where }: Step, category: Uint8Array, name: Uint8Array): PdfDirectObject | undefined {
    const entries = dictionaryOf(this.deref(scope.resources?.get(category)));
    const value = entries?.get(name);
    if (value === undefined || this.deref(value)?.kind === 'null') {
      this.warn('resource-missing', `${where}: the ${latin1(category)} resource ${latin1(name)} is not defined`, true);
      return undefined;
    }
    return value;
  }

  run(streams: readonly Uint8Array[], scope: Scope): void {
    try {
      const operations = readContent(streams, this.document.maxNesting);
      for (let step = operations.next(); step.done !== true; step = operations.next()) {
        this.operations++;
        this.execute(step.value, scope);
      }
    } catch (error: unknown) {
      if (!(error instanceof ParseError)) throw error;
      this.warn('content-unreadable', `the content cannot be read further: ${error.message}`, true);
    }
  }

  private execute(operation: ContentOperation, scope: Scope): void {
    const { operator } = operation;
    const where = `${operator} at offset ${String(operation.offset)} of ${scope.label(operation.stream)}`;
    const checked = checkOperands(operator, operation.operands);
    // 7.8.2: inside BX and EX "unrecognized operators shall be ignored without error"; elsewhere they are ignored with a warning, as readers do.
    if (checked.kind === 'unknown') {
      if (this.compatibility === 0) this.warn('unknown-operator', where, false);
      return;
    }
    if (checked.kind === 'bad') {
      this.warn('bad-operands', where, true);
      return;
    }
    const { values } = checked;
    const step: Step = { scope, where };
    if (this.graphics(operator, values)) return;
    if (this.textState(operator, values, step)) return;
    if (this.textShow(operator, values, step)) return;
    if (this.color(operator, values, step)) return;
    this.painting(operation, values, step);
  }

  private emitPaint(kind: PaintKind, colorSpaces: readonly ColorSpaceUse[], scope: Scope): void {
    this.handlers.paint?.({ kind, colorSpaces, context: scope.context, sequence: this.sequence++ });
  }

  private graphics(operator: string, values: readonly PdfDirectObject[]): boolean {
    if (operator === 'q') this.stack.push(this.state);
    // 8.4.4, Table 57: Q restores "the most recently saved state"; an unbalanced Q has none to restore and is ignored.
    else if (operator === 'Q') this.state = this.stack.pop() ?? this.state;
    else if (operator === 'cm') {
      // 8.3.4: the operand matrix is premultiplied with the CTM.
      const matrix: Matrix = [number(values, 0), number(values, 1), number(values, 2), number(values, 3), number(values, 4), number(values, 5)];
      this.state = { ...this.state, ctm: multiply(matrix, this.state.ctm) };
    } else if (operator === 'BX') this.compatibility++;
    else if (operator === 'EX') this.compatibility = Math.max(0, this.compatibility - 1);
    else return false;
    return true;
  }

  private textState(operator: string, values: readonly PdfDirectObject[], step: Step): boolean {
    const value = number(values, 0);
    if (operator === 'Tc') this.state = { ...this.state, characterSpacing: value };
    else if (operator === 'Tw') this.state = { ...this.state, wordSpacing: value };
    else if (operator === 'Tz') this.state = { ...this.state, horizontalScaling: value / 100 };
    else if (operator === 'TL') this.state = { ...this.state, leading: value };
    else if (operator === 'Tr') this.state = { ...this.state, renderMode: value };
    else if (operator === 'Ts') this.state = { ...this.state, rise: value };
    else if (operator === 'Tf') this.state = { ...this.state, font: this.namedFont(step, nameBytes(values[0])), fontSize: number(values, 1) };
    else if (operator === 'gs') this.graphicsStateParameters(step, nameBytes(values[0]));
    // 9.4.1, Table 107: BT sets the text matrix and the text line matrix to the identity matrix.
    else if (operator === 'BT') this.setLine(IDENTITY);
    else if (operator === 'ET') this.positionKnown = true;
    else if (operator === 'Td') this.nextLine(value, number(values, 1));
    else if (operator === 'TD') {
      // 9.4.2, Table 108: TD has the effect of −ty TL followed by tx ty Td.
      this.state = { ...this.state, leading: -number(values, 1) };
      this.nextLine(value, number(values, 1));
    } else if (operator === 'Tm') this.setLine([value, number(values, 1), number(values, 2), number(values, 3), number(values, 4), number(values, 5)]);
    // Table 108: T* "has the same effect as the code" 0 -Tl Td.
    else if (operator === 'T*') this.nextLine(0, -this.state.leading);
    else return false;
    return true;
  }

  private setLine(matrix: Matrix): void {
    this.lineMatrix = matrix;
    this.textMatrix = matrix;
    this.positionKnown = true;
  }

  // Table 108, Td: "Move to the start of the next line, offset from the start of the current line by" the operands.
  private nextLine(x: number, y: number): void {
    this.setLine(multiply(translation(x, y), this.lineMatrix));
  }

  private namedFont(step: Step, name: Uint8Array): FontModel | undefined {
    const value = this.resource(step, FONT, name);
    return value === undefined ? undefined : this.fonts.font(value, fontKey(value, step.scope.owner, name));
  }

  // 8.4.5, Table 58: a graphics state parameter dictionary's Font entry is "An array of the form [ font size ]".
  private graphicsStateParameters(step: Step, name: Uint8Array): void {
    const { scope, where } = step;
    const value = this.resource(step, EXT_G_STATE, name);
    const parameters = dictionaryOf(this.deref(value));
    if (value !== undefined && parameters === undefined) {
      this.warn('resource-missing', `${where}: the ExtGState resource ${latin1(name)} is not a dictionary`, true);
    }
    const font = this.deref(parameters?.get(FONT));
    if (font?.kind === 'array') {
      const [fontValue, size] = font.items;
      const fontSize = numberOf(this.deref(size));
      if (fontValue === undefined || fontSize === undefined) this.warn('bad-operands', `${where}: the Font entry is not [font size]`, true);
      else this.state = { ...this.state, font: this.fonts.font(fontValue, fontKey(fontValue, `${scope.owner}:ExtGState`, name)), fontSize };
    }
  }

  private textShow(operator: string, values: readonly PdfDirectObject[], step: Step): boolean {
    if (operator === 'Tj') this.show(step, values[0]);
    else if (operator === "'") {
      this.nextLine(0, -this.state.leading);
      this.show(step, values[0]);
    } else if (operator === '"') {
      // Table 109, ": "Move to the next line and show a text string, using aw as the word spacing and ac as the character spacing".
      this.state = { ...this.state, wordSpacing: number(values, 0), characterSpacing: number(values, 1) };
      this.nextLine(0, -this.state.leading);
      this.show(step, values[2]);
    } else if (operator === 'TJ') this.showArray(step, values[0]);
    else return false;
    return true;
  }

  private showArray(step: Step, array: PdfDirectObject | undefined): void {
    let adjustment: number | undefined = undefined;
    for (const item of array?.kind === 'array' ? array.items : []) {
      const value = numberOf(item);
      if (item.kind === 'string') {
        this.show(step, item, adjustment);
        adjustment = undefined;
      } else if (value === undefined) this.warn('bad-operands', `${step.where}: a TJ element is neither a string nor a number`, true);
      else {
        adjustment = (adjustment ?? 0) + value;
        const font = this.state.font?.writingMode ?? 0;
        const [x, y] = adjustmentDisplacement(value, font, this.state);
        this.textMatrix = multiply(translation(x, y), this.textMatrix);
      }
    }
  }

  private reportFont(font: FontModel): void {
    if (this.reportedFonts.has(font.key)) return;
    this.reportedFonts.add(font.key);
    for (const warning of font.warnings) this.warn(warning.code, `font ${font.key}: ${warning.detail}`, false);
  }

  private show({ scope, where }: Step, value: PdfDirectObject | undefined, adjustment?: number): void {
    const string = value?.kind === 'string' ? value.bytes : new Uint8Array();
    const { font } = this.state;
    if (font === undefined) {
      this.warn('resource-missing', `${where}: no font is set`, true);
      this.positionKnown = false;
      return;
    }
    this.reportFont(font);
    const split = font.glyphs(string);
    const glyphs: ShownGlyph[] = [];
    if (split.kind === 'glyphs') {
      for (const glyph of split.glyphs) {
        glyphs.push({ glyph, textMatrix: this.textMatrix, positionKnown: this.positionKnown });
        const displacement = glyphDisplacement(glyph, font.writingMode, this.state);
        if (displacement === undefined) this.positionKnown = false;
        else this.textMatrix = multiply(translation(displacement[0], displacement[1]), this.textMatrix);
      }
    } else this.positionKnown = false;
    const { renderMode } = this.state;
    const spaces = [...(FILLING_MODES.has(renderMode) ? [this.state.fill] : []), ...(STROKING_MODES.has(renderMode) ? [this.state.stroke] : [])];
    if (string.length > 0 && spaces.length > 0) this.emitPaint('text', spaces, scope);
    this.handlers.text?.({
      font,
      string,
      adjustment,
      glyphs,
      unsplit: split.kind === 'glyphs' ? undefined : split,
      state: this.state,
      context: scope.context,
      sequence: this.sequence++,
    });
  }

  // A colour space operand: a family name, or a ColorSpace resource (8.6.3).
  private colorSpace(step: Step, name: Uint8Array): ColorSpaceUse {
    const family = latin1(name);
    if (FAMILIES.has(family)) return { space: pdfName(family), resourceName: undefined, components: [], pattern: undefined };
    const value = this.resource(step, COLOR_SPACE, name);
    return { space: value === undefined ? undefined : this.deref(value), resourceName: name, components: [], pattern: undefined };
  }

  private select(target: 'fill' | 'stroke', use: ColorSpaceUse, { scope }: Step): void {
    this.state = target === 'fill' ? { ...this.state, fill: use } : { ...this.state, stroke: use };
    this.handlers.select?.({ target, use, context: scope.context, sequence: this.sequence++ });
  }

  private device(target: 'fill' | 'stroke', family: string, step: Step & { readonly values: readonly PdfDirectObject[] }): void {
    const { values } = step;
    this.select(
      target,
      { space: pdfName(family), resourceName: undefined, components: values.map((_, index) => number(values, index)), pattern: undefined },
      step,
    );
  }

  // 8.6.8, Table 74: SC and sc take numbers; SCN and scn also take a final pattern name in a Pattern space.
  private setColor(target: 'fill' | 'stroke', values: readonly PdfDirectObject[], step: Step): void {
    const { where } = step;
    const last = values.at(-1);
    const named = last?.kind === 'name';
    const numbers = (named ? values.slice(0, -1) : values).map(value => numberOf(value));
    const components = numbers.filter(value => value !== undefined);
    if (components.length !== numbers.length) {
      this.warn('bad-operands', where, true);
      return;
    }
    const current = target === 'fill' ? this.state.fill : this.state.stroke;
    let { pattern } = current;
    if (named) {
      const value = this.resource(step, PATTERN, last.bytes);
      pattern = { name: last.bytes, reference: value?.kind === 'reference' ? value : undefined, value: value === undefined ? undefined : this.deref(value) };
    }
    const use: ColorSpaceUse = { ...current, components, pattern };
    this.state = target === 'fill' ? { ...this.state, fill: use } : { ...this.state, stroke: use };
  }

  private color(operator: string, values: readonly PdfDirectObject[], step: Step): boolean {
    if (operator === 'CS' || operator === 'cs') this.select(operator === 'cs' ? 'fill' : 'stroke', this.colorSpace(step, nameBytes(values[0])), step);
    else if (operator === 'SC' || operator === 'SCN') this.setColor('stroke', operator === 'SC' ? values.filter(value => value.kind !== 'name') : values, step);
    else if (operator === 'sc' || operator === 'scn') this.setColor('fill', operator === 'sc' ? values.filter(value => value.kind !== 'name') : values, step);
    else if (operator === 'G' || operator === 'g') this.device(operator === 'g' ? 'fill' : 'stroke', 'DeviceGray', { ...step, values });
    else if (operator === 'RG' || operator === 'rg') this.device(operator === 'rg' ? 'fill' : 'stroke', 'DeviceRGB', { ...step, values });
    else if (operator === 'K' || operator === 'k') this.device(operator === 'k' ? 'fill' : 'stroke', 'DeviceCMYK', { ...step, values });
    else return false;
    return true;
  }

  private painting(operation: ContentOperation, values: readonly PdfDirectObject[], step: Step): void {
    const { scope } = step;
    const { operator } = operation;
    const paint = PATH_PAINTS.get(operator);
    if (paint !== undefined) {
      this.pendingClip = false;
      this.emitPaint(paint, paint === 'fill-stroke' ? [this.state.fill, this.state.stroke] : [paint === 'fill' ? this.state.fill : this.state.stroke], scope);
    } else if (operator === 'W' || operator === 'W*') this.pendingClip = true;
    else if (operator === 'n') {
      if (this.pendingClip) this.emitPaint('clip', [this.state.fill, this.state.stroke], scope);
      this.pendingClip = false;
    } else if (operator === 'Do') this.xObject(step, nameBytes(values[0]));
    else if (operator === 'sh') this.shading(step, nameBytes(values[0]));
    else if (operator === 'BI' && operation.inlineImage !== undefined) this.inlineImage(step, operation.inlineImage);
  }

  private imageUse(value: PdfDirectObject | undefined): ColorSpaceUse {
    return { space: value === undefined ? undefined : this.deref(value), resourceName: undefined, components: [], pattern: undefined };
  }

  private xObject(step: Step, name: Uint8Array): void {
    const { scope, where } = step;
    const value = this.resource(step, XOBJECT, name);
    const object = this.deref(value);
    if (object?.kind !== 'stream') {
      if (value !== undefined) this.warn('resource-missing', `${where}: the XObject resource ${latin1(name)} is not a stream`, true);
      return;
    }
    const subtype = this.deref(object.dictionary.get(SUBTYPE));
    if (subtype?.kind !== 'name' || latin1(subtype.bytes) !== 'Image') return;
    // 8.9.5, Table 89, ImageMask: "unmasked areas shall be painted using the current nonstroking colour".
    const mask = this.deref(object.dictionary.get(IMAGE_MASK));
    if (mask?.kind === 'boolean' && mask.value) this.emitPaint('image-mask', [this.state.fill], scope);
    else this.emitPaint('image', [this.imageUse(object.dictionary.get(COLOR_SPACE))], scope);
  }

  // 8.7.4.2: sh paints the shading named in the Shading resources, in the shading dictionary's ColorSpace (8.7.4.3, Table 78).
  private shading(step: Step, name: Uint8Array): void {
    const shading = dictionaryOf(this.deref(this.resource(step, SHADING, name)));
    if (shading !== undefined) this.emitPaint('shading', [this.imageUse(shading.get(COLOR_SPACE))], step.scope);
  }

  private inlineImage(step: Step, image: InlineImage): void {
    const { scope } = step;
    const parameter = (keys: readonly string[]): ContentOperand | undefined => {
      for (let index = 0; index + 1 < image.parameters.length; index += 2) {
        const key = image.parameters[index];
        if (key?.kind === 'name' && keys.includes(latin1(key.bytes))) return image.parameters[index + 1];
      }
      return undefined;
    };
    const mask = parameter(['IM', 'ImageMask']);
    if (mask?.kind === 'boolean' && mask.value) {
      this.emitPaint('inline-image-mask', [this.state.fill], scope);
      return;
    }
    const space = parameter(['CS', 'ColorSpace']);
    if (space?.kind === 'name') {
      const family = INLINE_FAMILIES.get(latin1(space.bytes));
      // 8.9.7: the value "may also be the name of a colour space in the ColorSpace subdictionary of the current resource dictionary".
      const use: ColorSpaceUse =
        family === undefined
          ? { space: this.deref(this.resource(step, COLOR_SPACE, space.bytes)), resourceName: space.bytes, components: [], pattern: undefined }
          : { space: pdfName(family), resourceName: undefined, components: [], pattern: undefined };
      this.emitPaint('inline-image', [use], scope);
    } else this.emitPaint('inline-image', space === undefined || space.kind === 'stray-delimiter' ? [] : [this.imageUse(space)], scope);
  }
}

interface PageResources {
  readonly resources: PdfDictionaryEntries | undefined;
  readonly owner: string;
}

// 7.8.3: the page's resource dictionary "shall be designated by the page dictionary’s Resources or is inherited".
const pageResources = (
  interpreter: Interpreter,
  page: PageEntry,
  { document, cache }: { document: DocumentInternals; cache: InheritedCache },
): PageResources => {
  try {
    const found = inherited(document.objects, page, { key: RESOURCES, cache });
    const owner = found?.value.kind === 'reference' ? referenceKey(found.value) : referenceKey(found?.from ?? page.reference);
    const resources = found === undefined ? undefined : dictionaryOf(document.objects.deref(found.value));
    if (found !== undefined && resources === undefined) interpreter.warn('resource-missing', 'the Resources of the page is not a dictionary', true);
    return { resources, owner };
  } catch (error: unknown) {
    if (!(error instanceof ParseError)) throw error;
    interpreter.warn('content-unreadable', `the Resources of the page cannot be read: ${error.message}`, true);
    return { resources: undefined, owner: referenceKey(page.reference) };
  }
};

/**
 * Interprets a page's content: the graphics state, colour, text state and text positioning, calling the handlers with each paint, text-show and colour-space selection event in content order.
 * Damaged content never throws: it becomes warnings and `complete: false`. A page index that is not a page throws InvalidArgumentError, and a decoded size past the document's limits ResourceLimitError.
 */
export const interpretPage = (document: DocumentInternals, pageIndex: number, options: InterpretOptions = {}): InterpretResult => {
  const page = Number.isInteger(pageIndex) ? document.pages[pageIndex] : undefined;
  if (page === undefined) {
    throw new InvalidArgumentError(`page index ${String(pageIndex)} is not a page of this document, which has ${String(document.pages.length)}`);
  }
  const interpreter = new Interpreter(document, options, options.fonts ?? new FontCache(document, undefined));
  const { resources, owner } = pageResources(interpreter, page, { document, cache: options.inheritance ?? createInheritedCache() });
  const content = pageContent(document, page);
  for (const problem of content.problems) interpreter.warn('content-unreadable', problem, true);
  interpreter.run(content.streams, {
    resources,
    owner,
    context: { sources: [{ kind: 'page' }] },
    label: stream => `content stream ${String(content.indexes[stream] ?? stream)}`,
  });
  return interpreter.result();
};
