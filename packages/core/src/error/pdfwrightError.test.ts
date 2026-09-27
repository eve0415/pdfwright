import { describe, expect, it } from 'vitest';

import { EncryptedDocumentError } from './encryptedDocumentError.ts';
import { InvalidArgumentError } from './invalidArgumentError.ts';
import { ParseError } from './parseError.ts';
import { PdfwrightError } from './pdfwrightError.ts';
import { ResourceLimitError } from './resourceLimitError.ts';
import { UnsupportedFeatureError } from './unsupportedFeatureError.ts';
import { ValidationError } from './validationError.ts';

describe('pdf errors', () => {
  it('exposes a stable code and class name for each error', () => {
    const errors = [
      [new InvalidArgumentError('bad argument'), 'invalid-argument', 'InvalidArgumentError'],
      [new ParseError('bad byte', 17), 'parse', 'ParseError'],
      [new EncryptedDocumentError('encrypted'), 'encrypted-document', 'EncryptedDocumentError'],
      [new UnsupportedFeatureError('unsupported'), 'unsupported-feature', 'UnsupportedFeatureError'],
      [new ValidationError('invalid'), 'validation', 'ValidationError'],
      [new ResourceLimitError('too large'), 'resource-limit', 'ResourceLimitError'],
    ] as const;

    for (const [error, code, name] of errors) {
      expect(error).toBeInstanceOf(PdfwrightError);
      expect(error.code).toBe(code);
      expect(error.name).toBe(name);
    }
    expect(errors[1][0].offset).toBe(17);
  });
});

describe('error reasons', () => {
  it('carries a typed reason on validation and invalid argument errors, and none when not given', () => {
    const errors = [
      new ValidationError('no identifier', 'document-id-required'),
      new ValidationError('invalid'),
      new InvalidArgumentError('keeps history', 'metadata-history'),
      new InvalidArgumentError('bad argument'),
    ];
    expect(errors.map(error => [error.code, error.reason])).toStrictEqual([
      ['validation', 'document-id-required'],
      ['validation', undefined],
      ['invalid-argument', 'metadata-history'],
      ['invalid-argument', undefined],
    ]);
  });
});
