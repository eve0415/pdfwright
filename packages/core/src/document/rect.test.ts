import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { mm, pt } from '../length/length.ts';

import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('page boxes', () => {
  it('normalizes diagonal corners', () => {
    expect(rect(pt(10), pt(20), pt(0), pt(5))).toStrictEqual([pt(0), pt(5), pt(10), pt(20)]);
  });

  it('writes only supplied boxes', () => {
    const document = createDocument();
    document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)), trimBox: rect(pt(10), pt(10), pt(90), pt(90)) });
    const pdf = ascii(document.save().toBytes());
    expect(pdf).toContain('/MediaBox[0 0 100 100]');
    expect(pdf).toContain('/TrimBox[10 10 90 90]');
    expect(pdf).not.toContain('/CropBox');
    expect(pdf).not.toContain('/BleedBox');
    expect(pdf).not.toContain('/ArtBox');
  });

  it('rejects boxes outside MediaBox and zero area after rounding', () => {
    const document = createDocument();
    const mediaBox = rect(pt(0), pt(0), pt(100), pt(100));
    expect(() => {
      document.addPage({ mediaBox, cropBox: rect(pt(-1), pt(0), pt(100), pt(100)) });
    }).toThrow(ValidationError);
    expect(() => {
      document.addPage({ mediaBox, artBox: rect(pt(0), pt(0), pt(101), pt(100)) });
    }).toThrow(ValidationError);
    expect(() => {
      document.addPage({ mediaBox, bleedBox: rect(mm(0.0000001), pt(0), mm(0.0000002), pt(10)) });
    }).toThrow(ValidationError);
    expect(() => {
      document.addPage({ mediaBox: rect(pt(0), pt(0), pt(0), pt(100)) });
    }).toThrow(ValidationError);
  });
});
