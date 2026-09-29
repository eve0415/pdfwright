import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { SpaceColorants } from './colorSpaceColorants.ts';

import { describe, expect, it } from 'vitest';

import { pdfReference } from '../../object/pdfObject.ts';
import { latin1Text, streamBody } from '../../testing/pdfBuilder.ts';
import { textPdf } from '../../testing/textPdf.ts';

import { colorSpaceColorants } from './colorSpaceColorants.ts';

const TINT = '<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0 1 0 0]/N 1>>';

const REFERENCED: readonly TestObject[] = [
  { number: 101, body: '/Referenced' },
  { number: 102, body: '[/ICCBased 104 0 R]' },
  { number: 103, body: TINT },
  { number: 104, body: streamBody('/N 4', '') },
];

// The colorants of the colour space written as object 100, with the other objects it refers to.
const colorants = (space: string, objects: readonly TestObject[] = []): SpaceColorants => {
  const document = textPdf({ pages: [{}], objects: [{ number: 100, body: space }, ...objects] });
  return colorSpaceColorants(document.objects, document.objects.deref(pdfReference(100, 0)));
};

const summary = (result: SpaceColorants): string[] =>
  result.colorants.map(
    colorant =>
      `${latin1Text(colorant.name)}:${colorant.kind}${colorant.component ? '' : ':listed'}${colorant.alternate === undefined ? '' : `:${colorant.alternate.family}`}`,
  );

const definition = (space: string, objects: readonly TestObject[] = []): string | undefined => colorants(space, objects).colorants[0]?.alternate?.definition;

describe('colorants of colour spaces', () => {
  it('reads a Separation colorant with its kind and alternate space', () => {
    const cases = ['Spot', 'All', 'None', 'Cyan', 'Black'].map(name => summary(colorants(`[/Separation/${name}/DeviceCMYK ${TINT}]`)));
    expect(cases).toStrictEqual([
      ['Spot:spot:DeviceCMYK'],
      ['All:all:DeviceCMYK'],
      ['None:none:DeviceCMYK'],
      ['Cyan:process:DeviceCMYK'],
      ['Black:process:DeviceCMYK'],
    ]);
  });

  it('keeps a colorant name as the bytes its escapes decode to', () => {
    const [colorant] = colorants(`[/Separation/#E7#89#B9#E8#89#B2/DeviceCMYK ${TINT}]`).colorants;
    expect(colorant?.name).toStrictEqual(Uint8Array.of(0xe7, 0x89, 0xb9, 0xe8, 0x89, 0xb2));
  });

  it('resolves references in the space, its name and its alternate', () => {
    expect(summary(colorants('[/Separation 101 0 R 102 0 R 103 0 R]', REFERENCED))).toStrictEqual(['Referenced:spot:ICCBased']);
  });

  it('reads DeviceN components, with None components and the reserved process names', () => {
    const result = colorants(`[/DeviceN[/Cyan/Gold/None]/DeviceCMYK ${TINT}]`);
    expect([summary(result), result.warnings]).toStrictEqual([['Cyan:process', 'Gold:spot', 'None:none'], []]);
  });

  it('reports All in a DeviceN space, where 8.6.6.5 forbids it', () => {
    const result = colorants(`[/DeviceN[/All/Gold]/DeviceCMYK ${TINT}]`);
    expect([summary(result), result.warnings.map(warning => warning.code)]).toStrictEqual([['All:all', 'Gold:spot'], ['devicen-all']]);
  });

  it('reads an NChannel space: process components, spot components with their Separation alternates, and listed extra colorants', () => {
    const attributes = `<</Subtype/NChannel/Process<</ColorSpace/DeviceRGB/Components[/R/G/B]>>/Colorants<</Gold[/Separation/Gold/DeviceCMYK ${TINT}]/Silver[/Separation/Silver/DeviceGray ${TINT}]>>>>`;
    expect(summary(colorants(`[/DeviceN[/R/Gold/Magenta]/DeviceRGB ${TINT} ${attributes}]`))).toStrictEqual([
      'R:process',
      'Gold:spot:DeviceCMYK',
      'Magenta:process',
      'Silver:spot:listed:DeviceGray',
    ]);
  });

  it('reads the base of an Indexed space and of a Pattern space', () => {
    const separation = `[/Separation/Gold/DeviceCMYK ${TINT}]`;
    expect([summary(colorants(`[/Indexed ${separation} 1 <00FF>]`)), summary(colorants(`[/Pattern ${separation}]`))]).toStrictEqual([
      ['Gold:spot:DeviceCMYK'],
      ['Gold:spot:DeviceCMYK'],
    ]);
  });

  it('finds no colorants in device, CIE-based and Pattern family spaces', () => {
    expect(
      ['/DeviceCMYK', '/Pattern', '[/CalGray<</WhitePoint[1 1 1]>>]', '[/Lab<</WhitePoint[1 1 1]>>]'].map(space => colorants(space).colorants),
    ).toStrictEqual([[], [], [], []]);
  });

  it('reports a Separation space whose colorant is not a name as unreadable', () => {
    const result = colorants(`[/Separation 42/DeviceCMYK ${TINT}]`);
    expect([result.colorants, result.warnings.map(warning => warning.code)]).toStrictEqual([[], ['colorspace-unreadable']]);
  });

  it('gives equal definitions to equal alternates and tint transforms, whatever objects hold them', () => {
    const direct = definition(`[/Separation/Gold/DeviceCMYK ${TINT}]`);
    const referenced = definition('[/Separation/Gold/DeviceCMYK 101 0 R]', [{ number: 101, body: TINT }]);
    const other = definition(`[/Separation/Gold/DeviceCMYK ${TINT.replace('0 1 0 0', '0 0 1 0')}]`);
    expect([direct === referenced, direct === other]).toStrictEqual([true, false]);
  });
});
