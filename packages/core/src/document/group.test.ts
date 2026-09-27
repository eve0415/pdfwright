import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { pt } from '../length/length.ts';

import { cmyk } from './color.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('transparency groups', () => {
  it('writes a form with its own resources and group attributes', () => {
    const document = createDocument();
    const spot = document.separation({ name: 'Primer', alternate: cmyk(0, 0, 0, 0.5) });
    const group = document.group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)), isolated: true, knockout: false, colorSpace: 'DeviceCMYK' }, content => {
      content.fillColor(spot, 1);
      content.graphicsState({ fillAlpha: 0.3 });
      content.path(path => path.rect(0, 0, 20, 20));
      content.fill('nonzero');
    });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.draw(content => {
      content.group(group, [1, 0, 0, 1, 0, 0]);
    });
    const pdf = ascii(document.save().toBytes());
    for (const fragment of [
      '/Subtype/Form',
      '/BBox[0 0 20 20]',
      '/Group<</S/Transparency/I true/K false/CS/DeviceCMYK>>',
      '/ColorSpace<</CS1',
      '/ExtGState<</GS1',
      '/XObject<</Fm1',
    ]) {
      expect(pdf).toContain(fragment);
    }
  });

  it('requires isolation when a form group names a colour space', () => {
    const document = createDocument();
    expect(() =>
      document.group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)), colorSpace: 'DeviceCMYK' }, content => {
        content.save();
        content.restore();
      }),
    ).toThrow(ValidationError);
  });

  it('checks inherited white overprint at placement', () => {
    const document = createDocument();
    const group = document.group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)) }, content => {
      content.fillColor(cmyk(0, 0, 0, 0));
      content.path(path => path.rect(0, 0, 20, 20));
      content.fill('nonzero');
    });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.draw(content => {
      content.graphicsState({ overprintFill: true, overprintMode: 1 });
      expect(() => {
        content.group(group, [1, 0, 0, 1, 0, 0]);
      }).toThrow(ValidationError);
      expect(() => {
        content.group(group, [1, 0, 0, 1, 0, 0], { acknowledgeInvisibleOverprint: true });
      }).not.toThrow();
    });
  });

  it('allows a group with its own ExtGState to override inherited overprint', () => {
    const document = createDocument();
    const group = document.group({ bbox: rect(pt(0), pt(0), pt(20), pt(20)) }, content => {
      content.graphicsState({ overprintFill: false });
      content.fillColor(cmyk(0, 0, 0, 0));
      content.path(path => path.rect(0, 0, 20, 20));
      content.fill('nonzero');
    });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(20), pt(20)) });
    page.draw(content => {
      content.graphicsState({ overprintFill: true, overprintMode: 1 });
      expect(() => {
        content.group(group, [1, 0, 0, 1, 0, 0]);
      }).not.toThrow();
    });
  });
});
