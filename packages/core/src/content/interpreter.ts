import type { DocumentInternals } from '../document/documentInternals.ts';
import type { InheritedCache } from '../document/loadedPage.ts';
import type { PageEntry } from '../document/pageTree.ts';
import type { FontGlyph, FontModel, FontString } from '../font/fontModel.ts';
import type { PdfStream } from '../font/fontValues.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { FillRule } from './clip.ts';
import type { ContentOperand, ContentOperation, InlineImage } from './contentOperations.ts';
import type { InspectWarning, InspectWarningCode } from './inspectWarning.ts';
import type { Matrix } from './matrix.ts';

import { createInheritedCache, inherited } from '../document/loadedPage.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { decodedData, dictionaryOf, latin1, numberOf, numbersOf } from '../font/fontValues.ts';
import { FontCache, fontKey, fontResourceOwner, graphicsStateFontOwner, pageResourcesOwner } from '../font/loadFont.ts';
import { pdfName } from '../object/pdfObject.ts';
import { annotationFlags } from '../resourceGraph/annotationFlags.ts';

import { Clip, rectanglePath } from './clip.ts';
import { readContent } from './contentOperations.ts';
import { IDENTITY, multiply, transformPoint } from './matrix.ts';
import { checkOperands } from './operands.ts';
import { pageContent } from './pageContent.ts';
import { PathBuilder } from './path.ts';
import { unreadable } from './unreadable.ts';

const RESOURCES = pdfName('Resources').bytes;
const FONT = pdfName('Font').bytes;
const COLOR_SPACE = pdfName('ColorSpace').bytes;
const PATTERN = pdfName('Pattern').bytes;
const EXT_G_STATE = pdfName('ExtGState').bytes;
const XOBJECT = pdfName('XObject').bytes;
const SHADING = pdfName('Shading').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
const IMAGE_MASK = pdfName('ImageMask').bytes;
const PROPERTIES = pdfName('Properties').bytes;
const FILL_ALPHA = pdfName('ca').bytes;
const STROKE_ALPHA = pdfName('CA').bytes;
const BLEND_MODE = pdfName('BM').bytes;
const SOFT_MASK = pdfName('SMask').bytes;
const MASK_SUBTYPE = pdfName('S').bytes;
const MASK_GROUP = pdfName('G').bytes;
const MATRIX = pdfName('Matrix').bytes;
const BBOX = pdfName('BBox').bytes;
const PATTERN_TYPE = pdfName('PatternType').bytes;
const GROUP = pdfName('Group').bytes;
const TRANSPARENCY = pdfName('Transparency').bytes;
const PAINT_TYPE = pdfName('PaintType').bytes;
const ANNOTS = pdfName('Annots').bytes;
const APPEARANCE = pdfName('AP').bytes;
const NORMAL_APPEARANCE = pdfName('N').bytes;
const APPEARANCE_STATE = pdfName('AS').bytes;
const FLAGS = pdfName('F').bytes;
const RECT = pdfName('Rect').bytes;

/** The default for `InterpretOptions.maxOperations`. */
export const MAX_OPERATIONS = 10_000_000;

/** The default for `InterpretOptions.maxContentBytes`: 256 MiB. */
export const MAX_CONTENT_BYTES = 268_435_456;

/**
 * A content stream being interpreted: the page's content, a form XObject, a tiling pattern's cell, a Type 3 glyph procedure, an annotation's appearance stream, or the transparency group of a soft mask.
 * Streams are identified by reference, which a well-formed file always has because ISO 32000-1:2008, 7.3.8.1 says "All streams shall be indirect objects".
 */
export type ContentSource =
  | { readonly kind: 'page' }
  | { readonly kind: 'form'; readonly reference: PdfReference | undefined }
  | { readonly kind: 'tiling-pattern'; readonly reference: PdfReference | undefined; readonly coloured: boolean }
  | { readonly kind: 'type3-glyph'; readonly font: string; readonly glyphName: string; readonly described: 'd0' | 'd1' | undefined }
  | { readonly kind: 'annotation'; readonly index: number; readonly printable: boolean }
  | { readonly kind: 'soft-mask'; readonly group: PdfReference | undefined };

/** Whether colour operators take effect: 8.6.8 restricts them "In any glyph description that uses the d1 operator" and "In the content stream of an uncoloured tiling pattern", where they are ignored. */
export type ColourUse = 'used' | 'd1-glyph' | 'uncoloured-pattern';

