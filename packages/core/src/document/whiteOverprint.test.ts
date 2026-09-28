import type { ContentBuilder } from './contentBuilder.ts';
import type { PageOptions, PdfDocument } from './pdfDocument.ts';

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { pt } from '../length/length.ts';

import { cmyk, gray } from './color.ts';
import { createContentBuilder } from './contentBuilder.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

const IDENTITY = [1, 0, 0, 1, 0, 0] as const satisfies [number, number, number, number, number, number];
const BOX = rect(pt(0), pt(0), pt(20), pt(20));

const fillBox = (content: ContentBuilder): void => {
  content.path(path => path.rect(0, 0, 20, 20));
  content.fill('nonzero');
};

const whiteBox = (content: ContentBuilder): void => {
  content.fillColor(cmyk(0, 0, 0, 0));
  fillBox(content);
};

const overprintPage = (document: PdfDocument, group?: PageOptions['group']): ((draw: (content: ContentBuilder) => void) => void) => {
  const page = document.addPage(group === undefined ? { mediaBox: BOX } : { mediaBox: BOX, group });
  return draw => {
    page.draw(content => {
      content.graphicsState({ overprintFill: true, overprintMode: 1 });
      draw(content);
    });
  };
};

describe('white overprint guard', () => {
  it('rejects direct zero DeviceCMYK fill under OPM 1 unless acknowledged', () => {
    const { content } = createContentBuilder(5);
    content.fillColor(cmyk(0, 0, 0, 0));
    content.graphicsState({ overprintFill: true, overprintMode: 1 });
    expect(() => {
      content.fill('nonzero');
    }).toThrow(expect.objectContaining({ constructor: ValidationError, reason: 'invisible-overprint' }));
    expect(() => {
      content.fill('nonzero', { acknowledgeInvisibleOverprint: true });
    }).not.toThrow();
  });

  it('checks the painting operation flag and restores state across q/Q', () => {
    const { content } = createContentBuilder(5);
    content.strokeColor(cmyk(0, 0, 0, 0));
    content.graphicsState({ overprintFill: true, overprintMode: 1 });
    expect(() => {
      content.stroke();
    }).not.toThrow();
    content.save();
    content.graphicsState({ overprintStroke: true });
    expect(() => {
      content.stroke();
    }).toThrow(ValidationError);
    content.restore();
    expect(() => {
      content.stroke();
    }).not.toThrow();
  });

  it('allows OPM 0, nonzero colour, and non-CMYK colours', () => {
    const { content } = createContentBuilder(5);
    content.fillColor(cmyk(0, 0, 0, 0));
    content.graphicsState({ overprintFill: true, overprintMode: 0 });
    expect(() => {
      content.fill('nonzero');
    }).not.toThrow();
    content.graphicsState({ overprintMode: 1 });
    content.fillColor(cmyk(0, 0, 0, 0.01));
    expect(() => {
      content.fill('nonzero');
    }).not.toThrow();
    content.fillColor(gray(1));
    expect(() => {
      content.fill('nonzero');
    }).not.toThrow();
  });

  it('allows zero DeviceCMYK in an RGB page group', () => {
    const { content } = createContentBuilder(5, { blendingSpace: 'DeviceRGB' });
    content.fillColor(cmyk(0, 0, 0, 0));
    content.graphicsState({ overprintFill: true, overprintMode: 1 });
    expect(() => {
      content.fill('nonzero');
    }).not.toThrow();
  });

  it('checks fill and stroke separately for a combined paint', () => {
    const { content } = createContentBuilder(5);
    content.fillColor(cmyk(0, 0, 0, 0));
    content.strokeColor(cmyk(0, 0, 0, 1));
    content.graphicsState({ overprintFill: true, overprintMode: 1 });
    expect(() => {
      content.fillAndStroke('evenodd');
    }).toThrow(ValidationError);
    content.graphicsState({ overprintFill: false, overprintStroke: true });
    expect(() => {
      content.fillAndStroke('evenodd');
    }).not.toThrow();
  });
});

