import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';

import { cmyk, gray } from './color.ts';
import { createContentBuilder } from './contentBuilder.ts';

describe('white overprint guard', () => {
  it('rejects direct zero DeviceCMYK fill under OPM 1 unless acknowledged', () => {
    const { content } = createContentBuilder(5);
    content.fillColor(cmyk(0, 0, 0, 0));
    content.graphicsState({ overprintFill: true, overprintMode: 1 });
    expect(() => {
      content.fill('nonzero');
    }).toThrow(ValidationError);
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
    const { content } = createContentBuilder(5, { colorSpace: 'DeviceRGB' });
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