/** Where a paint or text-show event happened. */
export interface PaintContext {
  /** The content streams being interpreted, outermost first: the page or an annotation appearance, then any forms, patterns, glyph procedures and soft-mask groups inside it. */
  readonly sources: readonly ContentSource[];
  readonly colour: ColourUse;
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

/** A soft mask set by a graphics state parameter dictionary's SMask entry (ISO 32000-1:2008, 11.6.5.2, Table 144). */
export interface SoftMask {
  readonly dictionary: PdfDictionaryEntries;
  /** S: `Alpha` or `Luminosity`. */
  readonly subtype: string | undefined;
  /** G: the transparency group XObject whose rendering defines the mask. */
  readonly group: PdfReference | undefined;
  /** 11.6.5.2: the group's Matrix concatenated with "the current transformation matrix at the moment the soft mask is established in the graphics state with the gs operator" defines the mask's coordinate system. */
  readonly ctm: Matrix;
}

/** The graphics state parameters the interpreter keeps (ISO 32000-1:2008, 8.4.1), including the text state (9.3.1), which q and Q save and restore with the rest. */
export interface GraphicsState {
  readonly ctm: Matrix;
  /** The current clipping path in page space (8.5.4). Text render modes that add glyphs to the clip (4 to 7) do not change it, since glyph outlines are not read. */
  readonly clip: Clip;
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
  /** ca, the nonstroking alpha constant (8.4.5, Table 58). */
  readonly fillAlpha: number;
  /** CA, the stroking alpha constant. */
  readonly strokeAlpha: number;
  /** The current blend mode, a name from 11.3.5, Tables 136 and 137; Compatible reads as Normal. */
  readonly blendMode: string;
  readonly softMask: SoftMask | undefined;
  /** How the transparency groups enclosing the content are composited: the product of their alpha constants, the first blend mode other than Normal, and whether any of them is soft-masked. Content is seen at `fillAlpha` × `group.alpha`. */
  readonly group: GroupCompositing;
}

/** The compositing of enclosing transparency group XObjects (ISO 32000-1:2008, 11.6.6), which Table 52 says reset the blend mode, soft mask and alpha constants inside them. */
export interface GroupCompositing {
  readonly alpha: number;
  readonly blendMode: string;
  readonly softMasked: boolean;
}

/** A marked-content sequence open where an event happened (ISO 32000-1:2008, 14.6). */
export interface MarkedContent {
  /** Tells sequences apart: unique within one interpretation. */
  readonly id: number;
  readonly tag: Uint8Array;
  /** The property list of BDC, inline or from the Properties resources (14.6.2); undefined for BMC or a name the resources do not define. */
  readonly properties: PdfDictionaryEntries | undefined;
}

export type PaintKind = 'fill' | 'stroke' | 'fill-stroke' | 'clip' | 'text' | 'image' | 'image-mask' | 'inline-image' | 'inline-image-mask' | 'shading';

/**
 * A painting operation. `colorSpaces` are the spaces it paints in: the fill space, the stroke space or both for paths and text, an image's own space or the fill space for an image mask, a shading's space.
 * A Pattern space is followed by the space the pattern paints in when it has one: a shading pattern's shading space, or an uncoloured tiling pattern's base space with the components set by scn; a coloured tiling pattern's cell reports its own events.
 * A `clip` event is a path ended by n after W or W*, which paints nothing; its spaces are the fill and stroke spaces current when it was built.
 */
export interface PaintEvent {
  readonly kind: PaintKind;
  readonly colorSpaces: readonly ColorSpaceUse[];
  /** The graphics state the paint happened in. */
  readonly state: GraphicsState;
  readonly context: PaintContext;
  /** The open marked-content sequences, outermost first. */
  readonly markedContent: readonly MarkedContent[];
  /** The event's position among every event of the interpretation. */
  readonly sequence: number;
}

/** A colour space selected as the current fill or stroke space: CS, cs, or one of the operators that also set a device space (8.6.8, Table 74). Where the context's `colour` is not `used` the selection is ignored and the state keeps its colour, and a pattern that SCN or scn chooses there is reported as a selection of its own. */
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

/** One string shown by Tj, ', " or one string of a TJ array, with the glyphs it split into and the state they were shown in. Text shown inside a Type 3 glyph procedure is painting of the glyph, reported by paint events only. */
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
  /** The open marked-content sequences, outermost first. */
  readonly markedContent: readonly MarkedContent[];
  readonly sequence: number;
}

/**
 * An opaque fill of a rectangle with sides parallel to the page axes, lying wholly inside the clip: alpha 1, blend mode Normal, no soft mask, a colour space that is not a Pattern or a None separation.
 * Whatever the page showed there before is hidden. Fills of other shapes, images and shadings that hide content are not reported.
 */
export interface CoverEvent {
  /** [left bottom right top] in page space. */
  readonly rectangle: readonly [number, number, number, number];
  readonly context: PaintContext;
  readonly sequence: number;
}

export interface InterpretHandlers {
  readonly paint?: (event: PaintEvent) => void;
  readonly cover?: (event: CoverEvent) => void;
  readonly text?: (event: TextShowEvent) => void;
  readonly select?: (event: ColorSelectEvent) => void;
}

export interface InterpretOptions extends InterpretHandlers {
  /** The document's font cache, shared between pages so that each font is read once; a new one is made when absent. */
  readonly fonts?: FontCache;
  /** Inherited page attributes shared between pages. */
  readonly inheritance?: InheritedCache;
  /** Which annotations' normal appearances are drawn after the page content: those that print (Table 165), none (the default), or all. */
  readonly annotations?: 'printable' | 'none' | 'all';
  /** The operations a page may execute, counting a form's operations each time it is drawn; past it ResourceLimitError is thrown. */
  readonly maxOperations?: number;
  /**
   * The decoded content bytes a page may lex: its content streams once, and each form, tiling pattern cell, Type 3 glyph procedure, soft-mask group and annotation appearance each time it is executed; past it ResourceLimitError is thrown.
   * The operation count does not see bytes that produce no operations, such as comments, so a large form drawn many times would otherwise cost unbounded time.
   */
  readonly maxContentBytes?: number;
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
  clip: Clip.NONE,
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
  fillAlpha: 1,
  strokeAlpha: 1,
  blendMode: 'Normal',
  softMask: undefined,
  group: { alpha: 1, blendMode: 'Normal', softMasked: false },
};

// 11.3.5, Tables 136 and 137: the standard blend modes.
const BLEND_MODES = new Set([
  'Normal',
  'Compatible',
  'Multiply',
  'Screen',
  'Overlay',
  'Darken',
  'Lighten',
  'ColorDodge',
  'ColorBurn',
  'HardLight',
  'SoftLight',
  'Difference',
  'Exclusion',
  'Hue',
  'Saturation',
  'Color',
  'Luminosity',
]);

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

const CONSTRUCTION = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);

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

// Table 52: blend mode, soft mask and alpha constants reset "at the beginning of execution of a transparency group XObject"; the group is composited with the blend mode and soft mask in force where it is drawn, and 11.6.4.4 says "The nonstroking alpha constant shall also be applied when painting a transparency group’s results onto its backdrop".
const enterGroup = (state: GraphicsState): GraphicsState => ({
  ...state,
  group: {
    alpha: state.group.alpha * state.fillAlpha,
    blendMode: state.group.blendMode === 'Normal' ? state.blendMode : state.group.blendMode,
    softMasked: state.group.softMasked || state.softMask !== undefined,
  },
  fillAlpha: 1,
  strokeAlpha: 1,
  blendMode: 'Normal',
  softMask: undefined,
});

