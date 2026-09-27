import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { formatLength } from '../length/length.ts';
import { formatInteger, formatNumber } from '../number/formatNumber.ts';
import { assertNameBytes } from '../object/nameBytes.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfInteger, pdfName } from '../object/pdfObject.ts';

import { ByteWriter } from './byteWriter.ts';

export interface SerializeOptions {
  fractionDigits: number;
}

const HEX = '0123456789ABCDEF';
const DELIMITERS = '#()<>[]{}/%';

const writeHexByte = (writer: ByteWriter, byte: number): void => {
  writer.writeByte(HEX.codePointAt(Math.floor(byte / 16)) ?? 0);
  writer.writeByte(HEX.codePointAt(byte % 16) ?? 0);
};

const writeEscape = (writer: ByteWriter, letter: number): void => {
  writer.writeByte(0x5c);
  writer.writeByte(letter);
};

const writeName = (writer: ByteWriter, bytes: Uint8Array): void => {
  assertNameBytes(bytes);
  // ISO 32000-1:2008, 7.3.5 requires hexadecimal escapes for nonregular name bytes and for NUMBER SIGN.
  writer.writeByte(0x2f);
  for (const byte of bytes) {
    if (byte < 0x21 || byte > 0x7e || DELIMITERS.includes(String.fromCodePoint(byte))) {
      writer.writeByte(0x23);
      writeHexByte(writer, byte);
    } else writer.writeByte(byte);
  }
};

const writeString = (writer: ByteWriter, bytes: Uint8Array, encoding: 'literal' | 'hex'): void => {
  if (encoding === 'hex') {
    // ISO 32000-1:2008, 7.3.4.3 encloses pairs of hexadecimal digits in angle brackets.
    writer.writeByte(0x3c);
    for (const byte of bytes) writeHexByte(writer, byte);
    writer.writeByte(0x3e);
    return;
  }
  // ISO 32000-1:2008, 7.3.4.2 defines backslash, control-character and octal escapes in literal strings.
  writer.writeByte(0x28);
  for (const byte of bytes) {
    if (byte === 0x5c || byte === 0x28 || byte === 0x29) {
      writer.writeByte(0x5c);
      writer.writeByte(byte);
    } else if (byte === 0x0d) writeEscape(writer, 0x72);
    else if (byte === 0x0a) writeEscape(writer, 0x6e);
    else if (byte === 0x09) writeEscape(writer, 0x74);
    else if (byte === 0x08) writeEscape(writer, 0x62);
    else if (byte === 0x0c) writeEscape(writer, 0x66);
    else if (byte < 0x20 || byte >= 0x7f) {
      writer.writeByte(0x5c);
      writer.writeByte(0x30 + Math.floor(byte / 64));
      writer.writeByte(0x30 + Math.floor((byte % 64) / 8));
      writer.writeByte(0x30 + (byte % 8));
    } else writer.writeByte(byte);
  }
  writer.writeByte(0x29);
};

const needsSpace = (object: PdfDirectObject): boolean =>
  object.kind === 'null' || object.kind === 'boolean' || object.kind === 'integer' || object.kind === 'real' || object.kind === 'reference';

const writeDirectObject = (writer: ByteWriter, object: PdfDirectObject, options: SerializeOptions): void => {
  switch (object.kind) {
    case 'null': {
      writer.writeAscii('null');
      break;
    }
    case 'boolean': {
      writer.writeAscii(object.value ? 'true' : 'false');
      break;
    }
    case 'integer': {
      writer.writeAscii(formatInteger(object.value));
      break;
    }
    case 'real': {
      writer.writeAscii(
        typeof object.value === 'number' ? formatNumber(object.value, options.fractionDigits) : formatLength(object.value, options.fractionDigits),
      );
      break;
    }
    case 'name': {
      writeName(writer, object.bytes);
      break;
    }
    case 'string': {
      writeString(writer, object.bytes, object.encoding);
      break;
    }
    case 'array': {
      writer.writeByte(0x5b);
      for (let index = 0; index < object.items.length; index++) {
        if (index > 0) writer.writeByte(0x20);
        const item = object.items[index];
        if (item !== undefined) writeDirectObject(writer, item, options);
      }
      writer.writeByte(0x5d);
      break;
    }
    case 'dictionary': {
      // ISO 32000-1:2008, 7.3.7 defines dictionaries as name-value pairs between double angle brackets.
      writer.writeAscii('<<');
      for (const [key, value] of object.entries.entries()) {
        writeName(writer, key);
        if (needsSpace(value)) writer.writeByte(0x20);
        writeDirectObject(writer, value, options);
      }
      writer.writeAscii('>>');
      break;
    }
    case 'reference': {
      writer.writeAscii(`${formatInteger(object.objectNumber)} ${formatInteger(object.generation)} R`);
      break;
    }
    default: {
      throw new InvalidArgumentError('only direct objects can be nested; ISO 32000-1:2008, 7.3.8.1 requires every stream to be an indirect object');
    }
  }
};

export const writePdfObject = (writer: ByteWriter, object: PdfObject, options: SerializeOptions): void => {
  if (object.kind !== 'stream') {
    writeDirectObject(writer, object, options);
    return;
  }
  const entries = new PdfDictionaryEntries(object.dictionary.entries());
  entries.set(pdfName('Length').bytes, pdfInteger(object.data.length));
  writeDirectObject(writer, { kind: 'dictionary', entries }, options);
  // ISO 32000-1:2008, 7.3.8.1 permits LF after stream and recommends an EOL after data before endstream.
  writer.writeAscii('\nstream\n');
  writer.writeBytes(object.data);
  writer.writeAscii('\nendstream');
};

export const serializeObject = (object: PdfObject, options: SerializeOptions): Uint8Array => {
  const writer = new ByteWriter();
  writePdfObject(writer, object, options);
  return writer.toUint8Array();
};
