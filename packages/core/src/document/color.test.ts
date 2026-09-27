import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { pt } from '../length/length.ts';

import { cmyk, gray, rgb } from './color.ts';
import { createContentBuilder } from './contentBuilder.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('device colours and graphics state', () => {
  it('validates components and writes colour operators', () => {
    expect(() => cmyk(0, 0, 0, 1.01)).toThrow(ValidationError);
    expect(() => rgb(-0.1, 0, 0)).toThrow(ValidationError);
    expect(() => gray(Number.NaN)).toThrow(ValidationError);
    const builder = createContentBuilder(5);
    builder.fillColor(cmyk(0, 0.1, 0.2, 0.3));
    builder.strokeColor(rgb(1, 0.5, 0));
    builder.fillColor(gray(0.25));
    builder.strokeColor(cmyk(0, 0, 0, 1));
    expect(ascii(builder.finish())).toBe('0 0.1 0.2 0.3 k\n1 0.5 0 RG\n0.25 g\n0 0 0 1 K\n');
  });

  it('deduplicates ExtGState by value per page and names first use', () => {
    const document = createDocument();
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
    page.draw(content => {
      content.graphicsState({ fillAlpha: 0.3, overprintFill: true, overprintMode: 1, softMask: 'None' });
      content.graphicsState({ overprintMode: 1, softMask: 'None', fillAlpha: 0.3, overprintFill: true });
      content.graphicsState({ strokeAlpha: 0.5, blendMode: 'Multiply' });
    });
    const pdf = ascii(document.save().toBytes());
    expect(pdf).toContain('/ExtGState<</GS1');
    expect(pdf).toContain('/GS2');
    expect(pdf).not.toContain('/GS3');
    for (const fragment of ['/CA 0.5', '/ca 0.3', '/OP false', '/op true', '/OPM 1', '/SMask/None']) expect(pdf).toContain(fragment);
  });
});