const isNone = (value: PdfObject | undefined): boolean => value?.kind === 'name' && latin1(value.bytes) === 'None';

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

const isPatternSpace = ({ space }: ColorSpaceUse): boolean => {
  const family = space?.kind === 'array' ? space.items[0] : space;
  return family?.kind === 'name' && latin1(family.bytes) === 'Pattern';
};

/** The resources a content stream uses and how its events are attributed. */
interface Scope {
  readonly resources: PdfDictionaryEntries | undefined;
  /** The key of the nearest indirect object holding the resource dictionary, which names direct fonts (see `fontKey`). */
  readonly owner: string;
  readonly context: PaintContext;
  /** Names a stream of this content in warnings. */
  readonly label: (stream: number) => string;
  /** The graphics state the stream began in, which a tiling pattern it paints with starts from (8.7.3.1). */
  readonly initial: GraphicsState;
  /** Whether text shown here is text of the page: not inside a Type 3 glyph procedure. */
  readonly pageText: boolean;
}

/** The fill and stroke spaces selected where colour operators are ignored. */
interface IgnoredSelections {
  readonly fill?: ColorSpaceUse;
  readonly stroke?: ColorSpaceUse;
}

/** A content stream to interpret inside the current one. */
interface Nested {
  readonly value: PdfDirectObject | undefined;
  readonly data: Uint8Array;
  readonly scope: Scope;
  /** An annotation appearance starts with no marked-content sequence open; other streams continue those of the stream that draws them. */
  readonly markedContent: 'inherit' | 'fresh';
}

/** How a form-like stream is drawn: under which source, in which starting state, with which enclosing sources. */
interface FormDrawing {
  readonly source: ContentSource;
  readonly base: GraphicsState;
  readonly parent: readonly ContentSource[];
  readonly colour: ColourUse;
  readonly markedContent: 'inherit' | 'fresh';
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
  private readonly maxOperations: number;
  private readonly maxContentBytes: number;
  private contentBytes = 0;
  // The streams being interpreted, by reference, so that a stream that draws itself is not entered again.
  private readonly active = new Set<string>();
  private depth = 0;
  private page: Pick<Scope, 'resources' | 'owner'> = { resources: undefined, owner: '' };
  private stack: GraphicsState[] = [];
  private state: GraphicsState = INITIAL_STATE;
  private textMatrix: Matrix = IDENTITY;
  private lineMatrix: Matrix = IDENTITY;
  private positionKnown = true;
  private path: PathBuilder | undefined = undefined;
  private pendingClip: FillRule | undefined = undefined;
  private compatibility = 0;
  // Kept apart from the graphics state: 14.6 requires marked-content pairs to nest properly with BT and ET, not with q and Q.
  private markedContent: readonly MarkedContent[] = [];
  private markedContentIds = 0;
  // The marked-content sequences of the streams drawing the current one, which its EMC cannot close.
  private markedFloor = 0;
  // Selections made where colour operators are ignored, in the stream being interpreted.
  private ignored: IgnoredSelections = {};
  private complete = true;
  private operations = 0;
  private sequence = 0;

  constructor(document: DocumentInternals, options: InterpretOptions, fonts: FontCache) {
    this.document = document;
    this.handlers = options;
    this.fonts = fonts;
    this.maxOperations = options.maxOperations ?? MAX_OPERATIONS;
    this.maxContentBytes = options.maxContentBytes ?? MAX_CONTENT_BYTES;
  }

  setPage(page: Pick<Scope, 'resources' | 'owner'>): void {
    this.page = page;
  }