describe('white overprint through groups', () => {
  it('treats each overprint key a group leaves unset as inherited, even after an unrelated ExtGState', () => {
    const document = createDocument();
    const alphaOnly = document.group({ bbox: BOX }, content => {
      content.graphicsState({ fillAlpha: 0.3 });
      whiteBox(content);
    });
    const fillFlagOnly = document.group({ bbox: BOX }, content => {
      content.graphicsState({ overprintFill: true });
      whiteBox(content);
    });
    const modeZero = document.group({ bbox: BOX }, content => {
      content.graphicsState({ overprintMode: 0 });
      whiteBox(content);
    });
    const page = document.addPage({ mediaBox: BOX });
    page.draw(content => {
      content.graphicsState({ overprintMode: 1 });
      content.group(alphaOnly, IDENTITY);
      expect(() => {
        content.group(fillFlagOnly, IDENTITY);
      }).toThrow(ValidationError);
      content.graphicsState({ overprintFill: true });
      expect(() => {
        content.group(alphaOnly, IDENTITY);
      }).toThrow(ValidationError);
      content.group(modeZero, IDENTITY);
    });
  });

  it('evaluates a group paint that sets no colour against the colour current at placement', () => {
    const document = createDocument();
    const inheritsColour = document.group({ bbox: BOX }, fillBox);
    overprintPage(document)(content => {
      content.fillColor(cmyk(0, 0, 0, 1));
      content.group(inheritsColour, IDENTITY);
      content.fillColor(cmyk(0, 0, 0, 0));
      expect(() => {
        content.group(inheritsColour, IDENTITY);
      }).toThrow(ValidationError);
      content.group(inheritsColour, IDENTITY, { acknowledgeInvisibleOverprint: true });
    });
  });

  it('passes a nested group requirement to the group that places it', () => {
    const document = createDocument();
    const inner = document.group({ bbox: BOX }, whiteBox);
    const outer = document.group({ bbox: BOX }, content => {
      content.group(inner, IDENTITY);
    });
    const shielded = document.group({ bbox: BOX }, content => {
      content.graphicsState({ overprintFill: false });
      content.group(inner, IDENTITY);
    });
    overprintPage(document)(content => {
      expect(() => {
        content.group(outer, IDENTITY);
      }).toThrow(ValidationError);
      content.group(shielded, IDENTITY);
    });
  });

  it('resolves the blending colour space through non-isolated groups to the page group', () => {
    const document = createDocument();
    const explicit = (content: ContentBuilder): void => {
      content.graphicsState({ overprintFill: true, overprintMode: 1 });
      whiteBox(content);
    };
    const nonIsolated = document.group({ bbox: BOX }, explicit);
    const isolatedRgb = document.group({ bbox: BOX, isolated: true, colorSpace: 'DeviceRGB' }, explicit);
    const isolatedCmyk = document.group({ bbox: BOX, isolated: true, colorSpace: 'DeviceCMYK' }, whiteBox);
    expect(() => document.group({ bbox: BOX, isolated: true, colorSpace: 'DeviceCMYK' }, explicit)).toThrow(ValidationError);
    overprintPage(document, { colorSpace: 'DeviceRGB' })(content => {
      content.group(nonIsolated, IDENTITY);
      content.group(isolatedRgb, IDENTITY);
      expect(() => {
        content.group(isolatedCmyk, IDENTITY);
      }).toThrow(ValidationError);
    });
    for (const group of [undefined, { colorSpace: 'DeviceCMYK' } as const]) {
      overprintPage(
        document,
        group,
      )(content => {
        content.graphicsState({ overprintFill: false });
        expect(() => {
          content.group(nonIsolated, IDENTITY);
        }).toThrow(ValidationError);
        content.group(isolatedRgb, IDENTITY);
      });
    }
  });
});