  finish(): void {
    if (this.markedContent.length > 0) {
      this.warn('marked-content-unbalanced', `${String(this.markedContent.length)} marked-content sequences are not closed by EMC`, false);
    }
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
      if (!unreadable(error)) throw error;
      this.warn('content-unreadable', `an object cannot be read: ${error.message}`, true);
      return undefined;
    }
  }

  // A named resource of a category (7.8.3); a name the resource dictionary does not define is reported.
  private resource({ scope, where }: Step, category: Uint8Array, name: Uint8Array): PdfDirectObject | undefined {
    const entries = dictionaryOf(this.deref(scope.resources?.get(category)));
    const value = entries?.get(name);
    const resolved = this.deref(value);
    // A value that cannot be parsed has been reported by deref; one that is absent or null is not defined.
    if (value !== undefined && resolved === undefined) return undefined;
    if (resolved === undefined || resolved.kind === 'null') {
      this.warn('resource-missing', `${where}: the ${latin1(category)} resource ${latin1(name)} is not defined`, true);
      return undefined;
    }
    return value;
  }

  // Font loading reads objects as it needs them, and a font object that cannot be parsed makes the font unusable rather than the content unreadable.
  private font<T>(font: string, read: () => T): T | undefined {
    try {
      return read();
    } catch (error: unknown) {
      if (!unreadable(error)) throw error;
      this.warn('font-unreadable', `font ${font}: ${error.message}`, true);
      return undefined;
    }
  }

  run(streams: readonly Uint8Array[], scope: Scope): void {
    // Bytes that produce no operations, such as comments, are invisible to maxOperations, so the bytes lexed are bounded apart.
    this.contentBytes += streams.reduce((sum, stream) => sum + stream.length, 0);
    if (this.contentBytes > this.maxContentBytes) {
      throw new ResourceLimitError(`the page interprets more than maxContentBytes (${String(this.maxContentBytes)} bytes) of content`);
    }
    try {
      const operations = readContent(streams, this.document.maxNesting);
      for (let step = operations.next(); step.done !== true; step = operations.next()) {
        if (++this.operations > this.maxOperations) {
          throw new ResourceLimitError(`the page executes more than maxOperations (${String(this.maxOperations)}) content operations`);
        }
        this.execute(step.value, scope);
      }
    } catch (error: unknown) {
      if (!unreadable(error)) throw error;
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
    if (this.marked(operator, values, step)) return;
    if (this.construction(operator, values)) return;
    this.painting(operation, values, step);
  }

  private emitPaint(kind: PaintKind, colorSpaces: readonly ColorSpaceUse[], scope: Scope): void {
    this.handlers.paint?.({ kind, colorSpaces, state: this.state, context: scope.context, markedContent: this.markedContent, sequence: this.sequence++ });
  }

  // A paint in colours that may be patterns: the event lists the spaces patterns paint in, and each tiling pattern's cell is drawn after it.
  private paintWith(kind: PaintKind, uses: readonly ColorSpaceUse[], step: Step): void {
    const spaces: ColorSpaceUse[] = [...uses];
    const cells: (() => void)[] = [];
    for (const use of uses) if (isPatternSpace(use)) this.pattern(step, { use, spaces, cells });
    this.emitPaint(kind, spaces, step.scope);
    for (const cell of cells) cell();
  }

  private pattern(step: Step, { use, spaces, cells }: { use: ColorSpaceUse; spaces: ColorSpaceUse[]; cells: (() => void)[] }): void {
    const value = use.pattern?.value;
    const dictionary = dictionaryOf(value);
    const type = numberOf(this.deref(dictionary?.get(PATTERN_TYPE)));
    // 8.7.4.1: a shading pattern (type 2) paints its shading, in the shading's ColorSpace.
    if (type === 2) {
      const shading = dictionaryOf(this.deref(dictionary?.get(SHADING)));
      if (shading !== undefined) spaces.push(this.imageUse(shading.get(COLOR_SPACE)));
      return;
    }
    if (type !== 1 || value?.kind !== 'stream') return;
    // 8.7.3.3: an uncoloured pattern (PaintType 2) is painted in the Pattern space's underlying space, with the colour scn gave.
    const uncoloured = numberOf(this.deref(value.dictionary.get(PAINT_TYPE))) === 2;
    const underlying = use.space?.kind === 'array' ? use.space.items[1] : undefined;
    const base: ColorSpaceUse | undefined = uncoloured ? { ...this.imageUse(underlying), components: use.components } : undefined;
    if (base !== undefined) spaces.push(base);
    cells.push(() => {
      this.tilingCell(step, { value: use.pattern?.reference ?? value, stream: value, base });
    });
  }

  // 8.7.3.1: the cell is painted after the reader "Installs the graphics state that was in effect at the beginning of the pattern’s parent content stream, with the current transformation matrix altered by the pattern matrix".
  private tilingCell(step: Step, { value, stream, base }: { value: PdfObject; stream: PdfStream; base: ColorSpaceUse | undefined }): void {
    const { initial } = step.scope;
    const ctm = multiply(this.matrixOf(stream.dictionary.get(MATRIX)) ?? IDENTITY, initial.ctm);
    const state: GraphicsState = base === undefined ? { ...initial, ctm } : { ...initial, ctm, fill: base, stroke: base };
    const reference = value.kind === 'reference' ? value : undefined;
    const source: ContentSource = { kind: 'tiling-pattern', reference, coloured: base === undefined };
    const colour = base === undefined ? step.scope.context.colour : 'uncoloured-pattern';
    const scope = this.childScope(step.scope, { stream, reference, source, colour, state });
    const data = this.decoded(stream, step.where);
    if (data !== undefined) this.nested(step.where, { value: reference, data, scope, markedContent: 'inherit' });
  }

  private numbers(value: PdfDirectObject | undefined): number[] | undefined {
    try {
      return numbersOf(this.document, value);
    } catch (error: unknown) {
      if (!unreadable(error)) throw error;
      this.warn('content-unreadable', `an object cannot be read: ${error.message}`, true);
      return undefined;
    }
  }

  // 11.6.6: a group XObject is a form whose Group dictionary has the subtype Transparency (Table 147, S).
  private isTransparencyGroup(stream: PdfStream): boolean {
    const group = dictionaryOf(this.deref(stream.dictionary.get(GROUP)));
    const subtype = this.deref(group?.get(MASK_SUBTYPE));
    return subtype?.kind === 'name' && latin1(subtype.bytes) === latin1(TRANSPARENCY);
  }

  private matrixOf(value: PdfDirectObject | undefined): Matrix | undefined {
    const numbers = this.numbers(value);
    const [a, b, c, d, e, f, ...rest] = numbers ?? [];
    if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined || f === undefined || rest.length > 0) return undefined;
    return [a, b, c, d, e, f];
  }

  private rectangleOf(value: PdfDirectObject | undefined): readonly [number, number, number, number] | undefined {
    const [x1, y1, x2, y2, ...rest] = this.numbers(value) ?? [];
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined || rest.length > 0) return undefined;
    // 7.9.5: a rectangle gives "a pair of diagonally opposite corners", which readers normalise.
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  }

  private decoded(stream: PdfStream, where: string): Uint8Array | undefined {
    const data = decodedData(this.document, stream);
    if (typeof data !== 'string') return data;
    this.warn('content-unreadable', `${where}: the stream cannot be read: ${data}`, true);
    return undefined;
  }

  // 7.8.3: a stream's own Resources, or, for forms and Type 3 fonts written without one, "the resource dictionary of the page on which they are used".
  private childScope(
    parent: Scope,
    {
      stream,
      reference,
      source,
      colour,
      state,
      resources = stream.dictionary.get(RESOURCES),
      holder,
    }: {
      stream: PdfStream;
      reference: PdfReference | undefined;
      source: ContentSource;
      colour: ColourUse;
      state: GraphicsState;
      resources?: PdfDirectObject | undefined;
      /** The key of the object holding a direct resource dictionary, when it is not the stream itself. */
      holder?: string;
    },
  ): Scope {
    const resolved = this.deref(resources);
    const own = resolved === undefined || resolved.kind === 'null' ? undefined : dictionaryOf(resolved);
    const key = reference === undefined ? parent.owner : referenceKey(reference);
    let owner = holder ?? key;
    if (own === undefined) ({ owner } = this.page);
    else if (resources?.kind === 'reference') owner = referenceKey(resources);
    return {
      resources: own ?? this.page.resources,
      owner,
      context: { sources: [...parent.context.sources, source], colour },
      label: () => `${source.kind} ${key}`,
      initial: state,
      pageText: parent.pageText && source.kind !== 'type3-glyph',
    };
  }

  // Interprets a stream inside the current one, with its own graphics state stack, and restores everything the stream could change.
  private nested(where: string, { value, data, scope, markedContent }: Nested): void {
    const key = value?.kind === 'reference' ? referenceKey(value) : undefined;
    if (key !== undefined && this.active.has(key)) {
      this.warn('content-cycle', `${where}: ${scope.label(0)} is already being drawn`, true);
      return;
    }
    if (this.depth >= this.document.maxNesting) {
      throw new ResourceLimitError(`content streams nest deeper than maxNesting (${String(this.document.maxNesting)})`);
    }
    const saved = {
      state: this.state,
      stack: this.stack,
      textMatrix: this.textMatrix,
      lineMatrix: this.lineMatrix,
      positionKnown: this.positionKnown,
      path: this.path,
      pendingClip: this.pendingClip,
      compatibility: this.compatibility,
      markedContent: this.markedContent,
      markedFloor: this.markedFloor,
      ignored: this.ignored,
    };
    this.ignored = {};
    this.state = scope.initial;
    this.stack = [];
    this.path = undefined;
    this.pendingClip = undefined;
    this.compatibility = 0;
    if (markedContent === 'fresh') this.markedContent = [];
    this.markedFloor = this.markedContent.length;
    if (key !== undefined) this.active.add(key);
    this.depth++;
    try {
      this.run([data], scope);
      if (this.markedContent.length > this.markedFloor) {
        this.warn(
          'marked-content-unbalanced',
          `${scope.label(0)}: ${String(this.markedContent.length - this.markedFloor)} marked-content sequences are not closed by EMC`,
          false,
        );
      }
    } finally {
      ({ state: this.state, stack: this.stack, textMatrix: this.textMatrix, lineMatrix: this.lineMatrix, positionKnown: this.positionKnown } = saved);
      ({
        path: this.path,
        pendingClip: this.pendingClip,
        compatibility: this.compatibility,
        markedContent: this.markedContent,
        markedFloor: this.markedFloor,
        ignored: this.ignored,
      } = saved);
      if (key !== undefined) this.active.delete(key);
      this.depth--;
    }
  }

  // 8.10.1: Do saves the graphics state, "Concatenates the matrix from the form dictionary’s Matrix entry with the current transformation matrix (CTM)", "Clips according to the form dictionary’s BBox entry", paints the content and restores the state.
  drawForm(
    where: string,
    { value, stream, parentScope, drawing }: { value: PdfDirectObject | undefined; stream: PdfStream; parentScope: Scope; drawing: FormDrawing },
  ): void {
    const { base, source } = drawing;
    const ctm = multiply(this.matrixOf(stream.dictionary.get(MATRIX)) ?? IDENTITY, base.ctm);
    const box = this.rectangleOf(stream.dictionary.get(BBOX));
    const clip = box === undefined ? base.clip : base.clip.intersect(rectanglePath(box, ctm), 'nonzero');
    const state: GraphicsState = this.isTransparencyGroup(stream) ? enterGroup({ ...base, ctm, clip }) : { ...base, ctm, clip };
    const reference = value?.kind === 'reference' ? value : undefined;
    const parent: Scope = { ...parentScope, context: { sources: drawing.parent, colour: drawing.colour } };
    const scope = this.childScope(parent, { stream, reference, source, colour: drawing.colour, state });
    const data = this.decoded(stream, where);
    if (data !== undefined) this.nested(where, { value, data, scope, markedContent: drawing.markedContent });
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
    if (value === undefined) return undefined;
    const { owner, name: resourceName } = fontResourceOwner(step.scope.resources?.get(FONT), step.scope.owner, name);
    const key = fontKey(value, owner, resourceName);
    return this.font(key, () => this.fonts.font(value, key));
  }

  // 8.4.5, Table 58: a graphics state parameter dictionary's Font entry is "An array of the form [ font size ]".
  private graphicsStateParameters(step: Step, name: Uint8Array): void {
    const { scope, where } = step;
    const value = this.resource(step, EXT_G_STATE, name);
    const parameters = dictionaryOf(this.deref(value));
    if (value !== undefined && parameters === undefined) {
      this.warn('resource-missing', `${where}: the ExtGState resource ${latin1(name)} is not a dictionary`, true);
    }
    if (parameters !== undefined) this.transparency(parameters, step);
    const font = this.deref(parameters?.get(FONT));
    if (font?.kind === 'array') {
      const [fontValue, size] = font.items;
      const fontSize = numberOf(this.deref(size));
      if (fontValue === undefined || fontSize === undefined) this.warn('bad-operands', `${where}: the Font entry is not [font size]`, true);
      else {
        const holder = graphicsStateFontOwner({ category: scope.resources?.get(EXT_G_STATE), state: value }, scope.owner, name);
        const key = fontKey(fontValue, holder.owner, holder.name);
        this.state = { ...this.state, font: this.font(key, () => this.fonts.font(fontValue, key)), fontSize };
      }
    }
  }

  // 8.4.5, Table 58: ca, CA, BM and SMask. 11.7.4.2: "The Compatible blend mode shall be treated as equivalent to Normal".
  private transparency(parameters: PdfDictionaryEntries, step: Step): void {
    const fillAlpha = numberOf(this.deref(parameters.get(FILL_ALPHA)));
    const strokeAlpha = numberOf(this.deref(parameters.get(STROKE_ALPHA)));
    const blend = this.deref(parameters.get(BLEND_MODE));
    const names = blend?.kind === 'array' ? blend.items.map(item => this.deref(item)) : [blend];
    const recognised =
      blend === undefined ? undefined : (names.map(name => (name?.kind === 'name' ? latin1(name.bytes) : '')).find(name => BLEND_MODES.has(name)) ?? 'Normal');
    const mask = this.deref(parameters.get(SOFT_MASK));
    const maskDictionary = dictionaryOf(mask);
    let { softMask } = this.state;
    // Table 58, SMask: "altering it with the gs operator completely replaces the old value with the new one"; the name None removes it.
    if (mask?.kind === 'name') softMask = undefined;
    else if (maskDictionary !== undefined) {
      const subtype = this.deref(maskDictionary.get(MASK_SUBTYPE));
      const group = maskDictionary.get(MASK_GROUP);
      softMask = {
        dictionary: maskDictionary,
        subtype: subtype?.kind === 'name' ? latin1(subtype.bytes) : undefined,
        group: group?.kind === 'reference' ? group : undefined,
        ctm: this.state.ctm,
      };
    }
    this.state = {
      ...this.state,
      fillAlpha: fillAlpha ?? this.state.fillAlpha,
      strokeAlpha: strokeAlpha ?? this.state.strokeAlpha,
      blendMode: recognised === 'Compatible' ? 'Normal' : (recognised ?? this.state.blendMode),
      softMask,
    };
    if (maskDictionary !== undefined && softMask !== undefined) this.softMaskGroup(step, softMask, maskDictionary.get(MASK_GROUP));
  }

  // 11.6.5.2: the group is drawn with the CTM "at the moment the soft mask is established in the graphics state with the gs operator", as a context of its own.
  private softMaskGroup(step: Step, mask: SoftMask, value: PdfDirectObject | undefined): void {
    const stream = this.deref(value);
    if (stream?.kind !== 'stream') return;
    const { sources, colour } = step.scope.context;
    const drawing: FormDrawing = {
      source: { kind: 'soft-mask', group: mask.group },
      base: { ...INITIAL_STATE, ctm: mask.ctm },
      parent: sources,
      colour,
      markedContent: 'inherit',
    };
    this.drawForm(step.where, { value, stream, parentScope: step.scope, drawing });
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

  private show(step: Step, value: PdfDirectObject | undefined, adjustment?: number): void {
    const { scope, where } = step;
    const string = value?.kind === 'string' ? value.bytes : new Uint8Array();
    const { font } = this.state;
    if (font === undefined) {
      this.warn('resource-missing', `${where}: no font is set`, true);
      this.positionKnown = false;
      return;
    }
    this.reportFont(font);
    const split: FontString = this.font(font.key, () => font.glyphs(string)) ?? { kind: 'undecodable', reason: 'the font cannot be read' };
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
    if (string.length > 0 && spaces.length > 0) this.paintWith('text', spaces, step);
    if (scope.pageText) {
      this.handlers.text?.({
        font,
        string,
        adjustment,
        glyphs,
        unsplit: split.kind === 'glyphs' ? undefined : split,
        state: this.state,
        context: scope.context,
        markedContent: this.markedContent,
        sequence: this.sequence++,
      });
    }
    // A glyph of a Type 3 font is drawn by its procedure, when the render mode paints.
    if (font.type3 !== undefined && spaces.length > 0) for (const shown of glyphs) this.glyphProcedure(step, font, shown);
  }

  // 9.6.5: "the current transformation matrix (CTM) shall be the concatenation of the font matrix (FontMatrix in the current font dictionary) and the text space that was in effect at the time the text-showing operator was invoked".
  private glyphProcedure(step: Step, font: FontModel, { glyph, textMatrix }: ShownGlyph): void {
    const name = glyph.glyphName;
    const value = name === undefined ? undefined : font.type3?.charProcs?.get(Uint8Array.from(name, character => character.codePointAt(0) ?? 0));
    const stream = this.deref(value);
    if (name === undefined || stream?.kind !== 'stream') return;
    const data = this.decoded(stream, step.where);
    if (data === undefined) return;
    const { fontSize, horizontalScaling, rise, ctm } = this.state;
    const textSpace = multiply([fontSize * horizontalScaling, 0, 0, fontSize, 0, rise], multiply(textMatrix, ctm));
    const described = this.described(data);
    const reference = value?.kind === 'reference' ? value : undefined;
    const source: ContentSource = { kind: 'type3-glyph', font: font.key, glyphName: name, described };
    const colour = described === 'd1' ? 'd1-glyph' : step.scope.context.colour;
    const state: GraphicsState = { ...this.state, ctm: multiply(font.glyphMatrix, textSpace) };
    // Table 112, Resources: without it the glyph procedures' names "shall be looked up in the resource dictionary of the page on which the font is used".
    const scope = this.childScope(step.scope, { stream, reference, source, colour, state, resources: font.type3?.resources, holder: font.key });
    this.nested(step.where, { value: reference, data, scope, markedContent: 'inherit' });
  }

  // 9.6.5: a glyph procedure's first operator is d0 or d1.
  private described(data: Uint8Array): 'd0' | 'd1' | undefined {
    try {
      const first = readContent(data, this.document.maxNesting).next();
      const operator = first.done === true ? undefined : first.value.operator;
      return operator === 'd0' || operator === 'd1' ? operator : undefined;
    } catch (error: unknown) {
      if (unreadable(error)) return undefined;
      throw error;
    }
  }

  // A colour space operand: a family name, or a ColorSpace resource (8.6.3).
  private colorSpace(step: Step, name: Uint8Array): ColorSpaceUse {
    const family = latin1(name);
    if (FAMILIES.has(family)) return { space: pdfName(family), resourceName: undefined, components: [], pattern: undefined };
    const value = this.resource(step, COLOR_SPACE, name);
    return { space: value === undefined ? undefined : this.deref(value), resourceName: name, components: [], pattern: undefined };
  }

  private select(target: 'fill' | 'stroke', use: ColorSpaceUse, { scope }: Step): void {
    if (scope.context.colour === 'used') this.state = target === 'fill' ? { ...this.state, fill: use } : { ...this.state, stroke: use };
    else this.ignored = target === 'fill' ? { ...this.ignored, fill: use } : { ...this.ignored, stroke: use };
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
    const used = step.scope.context.colour === 'used';
    // Where colour operators are ignored, a pattern chosen after an ignored selection is still reported, as that selection was.
    const current = used ? this.state[target] : this.ignored[target];
    if (current === undefined) return;
    let { pattern } = current;
    if (named) {
      const value = this.resource(step, PATTERN, last.bytes);
      pattern = { name: last.bytes, reference: value?.kind === 'reference' ? value : undefined, value: value === undefined ? undefined : this.deref(value) };
    }
    const use: ColorSpaceUse = { ...current, components, pattern };
    if (used) this.state = target === 'fill' ? { ...this.state, fill: use } : { ...this.state, stroke: use };
    else if (named) this.select(target, use, step);
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

  // 14.6, Table 320: BMC and BDC begin a sequence "terminated by a balancing EMC operator"; BDC's properties are "either an inline dictionary containing the property list or a name object associated with it in the Properties subdictionary".
  private marked(operator: string, values: readonly PdfDirectObject[], step: Step): boolean {
    if (operator === 'BMC' || operator === 'BDC') {
      const [tag, list] = values;
      const properties = list?.kind === 'name' ? dictionaryOf(this.deref(this.resource(step, PROPERTIES, list.bytes))) : dictionaryOf(list);
      this.markedContent = [...this.markedContent, { id: this.markedContentIds++, tag: nameBytes(tag), properties }];
    } else if (operator === 'EMC') {
      if (this.markedContent.length <= this.markedFloor) {
        this.warn('marked-content-unbalanced', `${step.where}: no marked-content sequence is open in this stream`, false);
      } else this.markedContent = this.markedContent.slice(0, -1);
    } else return operator === 'MP' || operator === 'DP';
    return true;
  }

  // 8.5.2, Table 59: path construction, with the points in user space transformed by the CTM as they are given.
  private construction(operator: string, values: readonly PdfDirectObject[]): boolean {
    if (!CONSTRUCTION.has(operator)) return false;
    // The path takes the CTM when its first segment is added; cm may not appear inside a path object (8.2; Annex L, Figure 9).
    this.path ??= new PathBuilder(this.state.ctm);
    const { path } = this;
    const at = (index: number): number => number(values, index);
    if (operator === 'm') path.moveTo(at(0), at(1));
    else if (operator === 'l') path.lineTo(at(0), at(1));
    else if (operator === 'c') path.curveTo([at(0), at(1), at(2), at(3), at(4), at(5)]);
    else if (operator === 'v') {
      const [x, y] = path.currentPoint() ?? [at(0), at(1)];
      path.curveTo([x, y, at(0), at(1), at(2), at(3)]);
    } else if (operator === 'y') path.curveTo([at(0), at(1), at(2), at(3), at(2), at(3)]);
    else if (operator === 'h') path.close();
    else if (operator === 're') path.rectangle([at(0), at(1), at(2), at(3)]);
    else return false;
    return true;
  }

  // 8.5.4: "After the path has been painted, the clipping path in the graphics state shall be set to the intersection of the current clipping path and the newly constructed path."
  private endPath(): void {
    if (this.pendingClip !== undefined && this.path !== undefined) this.state = { ...this.state, clip: this.state.clip.intersect(this.path, this.pendingClip) };
    this.pendingClip = undefined;
    this.path = undefined;
  }

  // 12.5.5: the normal appearance of each chosen annotation, a single stream or the state of a subdictionary that AS names, drawn under the matrix AA.
  drawAnnotations(page: PageEntry, pageScope: Scope, mode: 'printable' | 'all'): void {
    const annotations = this.deref(dictionaryOf(this.deref(page.reference))?.get(ANNOTS));
    for (const [index, item] of annotations?.kind === 'array' ? annotations.items.entries() : []) {
      const annotation = dictionaryOf(this.deref(item));
      const { printable } = annotationFlags(this.deref(annotation?.get(FLAGS)));
      if (annotation === undefined || (mode === 'printable' && !printable)) continue;
      const normal = dictionaryOf(this.deref(annotation.get(APPEARANCE)))?.get(NORMAL_APPEARANCE);
      const resolved = this.deref(normal);
      const state = this.deref(annotation.get(APPEARANCE_STATE));
      let value = normal;
      if (resolved?.kind === 'dictionary') value = state?.kind === 'name' ? resolved.entries.get(state.bytes) : undefined;
      const stream = this.deref(value);
      const rectangle = this.rectangleOf(annotation.get(RECT));
      if (stream?.kind !== 'stream' || rectangle === undefined) continue;
      const drawing: FormDrawing = {
        source: { kind: 'annotation', index, printable },
        base: { ...INITIAL_STATE, ctm: this.appearanceMatrix(stream, rectangle) },
        parent: [],
        colour: 'used',
        markedContent: 'fresh',
      };
      this.drawForm(`the appearance of annotation ${String(index)}`, { value, stream, parentScope: pageScope, drawing });
    }
  }

  // 12.5.5, Algorithm: the BBox transformed by Matrix, "the smallest upright rectangle that encompasses this quadrilateral", is mapped onto Rect by A; Do then applies Matrix, making AA = Matrix × A. An empty box along an axis is not scaled along it.
  private appearanceMatrix(stream: PdfStream, [left, bottom, right, top]: readonly [number, number, number, number]): Matrix {
    const matrix = this.matrixOf(stream.dictionary.get(MATRIX)) ?? IDENTITY;
    const [x1, y1, x2, y2] = this.rectangleOf(stream.dictionary.get(BBOX)) ?? [0, 0, 0, 0];
    const corners = [transformPoint(matrix, x1, y1), transformPoint(matrix, x2, y1), transformPoint(matrix, x2, y2), transformPoint(matrix, x1, y2)];
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    const [boxLeft, boxBottom] = [Math.min(...xs), Math.min(...ys)];
    const [width, height] = [Math.max(...xs) - boxLeft, Math.max(...ys) - boxBottom];
    const scaleX = width === 0 ? 1 : (right - left) / width;
    const scaleY = height === 0 ? 1 : (top - bottom) / height;
    return [scaleX, 0, 0, scaleY, left - boxLeft * scaleX, bottom - boxBottom * scaleY];
  }

  // A colour that paints over what is below: not a pattern, whose cells may leave gaps, and not only None colorants, since 8.6.6.4 says "The special colorant name None shall not produce any visible output" and 8.6.6.5 that a None component "shall never be painted"; an Indexed space paints in its base (8.6.6.3).
  private opaque(space: PdfObject | undefined, depth = 0): boolean {
    if (space?.kind === 'name') return latin1(space.bytes) !== 'Pattern';
    if (space?.kind !== 'array' || depth > 2) return false;
    const [family, second] = space.items;
    const familyName = family?.kind === 'name' ? latin1(family.bytes) : undefined;
    if (familyName === 'Separation') return !isNone(this.deref(second));
    if (familyName === 'DeviceN') {
      const names = this.deref(second);
      return !(names?.kind === 'array' && names.items.every(name => isNone(this.deref(name))));
    }
    if (familyName === 'Indexed') return this.opaque(this.deref(second), depth + 1);
    return familyName !== undefined && familyName !== 'Pattern';
  }

  // Only fills that mark the page count: not those in a pattern cell, a glyph procedure or a soft mask's group.
  private cover(scope: Scope): void {
    const { fillAlpha, blendMode, softMask, fill, clip, group } = this.state;
    if (fillAlpha !== 1 || blendMode !== 'Normal' || softMask !== undefined || !this.opaque(fill.space)) return;
    if (group.alpha !== 1 || group.blendMode !== 'Normal' || group.softMasked) return;
    if (scope.context.sources.some(source => source.kind === 'tiling-pattern' || source.kind === 'type3-glyph' || source.kind === 'soft-mask')) return;
    const rectangle = this.path?.axisAlignedRectangle();
    if (rectangle === undefined) return;
    const [left, bottom, right, top] = rectangle;
    if (clip.classifyQuad([left, bottom, right, bottom, right, top, left, top]) !== 'inside') return;
    this.handlers.cover?.({ rectangle, context: scope.context, sequence: this.sequence++ });
  }

  private painting(operation: ContentOperation, values: readonly PdfDirectObject[], step: Step): void {
    const { scope } = step;
    const { operator } = operation;
    const paint = PATH_PAINTS.get(operator);
    if (paint !== undefined) {
      this.paintWith(paint, paint === 'fill-stroke' ? [this.state.fill, this.state.stroke] : [paint === 'fill' ? this.state.fill : this.state.stroke], step);
      if (paint !== 'stroke') this.cover(scope);
      this.endPath();
    } else if (operator === 'W' || operator === 'W*') this.pendingClip = operator === 'W' ? 'nonzero' : 'even-odd';
    else if (operator === 'n') {
      if (this.pendingClip !== undefined) this.emitPaint('clip', [this.state.fill, this.state.stroke], scope);
      this.endPath();
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
    const kind = subtype?.kind === 'name' ? latin1(subtype.bytes) : undefined;
    if (kind === 'Form') {
      const reference = value?.kind === 'reference' ? value : undefined;
      const { sources, colour } = scope.context;
      const drawing: FormDrawing = { source: { kind: 'form', reference }, base: this.state, parent: sources, colour, markedContent: 'inherit' };
      this.drawForm(where, { value, stream: object, parentScope: scope, drawing });
      return;
    }
    if (kind !== 'Image') return;
    // 8.9.5, Table 89, ImageMask: "unmasked areas shall be painted using the current nonstroking colour".
    const mask = this.deref(object.dictionary.get(IMAGE_MASK));
    if (mask?.kind === 'boolean' && mask.value) this.paintWith('image-mask', [this.state.fill], step);
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
      this.paintWith('inline-image-mask', [this.state.fill], step);
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
    const owner = pageResourcesOwner(found, page);
    const resources = found === undefined ? undefined : dictionaryOf(document.objects.deref(found.value));
    if (found !== undefined && resources === undefined) interpreter.warn('resource-missing', 'the Resources of the page is not a dictionary', true);
    return { resources, owner };
  } catch (error: unknown) {
    if (!unreadable(error)) throw error;
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
  interpreter.setPage({ resources, owner });
  const content = pageContent(document, page);
  for (const problem of content.problems) interpreter.warn('content-unreadable', problem, true);
  const scope: Scope = {
    resources,
    owner,
    context: { sources: [{ kind: 'page' }], colour: 'used' },
    label: stream => `content stream ${String(content.indexes[stream] ?? stream)}`,
    initial: INITIAL_STATE,
    pageText: true,
  };
  interpreter.run(content.streams, scope);
  interpreter.finish();
  const annotations = options.annotations ?? 'none';
  if (annotations !== 'none') interpreter.drawAnnotations(page, scope, annotations);
  return interpreter.result();
};
